const { Buffer } = require("buffer");
const assert = require("assert");
const {
    composeDiagnosticVtt,
    createDiagnosticSubtitleOption,
    parseDiagnosticSubtitlePayload,
} = require("../lib/diagnostic-subtitle");

describe("diagnostic subtitle", function () {
    let previousAddonBaseUrl;

    beforeEach(function () {
        previousAddonBaseUrl = process.env.ADDON_BASE_URL;
        process.env.ADDON_BASE_URL = "https://subs.example.com";
    });

    afterEach(function () {
        if (previousAddonBaseUrl === undefined) {
            delete process.env.ADDON_BASE_URL;
            return;
        }
        process.env.ADDON_BASE_URL = previousAddonBaseUrl;
    });

    it("builds a subtitle option carrying the diagnostic payload in its url", function () {
        const option = createDiagnosticSubtitleOption({
            code: "no-source-language-subtitles",
            config: { stremioTargetLanguage: "vie" },
            message: "Try another episode.",
            title: "No English subtitles found",
        });

        assert.equal(option.id, "double-subtitles-diagnostic-no-source-language-subtitles-to-vie");
        assert.equal(option.lang, "vie");
        assert.equal(option.name, "No English subtitles found");

        const encoded = option.url.match(/^https:\/\/subs\.example\.com\/diagnostic-subtitles\/(.+)\.vtt$/)[1];
        assert.deepEqual(parseDiagnosticSubtitlePayload(encoded), {
            message: "Try another episode.",
            title: "No English subtitles found",
        });
    });

    it("round-trips payloads through base64url so they survive url path encoding", function () {
        const option = createDiagnosticSubtitleOption({
            code: "translation-failed",
            config: { stremioTargetLanguage: "vie" },
            message: "Rate limit reached (429) + retry?",
            title: "Bản dịch chưa xong",
        });
        const encoded = option.url
            .split("/")
            .pop()
            .replace(/\.vtt$/, "");

        assert.doesNotMatch(encoded, /[+/=]/);
        assert.deepEqual(parseDiagnosticSubtitlePayload(encoded), {
            message: "Rate limit reached (429) + retry?",
            title: "Bản dịch chưa xong",
        });
    });

    it("collapses whitespace and truncates long fields", function () {
        const encoded = Buffer.from(
            JSON.stringify({ message: "b".repeat(600), title: "  spaced \n  title  " }),
            "utf8",
        ).toString("base64url");

        const payload = parseDiagnosticSubtitlePayload(encoded);

        assert.equal(payload.title, "spaced title");
        assert.equal(payload.message.length, 500);
        assert.ok(payload.message.endsWith("..."));
    });

    it("composes a ten hour cue with the title and message", function () {
        const vtt = composeDiagnosticVtt({ message: "Details: nothing", title: "Groq Subs" });

        assert.equal(vtt, "WEBVTT\n\n00:00:00.000 --> 10:00:00.000\nGroq Subs\nDetails: nothing\n");
    });

    it("escapes VTT-unsafe characters and omits empty lines", function () {
        const vtt = composeDiagnosticVtt({ message: "", title: "a & b <c>" });

        assert.equal(vtt, "WEBVTT\n\n00:00:00.000 --> 10:00:00.000\na &amp; b &lt;c&gt;\n");
    });
});
