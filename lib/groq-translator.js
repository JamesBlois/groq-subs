const logger = require("./logger");
const { LANGUAGES } = require("./languages");

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile";
const GROQ_CHUNK_SIZE = 50;
const GROQ_MAX_TOKENS = 4000;

const GROQ_MODELS = [
    "groq/compound-mini",
    "llama-3.1-8b-instant",
    "llama-3.3-70b-versatile",
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "qwen/qwen3.6-27b",
];

const LANGUAGE_LABELS = buildLanguageLabels();

function buildLanguageLabels() {
    const labels = {};
    for (const { code, label, stremio } of LANGUAGES) {
        labels[String(code).toLowerCase()] = label;
        labels[String(stremio).toLowerCase()] = label;
    }
    return labels;
}

function languageLabel(code) {
    const key = String(code || "").toLowerCase();
    return LANGUAGE_LABELS[key] || code || "Vietnamese";
}

function chunkArray(array, chunkSize) {
    const results = [];
    for (let i = 0; i < array.length; i += chunkSize) {
        results.push(array.slice(i, i + chunkSize));
    }
    return results;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function groqApiKey(config) {
    return (config?.groqApiKey || process.env.GROQ_API_KEY || "").trim();
}

function groqModel(config) {
    const model = (config?.groqModel || process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL).trim();
    return model || DEFAULT_GROQ_MODEL;
}

async function testGroqApiKey(config) {
    const apiKey = groqApiKey(config);
    if (!apiKey) {
        return { ok: false, status: 401, message: "Missing Groq API key" };
    }

    try {
        const response = await fetch(GROQ_API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: groqModel(config),
                messages: [
                    { role: "system", content: "You are a translation assistant. Reply with the single word: ok" },
                    { role: "user", content: "ping" },
                ],
                temperature: 0,
                max_tokens: 5,
            }),
        });

        if (response.status === 401) {
            const data = await response.json().catch(() => ({}));
            return { ok: false, status: 401, message: data.error?.message || "Invalid Groq API key" };
        }

        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            return {
                ok: false,
                status: response.status,
                message: data.error?.message || `${response.status} ${response.statusText}`,
            };
        }

        const data = await response.json();
        return {
            ok: true,
            status: 200,
            model: groqModel(config),
            message: "Groq API key is valid",
            preview: data.choices?.[0]?.message?.content,
        };
    } catch (error) {
        return { ok: false, status: 0, message: error.message || "Network error contacting Groq API" };
    }
}

function buildSystemInstruction(config) {
    const target = languageLabel(config?.groqTargetLanguage || config?.targetLanguage || "vi");
    const source = languageLabel(config?.groqSourceLanguage || config?.sourceLanguage || "en");

    return `You are a master subtitle translator specializing in cinema and Asian dramas. Translate movie subtitles from ${source} to ${target}.

PRONOUN & CONTEXT RULES:
- NO PROFANITY & NO "MÀY - TAO": Strictly forbid using profanity, vulgarity, or "Mày - Tao" in any context.
- Korean/Asian Dramas:
  + Male - Female romantic: Anh - Em (or Tôi - Cô when distant).
  + Close friends / Colleagues: Tớ - Cậu, Tôi - Cậu, or Anh/Chị - Em.
  + Boss - Subordinate: Sếp/Anh/Chị - Cậu/Cô/Em.
- Action / Thriller: Enemies use Hắn - Tôi, Ngươi - Ta, Ông - Tôi (NO "Mày - Tao").
- Western Movies: Natural, avoid rigid "Bạn/Tôi".

SUBTITLE RULES:
- Natural localized ${target}, concise, maintain line order.
- Preserve meaning, tone and emotion. Keep technical/proper nouns intact when appropriate.

OUTPUT FORMAT (CRITICAL):
- Output EXACTLY one translated line per input line, in the same order.
- Output ONLY the translated lines, separated by a single newline.
- Do NOT number the lines. Do NOT add quotes, explanations, notes, headings, or blank lines.
- Do NOT wrap your answer in <think>...</think> tags or include any reasoning, commentary, or preamble.`;
}

