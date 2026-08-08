const assert = require("assert");
const { Buffer } = require("buffer");
const { once } = require("events");
const { breaker } = require("../lib/groq-translator");
const { createApp, decodeProviderKey, isPrivateAddress } = require("../server");
const { getJson, getResponse } = require("./helpers/http");

describe("server", function () {
    let baseUrl;
    let previousConsoleError;
    let previousConsoleLog;
    let previousFetch;
    let previousGroqApiKey;
    let server;

    before(async function () {
        server = createApp().listen(0, "127.0.0.1");
        await once(server, "listening");
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    after(async function () {
        if (server) {
            server.close();
            await once(server, "close");
        }
    });

    beforeEach(function () {
        previousConsoleError = console.error;
        previousConsoleLog = console.log;
        previousFetch = global.fetch;
        previousGroqApiKey = process.env.GROQ_API_KEY;
        console.log = () => {};
        // Earlier suites rate-limit every model; a cooling-down model is reported, not probed.
        breaker.reset();
    });

    afterEach(function () {
        console.error = previousConsoleError;
        console.log = previousConsoleLog;
        global.fetch = previousFetch;
        if (previousGroqApiKey === undefined) {
            delete process.env.GROQ_API_KEY;
        } else {
            process.env.GROQ_API_KEY = previousGroqApiKey;
        }
    });

    it("answers CORS preflight requests without hitting a route", async function () {
        const response = await getResponse(`${baseUrl}/manifest.json`, { method: "OPTIONS" });

        assert.equal(response.statusCode, 204);
        assert.equal(response.headers["access-control-allow-origin"], "*");
        assert.equal(response.headers["access-control-allow-methods"], "GET, HEAD, OPTIONS");
    });

    it("serves the configuration page", async function () {
        const response = await getResponse(`${baseUrl}/`);

        assert.equal(response.statusCode, 200);
        assert.match(response.headers["content-type"], /text\/html/);
        assert.match(response.body, /<option value="vi" selected>/);
    });

    it("redirects every configure page back to the root form", async function () {
        for (const path of [
            "/configure",
            "/configure/en/vi/configure",
            `/configure/en/vi/groq/llama-3.1-8b-instant/${encodeKey("gsk_test")}/configure`,
        ]) {
            const response = await getResponse(`${baseUrl}${path}`);

            assert.equal(response.statusCode, 302, path);
            assert.equal(response.headers.location, "/", path);
        }
    });

    it("renders a diagnostic subtitle from its url payload", async function () {
        const payload = Buffer.from(JSON.stringify({ message: "Nothing to do", title: "Groq Subs" })).toString(
            "base64url",
        );

        const response = await getResponse(`${baseUrl}/diagnostic-subtitles/${payload}.vtt`);

        assert.equal(response.statusCode, 200);
        assert.match(response.headers["content-type"], /text\/vtt/);
        assert.equal(response.headers["cache-control"], "no-store");
        assert.match(response.body, /^WEBVTT\n\n00:00:00\.000 --> 10:00:00\.000\nGroq Subs\nNothing to do\n$/);
    });

    it("reports a broken diagnostic payload through the error handler", async function () {
        console.error = () => {};

        const response = await getResponse(`${baseUrl}/diagnostic-subtitles/not-base64-json.vtt`);

        assert.equal(response.statusCode, 500);
        assert.ok(JSON.parse(response.body).error);
    });

    it("serves an expiry notice for an unknown generated subtitle", async function () {
        const response = await getResponse(`${baseUrl}/generated-subtitles/deadbeef.vtt`);

        assert.equal(response.statusCode, 200);
        assert.equal(response.headers["cache-control"], "no-store");
        assert.match(response.body, /Generated subtitle expired or was not found/);
    });

    it("rejects a missing Groq api key on the key test endpoint", async function () {
        delete process.env.GROQ_API_KEY;

        const response = await getResponse(`${baseUrl}/test-groq`);

        assert.equal(response.statusCode, 401);
        assert.deepEqual(JSON.parse(response.body), {
            ok: false,
            status: 401,
            message: "Missing Groq API key",
        });
    });

    it("accepts a base64url api key on the key test endpoint", async function () {
        global.fetch = async (url, options) => {
            assert.equal(JSON.parse(options.body).model, "llama-3.1-8b-instant");
            assert.equal(options.headers.Authorization, "Bearer gsk_test/key");
            return {
                ok: true,
                status: 200,
                statusText: "OK",
                json: async () => ({ choices: [{ message: { content: "ok" } }] }),
            };
        };

        const result = await getJson(
            `${baseUrl}/test-groq?apiKey=${encodeKey("gsk_test/key")}&model=llama-3.1-8b-instant`,
        );

        assert.equal(result.ok, true);
        assert.equal(result.model, "llama-3.1-8b-instant");
        assert.equal(result.preview, "ok");
    });

    it("requires an api key before probing model status", async function () {
        delete process.env.GROQ_API_KEY;

        const response = await getResponse(`${baseUrl}/models-status`);

        assert.equal(response.statusCode, 401);
        assert.match(JSON.parse(response.body).error, /Missing API key/);
    });

    it("probes every model, then serves the cached probe result", async function () {
        this.timeout(10000);
        let probes = 0;
        global.fetch = async () => {
            probes += 1;
            return {
                ok: true,
                status: 200,
                statusText: "OK",
                body: null,
                json: async () => ({ choices: [{ message: { content: "ok" } }] }),
            };
        };

        const status = await getJson(`${baseUrl}/models-status?apiKey=${encodeKey("gsk_test")}`);

        assert.equal(status.cached, false);
        assert.equal(status.models.length, probes);
        assert.ok(status.models.every((model) => model.state === "available"));
        assert.deepEqual(status.recommendation, { provider: "groq", model: status.models[0].model });

        const cached = await getJson(`${baseUrl}/models-status?apiKey=${encodeKey("gsk_test")}`);
        assert.equal(cached.cached, true);
        assert.equal(probes, status.models.length, "a cached response must not re-probe");
    });

    it("decodes base64url provider keys", function () {
        assert.equal(decodeProviderKey(encodeKey("gsk_a+b/c")), "gsk_a+b/c");
        assert.equal(decodeProviderKey(""), "");
    });

    it("recognises loopback and private addresses", function () {
        for (const address of [
            "127.0.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "10.1.2.3",
            "192.168.1.9",
            "172.16.0.1",
            "172.31.255.255",
            "fd00::1",
            "fc00::1",
        ]) {
            assert.equal(isPrivateAddress(address), true, address);
        }

        for (const address of ["8.8.8.8", "172.32.0.1", "172.15.0.1", "2001:db8::1", ""]) {
            assert.equal(isPrivateAddress(address), false, address);
        }
    });
});

function encodeKey(value) {
    return Buffer.from(value, "utf8").toString("base64url");
}
