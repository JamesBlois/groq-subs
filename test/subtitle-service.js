const assert = require("assert");
const { clearGeneratedSubtitleCacheForTests, setRedisClientForTests } = require("../lib/generated-subtitle-cache");
const { breaker } = require("../lib/groq-translator");
const { getGeneratedSubtitleResponse, getJobsStatus, getSubtitleOptions } = require("../subtitle-service");

describe("subtitle service", function () {
    let previousAddonBaseUrl;
    let previousConsoleError;
    let previousConsoleLog;
    let previousFetch;
    let previousLogLevel;

    beforeEach(function () {
        previousAddonBaseUrl = process.env.ADDON_BASE_URL;
        previousConsoleError = console.error;
        previousConsoleLog = console.log;
        previousFetch = global.fetch;
        previousLogLevel = process.env.LOG_LEVEL;
        process.env.ADDON_BASE_URL = "http://127.0.0.1:53100";
        process.env.LOG_LEVEL = "info";
        console.log = () => {};
        clearGeneratedSubtitleCacheForTests();
        setRedisClientForTests(null);
        // Earlier suites rate-limit every model; a cooling-down model is skipped, not called.
        breaker.reset();
    });

    afterEach(function () {
        console.error = previousConsoleError;
        console.log = previousConsoleLog;
        global.fetch = previousFetch;
        restoreEnv("ADDON_BASE_URL", previousAddonBaseUrl);
        restoreEnv("LOG_LEVEL", previousLogLevel);
        clearGeneratedSubtitleCacheForTests();
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
        this.timeout(20000);
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

        // Must NOT contain the untranslated English source text.
        assert.doesNotMatch(subtitle.vtt, /Hello world/);
        // Must contain a Vietnamese notice (not the English source).
        assert.match(subtitle.vtt, /chưa dịch xong|Groq Subs/i);
        // Partial results are not cached as final.
        assert.equal(subtitle.cacheControl, "no-store");
    });

    it("translates the source subtitle, then serves it from the cache", async function () {
        let groqCalls = 0;
        global.fetch = async (url) => {
            const target = String(url);
            if (target.includes("opensubtitles-v3.strem.io")) {
                return okJson({ subtitles: [{ id: "7", lang: "eng", url: "https://example.com/sub.srt" }] });
            }
            if (target.includes("example.com/sub.srt")) {
                return okText("1\n00:00:01,000 --> 00:00:02,000\nHello world\n");
            }
            if (target.includes("api.groq.com")) {
                groqCalls += 1;
                return okJson({ choices: [{ message: { content: "1. Xin chào thế giới" } }] });
            }
            throw new Error(`unexpected fetch ${target}`);
        };

        const options = await getSubtitleOptions({
            config: { groqApiKey: "gsk_test", sourceLang: "en", targetLang: "vi" },
            id: "tt7",
            type: "movie",
        });
        assert.equal(options.subtitles[0].id, "opensubtitles-v3-7-to-vie");
        const key = options.subtitles[0].url.match(/\/generated-subtitles\/(.+)\.vtt$/)[1];

        const built = await getGeneratedSubtitleResponse(key);
        assert.equal(built.diagnostic, false);
        assert.equal(built.cacheControl, "public, max-age=86400");
        assert.match(built.vtt, /Xin chào thế giới/);

        const cached = await getGeneratedSubtitleResponse(key);
        assert.deepEqual(cached, built);
        assert.equal(groqCalls, 1, "a cached subtitle must not be re-translated");
    });

    it("returns a diagnostic option when OpenSubtitles has no subtitles at all", async function () {
        global.fetch = async () => okJson({ subtitles: [] });

        const response = await getSubtitleOptions({
            config: { sourceLang: "en", targetLang: "vi" },
            id: "tt404",
            type: "movie",
        });

        assert.equal(response.subtitles.length, 1);
        assert.equal(response.subtitles[0].id, "double-subtitles-diagnostic-no-upstream-subtitles-to-vie");
    });

    it("returns a diagnostic option when the lookup itself fails", async function () {
        console.error = () => {};
        global.fetch = async () => {
            throw new Error("upstream down");
        };

        const response = await getSubtitleOptions({
            extra: { __config: { sourceLang: "en", targetLang: "vi" } },
            id: "tt500",
            type: "movie",
        });

        assert.equal(response.subtitles.length, 1);
        assert.equal(response.subtitles[0].id, "double-subtitles-diagnostic-lookup-failed-to-vie");
    });

    it("serves a diagnostic subtitle when the source subtitle has no cues", async function () {
        console.error = () => {};
        global.fetch = async (url) => {
            const target = String(url);
            if (target.includes("opensubtitles-v3.strem.io")) {
                return okJson({ subtitles: [{ id: "8", lang: "eng", url: "https://example.com/empty.srt" }] });
            }
            if (target.includes("example.com/empty.srt")) {
                return okText("");
            }
            throw new Error(`unexpected fetch ${target}`);
        };

        const options = await getSubtitleOptions({
            config: { groqApiKey: "gsk_test", sourceLang: "en", targetLang: "vi" },
            id: "tt8",
            type: "movie",
        });
        const key = options.subtitles[0].url.match(/\/generated-subtitles\/(.+)\.vtt$/)[1];

        const subtitle = await getGeneratedSubtitleResponse(key);

        assert.equal(subtitle.diagnostic, true);
        assert.equal(subtitle.cacheControl, "no-store");
        assert.match(subtitle.vtt, /Could not generate translated subtitles/);
    });

    it("reports queued jobs and their translation progress", async function () {
        global.fetch = async () => okJson({ subtitles: [{ id: "9", lang: "eng", url: "https://example.com/a.srt" }] });

        const options = await getSubtitleOptions({
            config: { groqApiKey: "gsk_test", groqModel: "openai/gpt-oss-20b", sourceLang: "en", targetLang: "vi" },
            id: "tt9",
            type: "movie",
        });
        const key = options.subtitles[0].url.match(/\/generated-subtitles\/(.+)\.vtt$/)[1];

        const status = getJobsStatus();
        const job = status.jobs.find((entry) => entry.key === key);

        assert.ok(status.activeJobCount >= 1);
        assert.equal(job.title, "OpenSubtitles v3 9");
        assert.equal(job.subtitleUrl, "https://example.com/a.srt");
        assert.equal(job.cueCount, 0);
        assert.equal(job.translatedCues, 0);
        assert.equal(job.complete, false);
        assert.equal(job.inFlight, false);
        assert.equal(job.config.groqModel, "openai/gpt-oss-20b");
    });
});

function okJson(body) {
    return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify(body), json: async () => body };
}

function okText(body) {
    return { ok: true, status: 200, statusText: "OK", text: async () => body };
}

function restoreEnv(name, value) {
    if (value === undefined) {
        delete process.env[name];
        return;
    }

    process.env[name] = value;
}
