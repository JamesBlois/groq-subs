const crypto = require("crypto");
const { Buffer } = require("buffer");
const { LRUCache } = require("lru-cache");
const { getSubtitleConfig } = require("./lib/config");
const { composeDiagnosticVtt, createDiagnosticSubtitleOption } = require("./lib/diagnostic-subtitle");
const { getCachedGeneratedSubtitle, setCachedGeneratedSubtitle } = require("./lib/generated-subtitle-cache");
const { fetchText } = require("./lib/http-client");
const { normalizeStremioLanguage } = require("./lib/languages");
const logger = require("./lib/logger");
const {
    recordGeneratedSubtitleCache,
    recordSubtitleCandidates,
    recordSubtitleLookup,
    recordSubtitleTranslation,
} = require("./lib/metrics");
const { getPublicBaseUrl } = require("./lib/public-url");
const { composeVtt, parseSubtitleCues } = require("./lib/subtitle-parser");
const { searchPublicStremioOpenSubtitles } = require("./lib/stremio-subtitles");
const { translateCues } = require("./lib/translator");
const { translationProvider } = require("./lib/translator");
const RESULT_LIMIT = Number(process.env.SUBTITLE_RESULT_LIMIT || 3);
const GENERATED_SUBTITLE_CACHE_CONTROL = "public, max-age=86400";
const DIAGNOSTIC_SUBTITLE_CACHE_CONTROL = "no-store";
const DEFAULT_JOB_MAX = 1000;
const DEFAULT_JOB_TTL_SECONDS = 24 * 60 * 60;
const JOB_MAX = DEFAULT_JOB_MAX;
const JOB_TTL_SECONDS = DEFAULT_JOB_TTL_SECONDS;
const jobs = new LRUCache({
    max: JOB_MAX,
    ttl: JOB_TTL_SECONDS * 1000,
    updateAgeOnGet: true,
});

// Background completion: after serving a partial VTT, keep translating in the
// background with long delays (matching circuit-breaker cooldown) so the next
// time the user opens the subtitle, a complete cached version is ready.
// Read at call time so tests can override via env after the module is loaded.
function bgRetryPasses() {
    return Number(process.env.BG_RETRY_PASSES || 10);
}
function bgRetryDelayMs() {
    return Number(process.env.BG_RETRY_DELAY_MS || 60_000);
}
const bgDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getSubtitleOptions(args) {
    const config = getSubtitleConfig(args.config || (args.extra && args.extra.__config));
    logger.info("subtitle options requested", {
        id: args.id,
        sourceLanguage: config.sourceLanguage,
        targetLanguage: config.targetLanguage,
        type: args.type,
    });

    try {
        // Ép OpenSubtitles v3 trả về sub của cả Tiếng Anh, Trung, Hàn, Đức, Nhật...
        // Request subtitles for the chosen source language. Use the Stremio 3-letter code so
        // OpenSubtitles returns matching candidates for ANY source language (not just a fixed
        // list). Empty/unknown -> "all" so we still get results to filter.
        const requestedSourceLang = normalizeStremioLanguage(config.sourceLanguage || "en");
        const sublanguageid = requestedSourceLang || "all";

        const modifiedArgs = {
            ...args,
            config: {
                ...args.config,
                sourceLanguage: requestedSourceLang,
                stremioSourceLanguage: requestedSourceLang,
            },
            extra: {
                ...(args.extra || {}),
                sublanguageid,
            },
        };

        const results = await searchPublicStremioOpenSubtitles(modifiedArgs);

        // 1. Chỉ lọc lấy những sub khớp đúng ngôn ngữ nguồn đã chọn (Ví dụ: 'en' thì chỉ lấy sub Anh)
        const targetSourceLang = normalizeStremioLanguage(config.sourceLanguage || "en").toLowerCase();

        const matchingSubtitles = results.filter((sub) => {
            const subLang = normalizeStremioLanguage(sub.lang || "").toLowerCase();
            if (targetSourceLang === "all") return true;
            if (targetSourceLang === "en" || targetSourceLang === "eng") {
                return subLang === "en" || subLang === "eng";
            }
            return subLang === targetSourceLang;
        });

        // 2. Lấy tối đa 5 sub ĐÚNG CHUẨN ngôn ngữ nguồn đó
        const sourceLanguageSubtitles = matchingSubtitles.slice(0, 5).map((sub) => ({
            ...sub,
            sourceLanguage: normalizeStremioLanguage(sub.lang || config.sourceLanguage),
        }));
        recordSubtitleCandidates({
            count: results.length,
            sourceLanguage: config.sourceLanguage,
            stage: "upstream",
            targetLanguage: config.targetLanguage,
            type: args.type,
        });
        recordSubtitleCandidates({
            count: sourceLanguageSubtitles.length,
            sourceLanguage: config.sourceLanguage,
            stage: "source_language",
            targetLanguage: config.targetLanguage,
            type: args.type,
        });
        // Tạo options sub với sourceLanguage lấy động từ từng file sub thay vì config cố định
        const subtitles = sourceLanguageSubtitles.length
            ? sourceLanguageSubtitles.flatMap((sub) => {
                  const dynamicConfig = {
                      ...config,
                      sourceLanguage: sub.sourceLanguage || normalizeStremioLanguage(sub.lang || config.sourceLanguage),
                  };
                  return createSubtitleOptions(args, results, [sub], dynamicConfig);
              })
            : createSubtitleOptions(args, results, [], config);
        recordSubtitleLookup({
            sourceLanguage: config.sourceLanguage,
            status: "success",
            targetLanguage: config.targetLanguage,
            type: args.type,
        });

        logger.info("subtitle options resolved", {
            id: args.id,
            returnedCount: subtitles.length,
            sourceLanguageCount: sourceLanguageSubtitles.length,
            totalCount: results.length,
            topSubtitleIds: sourceLanguageSubtitles.slice(0, RESULT_LIMIT).map((subtitle) => subtitle.id),
        });
        return { subtitles };
    } catch (error) {
        logger.error("subtitle lookup failed", {
            error,
            id: args.id,
            type: args.type,
        });
        recordSubtitleLookup({
            sourceLanguage: config.sourceLanguage,
            status: "failure",
            targetLanguage: config.targetLanguage,
            type: args.type,
        });
        const subtitles = [
            createDiagnosticSubtitleOption({
                code: "lookup-failed",
                config,
                title: "Groq Subs lookup failed",
                message: "Could not look up source subtitles for this video.",
            }),
        ];
        logger.info("subtitle options resolved", {
            diagnostic: true,
            id: args.id,
            returnedCount: subtitles.length,
            sourceLanguageCount: 0,
            totalCount: 0,
            topSubtitleIds: [],
        });
        return { subtitles };
    }
}

