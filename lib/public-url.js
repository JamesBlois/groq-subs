const { AsyncLocalStorage } = require("async_hooks");

const DEFAULT_PORT = process.env.PORT || "53100";
const requestBaseUrl = new AsyncLocalStorage();

function getPublicBaseUrl() {
    // 1. An explicitly configured URL wins (custom domain / known deploy URL).
    const envUrl =
        process.env.ADDON_BASE_URL ||
        process.env.PUBLIC_URL ||
        process.env.HOST_URL ||
        process.env.RENDER_EXTERNAL_URL ||
        process.env.VERCEL_URL;
    if (envUrl) {
        return stripTrailingSlash(envUrl);
    }
    // 2. Auto-detected from the current HTTP request (works on Render/Vercel/Railway
    //    without manually setting any env var, via x-forwarded-proto/host headers).
    const detected = requestBaseUrl.getStore();
    if (detected) {
        return detected;
    }
    // 3. Fallback for local/offline calls.
    return `http://127.0.0.1:${DEFAULT_PORT}`;
}

function withRequestBaseUrl(url, next) {
    return requestBaseUrl.run(url, next);
}

function baseUrlFromRequest(req) {
    const proto = (req.get && req.get("x-forwarded-proto")) || req.protocol || "https";
    const host = (req.get && (req.get("x-forwarded-host") || req.get("host"))) || req.hostname;
    if (!host) return null;
    return stripTrailingSlash(`${proto}://${host.split(",")[0].trim()}`);
}

function getListenHost() {
    return process.env.HOST || "0.0.0.0";
}

function getDisplayBaseUrl(_port) {
    return getPublicBaseUrl();
}

function getTrustProxySetting() {
    return process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PUBLIC_DOMAIN ? 1 : false;
}

function stripTrailingSlash(value) {
    return String(value).replace(/\/+$/, "");
}

module.exports = {
    baseUrlFromRequest,
    getDisplayBaseUrl,
    getListenHost,
    getPublicBaseUrl,
    getTrustProxySetting,
    withRequestBaseUrl,
};
