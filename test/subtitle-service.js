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
});

function restoreEnv(name, value) {
    if (value === undefined) {
        delete process.env[name];
        return;
    }

    process.env[name] = value;
}
