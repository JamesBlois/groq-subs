const { Buffer } = require("buffer");
const assert = require("assert");
const {
    clearGeneratedSubtitleCacheForTests,
    getCachedGeneratedSubtitle,
    getGeneratedSubtitleCacheStats,
    setCachedGeneratedSubtitle,
    setRedisClientForTests,
} = require("../lib/generated-subtitle-cache");

describe("generated subtitle cache", function () {
    let previousConsoleWarn;
    let previousRedisUrl;

    beforeEach(function () {
        previousConsoleWarn = console.warn;
        previousRedisUrl = process.env.REDIS_URL;
        console.warn = () => {};
        clearGeneratedSubtitleCacheForTests();
    });

    afterEach(function () {
        console.warn = previousConsoleWarn;
        if (previousRedisUrl === undefined) {
            delete process.env.REDIS_URL;
        } else {
            process.env.REDIS_URL = previousRedisUrl;
        }
        clearGeneratedSubtitleCacheForTests();
    });

    it("stores generated subtitles in memory when redis is unavailable", async function () {
        setRedisClientForTests(null);

        await setCachedGeneratedSubtitle("abc", "WEBVTT\n\ncached");

        assert.deepEqual(await getCachedGeneratedSubtitle("abc"), {
            source: "memory",
            vtt: "WEBVTT\n\ncached",
        });
    });

    it("reads generated subtitles from redis and warms memory", async function () {
        const client = createFakeRedisClient();
        setRedisClientForTests(client);

        await setCachedGeneratedSubtitle("abc", "WEBVTT\n\nredis");
        clearGeneratedSubtitleCacheForTests();
        setRedisClientForTests(client);

        assert.deepEqual(await getCachedGeneratedSubtitle("abc"), {
            source: "redis",
            vtt: "WEBVTT\n\nredis",
        });
        assert.deepEqual(await getCachedGeneratedSubtitle("abc"), {
            source: "memory",
            vtt: "WEBVTT\n\nredis",
        });
    });

    it("does not fail requests when redis writes fail", async function () {
        setRedisClientForTests({
            async get() {
                return null;
            },
            async set() {
                throw new Error("redis unavailable");
            },
        });

        await setCachedGeneratedSubtitle("abc", "WEBVTT\n\nfallback");

        assert.deepEqual(await getCachedGeneratedSubtitle("abc"), {
            source: "memory",
            vtt: "WEBVTT\n\nfallback",
        });
    });

    it("reports generated subtitle memory cache stats", async function () {
        setRedisClientForTests(null);

        await setCachedGeneratedSubtitle("abc", "WEBVTT\n\ncached");
        const stats = getGeneratedSubtitleCacheStats();

        assert.equal(stats.memoryEntryCount, 1);
        assert.equal(stats.memoryMaxBytes, 128 * 1024 * 1024);
        assert.equal(stats.memoryMaxEntries, 500);
        assert.equal(stats.memoryTtlSeconds, 24 * 60 * 60);
        assert.ok(stats.memoryCalculatedBytes > Buffer.byteLength("WEBVTT\n\ncached", "utf8"));
    });

    it("stores generated subtitles in redis for three days", async function () {
        const client = createFakeRedisClient();
        setRedisClientForTests(client);

        await setCachedGeneratedSubtitle("abc", "WEBVTT\n\nredis");

        assert.deepEqual(client.setCalls[0], {
            key: "stremio-double-subtitles:generated-subtitle:abc",
            options: { EX: 3 * 24 * 60 * 60 },
            value: "WEBVTT\n\nredis",
        });
    });

    it("treats a redis read failure as a cache miss", async function () {
        setRedisClientForTests({
            async get() {
                throw new Error("redis unavailable");
            },
            async set() {},
        });

        assert.equal(await getCachedGeneratedSubtitle("abc"), null);
    });

    it("returns null when redis has no entry for the key", async function () {
        setRedisClientForTests(createFakeRedisClient());

        assert.equal(await getCachedGeneratedSubtitle("missing"), null);
    });

    it("skips redis entirely when REDIS_URL is not configured", async function () {
        delete process.env.REDIS_URL;

        await setCachedGeneratedSubtitle("abc", "WEBVTT\n\nmemory-only");

        assert.deepEqual(await getCachedGeneratedSubtitle("abc"), {
            source: "memory",
            vtt: "WEBVTT\n\nmemory-only",
        });
        assert.equal(await getCachedGeneratedSubtitle("other"), null);
    });

    it("keeps serving from memory when the redis connection fails", async function () {
        // Port 1 is never listening, so connect() rejects and the cache degrades to memory only.
        process.env.REDIS_URL = "redis://127.0.0.1:1";

        await setCachedGeneratedSubtitle("abc", "WEBVTT\n\nno-redis");

        assert.deepEqual(await getCachedGeneratedSubtitle("abc"), {
            source: "memory",
            vtt: "WEBVTT\n\nno-redis",
        });
        assert.equal(await getCachedGeneratedSubtitle("other"), null);
    });
});

function createFakeRedisClient() {
    const values = new Map();

    const client = {
        setCalls: [],
        async get(key) {
            return values.get(key) || null;
        },
        async set(key, value, options) {
            this.setCalls.push({ key, options, value });
            values.set(key, value);
        },
    };

    return client;
}
