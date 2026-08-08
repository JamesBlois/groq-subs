const LEVELS = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

function debug(message, meta) {
    writeLog("debug", message, meta);
}

function info(message, meta) {
    writeLog("info", message, meta);
}

function warn(message, meta) {
    writeLog("warn", message, meta);
}

function error(message, meta) {
    writeLog("error", message, meta);
}

function writeLog(level, message, meta = {}) {
    if (LEVELS[level] < activeLevel()) return;

    const record = {
        time: new Date().toISOString(),
        level,
        message,
        ...normalizeMeta(meta),
    };

    const line = JSON.stringify(record);
    if (level === "error") {
        console.error(line);
        return;
    }

    if (level === "warn") {
        console.warn(line);
        return;
    }

    console.log(line);
}

function activeLevel() {
    return LEVELS[String(process.env.LOG_LEVEL || "info").toLowerCase()] || LEVELS.info;
}

function normalizeMeta(meta) {
    return Object.fromEntries(
        Object.entries(meta)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => [key, normalizeValue(value)]),
    );
}

function normalizeValue(value) {
    if (value instanceof Error) {
        return {
            name: value.name,
            message: value.message,
            stack: process.env.LOG_STACKS === "true" ? value.stack : undefined,
        };
    }

    return value;
}

module.exports = {
    debug,
    error,
    info,
    warn,
};
