# Groq Subs

Fetches subtitles from the public Stremio OpenSubtitles v3 addon, translates them with the **Groq API**, merges them together and serves generated WebVTT subtitles to Stremio. A Groq API key is required.

The translation prompt follows high-quality cinema/Asian-drama subtitle rules (Vietnamese-ized): translate only the actual dialogue/lyrics (not on-screen text), preserve meaning/context/emotion/personality, use natural localized phrasing, consistent context-appropriate pronouns (Anh-Em, Tớ-Cậu, Tôi-Anh, Hắn-Tôi...), avoid "Mày-Tao" and profanity while keeping emotional intensity, no extra narration or invented details, and concise TTS-friendly output. Subtitle numbers, timestamps, formatting tags and segment structure are preserved exactly (never merged/split/recalculated), and strict 1:1 cue alignment is enforced so translations never drift out of sync with the video. Priority: Meaning → Context → Character voice → Natural Vietnamese → Consistent pronouns → Subtitle format.

![Screenshot of web interface](img/screenshot.webp "Stremio with double subtitles")

## Setup

Install dependencies:

```bash
pnpm install
```

Set your Groq API key (optional in env, or enter it in the web UI):

```bash
cp .env.example .env
# edit .env and set GROQ_API_KEY=...
```

## Run

```bash
pnpm start
```

Open the local web interface, choose source/target languages, pick a Groq model, paste your Groq API key and (optionally) click **Test API key**:

```text
http://127.0.0.1:53100/
```

Install it on Stremio using instructions from the web interface.

The generated subtitle is one double subtitle: source language on top, translated language on the bottom.

### Groq models

The addon supports selecting one of these models (the selected one becomes the default for that configured addon instance):

- `groq/compound-mini`
- `llama-3.1-8b-instant`
- `llama-3.3-70b-versatile` (default)
- `openai/gpt-oss-120b`
- `openai/gpt-oss-20b`
- `qwen/qwen3.6-27b`

### Test API key

`GET /test-groq?apiKey=<base64url-key>&model=<model>` verifies the Groq API key by sending a minimal request to the Groq Chat Completions API.

### Docker

```bash
docker run -p 53100:53100 -e GROQ_API_KEY=... ghcr.io/awerks/stremio-double-subtitles:latest
```

then open the local web interface.

## Deploy (Render / Vercel / Railway)

- Set `GROQ_API_KEY` to your Groq API key.
- The public URL is **auto-detected** from the request (`x-forwarded-proto`/`x-forwarded-host`), so you usually do not need to set it. If you use a custom domain or the auto-detection does not work, set `PUBLIC_URL` (e.g. `https://groq-subs.onrender.com`).
- Optionally set `GROQ_MODEL` to a non-default model (same list as the web dropdown).
- Free-tier Groq rate limits apply per model; the addon round-robins across models and resumes partial translations to stay within quota.

## Extra free model sources (optional)

To add more free translation capacity (and avoid Groq rate limits), configure an
OpenAI-compatible provider via env. Its models join the Groq models in the rotation
pool, so when Groq is rate-limited the addon falls back to these models.

- `LLM_BASE_URL` — chat completions endpoint (OpenAI-compatible).
- `LLM_API_KEY` — key for that provider.
- `LLM_MODELS` — comma-separated model IDs to use.

Examples:

**OpenRouter** (15+ free models, one key, no credit card — `https://openrouter.ai/keys`):

```env
LLM_BASE_URL=https://openrouter.ai/api/v1/chat/completions
LLM_API_KEY=sk-or-...
LLM_MODELS=openai/gpt-oss-20b:free,nvidia/nemotron-3-nano-9b-v2:free,google/gemma-4-26b-a4b-it:free
```

**NVIDIA NIM** (120+ free models incl. GLM, DeepSeek, Qwen — `https://build.nvidia.com`):

```env
LLM_BASE_URL=https://integrate.api.nvidia.com/v1/chat/completions
LLM_API_KEY=nvapi-...
LLM_MODELS=zhipuai/glm-5.2,deepseek-ai/deepseek-r1,qwen/qwen3-235b
```

Check availability and quota from the web UI ("Check models quota") or `GET /status`.

## Operational endpoints

`GET /metrics` (Prometheus) and `GET /status` expose operational detail (in-flight jobs, source
subtitle URLs, provider configuration) and are not public:

- With `METRICS_TOKEN` set, both require `Authorization: Bearer <METRICS_TOKEN>`. Set it on any
  deployment that is reachable from the internet.
- Without `METRICS_TOKEN`, they are served only to callers on a private/loopback network.

`GET /test-groq` and `GET /models-status` spend Groq quota, so they only fall back to the
server's `GROQ_API_KEY` for private/loopback callers; remote callers must supply their own key
via `?apiKey=<base64url-key>`.

### Streaming & timeouts (large models)

Translation and the "Check models" probe both use **streaming** (`stream: true`). Large hosted
models (NVIDIA NIM: Nemotron, MiniMax, GLM, DeepSeek) have a long time-to-first-token; a
non-streaming request waits for the whole completion before the first byte, so it times out even
while the provider is still generating. Streaming flushes tokens immediately, keeping the
connection alive — a slow-but-live model reports as available and translates successfully instead
of showing "⏱ Hết giờ".

If a connection goes truly dead, an idle/total timeout aborts it so the addon falls back to the
next model instead of hanging forever. Tune via env (milliseconds):

- `LLM_IDLE_TIMEOUT_MS` (default `60000`) — max gap between stream tokens.
- `LLM_TOTAL_TIMEOUT_MS` (default `180000`) — hard ceiling for one request.
- `PROBE_TIMEOUT_MS` (default `20000`) — per-model dashboard probe (time to first token).
