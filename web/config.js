const form = document.getElementById("configForm");
const source = document.getElementById("sourceLang");
const target = document.getElementById("targetLang");
const groqModel = document.getElementById("groqModel");
const groqApiKey = document.getElementById("groqApiKey");
const copyButton = document.getElementById("copyManifest");
const openStremioWebButton = document.getElementById("openStremioWeb");
const copyStatus = document.getElementById("copyStatus");
const testButton = document.getElementById("testApiKey");
const testStatus = document.getElementById("testStatus");
const checkModelsButton = document.getElementById("checkModels");
const modelsStatusDiv = document.getElementById("modelsStatus");
const installButton = form.querySelector('button[type="submit"]');

const STORAGE_KEY = "groq-subs-config";
// Whether the current field values have been verified by a successful Test API key call.
// Install / copy / Stremio Web are only allowed once this is true, so the installed addon
// always uses a config whose API key is known to work.
let configVerified = false;

function currentConfig() {
    return {
        source: source.value,
        target: target.value,
        model: groqModel.value,
        apiKey: groqApiKey.value.trim(),
    };
}

function saveConfig() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(currentConfig()));
    } catch {
        // localStorage may be unavailable (private mode); saving is best-effort.
    }
}

function restoreConfig() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
        if (!saved) return;
        if (saved.source) source.value = saved.source;
        if (saved.target) target.value = saved.target;
        if (saved.model) groqModel.value = saved.model;
        if (saved.apiKey) groqApiKey.value = saved.apiKey;
    } catch {
        // ignore malformed storage
    }
}

function manifestUrl() {
    const baseUrl = `${location.origin}/configure/${encodeURIComponent(source.value)}/${encodeURIComponent(target.value)}`;
    const key = groqApiKey.value.trim();
    if (!key) return `${baseUrl}/manifest.json`;
    return `${baseUrl}/groq/${encodeURIComponent(groqModel.value)}/${encodeProviderKey(key)}/manifest.json`;
}

function stremioWebUrl() {
    return `https://web.stremio.com/#/addons?addon=${encodeURIComponent(manifestUrl())}`;
}

function updateInstallState() {
    // Block install/copy/web until the config has been verified with Test API key.
    const blocked = !configVerified;
    installButton.disabled = blocked;
    copyButton.disabled = blocked;
    openStremioWebButton.disabled = blocked;
    if (blocked) {
        installButton.textContent = "Bấm Test API key trước khi cài";
    } else {
        installButton.textContent = "Install configured addon";
    }
}

function updateView() {
    copyStatus.textContent = "";
}

form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!requireVerified()) return;
    saveConfig();
    location.href = manifestUrl().replace(/^https?:\/\//, "stremio://");
});

copyButton.addEventListener("click", async () => {
    if (!requireVerified()) return;
    saveConfig();
    try {
        await copyText(manifestUrl());
        copyStatus.textContent = "Copied";
    } catch {
        copyStatus.textContent = "Copy failed";
    }
});

openStremioWebButton.addEventListener("click", () => {
    if (!requireVerified()) return;
    saveConfig();
    location.href = stremioWebUrl();
});

testButton.addEventListener("click", async () => {
    const key = groqApiKey.value.trim();
    if (!key) {
        testStatus.textContent = "Vui lòng nhập Groq API key";
        testStatus.className = "test-status error";
        return;
    }

    testButton.disabled = true;
    testStatus.textContent = "Đang kiểm tra...";
    testStatus.className = "test-status";

    try {
        const url = `${location.origin}/test-groq?apiKey=${encodeProviderKey(key)}&model=${encodeURIComponent(groqModel.value)}`;
        const data = await fetchJson(url);
        if (data.ok) {
            // A 429 means the key is valid but the chosen model is rate-limited right now. The
            // addon still works (it falls back across models), so we keep config verified but
            // show a warning instead of pretending everything is green.
            if (data.rateLimited) {
                testStatus.textContent = `⚠ ${data.message}`;
                testStatus.className = "test-status warn";
            } else {
                testStatus.textContent = `✓ ${data.message} (model: ${data.model})`;
                testStatus.className = "test-status success";
            }
            // Test succeeded: persist this config and unlock install so the installed addon
            // always uses the latest verified configuration.
            configVerified = true;
            saveConfig();
            updateInstallState();
        } else {
            testStatus.textContent = `✗ ${data.message || "API key không hợp lệ"}`;
            testStatus.className = "test-status error";
            configVerified = false;
            updateInstallState();
        }
    } catch (err) {
        testStatus.textContent = `✗ Lỗi: ${err.message}`;
        testStatus.className = "test-status error";
        configVerified = false;
        updateInstallState();
    } finally {
        testButton.disabled = false;
    }
});

