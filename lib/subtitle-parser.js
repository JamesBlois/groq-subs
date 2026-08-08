const { parseSync, stringifySync } = require("subtitle");

function parseSubtitleCues(text) {
    return parseSync(text)
        .filter((node) => node.type === "cue" && node.data && node.data.text)
        .map((node) => ({
            start: node.data.start,
            end: node.data.end,
            settings: node.data.settings,
            text: cleanCueText(node.data.text),
        }))
        .filter((cue) => cue.text);
}

function composeVtt(cues, translations) {
    const nodes = cues.map((cue, index) => {
        const translated = cueTextForDisplay(translations[index]);
        // NEVER fall back to the source-language text: a Vietnamese subtitle must not contain
        // untranslated English (the previous `translated || sourceText` leaked source lines
        // whenever a translation was missing, producing a half-English / half-Vietnamese file).
        // An empty translation yields a blank cue line rather than the wrong language.
        const text = escapeVttText(translated || "");

        return {
            type: "cue",
            data: {
                start: cue.start,
                end: cue.end,
                text,
                ...(cue.settings ? { settings: cue.settings } : {}),
            },
        };
    });

    return stringifySync(nodes, { format: "WebVTT" });
}

function cueTextForTranslation(cue) {
    // Flatten multi-line cue text into a single line so each cue maps to exactly one
    // translation line (1:1 alignment with its timestamp). The model is told to keep
    // multi-line content on a single output line; we restore a line break for display.
    return cleanCueText(cue.text.replace(/\n/g, " ")).trim();
}

function cueTextForDisplay(text) {
    return cleanCueText(text)
        .replace(/\s*\n+\s*/g, " ")
        .replace(/[ \t]+/g, " ")
        .trim();
}

function cleanCueText(text) {
    return String(text || "")
        .replace(/\{\\[^}]+}/g, "")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function escapeVttText(text) {
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

module.exports = {
    composeVtt,
    cueTextForTranslation,
    parseSubtitleCues,
};
