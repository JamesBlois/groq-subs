const assert = require("assert");
const { readWebAsset, renderConfigPage } = require("../lib/web-page");
const { LANGUAGES } = require("../lib/languages");
const { DEFAULT_GROQ_MODEL, GROQ_MODELS } = require("../lib/groq-translator");

describe("web page", function () {
    it("renders every language and Groq model option with the defaults selected", function () {
        const html = renderConfigPage();

        assert.doesNotMatch(html, /{{[a-zA-Z]+}}/);
        for (const { code, label } of LANGUAGES) {
            const selected = code === "en" || code === "vi" ? " selected" : "";
            assert.ok(html.includes(`<option value="${code}"${selected}>${label}</option>`), code);
        }
        for (const model of GROQ_MODELS) {
            const selected = model === DEFAULT_GROQ_MODEL ? " selected" : "";
            assert.ok(html.includes(`<option value="${model}"${selected}>${model}</option>`), model);
        }
    });

    it("selects the source default once and the target default once", function () {
        const html = renderConfigPage();

        assert.equal(html.match(/<option value="en" selected>/g).length, 1);
        assert.equal(html.match(/<option value="vi" selected>/g).length, 1);
    });

    it("reads assets from the web directory", function () {
        assert.match(readWebAsset("config.js"), /\S/);
        assert.equal(readWebAsset("../../web/config.js"), readWebAsset("config.js"));
    });

    it("does not read files outside the web directory", function () {
        assert.throws(() => readWebAsset("../server.js"), /ENOENT/);
    });
});
