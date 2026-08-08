const { Buffer } = require("buffer");
const assert = require("assert");
const { getSubtitleConfig, parseConfigPrefix } = require("../lib/config");
const { DEFAULT_GROQ_MODEL } = require("../lib/groq-translator");

describe("config", function () {
    it("defaults to english source, vietnamese target and the default Groq model", function () {
        assert.deepEqual(getSubtitleConfig(), {
            groqApiKey: undefined,
            groqModel: DEFAULT_GROQ_MODEL,
            sourceLanguage: "en",
            targetLanguage: "vi",
            translationProvider: "groq",
            stremioSourceLanguage: "eng",
            stremioTargetLanguage: "vie",
            groqSourceLanguage: "en",
            groqTargetLanguage: "vi",
        });
    });

    it("accepts both short and long language property names", function () {
        assert.deepEqual(getSubtitleConfig({ sourceLang: "ko", targetLang: "pt-BR" }), {
            groqApiKey: undefined,
            groqModel: DEFAULT_GROQ_MODEL,
            sourceLanguage: "ko",
            targetLanguage: "pt-BR",
            translationProvider: "groq",
            stremioSourceLanguage: "kor",
            stremioTargetLanguage: "pob",
            groqSourceLanguage: "ko",
            groqTargetLanguage: "pt-BR",
        });

        const long = getSubtitleConfig({ sourceLanguage: "ja", targetLanguage: "de" });
        assert.equal(long.stremioSourceLanguage, "jpn");
        assert.equal(long.stremioTargetLanguage, "ger");
    });

    it("keeps the provided api key, model and provider", function () {
        const config = getSubtitleConfig({
            groqApiKey: "gsk_test",
            groqModel: "openai/gpt-oss-20b",
            translationProvider: "groq",
        });

        assert.equal(config.groqApiKey, "gsk_test");
        assert.equal(config.groqModel, "openai/gpt-oss-20b");
        assert.equal(config.translationProvider, "groq");
    });

    it("parses a configure path prefix with a base64url api key", function () {
        const key = Buffer.from("gsk_secret/value+here", "utf8").toString("base64url");

        assert.deepEqual(parseConfigPrefix(["configure", "en", "vi", "groq", "llama-3.1-8b-instant", key]), {
            groqApiKey: "gsk_secret/value+here",
            sourceLang: "en",
            targetLang: "vi",
            translationProvider: "groq",
            groqModel: "llama-3.1-8b-instant",
        });
    });

    it("url-decodes languages and falls back to the default model without an api key", function () {
        assert.deepEqual(parseConfigPrefix(["configure", "pt-BR", "zh", "groq"]), {
            groqApiKey: "",
            sourceLang: "pt-BR",
            targetLang: "zh",
            translationProvider: "groq",
            groqModel: DEFAULT_GROQ_MODEL,
        });

        assert.equal(parseConfigPrefix(["configure", "pt%2DBR", "vi"]).sourceLang, "pt-BR");
    });

    it("returns null for paths that are not a configure prefix", function () {
        assert.equal(parseConfigPrefix(["manifest.json"]), null);
        assert.equal(parseConfigPrefix(["configure"]), null);
        assert.equal(parseConfigPrefix(["configure", "en"]), null);
        assert.equal(parseConfigPrefix(["configure", "", "vi"]), null);
    });
});
