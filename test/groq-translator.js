const assert = require("assert");
const { getSubtitleConfig } = require("../lib/config");
const {
    translateGroqBatch,
    testGroqApiKey,
    buildSystemInstruction,
    parseTranslations,
    GROQ_MODELS,
    DEFAULT_GROQ_MODEL,
    breaker,
    parseRetryAfterMs,
} = require("../lib/groq-translator");
const { translateCues } = require("../lib/translator");
const { streamChatCompletion } = require("../lib/llm-stream");

describe("Groq translator", function () {
    const originalFetch = global.fetch;
    const originalGroqApiKey = process.env.GROQ_API_KEY;
    const originalGroqModel = process.env.GROQ_MODEL;

    beforeEach(function () {
        // Start each test with a clean Groq env so tests are isolated from real keys.
        delete process.env.GROQ_API_KEY;
        delete process.env.GROQ_MODEL;
        breaker.reset();
    });

    afterEach(function () {
        if (originalGroqApiKey === undefined) {
            delete process.env.GROQ_API_KEY;
        } else {
            process.env.GROQ_API_KEY = originalGroqApiKey;
        }
        if (originalGroqModel === undefined) {
            delete process.env.GROQ_MODEL;
        } else {
            process.env.GROQ_MODEL = originalGroqModel;
        }
        global.fetch = originalFetch;
    });

    it("lists six Groq models", function () {
        assert.equal(GROQ_MODELS.length, 6);
        assert.ok(GROQ_MODELS.includes("groq/compound-mini"));
        assert.ok(GROQ_MODELS.includes("llama-3.1-8b-instant"));
        assert.ok(GROQ_MODELS.includes("llama-3.3-70b-versatile"));
        assert.ok(GROQ_MODELS.includes("openai/gpt-oss-120b"));
        assert.ok(GROQ_MODELS.includes("openai/gpt-oss-20b"));
        assert.ok(GROQ_MODELS.includes("qwen/qwen3.6-27b"));
    });

    it("defaults to a sensible Groq model", function () {
        assert.equal(DEFAULT_GROQ_MODEL, "llama-3.3-70b-versatile");
    });

    it("throws when the API key is missing (so the caller serves a notice, not the source text)", async function () {
        await assert.rejects(translateGroqBatch(["Hello", "World"], {}), /Missing API key/);
    });

    it("posts batches to Groq and parses numbered translations", async function () {
        const config = getSubtitleConfig({ groqApiKey: "gsk_test", sourceLang: "en", targetLang: "vi" });
        const requests = [];
        global.fetch = async (url, options) => {
            requests.push({ body: JSON.parse(options.body), headers: options.headers, url });
            return {
                ok: true,
                async json() {
                    return {
                        choices: [
                            {
                                message: {
                                    content: "1. Xin chào\n2. Thế giới",
                                },
                            },
                        ],
                    };
                },
            };
        };

        const translated = await translateGroqBatch(["Hello", "World"], config);

        assert.deepEqual(translated, ["Xin chào", "Thế giới"]);
        assert.equal(requests[0].url, "https://api.groq.com/openai/v1/chat/completions");
        assert.equal(requests[0].headers.Authorization, "Bearer gsk_test");
        assert.equal(requests[0].body.model, DEFAULT_GROQ_MODEL);
        assert.ok(requests[0].body.messages[0].content.includes("Vietnamese"));
    });

    it("uses the configured Groq model", async function () {
        const config = getSubtitleConfig({
            groqApiKey: "gsk_test",
            sourceLang: "en",
            targetLang: "vi",
            groqModel: "llama-3.1-8b-instant",
        });
        const requests = [];
        global.fetch = async (url, options) => {
            requests.push({ body: JSON.parse(options.body) });
            return {
                ok: true,
                async json() {
                    return { choices: [{ message: { content: "1. Xin chào" } }] };
                },
            };
        };

        await translateGroqBatch(["Hello"], config);
        assert.equal(requests[0].body.model, "llama-3.1-8b-instant");
    });

    it("throws when all models return mismatched line counts", async function () {
        this.timeout(15000);
        const config = getSubtitleConfig({ groqApiKey: "gsk_test", sourceLang: "en", targetLang: "vi" });
        global.fetch = async () => ({
            ok: true,
            async json() {
                return { choices: [{ message: { content: "1. Xin chào" } }] };
            },
        });

        await assert.rejects(translateGroqBatch(["Hello", "World"], config), /All models failed/);
    });

    it("reports an invalid API key via testGroqApiKey", async function () {
        global.fetch = async () => ({
            ok: false,
            status: 401,
            async json() {
                return { error: { message: "Invalid API key" } };
            },
        });

        const result = await testGroqApiKey({ groqApiKey: "bad", groqModel: DEFAULT_GROQ_MODEL });
        assert.equal(result.ok, false);
        assert.equal(result.status, 401);
        assert.match(result.message, /Invalid API key/);
    });

    it("reports a valid API key via testGroqApiKey", async function () {
        global.fetch = async () => ({
            ok: true,
            status: 200,
            async json() {
                return { choices: [{ message: { content: "ok" } }] };
            },
        });

        const result = await testGroqApiKey({ groqApiKey: "good", groqModel: DEFAULT_GROQ_MODEL });
        assert.equal(result.ok, true);
        assert.equal(result.status, 200);
        assert.equal(result.model, DEFAULT_GROQ_MODEL);
    });

    it("reports a missing API key via testGroqApiKey", async function () {
        const result = await testGroqApiKey({});
        assert.equal(result.ok, false);
        assert.equal(result.status, 401);
    });

    it("treats a 429 (rate-limited model) as a VALID key, not a bad key", async function () {
        // The chosen model is rate-limited, but the key itself is fine — and the addon still
        // works via fallback. Reporting this as "key invalid" (old behaviour) made users think
        // their key was broken just because they picked a rate-limited model.
        global.fetch = async () => ({
            ok: false,
            status: 429,
            async json() {
                return { error: { message: "Rate limit reached. Please try again in 30s" } };
            },
        });

        const result = await testGroqApiKey({ groqApiKey: "good", groqModel: "llama-3.1-8b-instant" });
        assert.equal(result.ok, true, "a 429 must NOT fail the key test");
        assert.equal(result.status, 429);
        assert.equal(result.rateLimited, true);
        assert.equal(result.model, "llama-3.1-8b-instant");
    });

    it("resumes from progress and skips already-translated cues to save tokens", async function () {
        this.timeout(15000);
        const config = getSubtitleConfig({ groqApiKey: "gsk_test", sourceLang: "en", targetLang: "vi" });
        const cues = [
            { text: "Hello", start: 0, end: 1 },
            { text: "World", start: 1, end: 2 },
            { text: "Goodbye", start: 2, end: 3 },
        ];
        // Cue 0 already translated in a previous run; cues 1-2 still missing.
        const progress = ["Xin chào", undefined, undefined];
        let calls = 0;
        global.fetch = async () => {
            calls += 1;
            return {
                ok: true,
                async json() {
                    // Only the missing cues should be sent: ["World", "Goodbye"] -> 2 lines.
                    return { choices: [{ message: { content: "1. Thế giới\n2. Tạm biệt" } }] };
                },
            };
        };

        const { translations, complete } = await translateCues(cues, config, progress);

        assert.equal(complete, true);
        assert.deepEqual(translations, ["Xin chào", "Thế giới", "Tạm biệt"]);
        // progress now fully populated
        assert.deepEqual(progress, ["Xin chào", "Thế giới", "Tạm biệt"]);
        // Only one Groq call was made (the already-translated cue was not re-sent).
        assert.equal(calls, 1);
    });

    it("marks the result incomplete when a batch fails and keeps progress for resume", async function () {
        this.timeout(15000);
        const config = getSubtitleConfig({ groqApiKey: "gsk_test", sourceLang: "en", targetLang: "vi" });
        const cues = [
            { text: "Hello", start: 0, end: 1 },
            { text: "World", start: 1, end: 2 },
        ];
        const progress = new Array(2).fill(undefined);
        global.fetch = async () => ({
            ok: true,
            async json() {
                // Always return a wrong line count so every model fails.
                return { choices: [{ message: { content: "1. Xin chào" } }] };
            },
        });

        const { complete } = await translateCues(cues, config, progress);

        assert.equal(complete, false);
        // Failed cues are not cached in progress (so a retry re-translates them).
        assert.deepEqual(progress, [undefined, undefined]);
    });

    it("parses Groq retry-after durations into milliseconds", function () {
        assert.equal(parseRetryAfterMs("Please try again in 23.8s"), 23800);
        assert.equal(parseRetryAfterMs("Please try again in 13m32.16s"), 13 * 60_000 + 32160);
        assert.equal(parseRetryAfterMs("Please try again in 1h2m26.304s"), 3600_000 + 2 * 60_000 + 26304);
        assert.equal(parseRetryAfterMs("no retry info"), null);
    });

    it("circuit breaker skips rate-limited models and retries a healthy one", async function () {
        this.timeout(15000);
        breaker.reset();
        const config = getSubtitleConfig({ groqApiKey: "gsk_test", sourceLang: "en", targetLang: "vi" });
        const called = [];
        global.fetch = async (url, options) => {
            const body = JSON.parse(options.body);
            called.push(body.model);
            if (body.model === "llama-3.3-70b-versatile") {
                return {
                    ok: false,
                    status: 429,
                    async json() {
                        return { error: { message: "Rate limit reached. Please try again in 1h2m26s" } };
                    },
                };
            }
            return {
                ok: true,
                async json() {
                    return { choices: [{ message: { content: "1. Xin chào\n2. Thế giới" } }] };
                },
            };
        };

        const translated = await translateGroqBatch(["Hello", "World"], config);
        assert.deepEqual(translated, ["Xin chào", "Thế giới"]);
        // The rate-limited default was called, then a healthy model took over.
        assert.ok(called.includes("llama-3.3-70b-versatile"));
        assert.ok(called.some((m) => m !== "llama-3.3-70b-versatile"));
        // The default model's circuit is now open (skipped on subsequent chunks).
        assert.equal(breaker.isOpen("groq:llama-3.3-70b-versatile"), true);
        breaker.reset();
    });

    it("retries the same model once after a short 429 backoff before moving on", async function () {
        this.timeout(15000);
        breaker.reset();

        const config = getSubtitleConfig({ groqApiKey: "gsk_test", sourceLang: "en", targetLang: "vi" });
        let callsToDefault = 0;
        global.fetch = async (url, options) => {
            const body = JSON.parse(options.body);
            if (body.model === "llama-3.3-70b-versatile") {
                callsToDefault += 1;
                // First call: short per-minute 429. Second call (the retry): success.
                if (callsToDefault === 1) {
                    return {
                        ok: false,
                        status: 429,
                        async json() {
                            return { error: { message: "Please try again in 2s" } };
                        },
                    };
                }
                return {
                    ok: true,
                    async json() {
                        return { choices: [{ message: { content: "1. Xin chào\n2. Thế giới" } }] };
                    },
                };
            }
            return {
                ok: true,
                async json() {
                    return { choices: [{ message: { content: "1. Xin chào\n2. Thế giới" } }] };
                },
            };
        };

        const translated = await translateGroqBatch(["Hello", "World"], config);
        assert.deepEqual(translated, ["Xin chào", "Thế giới"]);
        // The default model was called twice (initial 429 + backoff retry) and succeeded.
        assert.equal(callsToDefault, 2);
        assert.equal(breaker.isOpen("groq:llama-3.3-70b-versatile"), false);
        breaker.reset();
    });

    it("falls back to a generic LLM provider model when all Groq models fail", async function () {
        this.timeout(15000);
        breaker.reset();
        process.env.LLM_BASE_URL = "https://example-llm.test/v1/chat/completions";
        process.env.LLM_API_KEY = "llm-key";
        process.env.LLM_MODELS = "zhipuai/glm-5.2";

        const config = getSubtitleConfig({ groqApiKey: "gsk_test", sourceLang: "en", targetLang: "vi" });
        const endpoints = [];
        global.fetch = async (url) => {
            const target = String(url);
            endpoints.push(target);
            // Groq always rate-limited (long cooldown), LLM provider succeeds.
            if (target.includes("api.groq.com")) {
                return {
                    ok: false,
                    status: 429,
                    json: async () => ({ error: { message: "Please try again in 1h2m26s" } }),
                };
            }
            // Generic LLM provider
            return {
                ok: true,
                json: async () => ({ choices: [{ message: { content: "1. Xin chào\n2. Thế giới" } }] }),
            };
        };

        try {
            const translated = await translateGroqBatch(["Hello", "World"], config);
            assert.deepEqual(translated, ["Xin chào", "Thế giới"]);
            // The LLM provider endpoint was actually hit (fallback beyond Groq).
            assert.ok(endpoints.some((e) => e.includes("example-llm.test")));
        } finally {
            delete process.env.LLM_BASE_URL;
            delete process.env.LLM_API_KEY;
            delete process.env.LLM_MODELS;
            breaker.reset();
        }
    });

    it("rotates to a reasoning model when non-reasoning models are rate-limited", async function () {
        this.timeout(15000);
        breaker.reset();
        const config = getSubtitleConfig({ groqApiKey: "gsk_test", sourceLang: "en", targetLang: "vi" });
        const attempted = [];
        global.fetch = async (url, options) => {
            const body = JSON.parse(options.body);
            attempted.push(body.model);
            // Non-reasoning Groq models are rate-limited (long cooldown).
            if (["groq/compound-mini", "llama-3.1-8b-instant", "llama-3.3-70b-versatile"].includes(body.model)) {
                return {
                    ok: false,
                    status: 429,
                    json: async () => ({ error: { message: "Please try again in 1h2m26s" } }),
                };
            }
            // A reasoning model (qwen) is available and succeeds.
            return {
                ok: true,
                json: async () => ({ choices: [{ message: { content: "1. Xin chào\n2. Thế giới" } }] }),
            };
        };

        const translated = await translateGroqBatch(["Hello", "World"], config);
        assert.deepEqual(translated, ["Xin chào", "Thế giới"]);
        // A reasoning model (previously filtered out) was actually attempted and succeeded.
        const reasoningAttempted = attempted.some((m) =>
            ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.6-27b"].includes(m),
        );
        assert.ok(reasoningAttempted, "a reasoning model should be tried when non-reasoning are rate-limited");
        breaker.reset();
    });

    it("buildSystemInstruction contains the Vietnamese movie subtitle rules and priority", function () {
        const instruction = buildSystemInstruction(getSubtitleConfig({ sourceLang: "en", targetLang: "vi" }));
        assert.ok(instruction.includes("VIETNAMESE MOVIE SUBTITLE TRANSLATION"));
        assert.ok(instruction.includes("voice narration"));
        assert.ok(instruction.includes("Mày-Tao"));
        assert.ok(/Anh-Em.*Tớ-Cậu.*Tôi-Anh.*Hắn-Tôi/.test(instruction));
        assert.ok(instruction.includes("PRIORITY"));
        assert.ok(instruction.includes("Meaning -> Context -> Character voice"));
        assert.ok(instruction.includes("English") && instruction.includes("Vietnamese"));
    });

    it("buildSystemInstruction forbids extra details and enforces 1:1 alignment", function () {
        const instruction = buildSystemInstruction(getSubtitleConfig({ sourceLang: "en", targetLang: "vi" }));
        assert.ok(instruction.includes("Do NOT add explanations, narration, actions, visual descriptions"));
        assert.ok(instruction.includes("one translated line per input line"));
        assert.ok(instruction.includes("NEVER merge"));
        assert.ok(instruction.includes("NEVER split"));
    });

    it("parseTranslations returns exact count for matching output", function () {
        const out = parseTranslations("1. Xin chào\n2. Thế giới", 2);
        assert.deepEqual(out, ["Xin chào", "Thế giới"]);
    });

    it("parseTranslations does NOT silently merge extra lines into the last cue", function () {
        // Model split one input line into two (a real misalignment failure mode).
        // Old behaviour appended the surplus onto the last line; now the count must mismatch
        // so the caller falls back instead of serving drifted, out-of-context translations.
        const out = parseTranslations("1. Xin chào\n2. Thế giới\n3. Thêm chi tiết", 2);
        assert.equal(out.length, 3, "surplus lines must NOT be merged away");
    });

    it("parseTranslations does NOT silently pad missing lines", function () {
        const out = parseTranslations("1. Xin chào", 2);
        assert.equal(out.length, 1, "missing lines must surface as a mismatch, not be padded");
    });

    it("falls back to the next model when a model returns too many lines (over-count)", async function () {
        this.timeout(15000);
        breaker.reset();
        const config = getSubtitleConfig({ groqApiKey: "gsk_test", sourceLang: "en", targetLang: "vi" });
        const attempted = [];
        global.fetch = async (url, options) => {
            const body = JSON.parse(options.body);
            attempted.push(body.model);
            // Default model splits one cue into two -> over-count -> must fail this attempt.
            if (body.model === "llama-3.3-70b-versatile") {
                return {
                    ok: true,
                    json: async () => ({ choices: [{ message: { content: "1. Xin chào\n2. Thế giới\n3. Lỗi" } }] }),
                };
            }
            return {
                ok: true,
                json: async () => ({ choices: [{ message: { content: "1. Xin chào\n2. Thế giới" } }] }),
            };
        };

        const translated = await translateGroqBatch(["Hello", "World"], config);
        assert.deepEqual(translated, ["Xin chào", "Thế giới"]);
        // The over-count model was tried AND then a fallback model produced the correct count.
        assert.ok(attempted.includes("llama-3.3-70b-versatile"));
        assert.ok(attempted.some((m) => m !== "llama-3.3-70b-versatile"));
        breaker.reset();
    });

    it("chatCompletion requests streaming and accumulates SSE deltas into one content string", async function () {
        // Simulates a NVIDIA-style provider that streams tokens across multiple chunks.
        let sentStreamTrue = false;
        global.fetch = async (url, options) => {
            const body = JSON.parse(options.body);
            sentStreamTrue = body.stream === true;
            const chunks = [
                `data: ${JSON.stringify({ choices: [{ delta: { content: "1. Xin" } }] })}\n\n`,
                `data: ${JSON.stringify({ choices: [{ delta: { content: " chào" } }] })}\n\n`,
                `data: ${JSON.stringify({ choices: [{ delta: {} }] })}\n\n`,
                `data: [DONE]\n\n`,
            ];
            return {
                ok: true,
                status: 200,
                body: toReadableStream(chunks.join("")),
            };
        };

        const { response, data } = await streamChatCompletion({
            endpoint: "https://integrate.api.nvidia.com/v1/chat/completions",
            apiKey: "nvapi_test",
            model: "z-ai/glm-5.2",
            messages: [{ role: "user", content: "hi" }],
        });
        assert.equal(sentStreamTrue, true);
        assert.equal(response.ok, true);
        assert.equal(data.choices[0].message.content, "1. Xin chào");
    });

    it("streamChatCompletion falls back to buffered json when the provider does not stream a body", async function () {
        // Some proxies buffer the whole response (no response.body); streaming must still work.
        global.fetch = async () => ({
            ok: true,
            status: 200,
            async json() {
                return { choices: [{ message: { content: "1. Xin chào" } }] };
            },
        });
        const { response, data } = await streamChatCompletion({
            endpoint: "https://example.test/v1/chat/completions",
            apiKey: "k",
            model: "m",
            messages: [{ role: "user", content: "hi" }],
        });
        assert.equal(response.ok, true);
        assert.equal(data.choices[0].message.content, "1. Xin chào");
    });

    it("streamChatCompletion classifies a non-ok response (e.g. 429) without reading a stream", async function () {
        global.fetch = async () => ({
            ok: false,
            status: 429,
            async json() {
                return { error: { message: "Please try again in 1m" } };
            },
        });
        const { response, data } = await streamChatCompletion({
            endpoint: "https://example.test/v1/chat/completions",
            apiKey: "k",
            model: "m",
            messages: [{ role: "user", content: "hi" }],
        });
        assert.equal(response.ok, false);
        assert.equal(response.status, 429);
        assert.match(data.error.message, /try again/);
    });

    it("streamChatCompletion aborts and rejects when no chunks arrive within the idle timeout", async function () {
        this.timeout(15000);
        // Simulates a connection that stays open but never sends any bytes (dead NVIDIA endpoint).
        // Only the idle timeout can break it, after which the caller falls back to the next model.
        const prevIdle = process.env.LLM_IDLE_TIMEOUT_MS;
        const prevTotal = process.env.LLM_TOTAL_TIMEOUT_MS;
        process.env.LLM_IDLE_TIMEOUT_MS = "500";
        process.env.LLM_TOTAL_TIMEOUT_MS = "5000";
        global.fetch = async () => ({
            ok: true,
            status: 200,
            body: new NeverReadableStream(),
        });
        await assert.rejects(
            streamChatCompletion({
                endpoint: "https://example.test/v1/chat/completions",
                apiKey: "k",
                model: "m",
                messages: [{ role: "user", content: "hi" }],
            }),
        );
        if (prevIdle === undefined) delete process.env.LLM_IDLE_TIMEOUT_MS;
        else process.env.LLM_IDLE_TIMEOUT_MS = prevIdle;
        if (prevTotal === undefined) delete process.env.LLM_TOTAL_TIMEOUT_MS;
        else process.env.LLM_TOTAL_TIMEOUT_MS = prevTotal;
    });
});

function toReadableStream(text) {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(text));
            controller.close();
        },
    });
}

// A ReadableStream whose read() never resolves — simulates a connection that stays open but
// never sends any bytes, so only the idle/total timeout can break it.
class NeverReadableStream {
    constructor() {
        this.locked = false;
    }
    getReader() {
        return {
            read() {
                return new Promise(() => {});
            },
            releaseLock() {},
        };
    }
}
