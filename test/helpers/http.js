const http = require("http");

async function getJson(url) {
    return JSON.parse(await getText(url));
}

async function getText(url) {
    const response = await getResponse(url);

    if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`${response.statusCode}: ${response.body}`);
    }

    return response.body;
}

function getResponse(url, options = {}) {
    return new Promise((resolve, reject) => {
        http.get(url, options, (response) => {
            let body = "";

            response.setEncoding("utf8");
            response.on("data", (chunk) => {
                body += chunk;
            });
            response.on("end", () => {
                resolve({
                    body,
                    headers: response.headers,
                    statusCode: response.statusCode,
                });
            });
        }).on("error", reject);
    });
}

module.exports = {
    getJson,
    getResponse,
    getText,
};
