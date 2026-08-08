#!/usr/bin/env node

const { Buffer } = require("buffer");
const crypto = require("crypto");
const path = require("path");
const express = require("express");
const { LRUCache } = require("lru-cache");
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
const { createRateLimiters } = require("./lib/rate-limit");
const { renderConfigPage } = require("./lib/web-page");
const { getGeneratedSubtitleResponse, getJobsStatus } = require("./subtitle-service");
const { getGeneratedSubtitleCacheStats } = require("./lib/generated-subtitle-cache");
const { testGroqApiKey, DEFAULT_GROQ_MODEL, breaker, getProviders } = require("./lib/groq-translator");

const DEFAULT_CONFIGURED_ROUTER_CACHE_MAX = 100;
const DEFAULT_CONFIGURED_ROUTER_CACHE_TTL_SECONDS = 6 * 60 * 60;
const CONFIGURED_ROUTER_CACHE_MAX = DEFAULT_CONFIGURED_ROUTER_CACHE_MAX;
const CONFIGURED_ROUTER_CACHE_TTL_SECONDS = DEFAULT_CONFIGURED_ROUTER_CACHE_TTL_SECONDS;
const MODELS_STATUS_CACHE_MS = 30_000;
const MAX_PROVIDER_KEY_LENGTH = 512;
const ADMIN_PATHS = new Set(["/metrics", "/status"]);

