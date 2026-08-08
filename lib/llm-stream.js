// Streaming OpenAI-compatible chat client.
//
// Large hosted models (NVIDIA NIM: Nemotron, MiniMax, GLM, DeepSeek...) have a long
// time-to-first-token. A non-streaming request waits for the *entire* completion before the
// first byte of the response body, so an app-level idle/total timeout fires even though the
// provider is still actively generating. Streaming (`stream: true`) makes the server flush
// tokens as soon as they are produced, so the connection stays alive and the app receives
// content incrementally — turning "timed out while still processing" into "worked".

const logger = require("./logger");

// Hard ceiling for one chat request, regardless of streaming progress. Guards against a
// pathological model that streams a little then hangs forever.
const DEFAULT_TOTAL_TIMEOUT_MS = Number(process.env.LLM_TOTAL_TIMEOUT_MS || 180_000);
// Max gap between any two stream chunks. If the provider goes silent for this long, abort and
// let the caller fall back to the next model. Tuned above typical inter-token latency for big
// models, but short enough that a genuinely dead connection is detected quickly.
const DEFAULT_IDLE_TIMEOUT_MS = Number(process.env.LLM_IDLE_TIMEOUT_MS || 60_000);

function envTimeout(name, fallback) {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
}

// Returns a pseudo non-streaming shape so callers (translateChunkWithFallback, probeModel) keep
// working unchanged: { response: { ok, status, statusText }, data: { choices:[{message:{content}}], error } }.
async function streamChatCompletion({ endpoint, apiKey, model, messages, options = {} }) {
    const totalMs = envTimeout("LLM_TOTAL_TIMEOUT_MS", DEFAULT_TOTAL_TIMEOUT_MS);
    const idleMs = envTimeout("LLM_IDLE_TIMEOUT_MS", DEFAULT_IDLE_TIMEOUT_MS);

    const controller = new AbortController();
    const timers = {};
    let aborted = null;

    // Rejects when abort fires, so a waiting reader.read() can be raced against it (an abort
    // does not otherwise wake a read() that is blocked on a stream that never produces bytes).
    let rejectOnAbort;
    const abortPromise = new Promise((_, reject) => {
        rejectOnAbort = reject;
    });
    // The rejection is only observed while a stream read races it. Without this handler an abort
    // during the request phase surfaces as an unhandled rejection, which terminates the process.
    abortPromise.catch(() => {});
    controller.signal.addEventListener("abort", () => {
        rejectOnAbort(timeoutError(aborted, model));
    });

    const armIdle = () => {
        clearTimeout(timers.idle);
        timers.idle = setTimeout(() => {
            logger.warn("llm stream idle timeout, aborting", { model, idleMs });
            aborted = { kind: "idle", ms: idleMs };
            controller.abort();
        }, idleMs);
    };
    timers.total = setTimeout(() => {
        logger.warn("llm stream total timeout, aborting", { model, totalMs });
        aborted = { kind: "total", ms: totalMs };
        controller.abort();
    }, totalMs);
    armIdle();

    try {
        const response = await fetch(endpoint, {
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

        if (!response.ok) {
            // Error responses are regular JSON, not a stream. Read + return so the caller can
            // classify (429/401/403...).
            const data = await readResponseBody(response);
            return { response: { ok: false, status: response.status, statusText: response.statusText }, data };
        }

        if (!response.body) {
            // No stream to consume (some proxies buffer). Fall back to buffered JSON.
            const data = await readResponseBody(response);
            return { response: { ok: true, status: 200, statusText: response.statusText }, data };
        }

        const content = await consumeStream(response.body, armIdle, abortPromise);

        return {
            response: { ok: true, status: 200, statusText: response.statusText },
            data: { choices: [{ message: { content } }] },
        };
    } catch (error) {
        // Aborts arrive as an opaque AbortError; replace them with a message naming the timeout
        // that fired and the model, so the fallback chain logs the reason rather than
        // "This operation was aborted".
        if (error.isLlmTimeout) throw error;
        if (aborted && (error.name === "AbortError" || controller.signal.aborted)) {
            throw timeoutError(aborted, model, error);
        }
        throw error;
    } finally {
        clearTimeout(timers.total);
        clearTimeout(timers.idle);
    }
}

function timeoutError(aborted, model, cause) {
    const options = cause ? { cause } : undefined;
    const error = aborted
        ? new Error(`llm stream ${aborted.kind} timeout after ${aborted.ms}ms for ${model}`, options)
        : new Error(`llm stream aborted for ${model} (dead connection)`, options);
    // Marks the error as already carrying the timeout reason, so the caller does not wrap it again.
    error.isLlmTimeout = true;
    return error;
}

// Read a non-streamed body without losing the upstream explanation: providers and proxies
// sometimes answer with HTML or plain text, and response.json() alone turns that into an empty
// object, hiding why a model was rejected.
async function readResponseBody(response) {
    if (typeof response.text !== "function") {
        return response.json().catch(() => ({}));
    }

    const body = await response.text().catch((error) => {
        logger.warn("llm response body could not be read", { error, status: response.status });
        return "";
    });
    if (!body) return {};

    try {
        return JSON.parse(body);
    } catch {
        return { error: { message: body.slice(0, 500) } };
    }
}

// Parse an SSE byte stream into concatenated delta.content. Resets the idle timer on every
// received chunk so a slow-but-live stream is never aborted. Races each read against an abort
// promise so a stream that produces no bytes is broken by the idle/total timeout.
async function consumeStream(body, onChunk, abortPromise) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";

    let finished = false;
    try {
        while (!finished) {
            // abortPromise rejects, so a timeout propagates instead of ending the loop quietly:
            // returning the partial content would let a truncated translation look successful.
            const { value, done } = await Promise.race([reader.read(), abortPromise]);
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
                    finished = true;
                    break;
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
        // Cancel rather than only releasing the lock: leaving early ([DONE], abort, or a
        // caller-side throw) otherwise leaves the response body undrained and the socket open
        // until the provider times it out, leaking a connection per translated chunk. Not
        // awaited so a provider that never acknowledges the cancel cannot stall the caller.
        Promise.resolve(reader.cancel?.()).catch(() => {});
        reader.releaseLock?.();
    }
    return content;
}

module.exports = {
    consumeStream,
    streamChatCompletion,
};
