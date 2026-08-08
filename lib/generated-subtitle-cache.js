const { Buffer } = require("buffer");
const { createClient } = require("redis");
const { LRUCache } = require("lru-cache");
const logger = require("./logger");

const KEY_PREFIX = "stremio-double-subtitles";
const REDIS_CACHE_TTL_SECONDS = 3 * 24 * 60 * 60;
const MEMORY_CACHE_TTL_SECONDS = 24 * 60 * 60;
const MEMORY_CACHE_MAX_ENTRIES = 500;
const MEMORY_CACHE_MAX_BYTES = 128 * 1024 * 1024;
const MEMORY_CACHE_MAX_ENTRY_BYTES = 8 * 1024 * 1024;

const memoryCache = new LRUCache({
    max: MEMORY_CACHE_MAX_ENTRIES,
    maxSize: MEMORY_CACHE_MAX_BYTES,
    maxEntrySize: MEMORY_CACHE_MAX_ENTRY_BYTES,
    sizeCalculation: subtitleCacheEntrySize,
    ttl: MEMORY_CACHE_TTL_SECONDS * 1000,
    ttlAutopurge: true,
    updateAgeOnGet: false,
});

let redisClientPromise;
let testRedisClient;

async function getCachedGeneratedSubtitle(key) {
    const vttFromMemory = memoryCache.get(key);
    if (vttFromMemory) return { source: "memory", vtt: vttFromMemory };

    const client = await getRedisClient();
    if (!client) return null;

    try {
        const vtt = await client.get(`${KEY_PREFIX}:generated-subtitle:${key}`);
        if (!vtt) return null;

        memoryCache.set(key, vtt);
        return { source: "redis", vtt };
    } catch (error) {
        logger.warn("redis generated subtitle cache read failed", {
            error,
            key,
        });
        return null;
    }
}

async function setCachedGeneratedSubtitle(key, vtt) {
    memoryCache.set(key, vtt);

    const client = await getRedisClient();
    if (!client) return;

    try {
        await client.set(redisKey(key), vtt, { EX: REDIS_CACHE_TTL_SECONDS });
    } catch (error) {
        logger.warn("redis generated subtitle cache write failed", {
            error,
            key,
        });
    }
}

async function getRedisClient() {
    if (testRedisClient !== undefined) return testRedisClient;

    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) return null;

    if (!redisClientPromise) {
        const client = createClient({
            socket: {
                connectTimeout: 5000,
                reconnectStrategy: false,
            },
            url: redisUrl,
        });
        client.on("error", (error) => {
            logger.warn("redis generated subtitle cache error", { error });
        });
        redisClientPromise = client
            .connect()
            .then(() => {
                logger.info("redis generated subtitle cache connected");
                return client;
            })
            .catch((error) => {
                redisClientPromise = null;
                logger.warn("redis generated subtitle cache connection failed", { error });
                return null;
            });
    }

    return redisClientPromise;
}

function redisKey(key) {
    return `${KEY_PREFIX}:generated-subtitle:${key}`;
}

function subtitleCacheEntrySize(value, key) {
    return Buffer.byteLength(value, "utf8") + Buffer.byteLength(key, "utf8");
}

function getGeneratedSubtitleCacheStats() {
    return {
        memoryCalculatedBytes: memoryCache.calculatedSize,
        memoryEntryCount: memoryCache.size,
        memoryMaxBytes: memoryCache.maxSize,
        memoryMaxEntries: memoryCache.max,
        memoryTtlSeconds: memoryCache.ttl / 1000,
    };
}

function clearGeneratedSubtitleCacheForTests() {
    memoryCache.clear();
    redisClientPromise = null;
    testRedisClient = undefined;
}

function setRedisClientForTests(client) {
    testRedisClient = client;
}

module.exports = {
    clearGeneratedSubtitleCacheForTests,
    getCachedGeneratedSubtitle,
    getGeneratedSubtitleCacheStats,
    setCachedGeneratedSubtitle,
    setRedisClientForTests,
};
