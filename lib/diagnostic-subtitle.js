const { Buffer } = require("buffer");
const { getPublicBaseUrl } = require("./public-url");

const MAX_FIELD_LENGTH = 500;

function createDiagnosticSubtitleOption({ config, code, title, message }) {
    return {
        id: `double-subtitles-diagnostic-${code}-to-${config.stremioTargetLanguage}`,
        name: title,
        url: diagnosticSubtitleUrl({ title, message }),
        lang: config.stremioTargetLanguage,
    };
}

function diagnosticSubtitleUrl(payload) {
    const encodedPayload = Buffer.from(JSON.stringify(sanitizePayload(payload)), "utf8").toString("base64url");

    return `${getPublicBaseUrl()}/diagnostic-subtitles/${encodedPayload}.vtt`;
}

function parseDiagnosticSubtitlePayload(value) {
    return sanitizePayload(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
}

function composeDiagnosticVtt(payload) {
    const sanitized = sanitizePayload(payload);
    const lines = [sanitized.title, sanitized.message].filter(Boolean);

    return `WEBVTT\n\n00:00:00.000 --> 10:00:00.000\n${lines.map(escapeVttText).join("\n")}\n`;
}

function sanitizePayload(payload) {
    return {
        title: truncateField(payload.title),
        message: truncateField(payload.message),
    };
}

function truncateField(value) {
    const text = String(value).replace(/\s+/g, " ").trim();
    if (text.length <= MAX_FIELD_LENGTH) return text;

    return `${text.slice(0, MAX_FIELD_LENGTH - 3)}...`;
}

function escapeVttText(text) {
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

module.exports = {
    composeDiagnosticVtt,
    createDiagnosticSubtitleOption,
    parseDiagnosticSubtitlePayload,
};