async function translateGroqBatch(texts, config) {
    if (!texts || !Array.isArray(texts) || texts.length === 0) return [];

    const apiKey = groqApiKey(config);
    if (!apiKey) {
        logger.error("Missing Groq API key");
        return texts;
    }

    // Primary model first, then the other models as a fallback chain so a single
    // rate-limited / temporarily unavailable model does not leave subtitles untranslated.
    const primary = groqModel(config);
    const baseChain = [primary, ...GROQ_MODELS.filter((m) => m !== primary)];

    const chunks = chunkArray(texts, GROQ_CHUNK_SIZE);
    let allTranslated = [];

    for (let i = 0; i < chunks.length; i += 1) {
        if (i > 0) {
            await delay(1000);
        }

        // Round-robin the starting model per chunk so daily token quota is spread evenly
        // across all models instead of exhausting the primary model first.
        const chain = rotate(baseChain, i % baseChain.length);
        const result = await translateChunkWithFallback(chunks[i], config, apiKey, chain);
        allTranslated = allTranslated.concat(result);
    }

    return allTranslated;
}

function rotate(array, positions) {
    const n = array.length;
    if (!n) return array;
    const k = ((positions % n) + n) % n;
    return array.slice(k).concat(array.slice(0, k));
}

async function translateChunkWithFallback(chunk, config, apiKey, fallbackModels) {
    const sourceLabel = languageLabel(config?.groqSourceLanguage || "en");
    const targetLabel = languageLabel(config?.groqTargetLanguage || "vi");
    const systemInstruction = buildSystemInstruction(config);
    const numbered = chunk.map((line, idx) => `${idx + 1}. ${line}`).join("\n");
    const userPrompt = `Translate each of the following ${chunk.length} subtitle lines from ${sourceLabel} to ${targetLabel}. Output one translated line per input line, same order, no numbering, no extra text:\n\n${numbered}`;

    for (let attempt = 0; attempt < fallbackModels.length; attempt += 1) {
        const model = fallbackModels[attempt];
        if (attempt > 0) {
            await delay(1200);
        }

        try {
            const response = await fetch(GROQ_API_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model,
                    messages: [
                        { role: "system", content: systemInstruction },
                        { role: "user", content: userPrompt },
                    ],
                    temperature: 0.2,
                    max_tokens: GROQ_MAX_TOKENS,
                }),
            });

            const data = await response.json();

            if (!response.ok) {
                logger.warn("Groq model failed, trying next", {
                    attempt,
                    message: data.error?.message,
                    model,
                    status: response.status,
                });
                continue;
            }

            const content = data.choices?.[0]?.message?.content || "";
            const translatedLines = parseTranslations(content, chunk.length);

            if (translatedLines.length !== chunk.length) {
                logger.warn("Groq line count mismatch, trying next model", {
                    attempt,
                    expected: chunk.length,
                    model,
                    received: translatedLines.length,
                });
                continue;
            }

            if (attempt > 0) {
                logger.info("Groq translation succeeded via fallback model", {
                    fallbackModel: model,
                    primaryModel: fallbackModels[0],
                });
            }
            return translatedLines;
        } catch (err) {
            logger.warn("Groq fetch error, trying next model", { error: err.message, model });
            continue;
        }
    }

    logger.error("All Groq models failed for chunk", { chunkSize: chunk.length });
    throw new Error("All Groq models failed for chunk");
}

function parseTranslations(content, expectedCount) {
    const raw = String(content || "");
    const OPEN = "<" + "think" + ">";
    const CLOSE = "</" + "think" + ">";
    let cleaned = raw;
    const lastClose = cleaned.lastIndexOf(CLOSE);
    if (lastClose !== -1) {
        cleaned = cleaned.slice(lastClose + CLOSE.length);
    } else if (cleaned.includes(OPEN)) {
        cleaned = "";
    }
    cleaned = cleaned.trim();
    const lines = cleaned.split("\n");
    const result = [];
    for (const line of lines) {
        const trimmed = line.replace(/\s+$/g, "").trim();
        if (!trimmed) continue;
        const stripped = trimmed.replace(/^\d+\.\s+/, "");
        if (result.length < expectedCount) {
            result.push(stripped);
        } else {
            result[result.length - 1] = `${result[result.length - 1]} ${stripped}`;
        }
    }
    return result.slice(0, expectedCount);
}

module.exports = {
    DEFAULT_GROQ_MODEL,
    GROQ_MODELS,
    groqApiKey,
    groqModel,
    testGroqApiKey,
    translateGroqBatch,
};
