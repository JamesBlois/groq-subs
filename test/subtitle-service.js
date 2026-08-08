const assert = require("assert");
const { clearGeneratedSubtitleCacheForTests, setRedisClientForTests } = require("../lib/generated-subtitle-cache");
const { getGeneratedSubtitleResponse, getSubtitleOptions } = require("../subtitle-service");

describe("subtitle service", function () {
    let previousAddonBaseUrl;
    let previousConsoleLog;
    let previousFetch;
    let previousLogLevel;

    beforeEach(function () {
        previousAddonBaseUrl = process.env.ADDON_BASE_URL;
        previousConsoleLog = console.log;
        previousFetch = global.fetch;
        previousLogLevel = process.env.LOG_LEVEL;
        process.env.ADDON_BASE_URL = "http://127.0.0.1:53100";
        process.env.LOG_LEVEL = "info";
        console.log = () => {};
        clearGeneratedSubtitleCacheForTests();
        setRedisClientForTests(null);
        clearJobsForTests();
        const { breaker } = require("../lib/groq-translator");
        breaker.reset();
    });

    afterEach(function () {
        console.log = previousConsoleLog;
        global.fetch = previousFetch;
        restoreEnv("ADDON_BASE_URL", previousAddonBaseUrl);
        restoreEnv("LOG_LEVEL", previousLogLevel);
        clearGeneratedSubtitleCacheForTests();
        clearJobsForTests();
    });

    it("returns a diagnostic response when a generated subtitle is missing", async function () {
        const subtitle = await getGeneratedSubtitleResponse("missing");

        assert.equal(subtitle.cacheControl, "no-store");
        assert.equal(subtitle.diagnostic, true);
        assert.match(subtitle.vtt, /^WEBVTT/);
        assert.match(subtitle.vtt, /Generated subtitle expired or was not found/);
        assert.doesNotMatch(subtitle.vtt, /Details:/);
    });

    it("returns a diagnostic subtitle option when source language subtitles are unavailable", async function () {
        global.fetch = async () => ({
            ok: true,
            text: async () =>
                JSON.stringify({
                    subtitles: [
                        {
                            id: "1",
                            lang: "eng",
                            url: "https://example.com/subtitle.vtt",
                        },
                    ],
                }),
        });

        const response = await getSubtitleOptions({
            config: {
                sourceLang: "de",
                targetLang: "en",
                translationProvider: "groq",
            },
            id: "tt123",
            type: "movie",
        });

        assert.equal(response.subtitles.length, 1);
        assert.equal(response.subtitles[0].id, "double-subtitles-diagnostic-no-source-language-subtitles-to-eng");
        assert.equal(response.subtitles[0].lang, "eng");
        assert.match(response.subtitles[0].url, /^http:\/\/127\.0\.0\.1:53100\/diagnostic-subtitles\/.+\.vtt$/);
    });

    it("never serves the source language when all Groq models fail; shows a Vietnamese notice", async function () {
        this.timeout(30000);
        process.env.TRANSLATE_RETRY_DELAY_MS = "0";
        process.env.TRANSLATE_RETRY_PASSES = "1";
        // Disable background completion so it doesn't leak into the next test.
        process.env.BG_RETRY_PASSES = "0";
        // Mock fetch to handle three callers by URL:
        //  - OpenSubtitles lookup (JSON)
        //  - subtitle download (SRT text)
        //  - Groq chat completions (always 429 so every model fails)
        global.fetch = async (url) => {
            const target = String(url);
            if (target.includes("opensubtitles-v3.strem.io")) {
                return {
                    ok: true,
                    text: async () =>
                        JSON.stringify({
                            subtitles: [{ id: "42", lang: "eng", url: "https://example.com/sub.srt" }],
                        }),
                };
            }
            if (target.includes("example.com/sub.srt")) {
                return {
                    ok: true,
                    text: async () => "1\n00:00:01,000 --> 00:00:02,000\nHello world\n",
                };
            }
            if (target.includes("api.groq.com")) {
                return {
                    ok: false,
                    status: 429,
                    json: async () => ({
                        error: { message: "Rate limit reached. Please try again in 1h2m26s" },
                    }),
                };
            }
            throw new Error(`unexpected fetch ${target}`);
        };

        const options = await getSubtitleOptions({
            config: { sourceLang: "en", targetLang: "vi", translationProvider: "groq", groqApiKey: "gsk_test" },
            id: "tt999",
            type: "movie",
        });
        assert.ok(options.subtitles.length > 0, "expected at least one subtitle option");
        const generatedUrl = options.subtitles[0].url;
        const key = generatedUrl.match(/\/generated-subtitles\/(.+)\.vtt$/)[1];

        const subtitle = await getGeneratedSubtitleResponse(key);

        // Partial VTT must stay usable: source text is kept so subtitles still display,
        // instead of serving a blocking diagnostic notice that overlays the movie.
        assert.match(subtitle.vtt, /Hello world/);
        // No long-running diagnostic cue should be prepended (it would block the movie).
        assert.doesNotMatch(subtitle.vtt, /chưa dịch xong/);
        // Partial results are not cached as final.
        assert.equal(subtitle.cacheControl, "no-store");
        delete process.env.TRANSLATE_RETRY_DELAY_MS;
        delete process.env.TRANSLATE_RETRY_PASSES;
        delete process.env.BG_RETRY_DELAY_MS;
        delete process.env.BG_RETRY_PASSES;
    });

    it("completes translation in the background and caches the final VTT for the next request", async function () {
        this.timeout(30000);
        process.env.TRANSLATE_RETRY_DELAY_MS = "0";
        process.env.TRANSLATE_RETRY_PASSES = "1";
        // Background: wait 1.2s so the 1s circuit-breaker cooldown clears before retrying.
        process.env.BG_RETRY_DELAY_MS = "1200";
        process.env.BG_RETRY_PASSES = "5";

        // Groq: fail on first pass (all models 429 with 1s cooldown), succeed on background retry.
        const { breaker } = require("../lib/groq-translator");
        breaker.reset();
        let groqCallCount = 0;
        global.fetch = async (url) => {
            const target = String(url);
            if (target.includes("opensubtitles-v3.strem.io")) {
                return {
                    ok: true,
                    text: async () =>
                        JSON.stringify({
                            subtitles: [{ id: "42", lang: "eng", url: "https://example.com/sub.srt" }],
                        }),
                };
            }
            if (target.includes("example.com/sub.srt")) {
                return {
                    ok: true,
                    text: async () => "1\n00:00:01,000 --> 00:00:02,000\nHello world\n",
                };
            }
            if (target.includes("api.groq.com")) {
                groqCallCount += 1;
                // First 6 calls (one pass through all models): 429 with 1s cooldown.
                // After that: models succeed.
                if (groqCallCount <= 6) {
                    return {
                        ok: false,
                        status: 429,
                        json: async () => ({ error: { message: "Please try again in 1s" } }),
                    };
                }
                return {
                    ok: true,
                    json: async () => ({ choices: [{ message: { content: "1. Xin chào thế giới" } }] }),
                };
            }
            throw new Error(`unexpected fetch ${target}`);
        };

        const options = await getSubtitleOptions({
            config: { sourceLang: "en", targetLang: "vi", translationProvider: "groq", groqApiKey: "gsk_test" },
            id: "tt-bg-test",
            type: "movie",
        });
        const key = options.subtitles[0].url.match(/\/generated-subtitles\/(.+)\.vtt$/)[1];

        // First request: partial VTT (source fallback, no translation).
        const first = await getGeneratedSubtitleResponse(key);
        assert.match(first.vtt, /Hello world/);
        assert.equal(first.cacheControl, "no-store");

        // Wait for background completion to finish (poll cache).
        const cached = await waitForCache(key, 15000);
        assert.ok(cached, "background completion should have cached the final VTT");

        // Second request: complete cached VTT with Vietnamese translation.
        const second = await getGeneratedSubtitleResponse(key);
        assert.match(second.vtt, /Xin chào thế giới/);
        assert.equal(second.cacheControl, "public, max-age=86400");

        delete process.env.TRANSLATE_RETRY_DELAY_MS;
        delete process.env.TRANSLATE_RETRY_PASSES;
        delete process.env.BG_RETRY_DELAY_MS;
        delete process.env.BG_RETRY_PASSES;
        breaker.reset();
    });
});

function waitForCache(key, timeoutMs) {
    const { getCachedGeneratedSubtitle } = require("../lib/generated-subtitle-cache");
    const start = Date.now();
    return new Promise((resolve) => {
        const check = async () => {
            while (Date.now() - start < timeoutMs) {
                const cached = await getCachedGeneratedSubtitle(key);
                if (cached) {
                    resolve(true);
                    return;
                }
                await new Promise((r) => setTimeout(r, 200));
            }
            resolve(false);
        };
        check();
    });
}

function restoreEnv(name, value) {
    if (value === undefined) {
        delete process.env[name];
        return;
    }

    process.env[name] = value;
}

function clearJobsForTests() {
    const { clearJobs } = require("../subtitle-service");
    if (typeof clearJobs === "function") clearJobs();
}
