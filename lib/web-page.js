const fs = require("fs");
const path = require("path");
const { escapeHtml } = require("./escape");
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

module.exports = {
    readWebAsset,
    renderConfigPage,
};
