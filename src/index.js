const path = require("path");
const fs = require("fs");
function buildTool(name, config) {
  return { name, description: config.description || "", handler: config.handler || (async () => ({ success: true })), schema: config.schema || {} };
}
function loadTools(dir) {
  const tools = {};
  const toolsDir = dir || path.join(__dirname, "tools");
  if (fs.existsSync(toolsDir)) {
    for (const entry of fs.readdirSync(toolsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".js") && entry.name !== "index.js") {
        try { Object.assign(tools, require(path.join(toolsDir, entry.name))); } catch (e) { console.warn('[tools] 加载工具模块失败:', entry.name, e?.message); }
      }
    }
  }
  return tools;
}
module.exports = { buildTool, loadTools };
