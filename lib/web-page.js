const fs = require("fs");
const path = require("path");
const { LANGUAGES } = require("./languages");
const { GROQ_MODELS, DEFAULT_GROQ_MODEL } = require("./groq-translator");

const WEB_DIR = path.join(__dirname, "..", "web");
const template = fs.readFileSync(path.join(WEB_DIR, "index.html"), "utf8");

function renderConfigPage() {
    const defaultSource = "en";
    const defaultTarget = "vi";

    return template
        .replace("{{sourceOptions}}", languageOptions(defaultSource))
        .replace("{{targetOptions}}", languageOptions(defaultTarget))
        .replace("{{groqModelOptions}}", groqModelOptions(DEFAULT_GROQ_MODEL));
}

function renderStatusPage() {
    return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Groq Subs — Trạng thái dịch</title>
<link rel="stylesheet" href="/assets/styles.css" />
<link rel="icon" type="image/png" href="/public/favicon-96x96.png" sizes="96x96" />
</head>
<body>
<main class="shell">
<div class="dash">
<a class="back-link" href="/">← Quay lại trang cấu hình</a>
<h1>Trạng thái dịch / model quota</h1>
<div id="busyBanner" class="busy-banner hidden">⏳ Đang dịch phụ đề — vui lòng đợi. Tiến độ cập nhật trực tiếp bên dưới.</div>

<section class="dash-section">
<h2>Subtitle đang dịch</h2>
<div class="summary-row">
<span>Job đang chạy: <strong id="activeJobCount">0</strong></span>
<span class="muted">Cập nhật lúc: <span id="lastUpdate">—</span> (tự làm mới 2s)</span>
</div>
<div id="jobs" class="jobs-list"></div>
</section>

<section class="dash-section">
<h2>Cache phụ đề đã dịch</h2>
<div class="kv-grid">
<div><span class="muted">Số bản đã lưu</span><strong id="cacheEntries">—</strong></div>
<div><span class="muted">Dung lượng</span><strong id="cacheBytes">—</strong></div>
<div><span class="muted">Giới hạn</span><strong id="cacheMax">—</strong></div>
<div><span class="muted">Tự hết hạn</span><strong id="cacheTtl">—</strong></div>
</div>
<p class="dash-note">Bản dịch hoàn chỉnh được lưu vào cache (memory/redis) để lần lấy sau trả ngay lập tức. Bản dịch dở dang KHÔNG được cache — sẽ nối tiếp dịch ở lần tiếp theo.</p>
</section>

<section class="dash-section">
<h2>Model & quota</h2>
<div class="kv-grid">
<div><span class="muted">Model mặc định</span><strong id="defaultModel">—</strong></div>
<div><span class="muted">Groq API key</span><strong id="groqKey">—</strong></div>
</div>
<div id="models" class="models-status"></div>
<p class="dash-note">Model đang giới hạn tốc độ (429) sẽ bị tạm skip; addon tự fallback sang model khác. Kiểm tra chi tiết quota từng model ở <a href="/">trang cấu hình</a> → “Check models quota”.</p>
</section>
</div>
<script defer src="/assets/dashboard.js"></script>
</body>
</html>`;
}

function readWebAsset(assetName) {
    const safeName = path.basename(assetName);
    return fs.readFileSync(path.join(WEB_DIR, safeName), "utf8");
}

function languageOptions(selected) {
    return LANGUAGES.map(({ code, label }) => {
        const isSelected = code === selected ? " selected" : "";
        return `<option value="${escapeHtml(code)}"${isSelected}>${escapeHtml(label)}</option>`;
    }).join("");
}

function groqModelOptions(selected) {
    return GROQ_MODELS.map((model) => {
        const isSelected = model === selected ? " selected" : "";
        return `<option value="${escapeHtml(model)}"${isSelected}>${escapeHtml(model)}</option>`;
    }).join("");
}

function escapeHtml(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

module.exports = {
    readWebAsset,
    renderConfigPage,
    renderStatusPage,
};
