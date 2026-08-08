const LANGUAGES = [
    { code: "en", label: "English", stremio: "eng" },
    { code: "vi", label: "Vietnamese", stremio: "vie" },
    { code: "ko", label: "Korean", stremio: "kor" },
    { code: "ja", label: "Japanese", stremio: "jpn" },
    { code: "zh", label: "Chinese", stremio: "chi" },
    { code: "es", label: "Spanish", stremio: "spa" },
    { code: "fr", label: "French", stremio: "fre" },
    { code: "de", label: "German", stremio: "ger" },
    { code: "pt", label: "Portuguese", stremio: "por" },
    { code: "pt-BR", label: "Portuguese (Brazil)", stremio: "pob" },
    { code: "it", label: "Italian", stremio: "ita" },
    { code: "ru", label: "Russian", stremio: "rus" },
    { code: "th", label: "Thai", stremio: "tha" },
    { code: "hi", label: "Hindi", stremio: "hin" },
    { code: "id", label: "Indonesian", stremio: "ind" },
    { code: "tr", label: "Turkish", stremio: "tur" },
    { code: "ar", label: "Arabic", stremio: "ara" },
    { code: "nl", label: "Dutch", stremio: "dut" },
    { code: "pl", label: "Polish", stremio: "pol" },
];

const STREMIO_ALIASES = buildAliasMap("stremio");

Object.assign(STREMIO_ALIASES, {
    baq: "baq",
    cze: "cze",
    deu: "ger",
    dut: "dut",
    ell: "ell",
    fra: "fre",
    fre: "fre",
    gre: "ell",
    nld: "dut",
    ron: "rum",
    slo: "slo",
    spn: "spa",
    zho: "chi",
    zhc: "chi",
    zhe: "chi",
    "pt-br": "pob",
    pob: "pob",
    por: "por",
    pt: "por",
    "pt-pt": "por",
    eng: "eng",
    en: "eng",
    vie: "vie",
    vi: "vie",
    kor: "kor",
    ko: "kor",
    jpn: "jpn",
    ja: "jpn",
    chi: "chi",
    zh: "chi",
    fr: "fre",
    de: "ger",
    es: "spa",
});

function normalizeStremioLanguage(language) {
    const normalized = normalizeCode(language);

    return STREMIO_ALIASES[normalized] || normalized;
}

function buildAliasMap(targetProperty) {
    const aliases = {};

    for (const language of LANGUAGES) {
        aliases[normalizeCode(language.code)] = normalizeLanguageValue(language[targetProperty]);
        aliases[normalizeCode(language.stremio)] = normalizeLanguageValue(language[targetProperty]);
    }

    return aliases;
}

function normalizeLanguageValue(value) {
    return normalizeCode(value);
}

function normalizeCode(language) {
    return String(language || "")
        .trim()
        .toLowerCase();
}

module.exports = {
    LANGUAGES,
    normalizeStremioLanguage,
};
