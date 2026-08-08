const { addonBuilder } = require("stremio-addon-sdk");
const { getSubtitleOptions } = require("./subtitle-service");
const { DEFAULT_GROQ_MODEL } = require("./lib/groq-translator");

// Docs: https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/manifest.md
const manifest = {
    id: "community.groqsubs",
    version: "1.0.0",
    catalogs: [],
    resources: ["subtitles"],
    types: ["movie", "series"],
    name: "Groq Subs",
    logo: "https://raw.githubusercontent.com/awerks/stremio-double-subtitles/main/assets/logo.png",
    description: "Phụ đề Vietsub AI cho Stremio (dịch bằng Groq)",
    behaviorHints: {
        configurable: true,
    },
    stremioAddonsConfig: {
        issuer: "https://stremio-addons.net",
        signature:
            "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..lZOE3jDOfPKJ6JqA06j3Tw.M1u9EjpQcpG9phA3owATbdKoqryengZhgSCmLP7a5USGOvSqMJpX_FBBvqs7KSmz69Gx0i1L299Pc6q15MlgPFX_fr3Lc8YPCIwszypbCDYvO9AEFUlYYaFDGf3NYgC2.eSeBQQsFsOdm2TLdBypbow",
    },
};
function createAddonInterface(config) {
    const builder = new addonBuilder(createManifest(config));

    builder.defineSubtitlesHandler((args) => getSubtitleOptions({ ...args, config }));
    return builder.getInterface();
}

function createManifest(config) {
    if (!config) return manifest;

    return {
        ...manifest,
        name: `${manifest.name} ${config.sourceLang}->${config.targetLang}`,
        description: `${manifest.description}: ${config.sourceLang} subtitles with ${config.targetLang} translation via Groq (${config.groqModel || DEFAULT_GROQ_MODEL})`,
    };
}

module.exports = createAddonInterface();
module.exports.createAddonInterface = createAddonInterface;
module.exports.createManifest = createManifest;
module.exports.manifest = manifest;
