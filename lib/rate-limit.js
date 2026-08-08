const rateLimit = require("express-rate-limit");

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_REQUEST_LIMIT = 300;
const DEFAULT_SUBTITLE_REQUEST_LIMIT = 60;

function createRateLimiters() {
    const subtitleLimiter = createLimiter({
        prefix: "SUBTITLE_RATE_LIMIT",
        defaultLimit: DEFAULT_SUBTITLE_REQUEST_LIMIT,
        message: "`Too many` subtitle requests. Try again later.",
    });

    return {
        general: createLimiter({
            prefix: "RATE_LIMIT",
            defaultLimit: DEFAULT_REQUEST_LIMIT,
            message: "Too many requests. Try again later.",
        }),
        subtitleWork(req, res, next) {
            if (!isSubtitleWorkPath(req.path)) {
                next();
                return;
            }

            subtitleLimiter(req, res, next);
        },
    };
}

function createLimiter({ prefix, defaultLimit, message }) {
    return rateLimit({
        windowMs: readPositiveInteger(`${prefix}_WINDOW_MS`, DEFAULT_WINDOW_MS),
        limit: readPositiveInteger(`${prefix}_MAX`, defaultLimit),
        standardHeaders: "draft-8",
        legacyHeaders: false,
        skip: (req) => req.method === "OPTIONS",
        message: { error: message },
    });
}

function isSubtitleWorkPath(path) {
    return (
        path.startsWith("/generated-subtitles/") ||
        path.startsWith("/subtitles/") ||
        /^\/configure\/[^/]+\/[^/]+\/subtitles\//.test(path)
    );
}

function readPositiveInteger(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isInteger(value) && value > 0 ? value : fallback;
}

module.exports = {
    createRateLimiters,
    isSubtitleWorkPath,
};
