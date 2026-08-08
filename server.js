#!/usr/bin/env node

const crypto = require("crypto");
const path = require("path");
const express = require("express");
const { getRouter } = require("stremio-addon-sdk");
const addonInterface = require("./addon");
const { createAddonInterface } = require("./addon");
const { composeDiagnosticVtt, parseDiagnosticSubtitlePayload } = require("./lib/diagnostic-subtitle");
const logger = require("./lib/logger");
const { contentType, recordHttpRequest, renderMetrics } = require("./lib/metrics");
const {
    getDisplayBaseUrl,
    getListenHost,
    getTrustProxySetting,
    baseUrlFromRequest,
    withRequestBaseUrl,
} = require("./lib/public-url");
const { decodeProviderKey, groqApiKeyFromQuery } = require("./lib/provider-key");
const { createRateLimiters } = require("./lib/rate-limit");
const { CONFIGURED_SUBTITLES_PATTERN } = require("./lib/route-paths");
const { elapsedSeconds, startTimer } = require("./lib/timing");
const { createTtlCache } = require("./lib/ttl-cache");
const { renderConfigPage } = require("./lib/web-page");
const { getGeneratedSubtitleResponse, getJobsStatus } = require("./subtitle-service");
const { getGeneratedSubtitleCacheStats } = require("./lib/generated-subtitle-cache");
const { testGroqApiKey, DEFAULT_GROQ_MODEL, breaker, getProviders, probeModel } = require("./lib/groq-translator");

const DEFAULT_CONFIGURED_ROUTER_CACHE_MAX = 100;
const DEFAULT_CONFIGURED_ROUTER_CACHE_TTL_SECONDS = 6 * 60 * 60;
const CONFIGURED_ROUTER_CACHE_MAX = DEFAULT_CONFIGURED_ROUTER_CACHE_MAX;
const CONFIGURED_ROUTER_CACHE_TTL_SECONDS = DEFAULT_CONFIGURED_ROUTER_CACHE_TTL_SECONDS;

