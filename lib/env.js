// Shared environment-variable readers. Centralised so every module resolves env config the
// same way (trimmed strings, positive-number validation) instead of re-implementing it.

function envString(name) {
    return (process.env[name] || "").trim();
}

// Comma-separated list, e.g. LLM_MODELS="a, b,c".
function envList(name) {
    const raw = envString(name);
    if (!raw) return [];
    return raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
}

function envPositiveNumber(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function envPositiveInteger(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isInteger(value) && value > 0 ? value : fallback;
}

module.exports = {
    envList,
    envPositiveInteger,
    envPositiveNumber,
    envString,
};
