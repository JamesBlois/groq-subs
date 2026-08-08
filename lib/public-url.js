const DEFAULT_PORT = process.env.PORT || "53100";

function getPublicBaseUrl() {
    const envUrl =
        process.env.ADDON_BASE_URL || process.env.PUBLIC_URL || process.env.HOST_URL || process.env.RENDER_EXTERNAL_URL;
    if (envUrl) {
        return stripTrailingSlash(envUrl);
    }
    return `http://127.0.0.1:${DEFAULT_PORT}`;
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
    getDisplayBaseUrl,
    getListenHost,
    getPublicBaseUrl,
    getTrustProxySetting,
};
