const assert = require("assert");
const { getSubtitleConfig } = require("../lib/config");
const {
    translateGroqBatch,
    testGroqApiKey,
    GROQ_MODELS,
    DEFAULT_GROQ_MODEL,
    breaker,
    parseRetryAfterMs,
} = require("../lib/groq-translator");
const { translateCues } = require("../lib/translator");

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
        process.env.TRANSLATE_RETRY_DELAY_MS = "0";
        process.env.TRANSLATE_RETRY_PASSES = "1";
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
        delete process.env.TRANSLATE_RETRY_DELAY_MS;
        delete process.env.TRANSLATE_RETRY_PASSES;
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

    it("retries missing cues with another available model after a batch fails", async function () {
        this.timeout(15000);
        breaker.reset();
        process.env.TRANSLATE_RETRY_DELAY_MS = "0";
        process.env.TRANSLATE_RETRY_PASSES = "3";
        const config = getSubtitleConfig({ groqApiKey: "gsk_test", sourceLang: "en", targetLang: "vi" });
        const cues = [
            { text: "Hello", start: 0, end: 1 },
            { text: "World", start: 1, end: 2 },
        ];
        // First attempt: primary model returns a line-count mismatch so the batch fails.
        // Retry pass: primary model now succeeds (simulating quota becoming available).
        let attemptsOnDefault = 0;
        global.fetch = async (url, options) => {
            const body = JSON.parse(options.body);
            if (body.model === "llama-3.3-70b-versatile") {
                attemptsOnDefault += 1;
                if (attemptsOnDefault === 1) {
                    return {
                        ok: true,
                        async json() {
                            // Wrong line count -> mismatch -> batch fails.
                            return { choices: [{ message: { content: "1. Xin chào" } }] };
                        },
                    };
                }
            }
            // Any model on retry: return the correct line count.
            return {
                ok: true,
                async json() {
                    return { choices: [{ message: { content: "1. Xin chào\n2. Thế giới" } }] };
                },
            };
        };

        const { translations, complete } = await translateCues(cues, config, new Array(2).fill(undefined));

        assert.equal(complete, true);
        assert.deepEqual(translations, ["Xin chào", "Thế giới"]);
        delete process.env.TRANSLATE_RETRY_DELAY_MS;
        delete process.env.TRANSLATE_RETRY_PASSES;
        breaker.reset();
    });

    it("verifyIntegrity counts cues whose translation is missing or empty", function () {
        const { verifyIntegrity } = require("../lib/translator");
        const cues = [
            { text: "Hello", start: 0, end: 1 },
            { text: "World", start: 1, end: 2 },
            { text: "", start: 2, end: 3 },
        ];
        assert.equal(verifyIntegrity(cues, ["Xin chào", "Thế giới", ""]), 0);
        assert.equal(verifyIntegrity(cues, ["Xin chào", "", ""]), 1);
        assert.equal(verifyIntegrity(cues, ["", "", ""]), 2);
    });
});
