const assert = require("assert");
const { fetchJson, fetchText, fetchWithTimeout } = require("../lib/http-client");

describe("http client", function () {
    let previousFetch;

    beforeEach(function () {
        previousFetch = global.fetch;
    });

    afterEach(function () {
        global.fetch = previousFetch;
    });

    it("returns the parsed json body", async function () {
        global.fetch = async () => createResponse({ body: JSON.stringify({ subtitles: [] }) });

        assert.deepEqual(await fetchJson("https://example.com/subtitles.json"), { subtitles: [] });
    });

    it("returns an empty object for an empty body", async function () {
        global.fetch = async () => createResponse({ body: "" });

        assert.deepEqual(await fetchJson("https://example.com/empty"), {});
    });

    it("forwards request options to fetch", async function () {
        let seen;
        global.fetch = async (url, options) => {
            seen = { url, options };
            return createResponse({ body: "{}" });
        };

        await fetchJson("https://api.groq.com/chat", { method: "POST", body: "{}" });

        assert.equal(seen.url, "https://api.groq.com/chat");
        assert.equal(seen.options.method, "POST");
        assert.ok(seen.options.signal, "expected an abort signal");
    });

    it("reports a truncated body when the response is not json", async function () {
        const body = `<html>${"x".repeat(400)}</html>`;
        global.fetch = async () => createResponse({ body });

        await assert.rejects(fetchJson("https://example.com/html"), (error) => {
            assert.match(error.message, /^Expected JSON from https:\/\/example\.com\/html, got: <html>/);
            assert.ok(error.message.length < 250, "expected the body to be truncated");
            assert.ok(error.cause instanceof Error);
            return true;
        });
    });

    it("prefers the json error message on failed responses", async function () {
        global.fetch = async () =>
            createResponse({ body: JSON.stringify({ message: "bad key" }), ok: false, status: 401 });

        await assert.rejects(fetchJson("https://example.com/x"), /bad key/);

        global.fetch = async () =>
            createResponse({ body: JSON.stringify({ error: "rate limited" }), ok: false, status: 429 });

        await assert.rejects(fetchJson("https://example.com/x"), /rate limited/);
    });

    it("falls back to the status line when the error body has no message", async function () {
        global.fetch = async () =>
            createResponse({ body: "{}", ok: false, status: 503, statusText: "Service Unavailable" });

        await assert.rejects(fetchJson("https://example.com/x"), /503 Service Unavailable/);
    });

    it("downloads subtitle text with an identifying user agent", async function () {
        let seen;
        global.fetch = async (url, options) => {
            seen = options;
            return createResponse({ body: "WEBVTT\n\n" });
        };

        assert.equal(await fetchText("https://example.com/sub.vtt"), "WEBVTT\n\n");
        assert.equal(seen.headers["User-Agent"], "stremio-addon-doublesubtitles");
    });

    it("throws the status line when a subtitle download fails", async function () {
        global.fetch = async () => createResponse({ body: "", ok: false, status: 404, statusText: "Not Found" });

        await assert.rejects(fetchText("https://example.com/missing.vtt"), /404 Not Found/);
    });

    it("clears the timeout once the request settles", async function () {
        global.fetch = async (url, options) => {
            assert.equal(options.signal.aborted, false);
            return createResponse({ body: "" });
        };

        const response = await fetchWithTimeout("https://example.com/ok");

        assert.equal(response.ok, true);
    });

    it("clears the timeout when the request rejects", async function () {
        global.fetch = async () => {
            throw new Error("network down");
        };

        await assert.rejects(fetchWithTimeout("https://example.com/boom"), /network down/);
    });
});

function createResponse({ body, ok = true, status = 200, statusText = "OK" }) {
    return {
        ok,
        status,
        statusText,
        text: async () => body,
    };
}
