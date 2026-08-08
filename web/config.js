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

function manifestUrl() {
    const baseUrl = `${location.origin}/configure/${encodeURIComponent(source.value)}/${encodeURIComponent(target.value)}`;
    const key = groqApiKey.value.trim();
    if (!key) return `${baseUrl}/manifest.json`;
    return `${baseUrl}/groq/${encodeURIComponent(groqModel.value)}/${encodeProviderKey(key)}/manifest.json`;
}

function stremioWebUrl() {
    return `https://web.stremio.com/#/addons?addon=${encodeURIComponent(manifestUrl())}`;
}

function updateView() {
    copyStatus.textContent = "";
}

form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!validateConfig()) return;

    location.href = manifestUrl().replace(/^https?:\/\//, "stremio://");
});

copyButton.addEventListener("click", async () => {
    if (!validateConfig()) return;

    try {
        await copyText(manifestUrl());
        copyStatus.textContent = "Copied";
    } catch {
        copyStatus.textContent = "Copy failed";
    }
});

openStremioWebButton.addEventListener("click", () => {
    if (!validateConfig()) return;

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
        const response = await fetch(url);
        const data = await response.json();
        if (data.ok) {
            testStatus.textContent = `✓ ${data.message} (model: ${data.model})`;
            testStatus.className = "test-status success";
        } else {
            testStatus.textContent = `✗ ${data.message || "API key không hợp lệ"}`;
            testStatus.className = "test-status error";
        }
    } catch (err) {
        testStatus.textContent = `✗ Lỗi kết nối: ${err.message}`;
        testStatus.className = "test-status error";
    } finally {
        testButton.disabled = false;
    }
});

source.addEventListener("change", updateView);
target.addEventListener("change", updateView);
groqModel.addEventListener("change", updateView);
groqApiKey.addEventListener("input", updateView);
updateView();

function encodeProviderKey(value) {
    return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function validateConfig() {
    if (source.value === target.value) {
        copyStatus.textContent = "Chọn ngôn ngữ nguồn và đích khác nhau";
        return false;
    }

    return true;
}

async function copyText(value) {
    if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
        return;
    }
}
