const assert = require("assert");
const { getSubtitleConfig } = require("../lib/config");
const { batchLimits, translateCues, translationProvider } = require("../lib/translator");
const { breaker } = require("../lib/groq-translator");

describe("translator batching", function () {
    const config = getSubtitleConfig({ groqApiKey: "gsk_test", sourceLang: "en", targetLang: "vi" });
    let previousFetch;

    beforeEach(function () {
        previousFetch = global.fetch;
        // Other suites rate-limit every model; a cooling-down model is skipped, not called.
        breaker.reset();
    });

    afterEach(function () {
        global.fetch = previousFetch;
    });

    it("always reports groq as the provider with its batch limits", function () {
        assert.equal(translationProvider(config), "groq");
        assert.deepEqual(batchLimits(config), { chars: 50000, texts: 100 });
        assert.deepEqual(batchLimits({ translationProvider: "unknown" }), batchLimits(config));
    });

    it("splits cues into batches of at most 100 texts", async function () {
        // translateGroqBatch waits a second between batches to be gentle on the Groq quota.
        this.timeout(10000);
        const cues = Array.from({ length: 101 }, (unused, index) => ({ text: `line ${index}` }));
        const batches = stubGroq();

        const { complete, translations } = await translateCues(cues, config);

        assert.equal(complete, true);
        assert.deepEqual(
            batches.map((batch) => batch.length),
            [100, 1],
        );
        assert.equal(translations.length, 101);
        assert.equal(translations[100], "dịch 1");
    });

    it("starts a new batch before exceeding the character budget", async function () {
        const cues = [{ text: "a".repeat(30000) }, { text: "b".repeat(30000) }];
        const batches = stubGroq();

        await translateCues(cues, config);

        assert.deepEqual(
            batches.map((batch) => batch.length),
            [1, 1],
        );
    });

    it("keeps empty cues empty and does not send them to Groq", async function () {
        const cues = [{ text: "   " }, { text: "<i></i>" }, { text: "Hello" }];
        const progress = new Array(cues.length);
        const batches = stubGroq();

        const { complete, translations } = await translateCues(cues, config, progress);

        assert.equal(complete, true);
        assert.deepEqual(batches, [["Hello"]]);
        assert.deepEqual(translations, ["", "", "dịch 1"]);
        assert.deepEqual(progress, ["", "", "dịch 1"]);
    });

    it("ignores a progress array that does not match the cue count", async function () {
        const cues = [{ text: "Hello" }, { text: "World" }];
        const progress = ["stale"];
        stubGroq();

        const { translations } = await translateCues(cues, config, progress);

        assert.deepEqual(translations, ["dịch 1", "dịch 2"]);
        assert.deepEqual(progress, ["stale"]);
    });

    it("makes no Groq calls when there is nothing to translate", async function () {
        const batches = stubGroq();

        assert.deepEqual(await translateCues([], config), { complete: true, translations: [] });
        assert.deepEqual(batches, []);
    });

    // Answers every batch with correctly numbered lines and records the texts it received.
    function stubGroq() {
        const batches = [];

        global.fetch = async (url, options) => {
            const body = JSON.parse(options.body);
            const texts = body.messages[body.messages.length - 1].content
                .split("\n")
                .filter((line) => /^\d+\.\s/.test(line));
            batches.push(texts.map((line) => line.replace(/^\d+\.\s/, "")));

            return {
                ok: true,
                async json() {
                    return {
                        choices: [
                            {
                                message: {
                                    content: texts.map((unused, index) => `${index + 1}. dịch ${index + 1}`).join("\n"),
                                },
                            },
                        ],
                    };
                },
            };
        };

        return batches;
    }
});