async function getGeneratedSubtitleResponse(key) {
    const startedAt = process.hrtime.bigint();
    const cachedSubtitle = await getCachedGeneratedSubtitle(key);
    if (cachedSubtitle) {
        logger.debug("generated subtitle cache hit", { key, source: cachedSubtitle.source });
        recordGeneratedSubtitleCache(`${cachedSubtitle.source}_hit`);
        logGeneratedSubtitleServed({
            cacheSource: cachedSubtitle.source,
            key,
            source: "cache",
            startedAt,
            vtt: cachedSubtitle.vtt,
        });
        return generatedSubtitleResponse(cachedSubtitle.vtt);
    }

    const job = jobs.get(key);
    if (!job) {
        return diagnosticGeneratedSubtitleResponse({
            key,
            message: "Generated subtitle expired or was not found.",
            source: "missing",
            startedAt,
        });
    }

    const source = job.promise ? "joined" : "build";
    if (!job.promise) {
        logger.info("generated subtitle build queued", { key });
        recordGeneratedSubtitleCache("miss");
        job.promise = buildTranslatedVtt(job)
            .then(({ vtt, complete }) => {
                if (complete) {
                    return setCachedGeneratedSubtitle(key, vtt).then(() => {
                        if (jobs.get(key) === job) {
                            jobs.delete(key);
                        }
                        logger.info("generated subtitle cached", {
                            bytes: Buffer.byteLength(vtt, "utf8"),
                            key,
                        });
                        return { vtt, cacheControl: GENERATED_SUBTITLE_CACHE_CONTROL };
                    });
                }
                // Partial translation: keep the job (with progress) so the next request
                // resumes instead of re-translating from scratch. Do NOT cache the partial VTT.
                job.promise = null;
                logger.warn("generated subtitle partial, will resume on next request", { key });
                return { vtt, cacheControl: DIAGNOSTIC_SUBTITLE_CACHE_CONTROL };
            })
            .catch((error) => {
                job.promise = null;
                logger.error("generated subtitle build failed", {
                    error,
                    key,
                });
                throw error;
            });
    } else {
        logger.debug("generated subtitle build joined", { key });
        recordGeneratedSubtitleCache("joined");
    }

    try {
        const { vtt, cacheControl } = await job.promise;
        logGeneratedSubtitleServed({
            key,
            source,
            startedAt,
            vtt,
        });
        return generatedSubtitleResponse(vtt, cacheControl);
    } catch (error) {
        return diagnosticGeneratedSubtitleResponse({
            error,
            key,
            message: "Could not generate translated subtitles for this video.",
            source: "error",
            startedAt,
        });
    }
}