function createApp() {
    const app = express();
    app.set("trust proxy", getTrustProxySetting());

    const imgDir = path.join(__dirname, "img");
    const publicDir = path.join(__dirname, "assets");
    const webDir = path.join(__dirname, "web");
    const configuredRouters = createTtlCache({
        max: CONFIGURED_ROUTER_CACHE_MAX,
        ttlSeconds: CONFIGURED_ROUTER_CACHE_TTL_SECONDS,
    });

    const rateLimiters = createRateLimiters();

    // Bind the request's public base URL into the async context so subtitle URLs
    // are generated with the correct host (auto-detected from x-forwarded-* headers)
    // even when no PUBLIC_URL env var is set.
    app.use((req, res, next) => {
        const detected = baseUrlFromRequest(req);
        if (detected) {
            return withRequestBaseUrl(detected, next);
        }
        next();
    });

    app.use(logRequest);
    app.use((req, res, next) => {
        res.set("Access-Control-Allow-Origin", "*");
        res.set("Access-Control-Allow-Headers", "*");
        res.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");

        if (req.method === "OPTIONS") {
            res.sendStatus(204);
            return;
        }

        next();
    });
    app.use(rateLimiters.general);
    app.use(rateLimiters.subtitleWork);

    app.use("/public", express.static(publicDir));
    app.use("/assets", express.static(webDir));
    app.use("/img", express.static(imgDir));

    app.get("/", (req, res) => {
        res.type("html").send(renderConfigPage(addonInterface.manifest));
    });

    app.get("/test-groq", async (req, res, next) => {
        try {
            const result = await testGroqApiKey({
                groqApiKey: groqApiKeyFromQuery(req.query.apiKey),
                groqModel: req.query.model,
            });
            res.status(result.ok ? 200 : result.status || 400).json(result);
        } catch (error) {
            next(error);
        }
    });

    // Short-lived cache so rapid repeated "Check models quota" clicks don't re-probe
    // every model (probing is slow, especially for NVIDIA models).
    let modelsStatusCache = null; // { at, payload }

    app.get("/models-status", async (req, res, next) => {
        try {
            // Serve a cached result if it is fresh (<= 30s) — probing 10+ models across
            // providers is slow, and quota state does not change in seconds.
            const MODELS_STATUS_CACHE_MS = 30_000;
            const now = Date.now();
            if (modelsStatusCache && now - modelsStatusCache.at < MODELS_STATUS_CACHE_MS) {
                res.json(modelsStatusCache.payload);
                return;
            }

            // Groq key may come from the query (encoded) or env; the generic LLM provider key
            // is always taken from env (not exposed in the URL).
            const providers = getProviders({ groqApiKey: groqApiKeyFromQuery(req.query.apiKey) });
            if (providers.length === 0 || !providers.some((p) => p.apiKey)) {
                res.status(401).json({ error: "Missing API key (set GROQ_API_KEY or LLM_API_KEY)" });
                return;
            }

            // Probe all models in parallel; allSettled + per-probe timeout means one slow
            // model cannot block the rest.
            const tasks = [];
            for (const provider of providers) {
                if (!provider.apiKey) continue;
                for (const model of provider.models) {
                    tasks.push(probeModel(provider, model));
                }
            }
            const settled = await Promise.allSettled(tasks);
            const probes = settled.map((s) =>
                s.status === "fulfilled"
                    ? s.value
                    : {
                          provider: "?",
                          model: "?",
                          state: "error",
                          circuitOpen: false,
                          message: s.reason?.message,
                          status: 0,
                      },
            );

            const available = probes
                .filter((p) => p.state === "available")
                .map((p) => ({ provider: p.provider, model: p.model }));
            const payload = {
                available,
                recommendation: available[0] || null,
                models: probes,
                cached: false,
            };
            modelsStatusCache = { at: now, payload: { ...payload, cached: true } };
            res.json(payload);
        } catch (error) {
            next(error);
        }
    });

    app.get("/status", async (req, res, next) => {
        try {
            const jobStats = getJobsStatus();
            const cacheStats = getGeneratedSubtitleCacheStats();
            const providers = getProviders({}).map((p) => ({
                id: p.id,
                baseUrl: p.baseUrl,
                apiKeyConfigured: Boolean(p.apiKey),
                models: p.models.map((model) => ({
                    model,
                    circuitOpen: breaker.isOpen(`${p.id}:${model}`),
                })),
            }));
            res.json({
                addon: addonInterface.manifest.name,
                groqApiKeyConfigured: Boolean(process.env.GROQ_API_KEY),
                llmProviderConfigured: Boolean(process.env.LLM_BASE_URL && process.env.LLM_API_KEY),
                defaultModel: process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL,
                providers,
                cache: cacheStats,
                jobs: jobStats,
            });
        } catch (error) {
            next(error);
        }
    });

    app.get("/configure", (req, res) => {
        res.redirect("/");
    });

    app.get("/configure/:sourceLang/:targetLang/configure", (req, res) => {
        res.redirect("/");
    });

    app.get("/configure/:sourceLang/:targetLang/groq/:groqModel/:groqApiKey/configure", (req, res) => {
        res.redirect("/");
    });

    app.get("/metrics", async (req, res, next) => {
        if (!isMetricsRequestAllowed(req)) {
            res.status(403).json({ error: "Forbidden" });
            return;
        }

        if (!isMetricsRequestAuthorized(req)) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }

        try {
            res.type(contentType).send(await renderMetrics());
        } catch (error) {
            next(error);
        }
    });

    app.get("/generated-subtitles/:key.vtt", async (req, res, next) => {
        try {
            const subtitle = await getGeneratedSubtitleResponse(req.params.key);
            res.type("text/vtt").set("Cache-Control", subtitle.cacheControl).send(subtitle.vtt);
        } catch (error) {
            next(error);
        }
    });

    app.get("/diagnostic-subtitles/:payload.vtt", (req, res, next) => {
        try {
            const payload = parseDiagnosticSubtitlePayload(req.params.payload);
            res.type("text/vtt").set("Cache-Control", "no-store").send(composeDiagnosticVtt(payload));
        } catch (error) {
            next(error);
        }
    });

    app.use("/configure/:sourceLang/:targetLang/groq/:groqModel/:groqApiKey", (req, res, next) => {
        getConfiguredRouter(configuredRouters, {
            groqApiKey: decodeProviderKey(req.params.groqApiKey),
            sourceLang: req.params.sourceLang,
            targetLang: req.params.targetLang,
            translationProvider: "groq",
            groqModel: decodeURIComponent(req.params.groqModel),
        })(req, res, next);
    });

    app.use("/configure/:sourceLang/:targetLang", (req, res, next) => {
        getConfiguredRouter(configuredRouters, {
            sourceLang: req.params.sourceLang,
            targetLang: req.params.targetLang,
            translationProvider: "groq",
        })(req, res, next);
    });

    app.use(getRouter(addonInterface));

    app.use((error, req, res, next) => {
        if (res.headersSent) {
            next(error);
            return;
        }

        logger.error("request failed", {
            error,
            method: req.method,
            path: req.path,
            statusCode: error.statusCode || 500,
        });
        res.status(error.statusCode || 500).json({ error: error.message || "Server error" });
    });

    return app;
}

