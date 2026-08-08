const { translateGroqBatch } = require("./groq-translator");
const { cueTextForTranslation } = require("./subtitle-parser");
const logger = require("./logger");

const BATCH_LIMITS = {
    groq: {
        chars: 50000,
        texts: 100,
    },
};

// Retry missing cues up to this many passes within a single request, so a short
// rate-limit window can clear and another model can finish the gaps in-line.
// Read at call time so tests can override via env after the module is loaded.
function maxRetryPasses() {
    return Number(process.env.TRANSLATE_RETRY_PASSES || 3);
}
// Delay between retry passes (lets circuit-breaker cooldowns clear). Overridable
// via env so tests don't slow down on real backoff values.
function retryDelayMs() {
    return Number(process.env.TRANSLATE_RETRY_DELAY_MS || 5000);
}

async function translateCues(cues, config, progress) {
    const translated = new Array(cues.length).fill("");
    const limits = batchLimits(config);
    // progress[i] holds a previously translated value (or "" for empty cues) so we
    // can resume after a partial run and skip already-translated cues to save tokens.
    const partial = Array.isArray(progress) && progress.length === cues.length ? progress : null;

    // Map of cues that still need a translation (index -> source text).
    const pending = new Map();
    for (let index = 0; index < cues.length; index += 1) {
        const text = cueTextForTranslation(cues[index]);
        if (!text) {
            if (partial) partial[index] = "";
            continue;
        }
        if (partial && partial[index] !== undefined && partial[index] !== "") {
            translated[index] = partial[index];
            continue;
        }
        pending.set(index, text);
    }

    await runPass(pending, translated, partial, limits, config);

    // Retry missing cues: each failed batch left its indexes in `pending`. Wait for
    // circuit-breaker cooldowns to clear, then try again with whatever models became
    // available. This finishes the file in one request instead of serving a partial.
    for (let pass = 1; pass <= maxRetryPasses(); pass += 1) {
        if (pending.size === 0) break;
        logger.info("translation retry pass", { pass, missing: pending.size });
        await delay(retryDelayMs());
        await runPass(pending, translated, partial, limits, config);
    }

    const missing = verifyIntegrity(cues, translated);
    const complete = missing === 0;

    if (!complete) {
        logger.warn("subtitle translation incomplete after retries", {
            missing,
            total: cues.length,
        });
    }

    return { translations: translated, complete };
}

async function runPass(pending, translated, partial, limits, config) {
    if (pending.size === 0) return;

    const indexes = [...pending.keys()];
    let batch = [];
    let batchIndexes = [];
    let batchChars = 0;

    async function flushBatch() {
        if (!batch.length) return;

        try {
            const result = await translateBatch(batch, config);
            result.forEach((text, index) => {
                const cleaned = cleanTranslatedText(text);
                const cueIndex = batchIndexes[index];
                translated[cueIndex] = cleaned;
                if (partial) partial[cueIndex] = cleaned;
                pending.delete(cueIndex);
            });
        } catch (err) {
            // This batch could not be translated (e.g. all models rate-limited). Leave
            // indexes in `pending` so a later retry pass re-translates them (instead of
            // caching the source text). Keep going so we make as much progress as possible.
            logger.warn("subtitle batch failed, will retry later", {
                count: batch.length,
                error: err.message,
            });
        }

        batch = [];
        batchIndexes = [];
        batchChars = 0;
    }

    for (const index of indexes) {
        const text = pending.get(index);
        if (!text) continue;

        if (batch.length >= limits.texts || batchChars + text.length > limits.chars) {
            await flushBatch();
        }

        batch.push(text);
        batchIndexes.push(index);
        batchChars += text.length;
    }

    await flushBatch();
}

// Count cues whose translation is missing or empty. Every cue with source text must
// have a non-empty translation; otherwise the file is not complete.
function verifyIntegrity(cues, translated) {
    let missing = 0;
    for (let index = 0; index < cues.length; index += 1) {
        const source = cueTextForTranslation(cues[index]);
        if (!source) continue;
        const value = translated[index];
        if (value === undefined || value === null || String(value).trim() === "") {
            missing += 1;
        }
    }
    return missing;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    verifyIntegrity,
};
