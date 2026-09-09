/**
 * find-tool.js — 工具自发现 (find_tool)
 *
 * 设计理念 (设计参考 9.3 find_tool 自发现):
 * - 不每轮把所有 80+ 工具都注入
 * - 当模型意识到需要某工具时，调用 FindTool 搜索
 * - 命中后下轮按需注入完整 schema
 *
 * 流程:
 * 1. FindTool(query) 返回匹配的 tool 列表（name + description）
 * 2. 调用方从结果中选 tool，记录到 _recentFoundTools 全局
 * 3. 下轮 buildToolDefinitions 看到 recentTools，把对应工具加进去
 * 4. 模型可以立即调用
 */

const { registry } = require('./registry');

// 跨调用共享的"最近发现工具"列表（被 buildToolDefinitions 消费）
const _recentFoundTools = [];
const MAX_RECENT = 10;

function markToolAsFound(toolNames) {
 if (!Array.isArray(toolNames)) return;
 for (const name of toolNames) {
 if (name && !_recentFoundTools.includes(name)) {
 _recentFoundTools.push(name);
 }
 }
 // 限制大小
 while (_recentFoundTools.length > MAX_RECENT) {
 _recentFoundTools.shift();
 }
}

function getRecentFoundTools() {
 return [..._recentFoundTools];
}

function clearRecentFoundTools() {
 _recentFoundTools.length = 0;
}

registry.register({
 name: 'FindTool',
 toolset: 'agent',
 category: 'meta',
 description: `工具自发现 — 当你需要某个工具但当前不在列表中时调用。
返回匹配的 tool 列表（含 name 和 description）。
下一轮该工具的完整 schema 会被自动注入到你的视野中。

用法示例:
 - "我需要一个翻译工具" → FindTool(query="翻译")
 - "怎么压缩文件" → FindTool(query="压缩 archive")
 - "查 PDF 工具" → FindTool(query="pdf")

返回结果示例:
[
 { "name": "Bash", "description": "...", "toolset": "system" },
 { "name": "Read", "description": "...", "toolset": "file" }
]`,
 schema: {
 type: 'object',
 properties: {
 query: {
 type: 'string',
 description: '工具搜索关键词（中文或英文），可用空格分隔多词',
 },
 limit: {
 type: 'number',
 description: '返回结果数量上限，默认 5',
 default: 5,
 },
 },
 required: ['query'],
 },
 isReadOnly: true,
 isDangerous: false,
 timeout: 5000,
 handler: async (params) => {
 const { query, limit } = params;
 const matches = registry.search(query, { limit: limit || 5 });

 // 命中后把工具名加到"最近发现"列表，下轮 buildToolDefinitions 会读
 if (matches.length > 0) {
 markToolAsFound(matches.map(m => m.name));
 }

 if (matches.length === 0) {
 return {
 success: true,
 query,
 matches: [],
 message: `未找到与 "${query}" 相关的工具。可尝试更宽泛的关键词，或先告知用户该能力暂未提供。`,
 };
 }

 return {
 success: true,
 query,
 count: matches.length,
 matches,
 message: `找到 ${matches.length} 个匹配工具，下一轮它们的完整 schema 会被注入。请在下一轮直接调用。`,
 };
 },
});

module.exports = {
 markToolAsFound,
 getRecentFoundTools,
 clearRecentFoundTools,
};
