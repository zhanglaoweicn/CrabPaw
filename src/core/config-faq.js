'use strict';

/**
 * config-faq.js — 配置 FAQ 智能问答
 *
 * 设计参考 的配置助手：
 * - 内置配置项 FAQ 知识库（默认 provider、路径、端口等）
 * - 基于关键词 + 模糊匹配 + 概念指纹
 * - 返回 top 条目（含：问题/答案/相关配置路径/默认值）
 * - 与 auto-directory 协作：补充"在哪里改"信息
 *
 * 公开 API:
 * - getConfigFAQ()
 * - faq.ask(question) → { answer, related, sources }
 * - faq.search(keyword) → [...]
 * - faq.refresh()
 */


const { getConceptExtractor } = require('./concept-extractor');

// ── 内置 FAQ 知识库 ──────────────────────────────────
// 格式: { q: 问题, k: 关键词, a: 答案, cfg: 相关配置路径, default: 默认值, category: 分类 }
const FAQ_ENTRIES = [
 // 启动
 { q: '如何启动 CrabPaw？', k: ['start', '启动', 'run', '启动服务', '运行'], a: '运行 `npm start` 或 `node src/cli/index.js start`。开发模式可用 `npm run dev`（--watch 热重载）。', cfg: ['cli'], default: 'npm start', category: 'startup' },
 { q: '如何启用 dev 模式？', k: ['dev', 'watch', '开发模式', '热重载'], a: '使用 `npm run dev`，会在文件变更时自动重启 Node.js 进程。', cfg: ['scripts.dev'], default: 'npm run dev', category: 'startup' },
 { q: '如何停止 CrabPaw？', k: ['stop', '停止', 'shutdown', '关闭'], a: '在终端按 Ctrl+C 优雅关闭；或通过 process API `process.exit(0)`。', cfg: ['shutdown'], default: 'Ctrl+C', category: 'startup' },

 // 数据目录
 { q: '数据存放在哪里？', k: ['data', 'dir', '数据', '存储', '路径', 'CRABPAW_HOME', '~/.crabpaw'], a: '默认在 `~/.crabpaw/`。可通过环境变量 `CRABPAW_DATA_DIR` 自定义。所有记忆、配置、日志、缓存均存于此。', cfg: ['CRABPAW_DATA_DIR'], default: '~/.crabpaw', category: 'storage' },
 { q: '如何更改数据目录？', k: ['CRABPAW_DATA_DIR', '数据目录', '自定义路径'], a: '设置环境变量 `CRABPAW_DATA_DIR=/your/path`，重启服务生效。', cfg: ['CRABPAW_DATA_DIR'], default: '~/.crabpaw', category: 'storage' },
 { q: '记忆存放在哪里？', k: ['memory', '记忆', 'unified-memory.db'], a: '在 `${CRABPAW_DATA_DIR}/unified-memory.db`（SQLite）。', cfg: ['memory.unifiedStore.path'], default: 'unified-memory.db', category: 'storage' },
 { q: '日志在哪里？', k: ['log', '日志', 'logs', 'audit'], a: '在 `${CRABPAW_DATA_DIR}/logs/`。审计日志 v2 记录在 `audit-log-v2.json`。', cfg: ['logs.dir'], default: 'logs/', category: 'storage' },

 // 模型与 LLM
 { q: '如何切换 LLM provider？', k: ['provider', 'model', '切换', 'llm', '模型'], a: '编辑 `${CRABPAW_DATA_DIR}/config.json` 中的 `models.currentProvider`，可选值有 minimax/doubao/deepseek/qwen/glm/ollama/coding-plan/custom。', cfg: ['models.currentProvider'], default: 'minimax', category: 'llm' },
 { q: '如何配置 OpenAI 兼容 provider？', k: ['openai', 'compat', 'compatible', '自定义 provider'], a: '使用 `custom` provider 类型，在 `models.providers.custom` 中设置 `baseUrl`、`apiKey`、`model`。', cfg: ['models.providers.custom'], default: 'custom', category: 'llm' },
 { q: '如何配置 doubao（火山方舟）？', k: ['doubao', '火山', 'ark', 'volcengine'], a: '设置 `models.providers.doubao.apiKey` 为方舟 API Key，`model` 为端点 ID（如 `doubao-pro-32k`）。', cfg: ['models.providers.doubao'], default: 'doubao-pro-32k', category: 'llm' },
 { q: '如何配置 qwen（通义千问）？', k: ['qwen', '通义', 'aliyun', 'dashscope'], a: '设置 `models.providers.qwen.apiKey` 为 DashScope API Key。', cfg: ['models.providers.qwen'], default: 'qwen-plus', category: 'llm' },
 { q: '如何配置 deepseek？', k: ['deepseek', '深度求索'], a: '设置 `models.providers.deepseek.apiKey` 为 DeepSeek API Key。', cfg: ['models.providers.deepseek'], default: 'deepseek-chat', category: 'llm' },
 { q: '如何配置 ollama（本地模型）？', k: ['ollama', '本地', 'local model'], a: '设置 `models.providers.ollama.baseUrl` 为 `http://localhost:11434`，`model` 为本地模型名（如 `llama3`）。', cfg: ['models.providers.ollama'], default: 'http://localhost:11434', category: 'llm' },

 // TTS / ASR
 { q: 'TTS 默认使用什么？', k: ['tts', '语音合成', 'default'], a: 'TTS 默认使用 doubao（seed-tts-2.0），也支持 edge / volcano / openai / qwen。配置在 `voice.tts.providerOrder`，按顺序尝试。', cfg: ['voice.tts.providerOrder'], default: 'doubao', category: 'voice' },
 { q: 'TTS 如何切换 provider？', k: ['tts', '切换', 'providerOrder'], a: '修改 `voice.tts.providerOrder` 数组顺序，重启服务生效。', cfg: ['voice.tts.providerOrder'], default: '["doubao","edge"]', category: 'voice' },
 { q: 'ASR 如何配置？', k: ['asr', '语音识别', 'speech'], a: '在 `voice.asr.providers` 中配置，支持 provider fallback 链。可选：edge / volcengine / iflytek。', cfg: ['voice.asr.providers'], default: 'edge', category: 'voice' },
 { q: '如何关闭语音回复？', k: ['voice', 'reply', '关闭语音', '静音'], a: '设置 `voice.replyEnabled: false`。', cfg: ['voice.replyEnabled'], default: 'true', category: 'voice' },

 // 渠道
 { q: '如何接入飞书？', k: ['lark', 'feishu', '飞书', 'lark-cli'], a: '设置环境变量 `LARK_APP_ID` 和 `LARK_APP_SECRET`，启用 `lark` 渠道。Webhook 模式监听 38770；WS 模式无需公网。', cfg: ['LARK_APP_ID', 'LARK_APP_SECRET'], default: '未配置', category: 'channel' },
 { q: '如何接入企业微信？', k: ['wecom', 'wechat', '企业微信'], a: '配置 `wecom.aibotId/aibotSecret` 和回调 URL。', cfg: ['wecom.aibotId'], default: '未配置', category: 'channel' },
 { q: '如何接入 Discord？', k: ['discord', 'discord bot'], a: '设置环境变量 `DISCORD_BOT_TOKEN`，启用 `discord` 渠道（通过 Gateway WebSocket）。', cfg: ['DISCORD_BOT_TOKEN'], default: '未配置', category: 'channel' },

 // 安全
 { q: '如何开启命令审批？', k: ['approval', '审批', 'permission'], a: '在 `permissions` 中设置 `mode` 为 `PLAN` 或 `FULL_AUTO`。`DEFAULT` 模式仅审计。', cfg: ['permissions.mode'], default: 'DEFAULT', category: 'security' },
 { q: '如何禁用危险命令？', k: ['dangerous', 'rm -rf', '危险命令'], a: '默认 `bash-command-filter` 拦截 `rm -rf /`、`shutdown` 等。可在 `security.bash.blocklist` 自定义。', cfg: ['security.bash.blocklist'], default: '已启用', category: 'security' },

 // 性能
 { q: '如何加快响应速度？', k: ['speed', '性能', '快', 'cache', '缓存'], a: '启用 `aci` 预判注入（已默认开启），开启 `crossSessionPromptCache`，增大 `budget.maxTokens`。', cfg: ['aci.enabled', 'crossSessionPromptCache.enabled'], default: 'true', category: 'performance' },
 { q: 'ACI 预判注入是什么？', k: ['aci', 'anticipatory', '预判', '注入'], a: 'Anticipatory Context Injection：在 LLM 调用前预取相关工具链、记忆、上下文，减少首字延迟。', cfg: ['aci.enabled'], default: 'true', category: 'performance' },

 // 工具
 { q: '工具太多怎么办？', k: ['tool', '工具多', 'token', 'tokens'], a: '使用 `find_tool` 按需发现工具；启用按需工具注入 `toolInjection.onDemand: true`。', cfg: ['toolInjection.onDemand'], default: 'false', category: 'tools' },
 { q: '如何注册新工具？', k: ['register', '注册工具', '新工具'], a: '在 `src/tools/your-tool.js` 中调用 `registry.register({...})`，然后在 `src/tools/index.js` 顶部 `require()` 它。', cfg: [], default: '无', category: 'tools' },

 // 记忆
 { q: '记忆系统如何工作？', k: ['memory', '记忆系统', 'work'], a: 'CrabPaw 使用 EnhancedMemorySystem + UnifiedMemoryStore。HRR 向量检索、LLM 更新、Agent 隔离、上下文围栏。', cfg: ['memory.enhancedSystem.enabled'], default: 'true', category: 'memory' },
 { q: '如何审计记忆？', k: ['audit', '审计', 'memory audit'], a: '使用 `MemoryAudit` 工具检测重复/冲突/孤岛，或在 Web 面板查看。', cfg: [], default: '无', category: 'memory' },

 // 测试
 { q: '如何运行测试？', k: ['test', '测试', 'jest'], a: '`npm test` 运行单元测试；`npm run eval` 运行评估套件；`npm run precommit` 提交前检查。', cfg: [], default: 'npm test', category: 'testing' },
 { q: '如何运行 eval？', k: ['eval', '评估', 'harness'], a: '`npm run eval` 运行 15 个评估套件；可加 tag 过滤 `eval-runner --tag=P0`。', cfg: [], default: 'npm run eval', category: 'testing' },
];

