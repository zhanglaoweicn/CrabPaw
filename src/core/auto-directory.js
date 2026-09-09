'use strict';

/**
 * auto-directory.js — CrabPaw 自动目录索引
 *
 * 设计参考 的项目自描述：
 * - 扫描项目结构（src/、tools/、core/、commands/）
 * - 抽取模块入口、类导出、工具注册、命令清单
 * - 提供自然语言查询（"怎么用语音识别？" / "记忆在哪？"）
 * - 生成可注入 prompt 的目录卡片
 *
 * 公开 API:
 * - getAutoDirectory()
 * - dir.scan()
 * - dir.query(question) → top 命中
 * - dir.card(scope) → prompt 友好的文本块
 * - dir.refresh()
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');

const SCAN_PATHS = {
 core: path.join(ROOT_DIR, 'src', 'core'),
 tools: path.join(ROOT_DIR, 'src', 'tools'),
 channels: path.join(ROOT_DIR, 'src', 'channels'),
 handlers: path.join(ROOT_DIR, 'src', 'handlers'),
 cli: path.join(ROOT_DIR, 'src', 'cli'),
 evals: path.join(ROOT_DIR, 'evals'),
 skills: path.join(ROOT_DIR, 'src', 'core', 'skill'),
};

const MAX_FILE_BYTES = 200 * 1024; // 200KB 上限，跳过大文件
const MAX_FILES_PER_DIR = 500; // 单目录最大扫描文件
const MAX_ENTRIES = 5000; // 全局条目上限

// ── 启发式分类 ──────────────────────────────────
const CATEGORY_HINTS = [
 { pattern: /tool|contract|orchestrator|dispatcher|executor/i, category: 'tools' },
 { pattern: /memory|recall|knowledge|store/i, category: 'memory' },
 { pattern: /asr|tts|voice|speech|audio/i, category: 'voice' },
 { pattern: /lark|feishu|wecom|wechat|discord|slack|email/i, category: 'channel' },
 { pattern: /skill|workflow|chain/i, category: 'skill' },
 { pattern: /agent|subagent|orchestrat/i, category: 'agent' },
 { pattern: /evolution|learn|adapt/i, category: 'evolution' },
 { pattern: /security|sanit|safe|guard|filter|whitelist|threat/i, category: 'security' },
 { pattern: /context|prompt|cache/i, category: 'context' },
 { pattern: /observ|metric|audit|log|trace|monitor/i, category: 'observability' },
 { pattern: /browser|web|search|crawl|fetch/i, category: 'web' },
 { pattern: /file|fs|path|dir/i, category: 'filesystem' },
 { pattern: /image|video|media|render/i, category: 'media' },
 { pattern: /database|sqlite|sql|store/i, category: 'storage' },
 { pattern: /config|setting|profile/i, category: 'config' },
 { pattern: /event|bus|signal/i, category: 'event' },
 { pattern: /rpa|desktop|window|clipboard/i, category: 'desktop' },
 { pattern: /scheduler|cron|timer/i, category: 'scheduler' },
 { pattern: /plugin|extension|adapter/i, category: 'plugin' },
 { pattern: /permission|approval|policy/i, category: 'policy' },
];

function inferCategory(relPath) {
 for (const hint of CATEGORY_HINTS) {
 if (hint.pattern.test(relPath)) return hint.category;
 }
 return 'core';
}

// ── 启发式关键能力提取 ──────────────────────────────────
function extractCapabilities(filePath, content) {
 const caps = new Set();

 // 工具导出
 const toolMatches = content.matchAll(/registry\.register\(\s*\{[^}]*name:\s*['"]([\w]+)['"]/g);
 for (const m of toolMatches) caps.add(`tool:${m[1]}`);

 // 类导出
 const classMatches = content.matchAll(/class\s+(\w+)/g);
 for (const m of classMatches) {
 if (m[1].length > 3) caps.add(`class:${m[1]}`);
 }

 // 函数导出
 const funcMatches = content.matchAll(/(?:async\s+)?function\s+(\w+)\s*\(/g);
 for (const m of funcMatches) {
 if (m[1].length > 3 && !['forEach', 'map', 'filter'].includes(m[1])) {
 caps.add(`fn:${m[1]}`);
 }
 }

 // module.exports
 const exportMatches = content.match(/module\.exports\s*=\s*\{([^}]+)\}/);
 if (exportMatches) {
 const names = exportMatches[1].match(/(\w+)/g) || [];
 for (const n of names) {
 if (n.length > 2) caps.add(`export:${n}`);
 }
 }

 return Array.from(caps).slice(0, 20); // 每个文件最多 20 个
}

// ── 启发式描述提取 ──────────────────────────────────
function extractDescription(content) {
 // 匹配文件首部注释中的描述
 const headerMatch = content.match(/^\s*(?:\/\*\*?|\/\/)\s*([\s\S]{0,400}?)(?:\*\/|$)/);
 if (!headerMatch) return '';
 let desc = headerMatch[1];
 // 去除星号前缀
 desc = desc.replace(/^\s*\*+\s?/gm, '').replace(/^\s*\/\/\s?/gm, '');
 // 取首行非空
 const lines = desc.split('\n').map(l => l.trim()).filter(Boolean);
 if (lines.length === 0) return '';
 return lines[0].slice(0, 200);
}

class AutoDirectory {
 constructor() {
 this._entries = [];
 this._scannedAt = null;
 this._indexed = new Map(); // keyword → [entry]
 this._byCategory = new Map();
 }

 scan(options = {}) {
 const maxFiles = options.maxFiles || MAX_FILES_PER_DIR;
 const maxBytes = options.maxBytes || MAX_FILE_BYTES;
 const maxEntries = options.maxEntries || MAX_ENTRIES;
 this._entries = [];
 this._indexed.clear();
 this._byCategory.clear();

 const allFiles = [];
 for (const [scope, dir] of Object.entries(SCAN_PATHS)) {
 if (!fs.existsSync(dir)) continue;
 this._walk(dir, scope, allFiles, maxFiles);
 }

 let count = 0;
 for (const { filePath, scope } of allFiles) {
 if (count >= maxEntries) break;
 let stat;
 try { stat = fs.statSync(filePath); } catch (e) { continue; }
 if (stat.size > maxBytes) continue;

 let content;
 try { content = fs.readFileSync(filePath, 'utf-8'); } catch (e) { continue; }
 if (!content) continue;

 const relPath = path.relative(ROOT_DIR, filePath).replace(/\\/g, '/');
 const category = inferCategory(relPath);
 const description = extractDescription(content);
 const capabilities = extractCapabilities(filePath, content);

 const entry = {
 path: relPath,
 scope,
 category,
 description,
 capabilities,
 size: stat.size,
 tools: capabilities.filter(c => c.startsWith('tool:')).map(c => c.slice(5)),
 classes: capabilities.filter(c => c.startsWith('class:')).map(c => c.slice(6)),
 };

 this._entries.push(entry);
 if (!this._byCategory.has(category)) this._byCategory.set(category, []);
 this._byCategory.get(category).push(entry);

 // 索引关键词
 this._indexKeywords(entry);
 count++;
 }

 this._scannedAt = Date.now();
 return { count: this._entries.length, categories: this._byCategory.size };
 }

 _walk(dir, scope, allFiles, maxFiles) {
 let count = 0;
 const stack = [dir];
 while (stack.length > 0 && count < maxFiles) {
 const cur = stack.pop();
 let entries;
 try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { continue; }
 for (const ent of entries) {
 if (count >= maxFiles) break;
 if (ent.name.startsWith('.')) continue;
 if (ent.name === 'node_modules') continue;
 const fp = path.join(cur, ent.name);
 if (ent.isDirectory()) {
 stack.push(fp);
 } else if (ent.isFile() && /\.(js|json|md)$/.test(ent.name)) {
 allFiles.push({ filePath: fp, scope });
 count++;
 }
 }
 }
 }

 _indexKeywords(entry) {
 const tokens = new Set();
 // 路径
 for (const part of entry.path.split(/[./_-]/)) {
 if (part.length > 2) tokens.add(part.toLowerCase());
 }
 // 工具名
 for (const t of entry.tools) {
 tokens.add(t.toLowerCase());
 }
 // 类名
 for (const c of entry.classes) {
 const parts = c.replace(/([A-Z])/g, ' $1').trim().split(/\s+/);
 for (const p of parts) {
 if (p.length > 2) tokens.add(p.toLowerCase());
 }
 }
 // 描述分词（简单）
 if (entry.description) {
 const words = entry.description.match(/[\w\u4e00-\u9fff]+/g) || [];
 for (const w of words) {
 if (w.length > 2) tokens.add(w.toLowerCase());
 }
 }

 for (const t of tokens) {
 if (!this._indexed.has(t)) this._indexed.set(t, []);
 this._indexed.get(t).push(entry);
 }
 }

 /**
 * 查询：根据自然语言问题返回 top 条目
 * @param {string} question
 * @param {object} [options] { limit?, category? }
 */
 query(question, options = {}) {
 if (!this._entries.length) this.scan();
 if (!question) return [];
 const limit = options.limit || 5;
 const words = (question.match(/[\w\u4e00-\u9fff]+/g) || []).map(w => w.toLowerCase()).filter(w => w.length > 1);
 if (words.length === 0) return [];

 const scores = new Map();
 for (const w of words) {
 // 精确匹配
 if (this._indexed.has(w)) {
 for (const e of this._indexed.get(w)) {
 scores.set(e, (scores.get(e) || 0) + 3);
 }
 }
 // 模糊匹配（包含）
 for (const [k, entries] of this._indexed) {
 if (k.includes(w) && k !== w) {
 for (const e of entries) {
 scores.set(e, (scores.get(e) || 0) + 1);
 }
 }
 if (w.includes(k) && k !== w) {
 for (const e of entries) {
 scores.set(e, (scores.get(e) || 0) + 2);
 }
 }
 }
 }

 let results = Array.from(scores.entries())
 .map(([entry, score]) => ({ entry, score }))
 .filter(r => !options.category || r.entry.category === options.category)
 .sort((a, b) => b.score - a.score)
 .slice(0, limit);

 return results.map(r => ({
 path: r.entry.path,
 scope: r.entry.scope,
 category: r.entry.category,
 description: r.entry.description,
 tools: r.entry.tools.slice(0, 5),
 score: r.score,
 }));
 }

 /**
 * 卡片：生成可注入 prompt 的目录摘要
 * @param {string} [scope] - 限定 scope (core/tools/channels/...)
 */
 card(scope = null) {
 if (!this._entries.length) this.scan();
 const lines = [];
 lines.push('📂 CrabPaw 自动目录');
 lines.push('━'.repeat(40));
 lines.push(`已索引 ${this._entries.length} 个文件，分 ${this._byCategory.size} 类`);

 if (scope) {
 const entries = this._entries.filter(e => e.scope === scope);
 lines.push(`\n[${scope}] ${entries.length} 个条目`);
 for (const e of entries.slice(0, 15)) {
 const desc = e.description ? ` — ${e.description.slice(0, 50)}` : '';
 lines.push(` • ${e.path}${desc}`);
 }
 } else {
 lines.push('\n分类概览:');
 for (const [cat, list] of this._byCategory) {
 lines.push(` • ${cat}: ${list.length} 个`);
 }
 }
 return lines.join('\n');
 }

 /**
 * 工具清单：所有注册过的工具
 */
 listTools() {
 if (!this._entries.length) this.scan();
 const seen = new Map();
 for (const e of this._entries) {
 for (const t of e.tools) {
 if (!seen.has(t)) seen.set(t, e.path);
 }
 }
 return Array.from(seen.entries()).map(([name, path]) => ({ name, path })).sort((a, b) => a.name.localeCompare(b.name));
 }

 refresh() {
 return this.scan();
 }

 get size() { return this._entries.length; }
 get categories() { return Array.from(this._byCategory.keys()); }
 get scannedAt() { return this._scannedAt; }
}

let _instance = null;
function getAutoDirectory() {
 if (!_instance) _instance = new AutoDirectory();
 return _instance;
}

module.exports = {
 AutoDirectory,
 getAutoDirectory,
};
