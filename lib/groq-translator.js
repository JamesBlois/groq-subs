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

    const model = groqModel(config);
    const chunks = chunkArray(texts, GROQ_CHUNK_SIZE);
    let allTranslated = [];

    for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];

        if (i > 0) {
            await delay(1000);
        }

        try {
            const systemInstruction = buildSystemInstruction(config);
            const sourceLabel = languageLabel(config?.groqSourceLanguage || "en");
            const targetLabel = languageLabel(config?.groqTargetLanguage || "vi");
            const numbered = chunk.map((line, idx) => `${idx + 1}. ${line}`).join("\n");
            const userPrompt = `Translate each of the following ${chunk.length} subtitle lines from ${sourceLabel} to ${targetLabel}. Output one translated line per input line, same order, no numbering, no extra text:\n\n${numbered}`;

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
                logger.error("Groq API error", {
                    status: response.status,
                    message: data.error?.message,
                    model,
                });
                allTranslated = allTranslated.concat(chunk);
                continue;
            }

            const content = data.choices?.[0]?.message?.content || "";
            const translatedLines = parseTranslations(content, chunk.length);

            if (translatedLines.length !== chunk.length) {
                logger.warn("Groq line count mismatch, using fallback", {
                    expected: chunk.length,
                    received: translatedLines.length,
                });
                allTranslated = allTranslated.concat(chunk);
            } else {
                allTranslated = allTranslated.concat(translatedLines);
            }
        } catch (err) {
            logger.error("Groq fetch error", { error: err, model });
            allTranslated = allTranslated.concat(chunk);
        }
    }

    return allTranslated;
}

function parseTranslations(content, expectedCount) {
    // Strip <think>...</think> reasoning blocks emitted by reasoning models (qwen, gpt-oss, etc.).
    const cleaned = String(content || "")
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        // Drop a trailing unclosed <think> block (model opened it but never closed): keep only text after it.
        .replace(/<think>[\s\S]*$/i, "")
        .trim();

    const lines = cleaned.split("\n");
    const result = [];

    for (const line of lines) {
        const trimmed = line.replace(/\s+$/g, "").trim();
        if (!trimmed) continue;

        // Strip an optional leading "N. " numbering prefix that some models still add.
        const stripped = trimmed.replace(/^\d+\.\s+/, "");
        if (result.length < expectedCount) {
            result.push(stripped);
        } else {
            // Extra lines beyond expected: fold into the last line as a safety net.
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