class ConfigFAQ {
 constructor() {
 this._entries = [...FAQ_ENTRIES];
 this._indexed = new Map();
 this._buildIndex();
 }

 _buildIndex() {
 this._indexed.clear();
 for (const e of this._entries) {
 const tokens = new Set();
 // 问题分词
 const qWords = (e.q.match(/[\w\u4e00-\u9fff]+/g) || []).map(w => w.toLowerCase());
 for (const w of qWords) tokens.add(w);
 // 关键词
 for (const k of e.k) tokens.add(k.toLowerCase());
 // 配置路径
 for (const c of e.cfg) {
 for (const part of c.split(/[./]/)) {
 if (part.length > 1) tokens.add(part.toLowerCase());
 }
 }
 // 分类
 tokens.add(e.category);

 for (const t of tokens) {
 if (!this._indexed.has(t)) this._indexed.set(t, []);
 this._indexed.get(t).push(e);
 }
 }
 }

 /**
 * 添加自定义 FAQ 条目
 */
 add(entry) {
 this._entries.push(entry);
 this._buildIndex();
 }

 /**
 * 提问
 * @param {string} question
 * @returns {{ answer: string, related: Array, sources: Array, best: object|null }}
 */
 ask(question) {
 if (!question) return { answer: '', related: [], sources: [], best: null };
 const ext = getConceptExtractor();
 const qfp = ext.extract(question);
 const qWords = (question.match(/[\w\u4e00-\u9fff]+/g) || []).map(w => w.toLowerCase()).filter(w => w.length > 1);
 const qConcepts = new Set(qfp.keywords.map(k => (k.word || '').toLowerCase()));

 const scores = new Map();
 for (const w of [...qWords, ...qConcepts]) {
 // 精确
 if (this._indexed.has(w)) {
 for (const e of this._indexed.get(w)) {
 scores.set(e, (scores.get(e) || 0) + 3);
 }
 }
 // 包含
 for (const [k, entries] of this._indexed) {
 if (k === w) continue;
 if (k.includes(w) || w.includes(k)) {
 for (const e of entries) {
 scores.set(e, (scores.get(e) || 0) + 1);
 }
 }
 }
 }

 if (scores.size === 0) {
 return {
 answer: '抱歉，未找到相关 FAQ。请尝试其他关键词或浏览完整 FAQ 列表。',
 related: [],
 sources: [],
 best: null,
 };
 }

 const sorted = Array.from(scores.entries())
 .sort((a, b) => b[1] - a[1])
 .slice(0, 5);

 const best = sorted[0][0];
 const related = sorted.slice(1, 5).map(([e]) => e);

 return {
 answer: best.a,
 related: related.map(e => ({ q: e.q, category: e.category })),
 sources: best.cfg,
 best: {
 q: best.q,
 a: best.a,
 cfg: best.cfg,
 default: best.default,
 category: best.category,
 },
 };
 }

 /**
 * 关键词搜索
 */
 search(keyword) {
 if (!keyword) return [];
 const lower = keyword.toLowerCase();
 return this._entries.filter(e => {
 if (e.q.toLowerCase().includes(lower)) return true;
 if (e.k.some(k => k.toLowerCase().includes(lower))) return true;
 if (e.cfg.some(c => c.toLowerCase().includes(lower))) return true;
 return false;
 });
 }

 /**
 * 列表
 */
 list(category = null) {
 if (!category) return [...this._entries];
 return this._entries.filter(e => e.category === category);
 }

 get size() { return this._entries.length; }
 get categories() {
 return Array.from(new Set(this._entries.map(e => e.category)));
 }
}

let _instance = null;
function getConfigFAQ() {
 if (!_instance) _instance = new ConfigFAQ();
 return _instance;
}

module.exports = {
 ConfigFAQ,
 getConfigFAQ,
};
