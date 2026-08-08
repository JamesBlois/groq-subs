const { createApp } = require("../server");

const app = createApp();

module.exports = (req, res) => {
    app(req, res);
};
