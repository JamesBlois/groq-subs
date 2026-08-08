// Monotonic elapsed-time helpers shared by request logging, metrics and job timing.

function startTimer() {
    return process.hrtime.bigint();
}

function elapsedSeconds(startedAt) {
    return Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
}

function elapsedMs(startedAt) {
    return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

module.exports = {
    elapsedMs,
    elapsedSeconds,
    startTimer,
};
