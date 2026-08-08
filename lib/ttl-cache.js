const { LRUCache } = require("lru-cache");

// Bounded cache whose entries expire after `ttlSeconds` and whose TTL is refreshed on access.
function createTtlCache({ max, ttlSeconds }) {
    return new LRUCache({
        max,
        ttl: ttlSeconds * 1000,
        updateAgeOnGet: true,
    });
}

module.exports = {
    createTtlCache,
};
