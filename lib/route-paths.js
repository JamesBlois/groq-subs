// Route path matchers shared by the rate limiter and the metrics route labeller, so both agree
// on what counts as expensive "subtitle work".

const CONFIGURED_SUBTITLES_PATTERN = /^\/configure\/[^/]+\/[^/]+\/subtitles\//;

function isSubtitleWorkPath(path) {
    return (
        path.startsWith("/generated-subtitles/") ||
        path.startsWith("/subtitles/") ||
        CONFIGURED_SUBTITLES_PATTERN.test(path)
    );
}

module.exports = {
    CONFIGURED_SUBTITLES_PATTERN,
    isSubtitleWorkPath,
};
