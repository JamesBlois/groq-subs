const { normalizeStremioLanguage } = require("./languages");
const { DEFAULT_GROQ_MODEL } = require("./groq-translator");
const { decodeProviderKey } = require("./provider-key");

function getSubtitleConfig(config = {}) {
    const sourceLanguage = config.sourceLang || config.sourceLanguage || "en";
    const targetLanguage = config.targetLang || config.targetLanguage || "vi";
    const groqApiKey = config.groqApiKey;
    const groqModel = config.groqModel || DEFAULT_GROQ_MODEL;
    const translationProvider = config.translationProvider || "groq";
    return {
        groqApiKey,
        groqModel,
        sourceLanguage,
        targetLanguage,
        translationProvider,
        stremioSourceLanguage: normalizeStremioLanguage(sourceLanguage),
        stremioTargetLanguage: normalizeStremioLanguage(targetLanguage),
        groqSourceLanguage: sourceLanguage,
        groqTargetLanguage: targetLanguage,
    };
}

function parseConfigPrefix(parts) {
    // /configure/:sourceLang/:targetLang/groq/:groqModel/:groqApiKey
    if (parts[0] !== "configure" || !parts[1] || !parts[2]) return null;

    return {
        groqApiKey: parts[5] ? decodeProviderKey(parts[5]) : "",
        sourceLang: decodeURIComponent(parts[1]),
        targetLang: decodeURIComponent(parts[2]),
        translationProvider: "groq",
        groqModel: parts[4] ? decodeURIComponent(parts[4]) : DEFAULT_GROQ_MODEL,
    };
}

module.exports = {
    getSubtitleConfig,
    parseConfigPrefix,
};
