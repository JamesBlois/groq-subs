// Shared text escaping helpers for the formats this addon emits (WebVTT cues and the
// configuration HTML page).

function escapeVttText(text) {
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtml(value) {
    return escapeVttText(value).replace(/"/g, "&quot;");
}

module.exports = {
    escapeHtml,
    escapeVttText,
};
