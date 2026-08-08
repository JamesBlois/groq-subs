const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

async function fetchJson(url, options = {}) {
    const response = await fetchWithTimeout(url, options);
    const body = await response.text();
    let json = {};

    if (body) {
        try {
            json = JSON.parse(body);
        } catch (error) {
            throw new Error(`Expected JSON from ${url}, got: ${body.slice(0, 160)}`, {
                cause: error,
            });
        }
    }

    if (!response.ok) {
        throw new Error(json.message || json.error || `${response.status} ${response.statusText}`);
    }

    return json;
}

async function fetchText(url) {
    const response = await fetchWithTimeout(url, {
        headers: {
            "User-Agent": "stremio-addon-doublesubtitles",
        },
    });

    if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
    }

    return response.text();
}

async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_REQUEST_TIMEOUT_MS);

    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
}

module.exports = {
    fetchJson,
    fetchText,
    fetchWithTimeout,
};