function createSubtitleOptions(args, results, sourceLanguageSubtitles, config) {
    if (!results.length) {
        return [
            createDiagnosticSubtitleOption({
                code: "no-upstream-subtitles",
                config,
                title: "Groq Subs notice",
                message: "OpenSubtitles did not return any subtitles for this video.",
            }),
        ];
    }

    if (!sourceLanguageSubtitles.length) {
        return [
            createDiagnosticSubtitleOption({
                code: "no-source-language-subtitles",
                config,
                title: "Groq Subs notice",
                message: `No ${config.sourceLanguage} subtitles were found for this video.`,
            }),
        ];
    }

    return sourceLanguageSubtitles
        .map((subtitle) => createSubtitleOption(args, subtitle, config))
        .filter(Boolean)
        .slice(0, RESULT_LIMIT);
}

function generatedSubtitleResponse(vtt, cacheControl = GENERATED_SUBTITLE_CACHE_CONTROL) {
    return {
        cacheControl,
        diagnostic: false,
        vtt,
    };
}

function diagnosticGeneratedSubtitleResponse({ error, key, message, source, startedAt }) {
    const vtt = composeDiagnosticVtt({
        title: "Groq Subs error",
        message,
    });
    logGeneratedSubtitleServed({
        diagnostic: true,
        error,
        key,
        source,
        startedAt,
        vtt,
    });

    return {
        cacheControl: DIAGNOSTIC_SUBTITLE_CACHE_CONTROL,
        diagnostic: true,
        vtt,
    };
}

function logGeneratedSubtitleServed({ cacheSource, diagnostic, error, key, source, startedAt, vtt }) {
    logger.info("generated subtitle served", {
        bytes: Buffer.byteLength(vtt, "utf8"),
        cacheSource,
        diagnostic,
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
        error,
        key,
        source,
    });
}

function createSubtitleOption(args, subtitle, config) {
    const key = hashKey({
        type: args.type,
        id: args.id,
        sourceLanguage: config.stremioSourceLanguage,
        targetLanguage: config.stremioTargetLanguage,
        subtitleId: subtitle.id,
        subtitleUrl: subtitle.url,
    });

    if (!jobs.get(key)) {
        jobs.set(key, {
            key,
            config,
            subtitleUrl: subtitle.url,
            title: `OpenSubtitles v3 ${subtitle.id}`,
        });
    }

    return {
        id: `opensubtitles-v3-${subtitle.id}-to-${config.stremioTargetLanguage}`,
        url: `${getPublicBaseUrl()}/generated-subtitles/${key}.vtt`,
        lang: config.stremioTargetLanguage || "vi",
    };
}

async function buildTranslatedVtt(job) {
    const config = getSubtitleConfig(job.config);
    const startedAt = process.hrtime.bigint();

    // Reuse parsed cues from a previous attempt (stored on the job) to avoid
    // re-downloading + re-parsing the subtitle file on every resume.
    let cues = job.cues;
    if (!cues || !cues.length) {
        logger.info("source subtitle download started", {
            key: job.key,
            subtitleUrl: job.subtitleUrl,
        });
        const subtitleText = await fetchText(job.subtitleUrl);
        cues = parseSubtitleCues(subtitleText);
        if (!cues.length) {
            throw new Error(`No subtitle cues found for ${job.title}`);
        }
        job.cues = cues;
    }

    // Reuse partial progress from a previous (interrupted) attempt so we resume instead of
    // re-translating cues that were already done — saves Groq tokens across retries.
    if (!Array.isArray(job.progress) || job.progress.length !== cues.length) {
        job.progress = new Array(cues.length).fill(undefined);
    }
    const resumedCount = job.progress.filter((v) => v !== undefined).length;

    logger.info("subtitle translation started", {
        cueCount: cues.length,
        key: job.key,
        resumedCues: resumedCount,
        sourceLanguage: config.groqSourceLanguage,
        targetLanguage: config.groqTargetLanguage,
        provider: translationProvider(config),
        groqModel: config.groqModel,
    });
    try {
        const { translations, complete } = await translateCues(cues, config, job.progress);

        if (!complete) {
            const resumedCount = job.progress.filter((v) => v !== undefined).length;
            // Serve the partial VTT directly: translated cues where available, source text
            // as fallback for the rest. Do NOT prepend a long-running diagnostic cue — it
            // would overlay the movie for 10 minutes and make the subtitle appear "stopped".
            // Stremio loads the VTT once, so the file must stay usable as-is.
            const partialVtt = composeVtt(cues, translations);
            recordSubtitleTranslation({
                bytes: Buffer.byteLength(partialVtt, "utf8"),
                durationSeconds: Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
                sourceLanguage: config.sourceLanguage,
                status: "partial",
                targetLanguage: config.targetLanguage,
            });
            logger.warn("subtitle translation incomplete, serving partial VTT (source fallback for gaps)", {
                complete: false,
                cueCount: cues.length,
                key: job.key,
                resumedCues: resumedCount,
            });
            // Kick off background completion: keep translating the missing cues with
            // long-delay retries until the file is complete, then cache the final VTT so
            // the next request gets a finished subtitle.
            startBackgroundCompletion(job.key);
            return { vtt: partialVtt, complete: false };
        }

        const vtt = composeVtt(cues, translations);
        recordSubtitleTranslation({
            bytes: Buffer.byteLength(vtt, "utf8"),
            durationSeconds: Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
            sourceLanguage: config.sourceLanguage,
            status: "success",
            targetLanguage: config.targetLanguage,
        });
        logger.info("subtitle translation finished", {
            complete,
            cueCount: cues.length,
            key: job.key,
        });
        return { vtt, complete };
    } catch (error) {
        recordSubtitleTranslation({
            bytes: 0,
            durationSeconds: Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
            sourceLanguage: config.sourceLanguage,
            status: "failure",
            targetLanguage: config.targetLanguage,
        });
        throw error;
    }
}

