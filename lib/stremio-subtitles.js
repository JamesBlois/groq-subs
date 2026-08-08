const { fetchJson } = require("./http-client");
const logger = require("./logger");

const STREMIO_OPEN_SUBTITLES_URL = "https://opensubtitles-v3.strem.io";

async function searchPublicStremioOpenSubtitles(args) {
    const url = `${STREMIO_OPEN_SUBTITLES_URL}${buildStremioAddonPath(args)}`;
    logger.info("opensubtitles lookup started", {
        id: args.id,
        type: args.type,
    });
    const response = await fetchJson(url);

    if (!Array.isArray(response.subtitles)) return [];
    const subtitles = response.subtitles.filter((subtitle) => subtitle.url);
    logger.info("opensubtitles lookup finished", {
        id: args.id,
        subtitleCount: subtitles.length,
        type: args.type,
    });
    return subtitles;
}

function buildStremioAddonPath(args) {
    const encodedId = encodeURIComponent(args.id);
    const encodedExtra = encodeExtra(args.extra || {});
    const extraSegment = encodedExtra ? `/${encodedExtra}` : "";

    return `/subtitles/${encodeURIComponent(args.type)}/${encodedId}${extraSegment}.json`;
}

function encodeExtra(extra) {
    return Object.entries(extra)
        .filter(([key, value]) => key !== "__config" && value !== undefined && value !== null && value !== "")
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join("&");
}

module.exports = {
    searchPublicStremioOpenSubtitles,
};
