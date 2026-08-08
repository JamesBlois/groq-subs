const { translateGroqBatch } = require("./groq-translator");
const { cueTextForTranslation } = require("./subtitle-parser");
const logger = require("./logger");

const BATCH_LIMITS = {
    groq: {
        chars: 50000,
        texts: 100,
    },
};

async function translateCues(cues, config, progress) {
    const translated = new Array(cues.length).fill("");
    const limits = batchLimits(config);
    // progress[i] holds a previously translated value (or "" for empty cues) so we
    // can resume after a partial run and skip already-translated cues to save tokens.
    const partial = Array.isArray(progress) && progress.length === cues.length ? progress : null;
    let hadFailure = false;

    let batch = [];
    let batchIndexes = [];
    let batchChars = 0;

    async function flushBatch() {
        if (!batch.length) return;

        try {
            const result = await translateBatch(batch, config);
            result.forEach((text, index) => {
                const cleaned = cleanTranslatedText(text);
                translated[batchIndexes[index]] = cleaned;
                if (partial) partial[batchIndexes[index]] = cleaned;
            });
        } catch (err) {
            // This batch could not be translated (e.g. all models rate-limited). Leave these
            // cues out of `partial` so a later retry re-translates them (instead of caching the
            // source text). Keep going so we make as much progress as possible this run.
            hadFailure = true;
            logger.warn("subtitle batch failed, will retry later", {
                count: batch.length,
                error: err.message,
            });
        }

        batch = [];
        batchIndexes = [];
        batchChars = 0;
    }

    for (let index = 0; index < cues.length; index += 1) {
        const text = cueTextForTranslation(cues[index]);
        if (!text) {
            if (partial) partial[index] = "";
            continue;
        }

        // Skip cues already translated in a previous (partial) run.
        if (partial && partial[index] !== undefined) {
            translated[index] = partial[index];
            continue;
        }

        if (batch.length >= limits.texts || batchChars + text.length > limits.chars) {
            await flushBatch();
        }

        batch.push(text);
        batchIndexes.push(index);
        batchChars += text.length;
    }

    await flushBatch();

    // If any batch failed, do not treat the file as complete: the (partial) VTT must not be
    // cached as final. The successful cues are already saved in `partial`, so the next request
    // resumes from there and only re-translates the missing cues — saving Groq tokens.
    return { translations: translated, complete: !hadFailure };
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
