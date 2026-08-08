const assert = require("assert");
const { LANGUAGES, normalizeStremioLanguage } = require("../lib/languages");

describe("languages", function () {
    it("maps every supported language code to its Stremio code", function () {
        for (const language of LANGUAGES) {
            assert.equal(normalizeStremioLanguage(language.code), language.stremio, language.code);
            assert.equal(normalizeStremioLanguage(language.stremio), language.stremio, language.stremio);
        }
    });

    it("normalizes casing and surrounding whitespace", function () {
        assert.equal(normalizeStremioLanguage("  PT-BR "), "pob");
        assert.equal(normalizeStremioLanguage("EN"), "eng");
    });

    it("resolves alternative ISO 639 codes to the Stremio variant", function () {
        assert.equal(normalizeStremioLanguage("deu"), "ger");
        assert.equal(normalizeStremioLanguage("fra"), "fre");
        assert.equal(normalizeStremioLanguage("nld"), "dut");
        assert.equal(normalizeStremioLanguage("gre"), "ell");
        assert.equal(normalizeStremioLanguage("ron"), "rum");
        assert.equal(normalizeStremioLanguage("zho"), "chi");
        assert.equal(normalizeStremioLanguage("pt-PT"), "por");
    });

    it("passes through unknown codes and empty values unchanged", function () {
        assert.equal(normalizeStremioLanguage("xyz"), "xyz");
        assert.equal(normalizeStremioLanguage(""), "");
        assert.equal(normalizeStremioLanguage(undefined), "");
        assert.equal(normalizeStremioLanguage(null), "");
    });
});
