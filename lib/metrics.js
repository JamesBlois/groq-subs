const client = require("prom-client");
const { getGeneratedSubtitleCacheStats } = require("./generated-subtitle-cache");

const register = new client.Registry();

client.collectDefaultMetrics({
    prefix: "stremio_double_subtitles_",
    register,
});

const httpRequestsTotal = new client.Counter({
    help: "Total HTTP requests.",
    labelNames: ["method", "route", "status"],
    name: "stremio_double_subtitles_http_requests_total",
    registers: [register],
});

const httpRequestDurationSeconds = new client.Histogram({
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    help: "HTTP request duration in seconds.",
    labelNames: ["method", "route", "status"],
    name: "stremio_double_subtitles_http_request_duration_seconds",
    registers: [register],
});

const subtitleLookupTotal = new client.Counter({
    help: "Subtitle lookup attempts.",
    labelNames: ["status", "type", "source_language", "target_language"],
    name: "stremio_double_subtitles_subtitle_lookup_total",
    registers: [register],
});

const subtitleCandidatesTotal = new client.Counter({
    help: "Subtitle candidates returned by upstream and after source-language filtering.",
    labelNames: ["stage", "type", "source_language", "target_language"],
    name: "stremio_double_subtitles_subtitle_candidates_total",
    registers: [register],
});

const subtitleTranslationTotal = new client.Counter({
    help: "Subtitle translation attempts.",
    labelNames: ["status", "source_language", "target_language"],
    name: "stremio_double_subtitles_subtitle_translation_total",
    registers: [register],
});

const subtitleTranslationDurationSeconds = new client.Histogram({
    buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
    help: "Subtitle translation duration in seconds.",
    labelNames: ["source_language", "target_language"],
    name: "stremio_double_subtitles_subtitle_translation_duration_seconds",
    registers: [register],
});

const generatedSubtitleBytes = new client.Histogram({
    buckets: [1000, 5000, 10000, 25000, 50000, 100000, 250000, 500000],
    help: "Generated subtitle size in bytes.",
    labelNames: ["source_language", "target_language"],
    name: "stremio_double_subtitles_generated_subtitle_bytes",
    registers: [register],
});

const generatedSubtitleCacheTotal = new client.Counter({
    help: "Generated subtitle cache events.",
    labelNames: ["event"],
    name: "stremio_double_subtitles_generated_subtitle_cache_total",
    registers: [register],
});

new client.Gauge({
    collect() {
        this.set(getGeneratedSubtitleCacheStats().memoryEntryCount);
    },
    help: "Generated subtitles stored in the in-process memory cache.",
    name: "stremio_double_subtitles_generated_subtitle_memory_cache_entries",
    registers: [register],
});

new client.Gauge({
    collect() {
        this.set(getGeneratedSubtitleCacheStats().memoryCalculatedBytes);
    },
    help: "Generated subtitle text bytes stored in the in-process memory cache.",
    name: "stremio_double_subtitles_generated_subtitle_memory_cache_bytes",
    registers: [register],
});

new client.Gauge({
    collect() {
        this.set(getGeneratedSubtitleCacheStats().memoryMaxBytes);
    },
    help: "Configured byte budget for the in-process generated subtitle memory cache.",
    name: "stremio_double_subtitles_generated_subtitle_memory_cache_max_bytes",
    registers: [register],
});

function recordHttpRequest({ durationSeconds, method, route, status }) {
    const labels = { method, route, status: String(status) };
    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(labels, durationSeconds);
}

function recordSubtitleLookup({ status, type, sourceLanguage, targetLanguage }) {
    subtitleLookupTotal.inc({
        source_language: sourceLanguage,
        status,
        target_language: targetLanguage,
        type,
    });
}

function recordSubtitleCandidates({ count, stage, type, sourceLanguage, targetLanguage }) {
    subtitleCandidatesTotal.inc(
        {
            source_language: sourceLanguage,
            stage,
            target_language: targetLanguage,
            type,
        },
        count,
    );
}

function recordSubtitleTranslation({ bytes, durationSeconds, status, sourceLanguage, targetLanguage }) {
    subtitleTranslationTotal.inc({
        source_language: sourceLanguage,
        status,
        target_language: targetLanguage,
    });

    if (status === "success") {
        subtitleTranslationDurationSeconds.observe(
            {
                source_language: sourceLanguage,
                target_language: targetLanguage,
            },
            durationSeconds,
        );
        generatedSubtitleBytes.observe(
            {
                source_language: sourceLanguage,
                target_language: targetLanguage,
            },
            bytes,
        );
    }
}

function recordGeneratedSubtitleCache(event) {
    generatedSubtitleCacheTotal.inc({ event });
}

async function renderMetrics() {
    return register.metrics();
}

module.exports = {
    contentType: register.contentType,
    recordGeneratedSubtitleCache,
    recordHttpRequest,
    recordSubtitleCandidates,
    recordSubtitleLookup,
    recordSubtitleTranslation,
    renderMetrics,
};
