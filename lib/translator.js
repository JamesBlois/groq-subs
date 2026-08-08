const { translateGroqBatch } = require("./groq-translator");
const { cueTextForTranslation } = require("./subtitle-parser");

const BATCH_LIMITS = {
    groq: {
        chars: 50000,
        texts: 100,
    },
};

async function translateCues(cues, config) {
    const translated = new Array(cues.length).fill("");
    const limits = batchLimits(config);
    let batch = [];
    let batchIndexes = [];
    let batchChars = 0;

    async function flushBatch() {
        if (!batch.length) return;

        const result = await translateBatch(batch, config);
        result.forEach((text, index) => {
            translated[batchIndexes[index]] = cleanTranslatedText(text);
        });

        batch = [];
        batchIndexes = [];
        batchChars = 0;
    }

    for (let index = 0; index < cues.length; index += 1) {
        const text = cueTextForTranslation(cues[index]);
        if (!text) continue;

        if (batch.length >= limits.texts || batchChars + text.length > limits.chars) {
            await flushBatch();
        }

        batch.push(text);
        batchIndexes.push(index);
        batchChars += text.length;
    }

    await flushBatch();
    return translated;
}

function batchLimits(config) {
    return BATCH_LIMITS[translationProvider(config)] || BATCH_LIMITS.groq;
}

async function translateBatch(texts, config) {
    return translateGroqBatch(texts, config);
}

function translationProvider() {
    return "groq";
}

function cleanTranslatedText(text) {
    return String(text || "")
        .replace(/[ \t]+/g, " ")
        .trim();
}

module.exports = {
    batchLimits,
    translateCues,
    translationProvider,
};
