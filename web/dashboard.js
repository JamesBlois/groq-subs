// Live translation status dashboard for Groq Subs.
// Polls /status.json every 2s and renders: active jobs (with progress bars), the cache,
// and per-model circuit-breaker state. Pure vanilla JS, no dependencies.

const POLL_MS = 2000;

const $ = (id) => document.getElementById(id);

function fmtBytes(n) {
    if (!n && n !== 0) return "—";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtTime(ms) {
    if (!ms) return "—";
    const d = new Date(ms);
    return d.toLocaleTimeString();
}

function stateMeta(state) {
    switch (state) {
        case "translating":
            return { text: "Đang dịch…", cls: "state-busy" };
        case "partial":
            return { text: "Chưa dịch xong (đã lưu tiến độ)", cls: "state-warn" };
        case "complete":
            return { text: "Hoàn tất", cls: "state-ok" };
        case "failed":
            return { text: "Lỗi", cls: "state-bad" };
        case "queued":
        default:
            return { text: "Chờ dịch", cls: "state-warn" };
    }
}

function videoLabel(job) {
    if (job.videoId) {
        const id = String(job.videoId).split(":")[0];
        return `<a class="vid-link" href="https://www.imdb.com/title/${encodeURIComponent(
            id,
        )}/" target="_blank" rel="noreferrer">${escapeHtml(job.videoId)}</a>`;
    }
    return `<span class="muted">—</span>`;
}

function renderJob(job) {
    const meta = stateMeta(job.state);
    const pct = job.percent || 0;
    const barCls = job.state === "failed" ? "bar-bad" : job.state === "partial" ? "bar-warn" : "bar-ok";
    const errorRow = job.error ? `<div class="job-error">✗ ${escapeHtml(job.error)}</div>` : "";
    const model = job.config?.groqModel || "—";
    const src = job.config?.sourceLanguage || "—";
    const tgt = job.config?.targetLanguage || "—";

    return `
        <div class="job-card">
            <div class="job-head">
                <span class="job-title">${escapeHtml(job.videoId || job.title)}</span>
                <span class="job-state ${meta.cls}">${meta.text}</span>
            </div>
            <div class="job-meta">
                <span><strong>Loại:</strong> ${escapeHtml(job.videoType || "—")}</span>
                <span><strong>Video:</strong> ${videoLabel(job)}</span>
                <span><strong>Sub nguồn:</strong> ${escapeHtml(job.subtitleId || "—")}</span>
                <span><strong>Ngôn ngữ:</strong> ${escapeHtml(src)} → ${escapeHtml(tgt)}</span>
                <span><strong>Model:</strong> <code>${escapeHtml(model)}</code></span>
                <span><strong>Cập nhật:</strong> ${fmtTime(job.updatedAt)}</span>
            </div>
            <div class="progress-track" title="${job.translatedCues}/${job.cueCount} dòng đã dịch">
                <div class="progress-fill ${barCls}" style="width:${pct}%"></div>
            </div>
            <div class="progress-label">
                Đã dịch <strong>${job.translatedCues}</strong> / <strong>${job.cueCount}</strong> dòng
                <span class="muted">(${pct}%)</span>
            </div>
            ${errorRow}
        </div>`;
}

function renderModelRow(m) {
    const labels = {
        available: { text: "✓ Khả dụng", cls: "state-ok" },
        rate_limited: { text: "⏳ Giới hạn tốc độ", cls: "state-warn" },
        blocked: { text: "⛔ Bị chặn", cls: "state-bad" },
        invalid_key: { text: "✗ Key sai", cls: "state-bad" },
        timeout: { text: "⏱ Hết giờ", cls: "state-warn" },
        error: { text: "✗ Lỗi", cls: "state-bad" },
        unknown: { text: "? Không rõ", cls: "state-warn" },
    };
    // The /status.json models only carry circuitOpen; derive state from it.
    const state = m.circuitOpen ? "rate_limited" : "available";
    const lbl = labels[state] || labels.unknown;
    return `<div class="model-row"><span class="model-name">${escapeHtml(m.provider)}:${escapeHtml(
        m.model,
    )}</span><span class="model-state ${lbl.cls}">${lbl.text}</span></div>`;
}

function renderEmpty(message) {
    return `<div class="empty">${escapeHtml(message)}</div>`;
}

async function poll() {
    try {
        const res = await fetch("/status.json");
        const data = await res.json();
        const jobs = (data.jobs && data.jobs.jobs) || [];
        const jobsEl = $("jobs");
        if (!jobs.length) {
            jobsEl.innerHTML = renderEmpty(
                "Hiện không có subtitle nào đang dịch. Mở một video trong Stremio và chọn Groq Subs để bắt đầu.",
            );
        } else {
            jobsEl.innerHTML = jobs.map(renderJob).join("");
        }
        $("activeJobCount").textContent = String(data.jobs?.activeJobCount ?? 0);

        const cache = data.cache || {};
        $("cacheEntries").textContent = String(cache.memoryEntryCount ?? 0);
        $("cacheBytes").textContent = fmtBytes(cache.memoryCalculatedBytes);
        $("cacheMax").textContent = fmtBytes(cache.memoryMaxBytes);
        $("cacheTtl").textContent = `${(cache.memoryTtlSeconds || 0) / 3600}h`;

        const providers = data.providers || [];
        const modelsHtml = providers
            .flatMap((p) =>
                (p.models || []).map((m) => ({ provider: p.id, model: m.model, circuitOpen: m.circuitOpen })),
            )
            .map(renderModelRow)
            .join("");
        $("models").innerHTML = modelsHtml || renderEmpty("Không có model nào được cấu hình (thiếu GROQ_API_KEY).");

        $("defaultModel").textContent = data.defaultModel || "—";
        $("groqKey").textContent = data.groqApiKeyConfigured ? "✓ đã cấu hình" : "✗ chưa cấu hình";
        $("groqKey").className = data.groqApiKeyConfigured ? "state-ok" : "state-bad";

        $("lastUpdate").textContent = new Date().toLocaleTimeString();
        const anyBusy = jobs.some((j) => j.state === "translating");
        $("busyBanner").classList.toggle("hidden", !anyBusy);
    } catch (err) {
        $("lastUpdate").textContent = `lỗi: ${err.message}`;
    }
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

poll();
setInterval(poll, POLL_MS);
