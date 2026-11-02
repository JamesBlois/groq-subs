const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { streamChatCompletion } = require("../lib/llm-stream");
const { getSubtitleOptions } = require("../subtitle-service");

describe("stability regressions", function () {
    const originalFetch = global.fetch;
    afterEach(() => {
        global.fetch = originalFetch;
    });
    it("survives network failure after the timeout deadline", function () {
        const result = spawnSync(
            process.execPath,
            [
                "-e",
                `
            process.env.LLM_IDLE_TIMEOUT_MS='30';
            process.env.LLM_TOTAL_TIMEOUT_MS='60';
            global.fetch=async()=>{throw Error('network failure')};
            require('./lib/llm-stream').streamChatCompletion({endpoint:'https://example.test',apiKey:'test',model:'test',messages:[]}).catch(()=>{});
            setTimeout(()=>console.log('survived'),120);
        `,
            ],
            { cwd: require("node:path").resolve(__dirname, ".."), encoding: "utf8" },
        );
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /survived/);
    });
    it("rejects token-truncated streaming responses", async function () {
        global.fetch = async () =>
            new globalThis.Response(
                "data: " +
                    JSON.stringify({ choices: [{ delta: { content: "partial" }, finish_reason: "length" }] }) +
                    "\n\ndata: [DONE]\n\n",
            );
        await assert.rejects(
            streamChatCompletion({ endpoint: "https://example.test", apiKey: "test", model: "test", messages: [] }),
            /truncated/,
        );
    });
    it("isolates subtitle jobs by model and credential", async function () {
        global.fetch = async () =>
            new globalThis.Response(
                JSON.stringify({
                    subtitles: [{ id: "isolation", lang: "eng", url: "https://example.test/isolation.srt" }],
                }),
            );
        async function url(model, key) {
            const result = await getSubtitleOptions({
                id: "isolation",
                type: "movie",
                config: { sourceLang: "en", targetLang: "vi", groqModel: model, groqApiKey: key },
            });
            return result.subtitles[0].url;
        }
        const first = await url("llama-3.1-8b-instant", "test-a");
        assert.notEqual(first, await url("openai/gpt-oss-120b", "test-a"));
        assert.notEqual(first, await url("llama-3.1-8b-instant", "test-b"));
        assert.equal(first, await url("llama-3.1-8b-instant", "test-a"));
    });
});
