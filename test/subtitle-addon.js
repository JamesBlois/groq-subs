const assert = require("assert");
const { once } = require("events");
const { getJson, getResponse, getText } = require("./helpers/http");

describe("live configured subtitle addon", function () {
    let server;
    let baseUrl;
    let generatedSubtitleUrl;
    let generatedVtt;

    before(async function () {
        this.timeout(10000);
        const { createApp } = require("../server");
        server = createApp().listen(0, "127.0.0.1");
        await once(server, "listening");
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        process.env.ADDON_BASE_URL = baseUrl;
    });

    after(async function () {
        delete process.env.ADDON_BASE_URL;

        if (server) {
            server.close();
            await once(server, "close");
        }
    });

    it("serves configured manifests for different language pairs", async function () {
        const frenchManifest = await getJson(`${baseUrl}/configure/de/fr/manifest.json`);
        assert.equal(frenchManifest.name, "Groq Subs de->fr");
        assert.match(frenchManifest.description, /de subtitles with fr translation via Groq/);

        const portugueseManifest = await getJson(`${baseUrl}/configure/de/pt-BR/manifest.json`);
        assert.equal(portugueseManifest.name, "Groq Subs de->pt-BR");
        assert.match(portugueseManifest.description, /de subtitles with pt-BR translation via Groq/);
    });

    it("default manifest has correct Groq Subs branding and no stale config", async function () {
        const manifest = await getJson(`${baseUrl}/manifest.json`);
        assert.equal(manifest.id, "community.groqsubs");
        assert.equal(manifest.name, "Groq Subs");
        assert.ok(!manifest.stremioAddonsConfig, "stale signature must be removed");
        assert.ok(!String(manifest.logo).includes("awerks"), "logo must point to our repo");
    });

    it("serves a status dashboard with provider + circuit-breaker state", async function () {
        const status = await getJson(`${baseUrl}/status`);
        assert.equal(status.addon, "Groq Subs");
        assert.ok(Array.isArray(status.providers) && status.providers.length > 0);
        assert.equal(status.providers[0].id, "groq");
        assert.equal(status.providers[0].models[0].model, "groq/compound-mini");
        assert.equal(typeof status.providers[0].models[0].circuitOpen, "boolean");
        assert.ok(status.jobs && typeof status.jobs.activeJobCount === "number");
        assert.ok(status.cache && typeof status.cache.memoryEntryCount === "number");
    });

    it("rate limits repeated requests", async function () {
        const previousMax = process.env.RATE_LIMIT_MAX;
        const previousWindowMs = process.env.RATE_LIMIT_WINDOW_MS;
        const { createApp } = require("../server");
        let rateLimitedServer;

        process.env.RATE_LIMIT_MAX = "1";
        process.env.RATE_LIMIT_WINDOW_MS = "60000";
        process.env.NODE_ENV = "production";
        try {
            rateLimitedServer = createApp().listen(0, "127.0.0.1");
            await once(rateLimitedServer, "listening");
            const rateLimitedBaseUrl = `http://127.0.0.1:${rateLimitedServer.address().port}`;

            assert.equal((await getResponse(`${rateLimitedBaseUrl}/`)).statusCode, 200);
            assert.equal((await getResponse(`${rateLimitedBaseUrl}/`)).statusCode, 429);
        } finally {
            restoreEnv("RATE_LIMIT_MAX", previousMax);
            restoreEnv("RATE_LIMIT_WINDOW_MS", previousWindowMs);
            restoreEnv("NODE_ENV", "development");
            if (rateLimitedServer) {
                rateLimitedServer.close();
                await once(rateLimitedServer, "close");
            }
        }
    });

    it("serves prometheus metrics", async function () {
        const metrics = await getText(`${baseUrl}/metrics`);

        assert.match(metrics, /stremio_double_subtitles_http_requests_total/);
        assert.match(metrics, /stremio_double_subtitles_subtitle_lookup_total/);
        assert.match(metrics, /stremio_double_subtitles_generated_subtitle_memory_cache_bytes/);
        assert.match(metrics, /stremio_double_subtitles_generated_subtitle_memory_cache_max_bytes/);
    });

    it("metrics with a bearer token", async function () {
        const previousToken = process.env.METRICS_TOKEN;
        const { createApp } = require("../server");
        let metricsServer;

        process.env.METRICS_TOKEN = "secret";

        try {
            metricsServer = createApp().listen(0, "127.0.0.1");
            await once(metricsServer, "listening");
            const metricsBaseUrl = `http://127.0.0.1:${metricsServer.address().port}`;

            assert.equal((await getResponse(`${metricsBaseUrl}/metrics`)).statusCode, 401);
        } finally {
            restoreEnv("METRICS_TOKEN", previousToken);

            if (metricsServer) {
                metricsServer.close();
                await once(metricsServer, "close");
            }
        }
    });

    it("maps configured target language to Stremio subtitle language code", async function () {
        this.timeout(15000);

        const subtitlesResponse = await getJson(
            `${baseUrl}/configure/de/pt-BR/subtitles/series/tt0428167%3A1%3A1/filename=Stromberg.S01E01.Der.Parkplatz.GERMAN.DVDRIP.ENGSUB.mkv&videoSize=242521670.json`,
        );

        assert.ok(subtitlesResponse.subtitles.length > 0, "expected at least one German subtitle");
        assert.equal(subtitlesResponse.subtitles[0].lang, "pob");
        assert.match(subtitlesResponse.subtitles[0].id, /-to-pob$/);
    });

    it("uses Stremio OpenSubtitles and Groq services", async function () {
        if (!process.env.GROQ_API_KEY) {
            this.skip();
        }
        this.timeout(90000);

        const subtitlesResponse = await getJson(
            `${baseUrl}/configure/de/fr/subtitles/series/tt0428167%3A1%3A1/filename=Stromberg.S01E01.Der.Parkplatz.GERMAN.DVDRIP.ENGSUB.mkv&videoSize=242521670.json`,
        );
        assert.ok(subtitlesResponse.subtitles.length > 0, "expected at least one German subtitle");
        assert.equal(subtitlesResponse.subtitles[0].lang, "fre");
        generatedSubtitleUrl = subtitlesResponse.subtitles[0].url;

        generatedVtt = await getText(generatedSubtitleUrl);
        assert.match(generatedVtt, /^WEBVTT/);
        assert.match(generatedVtt, /Büro/);
        assert.match(generatedVtt, /bureau/i);
    });

    it("serves the cached generated subtitle on repeated requests", async function () {
        if (!generatedSubtitleUrl || !generatedVtt) {
            this.skip();
        }

        const cachedVtt = await getText(generatedSubtitleUrl);
        assert.equal(cachedVtt, generatedVtt);
    });
});

function restoreEnv(name, value) {
    if (value === undefined) {
        delete process.env[name];
        return;
    }

    process.env[name] = value;
}
