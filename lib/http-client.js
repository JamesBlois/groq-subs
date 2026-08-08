const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

function httpError(message, { status, url, cause } = {}) {
    const error = new Error(message, cause ? { cause } : undefined);
    if (status) error.status = status;
    if (url) error.url = url;
    return error;
}

async function fetchJson(url, options = {}) {
    const response = await fetchWithTimeout(url, options);
    const body = await response.text();
    let json = {};

    if (body) {
        try {
            json = JSON.parse(body);
        } catch (error) {
            throw httpError(`Expected JSON from ${url}, got: ${body.slice(0, 160)}`, {
                cause: error,
                status: response.status,
                url,
            });
        }
    }

    if (!response.ok) {
        // Keep the status on the error: callers (and logs) cannot tell a 404 from a 503 when
        // only the upstream message survives.
        throw httpError(
            `${response.status} ${response.statusText} from ${url}: ${json.message || json.error || "no message"}`,
            { status: response.status, url },
        );
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
        throw httpError(`${response.status} ${response.statusText} from ${url}`, {
            status: response.status,
            url,
        });
    }

    return response.text();
}

async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_REQUEST_TIMEOUT_MS);

    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
        // A bare AbortError says nothing about what timed out; name the url and the budget.
        if (error.name === "AbortError" && controller.signal.aborted) {
            throw httpError(`Request to ${url} timed out after ${DEFAULT_REQUEST_TIMEOUT_MS}ms`, {
                cause: error,
                url,
            });
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

module.exports = {
    fetchJson,
    fetchText,
    fetchWithTimeout,
};
