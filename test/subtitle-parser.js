const assert = require("assert");
const { composeVtt } = require("../lib/subtitle-parser");

describe("subtitle parser / composer", function () {
    it("composeVtt never leaks the source-language text when a translation is missing", function () {
        // A translated subtitle must NEVER contain untranslated source lines (the previous
        // `translated || sourceText` fallback produced half-English / half-Vietnamese files).
        const cues = [
            { start: 0, end: 1, text: "Hello world" },
            { start: 1, end: 2, text: "Goodbye" },
        ];
        // translations[1] is missing -> must NOT fall back to "Goodbye".
        const vtt = composeVtt(cues, ["Xin chào", ""]);
        assert.match(vtt, /Xin chào/);
        assert.doesNotMatch(vtt, /Hello world|Goodbye/);
    });

    it("composeVtt renders all cues when every translation is present", function () {
        const cues = [
            { start: 0, end: 1, text: "Hello" },
            { start: 1, end: 2, text: "World" },
        ];
        const vtt = composeVtt(cues, ["Xin chào", "Thế giới"]);
        assert.match(vtt, /Xin chào/);
        assert.match(vtt, /Thế giới/);
    });
});
