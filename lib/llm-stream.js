// Streaming OpenAI-compatible chat client.
//
// Large hosted models (NVIDIA NIM: Nemotron, MiniMax, GLM, DeepSeek...) have a long
// time-to-first-token. A non-streaming request waits for the *entire* completion before the
// first byte of the response body, so an app-level idle/total timeout fires even though the
// provider is still actively generating. Streaming (`stream: true`) makes the server flush
// tokens as soon as they are produced, so the connection stays alive and the app receives
// content incrementally — turning "timed out while still processing" into "worked".

const { envPositiveNumber } = require("./env");
const logger = require("./logger");

// Hard ceiling for one chat request, regardless of streaming progress. Guards against a
// pathological model that streams a little then hangs forever.
const DEFAULT_TOTAL_TIMEOUT_MS = 180_000;
// Max gap between any two stream chunks. If the provider goes silent for this long, abort and
// let the caller fall back to the next model. Tuned above typical inter-token latency for big
// models, but short enough that a genuinely dead connection is detected quickly.
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

// An abort raised either by fetch itself or by the read/abort race below.
function isAbortError(error) {
    return error?.name === "AbortError" || /aborted/i.test(error?.message || "");
}

// Returns a pseudo non-streaming shape so callers (translateChunkWithFallback, probeModel) keep
// working unchanged: { response: { ok, status, statusText }, data: { choices:[{message:{content}}], error } }.
// `options.firstChunkOnly` resolves as soon as the stream yields anything, without consuming the
// rest of it — enough to prove a model answers (used by the model-status probe).
async function streamChatCompletion({ endpoint, apiKey, model, messages, options = {} }) {
    const totalMs = options.totalTimeoutMs || envPositiveNumber("LLM_TOTAL_TIMEOUT_MS", DEFAULT_TOTAL_TIMEOUT_MS);
    const idleMs = options.idleTimeoutMs || envPositiveNumber("LLM_IDLE_TIMEOUT_MS", DEFAULT_IDLE_TIMEOUT_MS);

    const controller = new AbortController();
    const timers = [];

    // Rejects when abort fires, so a waiting reader.read() can be raced against it (an abort
    // does not otherwise wake a read() that is blocked on a stream that never produces bytes).
    let rejectOnAbort;
    const abortPromise = new Promise((_, reject) => {
        rejectOnAbort = reject;
    });
    controller.signal.addEventListener("abort", () => {
        rejectOnAbort(new Error("llm stream aborted (idle/total timeout or dead connection)"));
    });

    const armIdle = () => {
        clearTimeout(timers.idle);
        timers.idle = setTimeout(() => {
            logger.warn("llm stream idle timeout, aborting", { model, idleMs });
            controller.abort();
        }, idleMs);
    };
    timers.total = setTimeout(() => {
        logger.warn("llm stream total timeout, aborting", { model, totalMs });
        controller.abort();
    }, totalMs);
    armIdle();

    let response;
    try {
        response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
                Accept: "text/event-stream",
            },
            body: JSON.stringify({
                model,
                messages,
                temperature: options.temperature ?? 0.2,
                max_tokens: options.maxTokens ?? 4000,
                stream: true,
            }),
            signal: controller.signal,
        });
    } finally {
        // The idle timer keeps running until we start streaming; the total timer until we finish.
    }

    if (!response.ok) {
        // Error responses are regular JSON, not a stream. Read + return so the caller can
        // classify (429/401/403...). Cancel timers.
        clearTimeout(timers.total);
        clearTimeout(timers.idle);
        const data = await response.json().catch(() => ({}));
        return { response: { ok: false, status: response.status, statusText: response.statusText }, data };
    }

    if (!response.body) {
        // No stream to consume (some proxies buffer). Fall back to buffered JSON.
        clearTimeout(timers.total);
        clearTimeout(timers.idle);
        const data = await response.json().catch(() => ({}));
        return { response: { ok: true, status: 200, statusText: response.statusText }, data };
    }

    const content = options.firstChunkOnly
        ? await firstStreamChunk(response.body, abortPromise)
        : await consumeStream(response.body, armIdle, abortPromise);

    clearTimeout(timers.total);
    clearTimeout(timers.idle);

    return {
        response: { ok: true, status: 200, statusText: response.statusText },
        data: { choices: [{ message: { content } }] },
    };
}

// Parse an SSE byte stream into concatenated delta.content. Resets the idle timer on every
// received chunk so a slow-but-live stream is never aborted. Races each read against an abort
// promise so a stream that produces no bytes is broken by the idle/total timeout.
async function consumeStream(body, onChunk, abortPromise) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";

    try {
        while (true) {
            const { value, done } = await Promise.race([
                reader.read(),
                abortPromise.then(() => ({ done: true, value: undefined })),
            ]);
            if (done) break;
            onChunk(); // any data => connection is alive
            buffer += decoder.decode(value, { stream: true });

            let nl;
            while ((nl = buffer.indexOf("\n")) !== -1) {
                const rawLine = buffer.slice(0, nl);
                buffer = buffer.slice(nl + 1);
                const line = rawLine.trim();
                if (!line) continue;
                if (!line.startsWith("data:")) continue;
                const payload = line.slice(5).trim();
                if (payload === "[DONE]") {
                    return content;
                }
                try {
                    const json = JSON.parse(payload);
                    const delta = json.choices?.[0]?.delta?.content;
                    if (delta) content += delta;
                } catch {
                    // Keep-alive comment or partial JSON across chunks; ignore and continue.
                }
            }
        }
    } finally {
        reader.releaseLock?.();
    }
    return content;
}

// Wait for the first bytes of the stream, then stop reading: any data proves the model is live
// and answering, which is all a probe needs.
async function firstStreamChunk(body, abortPromise) {
    const reader = body.getReader();
    try {
        await Promise.race([reader.read(), abortPromise]);
    } finally {
        reader.releaseLock?.();
    }
    return "";
}

module.exports = {
    consumeStream,
    isAbortError,
    streamChatCompletion,
};