// Background completion loop: after a partial VTT is served, keep retrying the
// missing cues with long delays (matching circuit-breaker cooldown) until the
// entire file is translated. When done, cache the final VTT and remove the job
// so the next request gets a complete, cached subtitle.
function startBackgroundCompletion(key) {
    const job = jobs.get(key);
    if (!job || job.completing) return;
    job.completing = true;

    logger.info("background completion started", { key });

    (async () => {
        try {
            for (let pass = 1; pass <= bgRetryPasses(); pass += 1) {
                const current = jobs.get(key);
                if (!current) {
                    logger.info("background completion stopped: job removed", { key, pass });
                    return;
                }

                // Check if already complete (e.g. another request finished it).
                const done =
                    Array.isArray(current.progress) && current.progress.every((v) => v !== undefined && v !== "");
                if (done) {
                    await cacheFinalVtt(key);
                    return;
                }

                logger.info("background completion retry pass", { key, pass, missing: countMissing(current) });

                if (pass > 1) {
                    await bgDelay(bgRetryDelayMs());
                }

                const config = getSubtitleConfig(current.config);
                const cues = current.cues;
                if (!cues || !cues.length) {
                    logger.warn("background completion: cues missing from job", { key });
                    return;
                }

                try {
                    const { complete } = await translateCues(cues, config, current.progress);
                    if (complete) {
                        await cacheFinalVtt(key);
                        logger.info("background completion finished", { key, pass });
                        return;
                    }
                } catch (err) {
                    logger.warn("background completion pass failed", { key, pass, error: err.message });
                }
            }
            logger.warn("background completion exhausted all passes", { key });
        } finally {
            const current = jobs.get(key);
            if (current) current.completing = false;
        }
    })().catch((err) => {
        logger.error("background completion error", { key, error: err.message });
        const current = jobs.get(key);
        if (current) current.completing = false;
    });
}

async function cacheFinalVtt(key) {
    const job = jobs.get(key);
    if (!job || !job.cues) return;

    const translations = job.progress.map((v) => (v === undefined ? "" : v));
    const vtt = composeVtt(job.cues, translations);

    await setCachedGeneratedSubtitle(key, vtt);
    if (jobs.get(key) === job) {
        jobs.delete(key);
    }
    logger.info("background completion cached final VTT", {
        bytes: Buffer.byteLength(vtt, "utf8"),
        key,
    });
}

function countMissing(job) {
    if (!Array.isArray(job.progress)) return 0;
    return job.progress.filter((v) => v === undefined || v === "").length;
}

function clearJobs() {
    jobs.clear();
}

function hashKey(value) {
    return crypto.createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

function getJobsStatus() {
    const entries = [];
    for (const [key, job] of jobs) {
        const total = Array.isArray(job.progress) ? job.progress.length : 0;
        const done = Array.isArray(job.progress) ? job.progress.filter((v) => v !== undefined).length : 0;
        entries.push({
            key,
            title: job.title,
            subtitleUrl: job.subtitleUrl,
            cueCount: total,
            translatedCues: done,
            complete: total > 0 && done === total,
            inFlight: Boolean(job.promise),
            backgroundCompleting: Boolean(job.completing),
            config: {
                sourceLang: job.config?.sourceLang,
                targetLang: job.config?.targetLang,
                groqModel: job.config?.groqModel,
            },
        });
    }
    return { activeJobCount: jobs.size, jobs: entries };
}

module.exports = {
    clearJobs,
    getGeneratedSubtitleResponse,
    getJobsStatus,
    getSubtitleOptions,
};
