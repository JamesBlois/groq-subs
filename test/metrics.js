const assert = require("assert");
const {
    recordGeneratedSubtitleCache,
    recordHttpRequest,
    recordSubtitleCandidates,
    recordSubtitleLookup,
    recordSubtitleTranslation,
    renderMetrics,
} = require("../lib/metrics");

describe("metrics", function () {
    it("records http requests with their duration", async function () {
        recordHttpRequest({ durationSeconds: 0.25, method: "GET", route: "/manifest.json", status: 200 });

        const metrics = await renderMetrics();

        assert.match(
            metrics,
            /stremio_double_subtitles_http_requests_total{method="GET",route="\/manifest\.json",status="200"} \d+/,
        );
        assert.match(metrics, /stremio_double_subtitles_http_request_duration_seconds_count{method="GET"/);
    });

    it("records subtitle lookups and candidate counts per stage", async function () {
        recordSubtitleLookup({ sourceLanguage: "en", status: "hit", targetLanguage: "vi", type: "movie" });
        recordSubtitleCandidates({
            count: 7,
            sourceLanguage: "en",
            stage: "upstream",
            targetLanguage: "vi",
            type: "movie",
        });

        const metrics = await renderMetrics();

        assert.match(
            metrics,
            /subtitle_lookup_total{source_language="en",status="hit",target_language="vi",type="movie"} \d+/,
        );
        assert.match(
            metrics,
            /subtitle_candidates_total{source_language="en",stage="upstream",target_language="vi",type="movie"} 7/,
        );
    });

    it("only observes duration and size for successful translations", async function () {
        recordSubtitleTranslation({ sourceLanguage: "en", status: "failed", targetLanguage: "ko" });
        assert.doesNotMatch(
            await renderMetrics(),
            /generated_subtitle_bytes_count{source_language="en",target_language="ko"}/,
        );

        recordSubtitleTranslation({
            bytes: 12000,
            durationSeconds: 3,
            sourceLanguage: "en",
            status: "success",
            targetLanguage: "ko",
        });
        const metrics = await renderMetrics();

        assert.match(metrics, /generated_subtitle_bytes_count{source_language="en",target_language="ko"} 1/);
        assert.match(
            metrics,
            /subtitle_translation_duration_seconds_count{source_language="en",target_language="ko"} 1/,
        );
    });

    it("exposes generated subtitle cache events and memory gauges", async function () {
        recordGeneratedSubtitleCache("memory-hit");

        const metrics = await renderMetrics();

        assert.match(metrics, /generated_subtitle_cache_total{event="memory-hit"} \d+/);
        assert.match(metrics, /generated_subtitle_memory_cache_entries \d+/);
        assert.match(metrics, /generated_subtitle_memory_cache_max_bytes \d+/);
    });
});
