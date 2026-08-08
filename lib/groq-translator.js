const logger = require("./logger");
const { LANGUAGES } = require("./languages");

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile";
const GROQ_CHUNK_SIZE_REASONING = 50;
// Reasoning models generate internal "thinking" tokens that count against max_tokens,
// so they need smaller chunks to leave room for the actual answer. Non-reasoning models
// can handle larger chunks, which amortises the per-request system-prompt overhead
// (fewer requests => fewer tokens spent repeating the prompt).
const GROQ_CHUNK_SIZE_NON_REASONING = 100;
const GROQ_MAX_TOKENS = 4000;
const REASONING_MODELS = new Set(["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.6-27b"]);

function chunkSizeForModel(model) {
    return REASONING_MODELS.has(model) ? GROQ_CHUNK_SIZE_REASONING : GROQ_CHUNK_SIZE_NON_REASONING;
}
// When a model returns 429 with a short "try again in Xs" (per-minute TPM limits),
// retry the SAME model once after that backoff instead of immediately moving on.
const RETRY_BACKOFF_MAX_MS = 15_000;
// Cooldown applied to a model after a 429, so it is skipped by the round-robin /
// fallback chain for a while. Capped so a daily (TPD) limit does not block a model
// for a whole day in-process.
const CIRCUIT_COOLDOWN_DEFAULT_MS = 60_000;
const CIRCUIT_COOLDOWN_MAX_MS = 5 * 60_000;

const GROQ_MODELS = [
    "groq/compound-mini",
    "llama-3.1-8b-instant",
    "llama-3.3-70b-versatile",
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "qwen/qwen3.6-27b",
];

// Tracks per-model rate-limit state so recently-429'd models are temporarily skipped,
// avoiding wasted requests against a model that is still cooling down.
class ModelCircuitBreaker {
    constructor() {
        this.openUntil = new Map();
    }

    markRateLimited(model, cooldownMs = CIRCUIT_COOLDOWN_DEFAULT_MS) {
        const clamped = Math.min(Math.max(cooldownMs, 0), CIRCUIT_COOLDOWN_MAX_MS);
        this.openUntil.set(model, Date.now() + clamped);
    }

    markHealthy(model) {
        this.openUntil.delete(model);
    }

    isOpen(model) {
        const until = this.openUntil.get(model);
        if (!until) return false;
        if (Date.now() >= until) {
            this.openUntil.delete(model);
            return false;
        }
        return true;
    }

    // Models not currently in cooldown. If every model is open, return all of them
    // so we never end up with an empty set (we still attempt rather than give up).
    available(models) {
        const open = models.filter((m) => this.isOpen(m));
        if (open.length === models.length) {
            logger.warn("all Groq models are in rate-limit cooldown; attempting anyway", {
                models: open,
            });
            return models;
        }
        return models.filter((m) => !this.isOpen(m));
    }

    reset() {
        this.openUntil.clear();
    }
}

const breaker = new ModelCircuitBreaker();

// Parse Groq's "Please try again in 13m32.16s" / "23.8s" / "1h2m26s" into milliseconds.
function parseRetryAfterMs(message) {
    const match = String(message || "").match(/try again in\s+([0-9hms.]+)/i);
    if (!match) return null;
    const token = match[1];
    let total = 0;
    const hours = token.match(/(\d+)h/);
    if (hours) total += Number(hours[1]) * 3600;
    const minutes = token.match(/(\d+)m(?!s)/);
    if (minutes) total += Number(minutes[1]) * 60;
    const seconds = token.match(/(\d+(?:\.\d+)?)s/);
    if (seconds) total += Number(seconds[1]);
    return total > 0 ? total * 1000 : null;
}

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

// Generic OpenAI-compatible provider (e.g. OpenRouter, NVIDIA NIM, Cerebras, DeepSeek).
// Configured via env so the user can add free model sources to the rotation pool.
function llmBaseUrl() {
    return (process.env.LLM_BASE_URL || "").trim();
}

