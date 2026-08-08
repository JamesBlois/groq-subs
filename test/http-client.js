const assert = require("assert");
const { fetchJson, fetchText } = require("../lib/http-client");

describe("http client", function () {
    const originalFetch = global.fetch;

    afterEach(function () {
        global.fetch = originalFetch;
    });

    it("keeps the status and url on a failed json request", async function () {
        global.fetch = async () => ({
            ok: false,
            status: 503,
            statusText: "Service Unavailable",
            async text() {
                return JSON.stringify({ message: "upstream down" });
            },
        });

        await assert.rejects(fetchJson("https://example.test/api"), (error) => {
            assert.equal(error.status, 503);
            assert.equal(error.url, "https://example.test/api");
            assert.match(error.message, /503 Service Unavailable/);
            assert.match(error.message, /upstream down/);
            return true;
        });
    });

    it("reports the body when a json endpoint answers with something else", async function () {
        global.fetch = async () => ({
            ok: true,
            status: 200,
            statusText: "OK",
            async text() {
                return "<html>maintenance</html>";
            },
        });

        await assert.rejects(fetchJson("https://example.test/api"), (error) => {
            assert.match(error.message, /Expected JSON/);
            assert.match(error.message, /maintenance/);
            assert.ok(error.cause instanceof Error);
            return true;
        });
    });

    it("keeps the status and url on a failed text request", async function () {
        global.fetch = async () => ({
            ok: false,
            status: 404,
            statusText: "Not Found",
        });

        await assert.rejects(fetchText("https://example.test/sub.srt"), (error) => {
            assert.equal(error.status, 404);
            assert.equal(error.url, "https://example.test/sub.srt");
            return true;
        });
    });
});