function getConfiguredRouter(configuredRouters, config) {
    const key = routerCacheKey(config);
    const cached = configuredRouters.get(key);
    if (cached) return cached;

    const router = getRouter(createAddonInterface(config));
    configuredRouters.set(key, router);
    return router;
}

function routerCacheKey(config) {
    return crypto.createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

function logRequest(req, res, next) {
    const startedAt = startTimer();

    res.on("finish", () => {
        const durationSeconds = elapsedSeconds(startedAt);
        const route = routeLabel(req);
        recordHttpRequest({
            durationSeconds,
            method: req.method,
            route,
            status: res.statusCode,
        });
        logger.info("http request", {
            durationMs: durationSeconds * 1000,
            method: req.method,
            path: req.path,
            statusCode: res.statusCode,
        });
    });

    next();
}

function routeLabel(req) {
    if (req.path === "/") return "/";
    if (req.path === "/metrics") return "/metrics";
    if (req.path.startsWith("/assets/")) return "/assets/*";
    if (req.path.startsWith("/img/")) return "/img/*";
    if (req.path.startsWith("/public/")) return "/public/*";
    if (req.path.startsWith("/generated-subtitles/")) return "/generated-subtitles/:key.vtt";
    if (req.path.startsWith("/diagnostic-subtitles/")) return "/diagnostic-subtitles/:payload.vtt";
    if (CONFIGURED_SUBTITLES_PATTERN.test(req.path)) {
        return "/configure/:sourceLang/:targetLang/subtitles/*";
    }
    if (/^\/configure\/[^/]+\/[^/]+/.test(req.path)) return "/configure/:sourceLang/:targetLang/*";
    if (req.path.startsWith("/subtitles/")) return "/subtitles/*";
    return "other";
}

function isMetricsRequestAuthorized(req) {
    const token = process.env.METRICS_TOKEN;
    if (!token) return true;
    return req.get("authorization") === `Bearer ${token}`;
}

function isMetricsRequestAllowed(req) {
    return clientAddresses(req).some(isPrivateAddress);
}

function clientAddresses(req) {
    const forwardedFor = String(req.get("x-forwarded-for") || "")
        .split(",")
        .map((address) => address.trim())
        .filter(Boolean);

    if (forwardedFor.length) return forwardedFor;

    return [req.get("x-real-ip"), req.ip, req.socket && req.socket.remoteAddress].filter(Boolean);
}

function isPrivateAddress(address) {
    const ip = String(address)
        .replace(/^::ffff:/, "")
        .toLowerCase();

    return (
        ip === "127.0.0.1" ||
        ip === "::1" ||
        ip.startsWith("10.") ||
        ip.startsWith("192.168.") ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip) ||
        ip.startsWith("fc") ||
        ip.startsWith("fd")
    );
}

if (require.main === module) {
    const app = createApp();
    const port = Number(process.env.PORT || 53100);
    const host = getListenHost();
    const server = app.listen(port, host, () => {
        const baseUrl = getDisplayBaseUrl(server.address().port);
        logger.info("server started", {
            host,
            baseUrl: baseUrl,
            port: server.address().port,
        });
    });
}

module.exports = {
    createApp,
    decodeProviderKey,
    isPrivateAddress,
};