function createApp() {
    const app = express();
    app.set("trust proxy", getTrustProxySetting());

    const imgDir = path.join(__dirname, "img");
    const publicDir = path.join(__dirname, "assets");
    const webDir = path.join(__dirname, "web");
    const configuredRouters = new LRUCache({
        max: CONFIGURED_ROUTER_CACHE_MAX,
        ttl: CONFIGURED_ROUTER_CACHE_TTL_SECONDS * 1000,
        updateAgeOnGet: true,
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
        // Admin/observability endpoints must not be readable by arbitrary web origins.
        if (ADMIN_PATHS.has(req.path)) {
            next();
            return;
        }

        res.set("Access-Control-Allow-Origin", "*");
        res.set("Access-Control-Allow-Headers", "Content-Type, Accept");
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
            const apiKey = requestProviderKey(req);
            if (apiKey === null) {
                res.status(400).json({ ok: false, status: 400, message: "Invalid apiKey parameter" });
                return;
            }
            const result = await testGroqApiKey({
                groqApiKey: apiKey,
                groqModel: req.query.model,
            });
            res.status(result.ok ? 200 : result.status || 400).json(result);
        } catch (error) {
            next(error);
        }
    });

    // Short-lived cache so rapid repeated "Check models quota" clicks don't re-probe
    // every model (probing is slow, especially for NVIDIA models).
    // Keyed by the caller's API key so one caller never sees quota state probed with another
    // caller's key.
    const modelsStatusCache = new LRUCache({ max: 50, ttl: MODELS_STATUS_CACHE_MS });

    // Probe one (provider, model) with a tiny STREAMING request. We only need the first token
    // (or stream end) to confirm the model answers — we do NOT wait for the full completion,
    // which is what made large NVIDIA models (Nemotron, MiniMax, GLM, DeepSeek) report
    // "⏱ Hết giờ": their time-to-first-token exceeds a non-streaming wait. Streaming flushes
    // immediately, so a live-but-slow model is correctly reported as available. A per-probe
    // timeout still guards against a genuinely dead connection so one model cannot block the
    // dashboard.
    const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 20_000);
    async function probeModel(provider, model) {
        const modelKey = `${provider.id}:${model}`;
        // Skip the live probe for models already known to be in rate-limit cooldown: their
        // state is already known and probing them just wastes a slow request.
        if (breaker.isOpen(modelKey)) {
            return {
                provider: provider.id,
                model,
                state: "rate_limited",
                circuitOpen: true,
                message: "in cooldown (recently rate-limited)",
                status: 429,
            };
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
        try {
            const response = await fetch(provider.baseUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${provider.apiKey}`,
                    Accept: "text/event-stream",
                },
                body: JSON.stringify({
                    model,
                    messages: [
                        { role: "system", content: "You are a translation assistant. Reply with the single word: ok" },
                        { role: "user", content: "ping" },
                    ],
                    temperature: 0,
                    max_tokens: 5,
                    stream: true,
                }),
                signal: controller.signal,
            });

            if (!response.ok) {
                // Error responses are regular JSON, not a stream.
                const data = await response.json().catch(() => ({}));
                let state = "unknown";
                if (response.status === 429) state = "rate_limited";
                else if (response.status === 403) state = "blocked";
                else if (response.status === 401) state = "invalid_key";
                return {
                    provider: provider.id,
                    model,
                    state,
                    circuitOpen: breaker.isOpen(modelKey),
                    message: data.error?.message,
                    status: response.status,
                };
            }

            // A 200 with a stream: any chunk received => the model is live and answering.
            // Resolve as available without consuming the (potentially long) rest of the stream.
            await firstStreamChunk(response);
            return {
                provider: provider.id,
                model,
                state: "available",
                circuitOpen: breaker.isOpen(modelKey),
                message: undefined,
                status: 200,
            };
        } catch (err) {
            const timedOut = err.name === "AbortError";
            return {
                provider: provider.id,
                model,
                state: timedOut ? "timeout" : "error",
                circuitOpen: breaker.isOpen(modelKey),
                message: timedOut ? `no response within ${PROBE_TIMEOUT_MS / 1000}s` : err.message,
                status: 0,
            };
        } finally {
            clearTimeout(timer);
        }
    }

    // Resolve as soon as the SSE stream yields its first data chunk, then stop reading. For a
    // provider that buffers the whole response (no body / non-SSE), fall back to json() so the
    // probe still resolves instead of hanging.
    async function firstStreamChunk(response) {
        if (!response.body) {
            await response.json().catch(() => ({}));
            return;
        }
        const reader = response.body.getReader();
        try {
            const { value } = await reader.read();
            if (!value) await response.json().catch(() => ({}));
        } finally {
            reader.releaseLock?.();
        }
    }

    app.get("/models-status", async (req, res, next) => {
        try {
            // Groq key may come from the query (encoded), or from env for local/private
            // callers; the generic LLM provider key is always taken from env (not exposed in
            // the URL).
            const groqKey = requestProviderKey(req);
            if (groqKey === null) {
                res.status(400).json({ error: "Invalid apiKey parameter" });
                return;
            }

            // Serve a cached result if it is fresh — probing 10+ models across providers is
            // slow, and quota state does not change in seconds.
            const cacheKey = cacheKeyForApiKey(groqKey);
            const cached = modelsStatusCache.get(cacheKey);
            if (cached) {
                res.json(cached);
                return;
            }

            const providers = getProviders({ groqApiKey: groqKey });
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
            modelsStatusCache.set(cacheKey, { ...payload, cached: true });
            res.json(payload);
        } catch (error) {
            next(error);
        }
    });

    app.get("/status", async (req, res, next) => {
        if (!isAdminRequestAuthorized(req)) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }

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
        if (!isAdminRequestAuthorized(req)) {
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

// The Groq key may be supplied by the caller (base64url in the query string). Falling back to
// the server's own key is only safe for local/private callers: otherwise any internet client
// could spend the operator's quota through the public probe endpoints.
function requestProviderKey(req) {
    if (req.query.apiKey === undefined) {
        return isPrivateRequest(req) ? process.env.GROQ_API_KEY : undefined;
    }

    const encoded = String(req.query.apiKey);
    if (!encoded || encoded.length > MAX_PROVIDER_KEY_LENGTH || !/^[A-Za-z0-9\-_=]+$/.test(encoded)) {
        return null;
    }

    return decodeProviderKey(encoded);
}

function cacheKeyForApiKey(apiKey) {
    return crypto
        .createHash("sha256")
        .update(apiKey || "")
        .digest("hex");
}

function logRequest(req, res, next) {
    const startedAt = process.hrtime.bigint();

    res.on("finish", () => {
        const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
        const route = routeLabel(req);
        recordHttpRequest({
            durationSeconds,
            method: req.method,
            route,
            status: res.statusCode,
        });
        // Log the route template, never the raw path: configured addon URLs embed the user's
        // provider API key as a path segment.
        logger.info("http request", {
            durationMs: durationSeconds * 1000,
            method: req.method,
            route,
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
    if (/^\/configure\/[^/]+\/[^/]+\/subtitles\//.test(req.path)) {
        return "/configure/:sourceLang/:targetLang/subtitles/*";
    }
    if (/^\/configure\/[^/]+\/[^/]+/.test(req.path)) return "/configure/:sourceLang/:targetLang/*";
    if (req.path.startsWith("/subtitles/")) return "/subtitles/*";
    return "other";
}

// Metrics and status expose operational detail (in-flight jobs, source subtitle URLs, provider
// configuration). With METRICS_TOKEN set they require that token; without one they are limited
// to callers on a private network.
function isAdminRequestAuthorized(req) {
    if (process.env.METRICS_TOKEN) return hasValidMetricsToken(req);
    return isPrivateRequest(req);
}

function hasValidMetricsToken(req) {
    const token = process.env.METRICS_TOKEN;
    if (!token) return false;

    const provided = Buffer.from(String(req.get("authorization") || ""), "utf8");
    const expected = Buffer.from(`Bearer ${token}`, "utf8");
    if (provided.length !== expected.length) return false;

    return crypto.timingSafeEqual(provided, expected);
}

// Only addresses Express itself derived (honouring the `trust proxy` setting) are considered:
// x-forwarded-for / x-real-ip are attacker-controlled and would let anyone claim to be
// 127.0.0.1.
function isPrivateRequest(req) {
    return [req.ip, req.socket && req.socket.remoteAddress].filter(Boolean).some(isPrivateAddress);
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

function decodeProviderKey(value) {
    return Buffer.from(String(value).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
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