function llmApiKey() {
    return (process.env.LLM_API_KEY || "").trim();
}

function llmModels() {
    const raw = (process.env.LLM_MODELS || "").trim();
    if (!raw) return [];
    return raw
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean);
}

// Each provider exposes an OpenAI-compatible chat completions endpoint + a model list.
function getProviders(config) {
    const providers = [
        {
            id: "groq",
            baseUrl: GROQ_API_URL,
            apiKey: groqApiKey(config),
            models: GROQ_MODELS,
        },
    ];

    const baseUrl = llmBaseUrl();
    const apiKey = llmApiKey();
    const models = llmModels();
    if (baseUrl && apiKey && models.length > 0) {
        providers.push({ id: "llm", baseUrl, apiKey, models });
    }
    return providers;
}

// Flat list of { providerId, baseUrl, apiKey, model } for the whole rotation pool.
// Only includes models whose provider actually has an API key configured.
function getAllPoolModels(config) {
    const pool = [];
    for (const p of getProviders(config)) {
        if (!p.apiKey) continue;
        for (const model of p.models) {
            pool.push({ providerId: p.id, baseUrl: p.baseUrl, apiKey: p.apiKey, model });
        }
    }
    return pool;
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

    return `Master cinema/drama subtitle translator. ${source} -> ${target}.
Rules: no profanity, never "Mày/Tao". Pronouns by context: romance Anh-Em (or Tôi-Cô), friends Tớ-Cậu/Tôi-Cậu, boss Sếp-Anh/Chị-Cậu/Cô/Em, enemies Hắn-Tôi/Ngươi-Ta/Ông-Tôi. Western: natural, avoid stiff Bạn/Tôi. Keep proper nouns. Concise, preserve tone.
Output: EXACTLY one translated line per input line, same order, newline-separated. No numbering, quotes, notes, blank lines,  IMD0th...ink blocks, or preamble.`;
}

