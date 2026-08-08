const assert = require("assert");
const { composeVtt, cueTextForTranslation, parseSubtitleCues } = require("../lib/subtitle-parser");

const SRT = [
    "1",
    "00:00:01,000 --> 00:00:02,000",
    "<i>Hello</i>  world",
    "",
    "2",
    "00:00:03,000 --> 00:00:04,000",
    "{\\an8}On-screen&nbsp;text",
    "",
    "3",
    "00:00:05,000 --> 00:00:06,000",
    "<i></i>",
    "",
].join("\n");

describe("subtitle parser", function () {
    it("parses cues, strips markup and drops cues without text", function () {
        const cues = parseSubtitleCues(SRT);

        assert.deepEqual(cues, [
            { start: 1000, end: 2000, settings: undefined, text: "Hello world" },
            { start: 3000, end: 4000, settings: undefined, text: "On-screen text" },
        ]);
    });

    it("keeps cue settings from WebVTT input", function () {
        const cues = parseSubtitleCues("WEBVTT\n\n00:00:01.000 --> 00:00:02.000 line:90% align:middle\nPositioned\n");

        assert.equal(cues.length, 1);
        assert.equal(cues[0].settings, "line:90% align:middle");
    });

    it("flattens multi-line cue text into a single translation line", function () {
        assert.equal(cueTextForTranslation({ text: "first line\nsecond line" }), "first line second line");
        assert.equal(cueTextForTranslation({ text: "<b>bold</b>\n{\\an8}tag" }), "bold tag");
        assert.equal(cueTextForTranslation({ text: "   \n  " }), "");
    });

    it("composes a WebVTT file from cues and their translations", function () {
        const cues = [
            { start: 1000, end: 2000, text: "Hello world" },
            { start: 3000, end: 4000, text: "Second cue" },
        ];

        const vtt = composeVtt(cues, ["Xin chào thế giới", "Câu thứ hai"]);

        assert.match(vtt, /^WEBVTT/);
        assert.match(vtt, /00:00:01\.000 --> 00:00:02\.000\nXin chào thế giới/);
        assert.match(vtt, /00:00:03\.000 --> 00:00:04\.000\nCâu thứ hai/);
    });

    it("falls back to the source text when a translation is missing", function () {
        const vtt = composeVtt([{ start: 0, end: 1000, text: "Only source" }], []);

        assert.match(vtt, /Only source/);
    });

    it("collapses newlines, strips markup and escapes VTT-unsafe characters", function () {
        const vtt = composeVtt([{ start: 0, end: 1000, text: "source" }], ["a &\n b > c <i>d</i>"]);

        assert.match(vtt, /a &amp; b &gt; c d/);
    });

    it("preserves cue settings when composing", function () {
        const vtt = composeVtt([{ start: 0, end: 1000, text: "source", settings: "align:middle" }], ["dịch"]);

        assert.match(vtt, /00:00:00\.000 --> 00:00:01\.000 align:middle/);
    });
});
