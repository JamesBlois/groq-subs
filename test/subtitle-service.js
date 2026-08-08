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
    });

    afterEach(function () {
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

    it("returns only ONE Groq Sub subtitle option (no duplicate buttons)", async function () {
        global.fetch = async () => ({
            ok: true,
            text: async () =>
                JSON.stringify({
                    subtitles: [
                        { id: "1", lang: "eng", url: "https://example.com/a.vtt" },
                        { id: "2", lang: "eng", url: "https://example.com/b.vtt" },
                        { id: "3", lang: "eng", url: "https://example.com/c.vtt" },
                        { id: "4", lang: "eng", url: "https://example.com/d.vtt" },
                    ],
                }),
        });

        const response = await getSubtitleOptions({
            config: { sourceLang: "en", targetLang: "vi", translationProvider: "groq" },
            id: "tt456",
            type: "movie",
        });

        assert.equal(response.subtitles.length, 1, "exactly one Groq Sub option must be returned");
        assert.match(response.subtitles[0].id, /^opensubtitles-v3-/);
        assert.equal(response.subtitles[0].lang, "vie");
    });

    it("stores the movie id/type on the job and reports rich progress in getJobsStatus", async function () {
        const { getJobsStatus } = require("../subtitle-service");
        global.fetch = async () => ({
            ok: true,
            text: async () =>
                JSON.stringify({
                    subtitles: [{ id: "77", lang: "eng", url: "https://example.com/sub.vtt" }],
                }),
        });

        await getSubtitleOptions({
            config: { sourceLang: "en", targetLang: "vi", translationProvider: "groq", groqApiKey: "k" },
            id: "tt9999:2:3",
            type: "series",
        });

        const status = getJobsStatus();
        const job = status.jobs.find((j) => j.videoId === "tt9999:2:3");
        assert.ok(job, "job for the requested video must exist");
        assert.equal(job.videoType, "series");
        assert.equal(job.state, "queued");
        // sourceLanguage is normalized to the Stremio 3-letter code on the job; targetLanguage
        // is kept as configured. groqModel reflects the configured/selected model.
        assert.equal(job.config.sourceLanguage, "eng");
        assert.equal(job.config.targetLanguage, "vi");
        assert.equal(job.config.groqModel, "llama-3.3-70b-versatile");
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
});

function restoreEnv(name, value) {
    if (value === undefined) {
        delete process.env[name];
        return;
    }

    process.env[name] = value;
}
