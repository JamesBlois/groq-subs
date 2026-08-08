const assert = require("assert");
const {
    baseUrlFromRequest,
    getDisplayBaseUrl,
    getListenHost,
    getPublicBaseUrl,
    getTrustProxySetting,
    withRequestBaseUrl,
} = require("../lib/public-url");

const ENV_KEYS = [
    "ADDON_BASE_URL",
    "PUBLIC_URL",
    "HOST_URL",
    "RENDER_EXTERNAL_URL",
    "VERCEL_URL",
    "HOST",
    "RAILWAY_ENVIRONMENT",
    "RAILWAY_PUBLIC_DOMAIN",
];

describe("public url", function () {
    let previousEnv;

    beforeEach(function () {
        previousEnv = {};
        for (const key of ENV_KEYS) {
            previousEnv[key] = process.env[key];
            delete process.env[key];
        }
    });

    afterEach(function () {
        for (const key of ENV_KEYS) {
            if (previousEnv[key] === undefined) {
                delete process.env[key];
                continue;
            }
            process.env[key] = previousEnv[key];
        }
    });

    it("prefers an explicitly configured url and strips trailing slashes", function () {
        process.env.ADDON_BASE_URL = "https://subs.example.com//";

        assert.equal(getPublicBaseUrl(), "https://subs.example.com");
        assert.equal(getDisplayBaseUrl(53100), "https://subs.example.com");
    });

    it("falls back through the platform url env vars in order", function () {
        process.env.VERCEL_URL = "https://vercel.example.com";
        assert.equal(getPublicBaseUrl(), "https://vercel.example.com");

        process.env.RENDER_EXTERNAL_URL = "https://render.example.com";
        assert.equal(getPublicBaseUrl(), "https://render.example.com");

        process.env.HOST_URL = "https://host.example.com";
        assert.equal(getPublicBaseUrl(), "https://host.example.com");

        process.env.PUBLIC_URL = "https://public.example.com";
        assert.equal(getPublicBaseUrl(), "https://public.example.com");
    });

    it("uses the current request base url when no env url is configured", function () {
        const detected = withRequestBaseUrl("https://detected.example.com", () => getPublicBaseUrl());

        assert.equal(detected, "https://detected.example.com");
    });

    it("prefers the configured url over the detected request url", function () {
        process.env.ADDON_BASE_URL = "https://configured.example.com";

        assert.equal(
            withRequestBaseUrl("https://detected.example.com", () => getPublicBaseUrl()),
            "https://configured.example.com",
        );
    });

    it("falls back to loopback outside of a request", function () {
        assert.equal(getPublicBaseUrl(), `http://127.0.0.1:${process.env.PORT || "53100"}`);
    });

    it("builds the base url from forwarded proxy headers", function () {
        const req = createRequest({
            "x-forwarded-proto": "https",
            "x-forwarded-host": "proxy.example.com, inner.example.com",
        });

        assert.equal(baseUrlFromRequest(req), "https://proxy.example.com");
    });

    it("falls back to the request protocol and host header", function () {
        const req = createRequest({ host: "direct.example.com" }, { protocol: "http" });

        assert.equal(baseUrlFromRequest(req), "http://direct.example.com");
    });

    it("defaults to https when the protocol is unknown", function () {
        assert.equal(baseUrlFromRequest(createRequest({ host: "nohost.example.com" })), "https://nohost.example.com");
    });

    it("uses req.hostname when no host header is present", function () {
        assert.equal(
            baseUrlFromRequest(createRequest({}, { hostname: "hostname.example.com" })),
            "https://hostname.example.com",
        );
    });

    it("returns null when the host cannot be determined", function () {
        assert.equal(baseUrlFromRequest(createRequest({})), null);
        assert.equal(baseUrlFromRequest({}), null);
    });

    it("listens on all interfaces unless HOST is set", function () {
        assert.equal(getListenHost(), "0.0.0.0");

        process.env.HOST = "127.0.0.1";
        assert.equal(getListenHost(), "127.0.0.1");
    });

    it("trusts a single proxy hop only on Railway", function () {
        assert.equal(getTrustProxySetting(), false);

        process.env.RAILWAY_PUBLIC_DOMAIN = "groq-subs.up.railway.app";
        assert.equal(getTrustProxySetting(), 1);

        delete process.env.RAILWAY_PUBLIC_DOMAIN;
        process.env.RAILWAY_ENVIRONMENT = "production";
        assert.equal(getTrustProxySetting(), 1);
    });
});

function createRequest(headers, extra = {}) {
    return {
        get: (name) => headers[name.toLowerCase()],
        ...extra,
    };
}
