const assert = require("assert");
const { searchPublicStremioOpenSubtitles } = require("../lib/stremio-subtitles");

describe("stremio opensubtitles lookup", function () {
    let previousConsoleLog;
    let previousFetch;
    let requestedUrl;

    beforeEach(function () {
        previousConsoleLog = console.log;
        previousFetch = global.fetch;
        console.log = () => {};
        requestedUrl = undefined;
    });

    afterEach(function () {
        console.log = previousConsoleLog;
        global.fetch = previousFetch;
    });

    it("builds the addon path from the type, id and extra arguments", async function () {
        stubSubtitles([{ id: "1", lang: "eng", url: "https://example.com/a.srt" }]);

        const subtitles = await searchPublicStremioOpenSubtitles({
            extra: { filename: "Show S01E01.mkv", videoSize: 123 },
            id: "tt0428167:1:1",
            type: "series",
        });

        assert.equal(
            requestedUrl,
            "https://opensubtitles-v3.strem.io/subtitles/series/tt0428167%3A1%3A1/filename=Show%20S01E01.mkv&videoSize=123.json",
        );
        assert.equal(subtitles.length, 1);
    });

    it("omits the extra segment when there is nothing to send", async function () {
        stubSubtitles([]);

        await searchPublicStremioOpenSubtitles({ id: "tt123", type: "movie" });

        assert.equal(requestedUrl, "https://opensubtitles-v3.strem.io/subtitles/movie/tt123.json");
    });

    it("drops the internal config and empty values from the extra segment", async function () {
        stubSubtitles([]);

        await searchPublicStremioOpenSubtitles({
            extra: { __config: { groqApiKey: "gsk_secret" }, empty: "", missing: undefined, nulled: null, ok: "1" },
            id: "tt123",
            type: "movie",
        });

        assert.equal(requestedUrl, "https://opensubtitles-v3.strem.io/subtitles/movie/tt123/ok=1.json");
    });

    it("keeps only subtitles that have a download url", async function () {
        stubSubtitles([
            { id: "1", lang: "eng", url: "https://example.com/a.srt" },
            { id: "2", lang: "eng" },
        ]);

        const subtitles = await searchPublicStremioOpenSubtitles({ id: "tt123", type: "movie" });

        assert.deepEqual(
            subtitles.map((subtitle) => subtitle.id),
            ["1"],
        );
    });

    it("returns an empty list when upstream sends no subtitles array", async function () {
        stubResponse({});

        assert.deepEqual(await searchPublicStremioOpenSubtitles({ id: "tt123", type: "movie" }), []);
    });

    function stubSubtitles(subtitles) {
        stubResponse({ subtitles });
    }

    function stubResponse(body) {
        global.fetch = async (url) => {
            requestedUrl = String(url);
            return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify(body) };
        };
    }
});
