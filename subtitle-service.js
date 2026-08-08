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
const RESULT_LIMIT = Number(process.env.SUBTITLE_RESULT_LIMIT || 1);
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
        // Tạo options sub với sourceLanguage lấy động từ từng file sub thay vì config cố định.
        // Apply RESULT_LIMIT to the FINAL list so the addon exposes a single "Groq Sub"
        // subtitle entry per video (no duplicate / conflicting buttons). Previously the limit
        // was applied per-source-subtitle inside createSubtitleOptions, which had no effect on
        // the total count when each sub produced one option.
        const subtitleOptions = sourceLanguageSubtitles.length
            ? sourceLanguageSubtitles.flatMap((sub) => {
                  const dynamicConfig = {
                      ...config,
                      sourceLanguage: sub.sourceLanguage || normalizeStremioLanguage(sub.lang || config.sourceLanguage),
                  };
                  return createSubtitleOptions(args, results, [sub], dynamicConfig);
              })
            : createSubtitleOptions(args, results, [], config);
        const subtitles = subtitleOptions.slice(0, RESULT_LIMIT);
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
            subtitleId: subtitle.id,
            // Stremio's content id (imdb/tmdb) + type so the status dashboard can show
            // WHICH movie/series is being translated, not just an opaque subtitle id.
            videoId: args.id,
            videoType: args.type,
            title: `OpenSubtitles v3 ${subtitle.id}`,
            state: "queued",
            progress: undefined,
            totalCues: 0,
            error: undefined,
            startedAt: undefined,
            updatedAt: undefined,
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
    job.startedAt = job.startedAt || Date.now();
    job.updatedAt = Date.now();
    job.state = "translating";
    job.error = undefined;
    logger.info("source subtitle download started", {
        key: job.key,
        subtitleUrl: job.subtitleUrl,
    });
    const subtitleText = await fetchText(job.subtitleUrl);

    const cues = parseSubtitleCues(subtitleText);

    if (!cues.length) {
        throw new Error(`No subtitle cues found for ${job.title}`);
    }

    job.totalCues = cues.length;
    // Reuse partial progress from a previous (interrupted) attempt so we resume instead of
    // re-translating cues that were already done — saves Groq tokens across retries.
    if (!Array.isArray(job.progress) || job.progress.length !== cues.length) {
        job.progress = new Array(cues.length).fill(undefined);
    }
    const resumedCount = job.progress.filter((v) => v !== undefined).length;
    job.updatedAt = Date.now();

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
            // Some cues could not be translated (all Groq models were rate-limited for their
            // chunk). Never serve the untranslated (source-language) text: show a Vietnamese
            // notice instead. Progress for the translated cues is already saved on the job, so
            // the next request resumes and only re-translates the missing cues.
            const resumedCount = job.progress.filter((v) => v !== undefined).length;
            job.state = "partial";
            job.updatedAt = Date.now();
            const vtt = composeDiagnosticVtt({
                title: "Groq Subs chưa dịch xong",
                message: `Đã dịch ${resumedCount}/${cues.length} dòng. Các model Groq đang bị giới hạn tốc độ. Vui lòng thử lại sau ít phút (tiến độ đã được lưu, sẽ nối tiếp).`,
            });
            recordSubtitleTranslation({
                bytes: Buffer.byteLength(vtt, "utf8"),
                durationSeconds: Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
                sourceLanguage: config.sourceLanguage,
                status: "partial",
                targetLanguage: config.targetLanguage,
            });
            logger.warn("subtitle translation incomplete, serving notice", {
                complete: false,
                cueCount: cues.length,
                key: job.key,
                resumedCues: resumedCount,
            });
            return { vtt, complete: false };
        }

        const vtt = composeVtt(cues, translations);
        job.state = "complete";
        job.updatedAt = Date.now();
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
        job.state = "failed";
        job.error = error.message || String(error);
        job.updatedAt = Date.now();
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

function hashKey(value) {
    return crypto.createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

function getJobsStatus() {
    const entries = [];
    for (const [key, job] of jobs) {
        const total = Array.isArray(job.progress) ? job.progress.length : job.totalCues || 0;
        const done = Array.isArray(job.progress) ? job.progress.filter((v) => v !== undefined).length : 0;
        const percent = total > 0 ? Math.round((done / total) * 100) : 0;
        const inFlight = Boolean(job.promise);
        // config stored on the job is the full getSubtitleConfig() output, which uses
        // sourceLanguage / targetLanguage / groqModel (NOT sourceLang/targetLang).
        const cfg = job.config || {};
        entries.push({
            key,
            title: job.title,
            subtitleUrl: job.subtitleUrl,
            subtitleId: job.subtitleId,
            videoId: job.videoId,
            videoType: job.videoType,
            cueCount: total,
            translatedCues: done,
            percent,
            complete: total > 0 && done === total,
            inFlight,
            // Explicit state for the UI: queued / translating / partial / complete / failed.
            // An in-flight build overrides the stored state so the dashboard shows "translating"
            // even between sub-state transitions.
            state: inFlight ? "translating" : job.state || "queued",
            error: job.error,
            startedAt: job.startedAt,
            updatedAt: job.updatedAt,
            config: {
                sourceLanguage: cfg.sourceLanguage,
                targetLanguage: cfg.targetLanguage,
                groqModel: cfg.groqModel,
            },
        });
    }
    return { activeJobCount: jobs.size, jobs: entries };
}

module.exports = {
    getGeneratedSubtitleResponse,
    getJobsStatus,
    getSubtitleOptions,
};
