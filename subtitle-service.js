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
    logger.info("source subtitle download started", {
        key: job.key,
        subtitleUrl: job.subtitleUrl,
    });
    const subtitleText = await fetchText(job.subtitleUrl);

    const cues = parseSubtitleCues(subtitleText);

    if (!cues.length) {
        throw new Error(`No subtitle cues found for ${job.title}`);
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
        const vtt = composeVtt(cues, translations);
        recordSubtitleTranslation({
            bytes: Buffer.byteLength(vtt, "utf8"),
            durationSeconds: Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
            sourceLanguage: config.sourceLanguage,
            status: complete ? "success" : "partial",
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

function hashKey(value) {
    return crypto.createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

module.exports = {
    getGeneratedSubtitleResponse,
    getSubtitleOptions,
};