// A failing endpoint can answer with an error status or a non-JSON body (proxy/HTML error page).
// response.json() alone turns both into an opaque parse error, so the page reported a "connection"
// problem for what was really a server error. Report the status and body instead.
async function fetchJson(url) {
    const response = await fetch(url);
    const body = await response.text();

    let data;
    try {
        data = body ? JSON.parse(body) : null;
    } catch {
        throw new Error(`${response.status} ${response.statusText}: ${body.slice(0, 160)}`);
    }

    if (!response.ok && !data?.message && !data?.models) {
        throw new Error(data?.error || `${response.status} ${response.statusText}`);
    }
    if (!data) throw new Error(`Empty response (${response.status})`);
    return data;
}

function requireVerified() {
    if (!configVerified) {
        copyStatus.textContent = "Vui lòng bấm Test API key thành công trước khi cài đặt";
        copyStatus.className = "copy-status error";
        return false;
    }
    return true;
}

checkModelsButton.addEventListener("click", async () => {
    const key = groqApiKey.value.trim();
    if (!key) {
        testStatus.textContent = "Vui lòng nhập Groq API key";
        testStatus.className = "test-status error";
        return;
    }

    checkModelsButton.disabled = true;
    modelsStatusDiv.classList.remove("hidden");
    modelsStatusDiv.innerHTML = '<span class="test-status">Đang kiểm tra từng model...</span>';

    try {
        const url = `${location.origin}/models-status?apiKey=${encodeProviderKey(key)}`;
        const data = await fetchJson(url);
        if (!data.models) {
            modelsStatusDiv.innerHTML = `<span class="test-status error">✗ ${data.error || "Lỗi"}</span>`;
            return;
        }

        const rows = data.models
            .map((m) => {
                const labels = {
                    available: { text: "✓ Khả dụng", cls: "model-ok" },
                    rate_limited: { text: "⏳ Giới hạn tốc độ", cls: "model-warn" },
                    blocked: { text: "⛔ Bị chặn", cls: "model-bad" },
                    invalid_key: { text: "✗ Key sai", cls: "model-bad" },
                    timeout: { text: "⏱ Hết giờ", cls: "model-warn" },
                    error: { text: "✗ Lỗi", cls: "model-bad" },
                    unknown: { text: "? Không rõ", cls: "model-warn" },
                };
                const lbl = labels[m.state] || labels.unknown;
                const cooldown = m.circuitOpen ? ' <span class="model-cooldown">(cooldown)</span>' : "";
                return `<div class="model-row ${lbl.cls}"><span class="model-name">${m.provider}:${m.model}</span><span class="model-state">${lbl.text}${cooldown}</span></div>`;
            })
            .join("");

        const cacheNote = data.cached ? '<span class="model-cooldown">(cache 30s)</span>' : "";
        const rec = data.recommendation
            ? `<div class="model-recommend">Khuyên dùng: <strong>${data.recommendation.provider}:${data.recommendation.model}</strong> (còn quota) ${cacheNote}</div>`
            : `<div class="model-recommend model-bad">Tất cả model đều bị giới hạn — thử lại sau vài phút. ${cacheNote}</div>`;

        modelsStatusDiv.innerHTML = rec + rows;
    } catch (err) {
        modelsStatusDiv.innerHTML = `<span class="test-status error">✗ Lỗi: ${err.message}</span>`;
    } finally {
        checkModelsButton.disabled = false;
    }
});

// Any field change invalidates the previous verification (the saved config may no longer match).
function markDirty() {
    configVerified = false;
    updateInstallState();
    testStatus.textContent = "";
    testStatus.className = "test-status";
}

source.addEventListener("change", markDirty);
target.addEventListener("change", markDirty);
groqModel.addEventListener("change", markDirty);
groqApiKey.addEventListener("input", markDirty);

restoreConfig();
updateView();
updateInstallState();

function encodeProviderKey(value) {
    return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function copyText(value) {
    if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
        return;
    }
}
