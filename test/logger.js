const assert = require("assert");
const logger = require("../lib/logger");

describe("logger", function () {
    let lines;
    let previousConsole;
    let previousLogLevel;
    let previousLogStacks;

    beforeEach(function () {
        lines = { error: [], log: [], warn: [] };
        previousConsole = { error: console.error, log: console.log, warn: console.warn };
        previousLogLevel = process.env.LOG_LEVEL;
        previousLogStacks = process.env.LOG_STACKS;
        console.error = (line) => lines.error.push(line);
        console.log = (line) => lines.log.push(line);
        console.warn = (line) => lines.warn.push(line);
    });

    afterEach(function () {
        Object.assign(console, previousConsole);
        restoreEnv("LOG_LEVEL", previousLogLevel);
        restoreEnv("LOG_STACKS", previousLogStacks);
    });

    it("writes each level to its console stream", function () {
        process.env.LOG_LEVEL = "debug";

        logger.debug("d");
        logger.info("i");
        logger.warn("w");
        logger.error("e");

        assert.deepEqual(
            lines.log.map((line) => JSON.parse(line).level),
            ["debug", "info"],
        );
        assert.equal(JSON.parse(lines.warn[0]).level, "warn");
        assert.equal(JSON.parse(lines.error[0]).level, "error");
    });

    it("emits a timestamped json record with its metadata", function () {
        process.env.LOG_LEVEL = "info";

        logger.info("http request", { path: "/manifest.json", statusCode: 200, undefinedField: undefined });

        const record = JSON.parse(lines.log[0]);
        assert.equal(record.message, "http request");
        assert.equal(record.path, "/manifest.json");
        assert.equal(record.statusCode, 200);
        assert.ok(!("undefinedField" in record));
        assert.ok(!Number.isNaN(Date.parse(record.time)));
    });

    it("drops records below the active level", function () {
        process.env.LOG_LEVEL = "warn";

        logger.debug("d");
        logger.info("i");
        logger.warn("w");

        assert.deepEqual(lines.log, []);
        assert.equal(lines.warn.length, 1);
    });

    it("falls back to info for an unknown level", function () {
        process.env.LOG_LEVEL = "verbose";

        logger.debug("d");
        logger.info("i");

        assert.deepEqual(
            lines.log.map((line) => JSON.parse(line).level),
            ["info"],
        );
    });

    it("serializes errors and only includes stacks when asked", function () {
        process.env.LOG_LEVEL = "info";
        delete process.env.LOG_STACKS;

        logger.warn("redis failed", { error: new Error("boom") });
        assert.deepEqual(JSON.parse(lines.warn[0]).error, { name: "Error", message: "boom" });

        process.env.LOG_STACKS = "true";
        logger.warn("redis failed", { error: new Error("boom") });
        assert.match(JSON.parse(lines.warn[1]).error.stack, /Error: boom/);
    });
});

function restoreEnv(name, value) {
    if (value === undefined) {
        delete process.env[name];
        return;
    }

    process.env[name] = value;
}