async function translateGroqBatch(texts, config) {
    if (!texts || !Array.isArray(texts) || texts.length === 0) return [];

    const pool = getAllPoolModels(config);
    if (pool.length === 0) {
        // No usable key/model => we cannot translate. Throw so the caller serves a
        // Vietnamese notice instead of silently returning the source text.
        logger.error("Missing API key / model for translation");
        throw new Error("Missing API key for translation");
    }

    // Primary model first, then the rest of the pool (other Groq models + any generic LLM
    // provider models) as a fallback chain. ALL pool models are eligible — including
    // reasoning models — so an "available" model is always tried even if the primary is
    // rate-limited. Chunk size is chosen per model at attempt time (see translateChunkWithFallback).
    const primary = groqModel(config);
    const baseChain = [...pool.filter((m) => m.model === primary), ...pool.filter((m) => m.model !== primary)];

    // Batch unit = the primary model's preferred chunk size (large for non-reasoning).
    // Each batch is then sub-chunked per attempted model, so reasoning models still work.
    const batchChunkSize = chunkSizeForModel(primary);
    const batches = chunkArray(texts, batchChunkSize);
    let allTranslated = [];

    for (let i = 0; i < batches.length; i += 1) {
        if (i > 0) {
            await delay(1000);
        }
        // Round-robin the starting model per batch so quota is spread evenly across all
        // models/providers. Models in rate-limit cooldown are skipped entirely.
        const available = breaker.available(baseChain);
        const rotated = rotate(available, i % available.length);
        const context = allTranslated.slice(-3);
        const result = await translateChunkWithFallback(batches[i], config, rotated, context);
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

async function chatCompletion(endpoint, apiKey, model, systemInstruction, userPrompt) {
    const response = await fetch(endpoint, {
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
    return { response, data };
}

async function translateChunkWithFallback(batch, config, fallbackModels, previousTranslations) {
    const sourceLabel = languageLabel(config?.groqSourceLanguage || "en");
    const targetLabel = languageLabel(config?.groqTargetLanguage || config?.targetLanguage || "vi");
    const systemInstruction = buildSystemInstruction(config);

    const contextLines = Array.isArray(previousTranslations) ? previousTranslations.filter((t) => t).slice(-3) : [];
    const contextBlock =
        contextLines.length > 0
            ? `Context (already translated, for consistency only — do NOT repeat these in output):\n${contextLines.join("\n")}\n\n`
            : "";

    async function tryModel(entry) {
        const modelKey = `${entry.providerId}:${entry.model}`;
        if (breaker.isOpen(modelKey)) {
            logger.debug("skipping model in cooldown", { model: modelKey });
            return { ok: false, reason: "cooldown" };
        }

        const subChunkSize = chunkSizeForModel(entry.model);
        const subChunks = chunkArray(batch, subChunkSize);
        const out = [];

        for (const sub of subChunks) {
            const numbered = sub.map((line, idx) => `${idx + 1}. ${line}`).join("\n");
            const userPrompt = `${contextBlock}Translate each of the following ${sub.length} subtitle lines from ${sourceLabel} to ${targetLabel}. Output one translated line per input line, same order, no numbering, no extra text:\n\n${numbered}`;

            let { response, data } = await chatCompletion(
                entry.baseUrl,
                entry.apiKey,
                entry.model,
                systemInstruction,
                userPrompt,
            );

            if (response.status === 429) {
                const retryAfterMs = parseRetryAfterMs(data.error?.message);
                if (retryAfterMs !== null && retryAfterMs <= RETRY_BACKOFF_MAX_MS) {
                    logger.info("model rate-limited, retrying same model after backoff", {
                        backoffMs: retryAfterMs,
                        model: modelKey,
                    });
                    await delay(retryAfterMs);
                    ({ response, data } = await chatCompletion(
                        entry.baseUrl,
                        entry.apiKey,
                        entry.model,
                        systemInstruction,
                        userPrompt,
                    ));
                }
            }

            if (!response.ok) {
                if (response.status === 429) {
                    const retryAfterMs = parseRetryAfterMs(data.error?.message);
                    breaker.markRateLimited(modelKey, retryAfterMs ?? CIRCUIT_COOLDOWN_DEFAULT_MS);
                }
                logger.warn("model sub-chunk failed, will try next model", {
                    message: data.error?.message,
                    model: modelKey,
                    status: response.status,
                });
                return { ok: false, reason: "http_error" };
            }

            const content = data.choices?.[0]?.message?.content || "";
            const translatedLines = parseTranslations(content, sub.length);
            if (translatedLines.length !== sub.length) {
                logger.warn("line count mismatch, will try next model", {
                    expected: sub.length,
                    model: modelKey,
                    received: translatedLines.length,
                });
                return { ok: false, reason: "mismatch" };
            }
            out.push(...translatedLines);
        }

        breaker.markHealthy(modelKey);
        return { ok: true, translations: out };
    }

    for (let attempt = 0; attempt < fallbackModels.length; attempt += 1) {
        if (attempt > 0) {
            await delay(800);
        }
        const entry = fallbackModels[attempt];
        try {
            const result = await tryModel(entry);
            if (result.ok) {
                if (attempt > 0) {
                    logger.info("translation succeeded via fallback model", {
                        fallbackModel: `${entry.providerId}:${entry.model}`,
                        primaryModel: `${fallbackModels[0].providerId}:${fallbackModels[0].model}`,
                    });
                }
                return result.translations;
            }
        } catch (err) {
            logger.warn("fetch error, trying next model", {
                error: err.message,
                model: `${entry.providerId}:${entry.model}`,
            });
        }
    }

    logger.error("All models failed for batch", { batchSize: batch.length });
    throw new Error("All models failed for chunk");
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
    breaker,
    getProviders,
    groqApiKey,
    groqModel,
    parseRetryAfterMs,
    testGroqApiKey,
    translateGroqBatch,
};
