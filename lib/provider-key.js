const { Buffer } = require("buffer");

// API keys travel through URL path segments / query strings base64url-encoded, so they must be
// converted back to standard base64 before decoding.
function decodeProviderKey(value) {
    return Buffer.from(String(value).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

// Groq key from the request (encoded) with the env key as fallback.
function groqApiKeyFromQuery(encodedKey) {
    return encodedKey ? decodeProviderKey(encodedKey) : process.env.GROQ_API_KEY;
}

module.exports = {
    decodeProviderKey,
    groqApiKeyFromQuery,
};
