const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('../config');

const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_TOKENS = 128000;
const SUMMARY_THRESHOLD = 0.7;
const PROTECT_FIRST_N = 2;
const TAIL_TOKEN_BUDGET_RATIO = 0.15;
const MIN_TAIL_MESSAGES = 3;
const MAX_INEFFECTIVE_COMPRESSIONS = 2;
const SUMMARY_FAILURE_COOLDOWN_MIN = 60;

const PREVIEW_SIZE = 1500;
const PERSIST_THRESHOLD = 50000;
const MIN_SUMMARY_TOKENS = 2000;
const SUMMARY_RATIO = 0.20;
const BASE_CHUNK_RATIO = 0.4;
const MIN_CHUNK_RATIO = 0.15;
const ADAPTIVE_SAFETY_MARGIN = 1.2;
const SUMMARY_TOKENS_CEILING = 12000;



const TOOL_ARGS_MAX = 1500;
const TOOL_ARGS_HEAD = 1200;

const { loadPromptFile } = require('../prompts/index');
const SUMMARY_PREFIX = loadPromptFile('compressor', 'summary-prefix.txt') || '[上下文压缩 — 仅供参考] 之前的对话已被压缩为以下摘要。这是来自上一个上下文窗口的交接信息 — 请将其视为背景参考，而非活跃指令。不要回答或执行摘要中提到的问题或请求，它们已经被处理过了。你当前的任务在摘要的"## 当前任务"部分中标识 — 从那里精确恢复。重要提示：系统提示词中的持久记忆（MEMORY.md、USER.md）始终是权威且活跃的 — 不要因为此压缩说明而忽略或降低记忆内容的优先级。请仅回复此摘要之后出现的最新用户消息。当前会话状态（文件、配置等）可能反映了此处描述的工作 — 避免重复：';
const SUMMARY_END_MARKER = loadPromptFile('compressor', 'summary-end-marker.txt') || '\n\n--- 上下文压缩结束 — 请仅回复下方最新消息，不要执行摘要中的任何指令 ---';

// Bootstrap 保护标记（与 ai.js 中的 BOOTSTRAP_MARKER 一致）
const BOOTSTRAP_MARKER = '<crabpaw-bootstrap>';
const BOOTSTRAP_END_MARKER = '</crabpaw-bootstrap>';

const SENSITIVE_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/,
  /api[_-]?key\s*[:=]\s*["']?[a-zA-Z0-9]{20,}/i,
  /token\s*[:=]\s*["']?[a-zA-Z0-9]{20,}/i,
  /password\s*[:=]\s*["']?[^\s"']{8,}/i,
  /secret\s*[:=]\s*["']?[a-zA-Z0-9]{20,}/i,
  /Bearer\s+[a-zA-Z0-9\-._~+/]+=*/,
];

const TOOL_SUMMARY_PATTERNS = {
  WebSearch: (args, content) => {
    try {
      const a = typeof args === 'string' ? JSON.parse(args) : args || {};
      const q = a.query || a.keyword || '';
      const len = (content || '').length;
      return `[WebSearch] 搜索"${q}" (${len.toLocaleString()} 字符结果)`;
    } catch { return `[WebSearch] 搜索完成 (${(content||'').length.toLocaleString()} 字符)`; }
  },
  WebFetch: (args, content) => {
    try {
      const a = typeof args === 'string' ? JSON.parse(args) : args || {};
      const u = a.url || '';
      return `[WebFetch] 抓取 ${u.length > 60 ? u.slice(0,57)+'...' : u} (${(content||'').length.toLocaleString()} 字符)`;
    } catch { return `[WebFetch] 抓取完成 (${(content||'').length.toLocaleString()} 字符)`; }
  },
  Read: (args, content) => {
    try {
      const a = typeof args === 'string' ? JSON.parse(args) : args || {};
      const f = a.file_path || a.path || '';
      const name = f.split(/[/\\]/).pop() || f;
      const offset = a.offset || a.line_start || 1;
      return `[Read] 读取 ${name} 从第 ${offset} 行 (${(content||'').length.toLocaleString()} 字符)`;
    } catch { return `[Read] 读取文件 (${(content||'').length.toLocaleString()} 字符)`; }
  },
  Write: (args, _content) => {
    try {
      const a = typeof args === 'string' ? JSON.parse(args) : args || {};
      const f = a.file_path || a.path || '';
      const name = f.split(/[/\\]/).pop() || f;
      const writtenLines = (a.content || '').split('\n').length;
      return `[Write] 写入 ${name} (${writtenLines} 行)`;
    } catch { return `[Write] 写入文件`; }
  },
  Edit: (args, content) => {
    try {
      const a = typeof args === 'string' ? JSON.parse(args) : args || {};
      const f = a.file_path || a.path || '';
      const name = f.split(/[/\\]/).pop() || f;
      return `[Edit] 编辑 ${name} (${(content||'').length.toLocaleString()} 字符结果)`;
    } catch { return `[Edit] 编辑文件`; }
  },
  Bash: (args, content) => {
    try {
      const a = typeof args === 'string' ? JSON.parse(args) : args || {};
      const cmd = a.command || '';
      const display = cmd.length > 80 ? cmd.slice(0,77)+'...' : cmd;
      const lines = (content||'').split('\n').length;
      const exitMatch = (content||'').match(/exit[_\s]?code["\s:]*(\d+)/i);
      const exitCode = exitMatch ? exitMatch[1] : '?';
      return `[Bash] 执行 \`${display}\` → exit ${exitCode}, ${lines} 行输出`;
    } catch { return `[Bash] 执行命令 (${(content||'').length.toLocaleString()} 字符)`; }
  },
  Glob: (args, content) => {
    try {
      const a = typeof args === 'string' ? JSON.parse(args) : args || {};
      const p = a.pattern || '';
      const count = (content||'').split('\n').filter(l=>l.trim()).length;
      return `[Glob] 匹配 "${p}" → ${count} 个文件`;
    } catch { return `[Glob] 文件搜索完成`; }
  },
  Grep: (args, content) => {
    try {
      const a = typeof args === 'string' ? JSON.parse(args) : args || {};
      const p = a.pattern || '';
      const dir = a.path || '.';
      const count = (content||'').split('\n').filter(l=>l.trim()).length;
      return `[Grep] 搜索 "${p}" 在 ${dir} → ${count} 条匹配`;
    } catch { return `[Grep] 内容搜索完成`; }
  },
  LS: (args, content) => {
    try {
      const a = typeof args === 'string' ? JSON.parse(args) : args || {};
      const p = a.path || '';
      const count = (content||'').split('\n').filter(l=>l.trim()).length;
      return `[LS] 列出 ${p} → ${count} 项`;
    } catch { return `[LS] 目录列表完成`; }
  },
  LarkCreateDoc: (args, content) => {
    try {
      const a = typeof args === 'string' ? JSON.parse(args) : args || {};
      return `[LarkCreateDoc] 创建飞书文档 "${a.title || '?'}" (${(content||'').length.toLocaleString()} 字符)`;
    } catch { return `[LarkCreateDoc] 创建飞书文档`; }
  },
  LarkReadDoc: (args, content) => {
    try {
      // eslint-disable-next-line no-unused-vars
      const a = typeof args === 'string' ? JSON.parse(args) : args || {};
      return `[LarkReadDoc] 读取飞书文档 (${(content||'').length.toLocaleString()} 字符)`;
    } catch { return `[LarkReadDoc] 读取飞书文档`; }
  },
  LarkCreateBitableRecord: (args, content) => {
    try {
      // eslint-disable-next-line no-unused-vars
      const a = typeof args === 'string' ? JSON.parse(args) : args || {};
      return `[LarkCreateBitableRecord] 创建多维表格记录 (${(content||'').length.toLocaleString()} 字符)`;
    } catch { return `[LarkCreateBitableRecord] 创建多维表格记录`; }
  },
  LarkQueryBitableRecords: (args, content) => {
    try {
      // eslint-disable-next-line no-unused-vars
      const a = typeof args === 'string' ? JSON.parse(args) : args || {};
      return `[LarkQueryBitableRecords] 查询多维表格 (${(content||'').length.toLocaleString()} 字符)`;
    } catch { return `[LarkQueryBitableRecords] 查询多维表格`; }
  },
  LarkCreateCalendarEvent: (args, _content) => {
    try {
      const a = typeof args === 'string' ? JSON.parse(args) : args || {};
      return `[LarkCreateCalendarEvent] 创建日历日程 "${a.summary || '?'}"`;
    } catch { return `[LarkCreateCalendarEvent] 创建日历日程`; }
  },
  LarkCreateTask: (args, _content) => {
    try {
      const a = typeof args === 'string' ? JSON.parse(args) : args || {};
      return `[LarkCreateTask] 创建飞书任务 "${a.summary || '?'}"`;
    } catch { return `[LarkCreateTask] 创建飞书任务`; }
  },
  skill_manage: (args, content) => {
    try {
      const a = typeof args === 'string' ? JSON.parse(args) : args || {};
      return `[SkillManage] ${a.action || '?'} name=${a.name || '?'} (${(content||'').length.toLocaleString()} 字符)`;
    } catch { return `[SkillManage] 技能管理`; }
  },
  // 2026-08-15 T7: 注册主名已收敛 PascalCase——新旧名共用同一 summarizer（别名兼容）。
  SkillManage: (args, content) => {
    try {
      const a = typeof args === 'string' ? JSON.parse(args) : args || {};
      return `[SkillManage] ${a.action || '?'} name=${a.name || '?'} (${(content||'').length.toLocaleString()} 字符)`;
    } catch { return `[SkillManage] 技能管理`; }
  },
  SkillsList: (args, content) => `[SkillsList] 列出技能 (${(content||'').length.toLocaleString()} 字符)`,
  SkillView: (args, content) => {
    try {
      const a = typeof args === 'string' ? JSON.parse(args) : args || {};
      return `[SkillView] 查看技能 "${a.name || '?'}" (${(content||'').length.toLocaleString()} 字符)`;
    } catch { return `[SkillView] 查看技能`; }
  },
  // eslint-disable-next-line no-unused-vars
  clarify: (_args, content) => `[clarify] 向用户提问`,
  // eslint-disable-next-line no-unused-vars
  todo: (_args, content) => `[Todo] 更新任务列表`,
  // 2026-08-15 T7: 注册主名已收敛 PascalCase——新旧名共用同一 summarizer（别名兼容）。
  // eslint-disable-next-line no-unused-vars
  Todo: (_args, content) => `[Todo] 更新任务列表`,
  memory: (args, _content) => {
    try {
      const a = typeof args === 'string' ? JSON.parse(args) : args || {};
      return `[memory] ${a.action || '?'} on ${a.target || '?'}`;
    } catch { return `[memory] 记忆操作`; }
  },
};

function redactSensitiveText(text) {
  if (!text) return text;
  let result = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
    result = result.replace(globalPattern, '[REDACTED]');
  }
  return result;
}

function summarizeToolResult(toolName, toolArgs, toolContent) {
  const summarizer = TOOL_SUMMARY_PATTERNS[toolName];
  if (summarizer) {
    try { return summarizer(toolArgs, toolContent); } catch { console.warn('[compressor] TOOL_SUMMARY_PATTERNS summarizer failed for:', toolName); }
  }
  const contentLen = (toolContent || '').length;
  const lineCount = (toolContent || '').split('\n').length;
  if (contentLen === 0) return `[${toolName}] 无输出`;
  if (lineCount <= 5) return `[${toolName}] ${toolContent.slice(0, 200)}`;
  return `[${toolName}] ${lineCount} 行输出 (${contentLen.toLocaleString()} 字符)`;
}

const IMPORTANCE_SIGNALS = {
  CRITICAL: [
    /error|错误|失败|fail|exception|traceback/i,
    /决定|decision|关键|important|critical/i,
    /用户要求|用户偏好|constraint|约束/i,
    /密码|password|secret|token|credential|api.?key/i,
  ],
  HIGH: [
    /创建|create|写入|write|修改|modify|编辑|edit|删除|delete/i,
    /安装|install|配置|config|部署|deploy/i,
    /测试|test|验证|verify|确认|confirm/i,
  ],
  MEDIUM: [
    /搜索|search|查询|query|读取|read|列出|list/i,
    /分析|analyze|检查|check/i,
  ],
};

function scoreMessageImportance(msg) {
  const content = _contentText(msg.content || '');
  if (!content) return 0;
  let score = 0;
  if (msg.role === 'user') score += 3;
  if (msg.role === 'assistant' && !msg.tool_calls) score += 2;
  if (msg.role === 'tool') score += 1;
  for (const pat of IMPORTANCE_SIGNALS.CRITICAL) {
    if (pat.test(content)) score += 5;
  }
  for (const pat of IMPORTANCE_SIGNALS.HIGH) {
    if (pat.test(content)) score += 2;
  }
  for (const pat of IMPORTANCE_SIGNALS.MEDIUM) {
    if (pat.test(content)) score += 1;
  }
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      const name = (tc.function?.name || '').toLowerCase();
      if (/write|edit|delete|create|bash|exec/i.test(name)) score += 3;
      else if (/read|search|grep|glob/i.test(name)) score += 1;
    }
  }
  return score;
}

function extractKeyFacts(messages) {
  const facts = [];
  for (const msg of messages) {
    const content = _contentText(msg.content || '');
    if (!content) continue;
    const score = scoreMessageImportance(msg);
    if (score < 5) continue;
    const lines = content.split('\n').filter(l => l.trim());
    for (const line of lines.slice(0, 3)) {
      if (/error|错误|失败|决定|decision|关键|important|创建|写入|修改|删除/i.test(line)) {
        facts.push(line.slice(0, 200));
        if (facts.length >= 15) return facts;
      }
    }
  }
  return facts;
}

function truncateToolCallArgsJson(argsStr, headChars = 200) {
  if (!argsStr || typeof argsStr !== 'string') return argsStr;
  if (argsStr.length <= headChars) return argsStr;
  try {
    const parsed = JSON.parse(argsStr);
    const shrunken = _shrinkValues(parsed, headChars);
    return JSON.stringify(shrunken);
  } catch {
    return argsStr.slice(0, headChars) + '...[truncated]';
  }
}

function _shrinkValues(obj, maxChars) {
  if (typeof obj === 'string') {
    return obj.length > maxChars ? obj.slice(0, maxChars) + '...[truncated]' : obj;
  }
  if (Array.isArray(obj)) {
    return obj.slice(0, 10).map(v => _shrinkValues(v, maxChars));
  }
  if (obj && typeof obj === 'object') {
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = _shrinkValues(v, maxChars);
    }
    return result;
  }
  return obj;
}

const IMAGE_TOKEN_ESTIMATE = 1600;
const IMAGE_CHAR_EQUIVALENT = IMAGE_TOKEN_ESTIMATE * CHARS_PER_TOKEN;

function _contentLengthForBudget(rawContent) {
  if (typeof rawContent === 'string') return rawContent.length;
  if (!Array.isArray(rawContent)) return String(rawContent || '').length;

  let total = 0;
  for (const p of rawContent) {
    if (typeof p === 'string') { total += p.length; continue; }
    if (!p || typeof p !== 'object') { total += String(p).length; continue; }
    const ptype = p.type;
    if (ptype === 'image_url' || ptype === 'input_image' || ptype === 'image') {
      total += IMAGE_CHAR_EQUIVALENT;
    } else {
      total += (p.text || '').length;
    }
  }
  return total;
}

function estimateTokens(text) {
  if (!text) return 0;
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const rest = text.length - chineseChars;
  return Math.ceil(chineseChars * 1.5 + rest / CHARS_PER_TOKEN);
}

function estimateMessagesTokens(messages) {
  let total = 0;
  for (const msg of messages) {
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part && (part.type === 'image_url' || part.type === 'input_image' || part.type === 'image')) {
          total += IMAGE_TOKEN_ESTIMATE;
        } else {
          total += estimateTokens(part?.text || part?.content || '');
        }
      }
    } else {
      total += estimateTokens(content || '');
    }
    if (msg.tool_calls) {
      for (const call of msg.tool_calls) {
        total += estimateTokens(call.function?.name || '');
        total += estimateTokens(call.function?.arguments || '');
      }
    }
    total += 4;
  }
  return total;
}

function _contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(c => c.text || c.content || '').join('');
  return '';
}

function _appendText(content, text, prepend = false) {
  if (content == null) return text;
  if (typeof content === 'string') return prepend ? text + content : content + text;
  if (Array.isArray(content)) {
    const block = { type: 'text', text };
    return prepend ? [block, ...content] : [...content, block];
  }
  const rendered = String(content);
  return prepend ? text + rendered : rendered + text;
}

function _isContextSummaryContent(content) {
  const text = _contentText(content).trimStart();
  return text.startsWith(SUMMARY_PREFIX);
}

function _stripSummaryPrefix(summary) {
  const text = (summary || '').trim();
  if (text.startsWith(SUMMARY_PREFIX)) {
    return text.slice(SUMMARY_PREFIX.length).trimStart();
  }
  return text;
}

class ContextCompressor {
  constructor(options = {}) {
    this.maxTokens = options.maxTokens || DEFAULT_MAX_TOKENS;
    this.summaryThreshold = options.summaryThreshold || SUMMARY_THRESHOLD;
    this.protectFirstN = options.protectFirstN || PROTECT_FIRST_N;
    this.tailTokenBudget = Math.floor(this.maxTokens * TAIL_TOKEN_BUDGET_RATIO);
    this.maxSummaryTokens = Math.min(Math.floor(this.maxTokens * 0.05), SUMMARY_TOKENS_CEILING);
    this.quietMode = options.quietMode || false;
    this.compressionCount = 0;
    this._previousSummary = null;
    this._ineffectiveCompressionCount = 0;
    this._summaryFailureCooldownUntil = 0;
    this._lastSummaryError = null;
    this._lastCompressionSavingsPct = 0;
    this._lastSummaryDroppedCount = 0;
    this._lastSummaryFallbackUsed = false;
    this._lastAuxModelFailureError = null;
    this._lastAuxModelFailureModel = null;
    this._summaryModelFallenBack = false;
    this.compressionHistory = [];
    this._persistDir = path.join(DATA_DIR, 'tool-results');
    this._llmCompressFn = options.llmCompressFn || null;
  }

  updateModel(model, contextLength) {
    this.model = model;
    this.maxTokens = contextLength || this.maxTokens;
    this.tailTokenBudget = Math.floor(this.maxTokens * TAIL_TOKEN_BUDGET_RATIO);
    this.maxSummaryTokens = Math.min(Math.floor(this.maxTokens * 0.05), SUMMARY_TOKENS_CEILING);
  }

  setLLMCompressFn(fn) {
    this._llmCompressFn = fn;
  }

  onSessionReset() {
    this._previousSummary = null;
    this._ineffectiveCompressionCount = 0;
    this._summaryFailureCooldownUntil = 0;
    this._lastSummaryError = null;
    this._lastCompressionSavingsPct = 0;
    this._lastSummaryDroppedCount = 0;
    this._lastSummaryFallbackUsed = false;
    this._lastAuxModelFailureError = null;
    this._lastAuxModelFailureModel = null;
    this._summaryModelFallenBack = false;
    this.compressionCount = 0;
  }

  _ensurePersistDir() {
    if (!fs.existsSync(this._persistDir)) {
      fs.mkdirSync(this._persistDir, { recursive: true });
    }
  }

  maybePersistToolResult(content, toolName, toolUseId) {
    if (!content || typeof content !== 'string') return { content, persisted: false };
    const contentBytes = Buffer.byteLength(content, 'utf-8');
    if (contentBytes <= PERSIST_THRESHOLD) return { content, persisted: false };

    this._ensurePersistDir();
    const fileName = `${toolUseId || Date.now().toString(36)}.txt`;
    const filePath = path.join(this._persistDir, fileName);

    try {
      fs.writeFileSync(filePath, content, 'utf-8');
    } catch (e) {
      console.warn('工具结果持久化写入失败:', e.message);
      return { content, persisted: false };
    }

    const preview = content.slice(0, PREVIEW_SIZE);
    const hasMore = content.length > PREVIEW_SIZE;
    const message = `<persisted-output>\n工具输出过大 (${(contentBytes/1024).toFixed(1)} KB)，完整结果已保存至: ${filePath}\n可使用 Read 工具读取特定部分。\n\n预览 (前 ${PREVIEW_SIZE} 字符):\n${preview}${hasMore ? '\n...[更多内容已省略]' : ''}\n</persisted-output>`;

    return { content: message, persisted: true, filePath };
  }

  _deduplicateToolResults(messages, pruneBoundary) {
    const contentHashes = new Map();
    let deduped = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== 'tool' || i >= pruneBoundary) continue;
      const content = _contentText(msg.content);
      if (typeof content !== 'string' || content.length < 200) continue;
      if (content.startsWith('[已压缩]') || content.startsWith('[Duplicate')) continue;

      const h = crypto.createHash('md5').update(content).digest('hex').slice(0, 12);
      if (contentHashes.has(h)) {
        messages[i] = { ...msg, content: '[重复的工具输出 — 与更近的调用内容相同]' };
        deduped++;
      } else {
        contentHashes.set(h, i);
      }
    }
    return deduped;
  }

  _pruneOldToolResults(messages, protectTailCount = MIN_TAIL_MESSAGES) {
    const n = messages.length;
    const result = messages.map(m => ({ ...m }));
    let prunedCount = 0;

    const callIdToTool = new Map();
    for (const msg of result) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.id) {
            callIdToTool.set(tc.id, {
              name: tc.function?.name || 'unknown',
              args: tc.function?.arguments || ''
            });
          }
        }
      }
    }

    let pruneBoundary = n - protectTailCount;
    if (this.tailTokenBudget > 0) {
      let accumulated = 0;
      let budgetBoundary = n;
      const minProtect = Math.min(protectTailCount, n);
      for (let i = n - 1; i >= 0; i--) {
        const msg = result[i];
        const rawContent = _contentText(msg.content);
        let msgTokens = estimateTokens(rawContent) + 10;
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            if (tc.function?.arguments) {
              msgTokens += estimateTokens(tc.function.arguments);
            }
          }
        }
        if (accumulated + msgTokens > this.tailTokenBudget * 1.5 && (n - i) >= minProtect) {
          budgetBoundary = i;
          break;
        }
        accumulated += msgTokens;
        budgetBoundary = i;
      }
      const budgetProtectCount = n - budgetBoundary;
      const protectedCount = Math.max(budgetProtectCount, minProtect);
      pruneBoundary = n - protectedCount;
    }

    const deduped = this._deduplicateToolResults(result, pruneBoundary);
    prunedCount += deduped;

    for (let i = 0; i < pruneBoundary; i++) {
      const msg = result[i];
      if (msg.role !== 'tool') continue;
      const content = _contentText(msg.content);
      if (typeof content !== 'string') continue;
      if (!content || content.startsWith('[已压缩]') || content.startsWith('[Duplicate') || content.startsWith('[重复')) continue;

      if (scoreMessageImportance(msg) >= 8) continue;

      if (content.length > 200) {
        const callId = msg.tool_call_id;
        const toolInfo = callIdToTool.get(callId) || { name: 'unknown', args: '' };
        const summary = summarizeToolResult(toolInfo.name, toolInfo.args, content);
        result[i] = { ...msg, content: `[已压缩] ${summary}` };
        prunedCount++;
      }
    }

    for (let i = 0; i < pruneBoundary; i++) {
      const msg = result[i];
      if (msg.role !== 'assistant' || !msg.tool_calls) continue;
      let modified = false;
      const newTcs = msg.tool_calls.map(tc => {
        const args = tc.function?.arguments || '';
        if (args.length > 500) {
          const newArgs = truncateToolCallArgsJson(args, 200);
          if (newArgs !== args) {
            modified = true;
            return { ...tc, function: { ...tc.function, arguments: newArgs } };
          }
        }
        return tc;
      });
      if (modified) {
        result[i] = { ...msg, tool_calls: newTcs };
      }
    }

    return { messages: result, prunedCount };
  }

  _sanitizeToolPairs(messages) {
    const survivingCallIds = new Set();
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const cid = tc.id || tc.call_id || '';
          if (cid) survivingCallIds.add(cid);
        }
      }
    }

    const resultCallIds = new Set();
    for (const msg of messages) {
      if (msg.role === 'tool' && msg.tool_call_id) {
        resultCallIds.add(msg.tool_call_id);
      }
    }

    const orphanedResults = new Set([...resultCallIds].filter(id => !survivingCallIds.has(id)));
    const filtered = orphanedResults.size > 0
      ? messages.filter(m => !(m.role === 'tool' && orphanedResults.has(m.tool_call_id)))
      : messages;

    if (orphanedResults.size > 0 && !this.quietMode) {
      console.log(`🔧 压缩清理: 移除 ${orphanedResults.size} 个孤立工具结果`);
    }

    const seenResultIds = new Set();
    const deduped = filtered.filter(m => {
      if (m.role === 'tool' && m.tool_call_id) {
        if (seenResultIds.has(m.tool_call_id)) return false;
        seenResultIds.add(m.tool_call_id);
      }
      return true;
    });

    const missingResults = new Set([...survivingCallIds].filter(id => !seenResultIds.has(id)));
    if (missingResults.size === 0) return deduped;

    const patched = [];
    for (const msg of deduped) {
      patched.push(msg);
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const cid = tc.id || tc.call_id || '';
          if (cid && missingResults.has(cid)) {
            patched.push({
              role: 'tool',
              tool_call_id: cid,
              content: '[早期对话的工具结果 — 参见上方上下文摘要]'
            });
            seenResultIds.add(cid);
          }
        }
      }
    }

    if (missingResults.size > 0 && !this.quietMode) {
      console.log(`🔧 压缩清理: 补充 ${missingResults.size} 个缺失工具结果存根`);
    }

    return patched;
  }

  _alignBoundaryForward(messages, idx) {
    while (idx < messages.length && messages[idx].role === 'tool') {
      idx++;
    }
    return idx;
  }

  _alignBoundaryBackward(messages, idx) {
    if (idx <= 0 || idx >= messages.length) return idx;
    let check = idx - 1;
    while (check >= 0 && messages[check].role === 'tool') {
      check--;
    }
    if (check >= 0 && messages[check].role === 'assistant' && messages[check].tool_calls) {
      idx = check;
    }
    return idx;
  }

  _findLastUserMessageIdx(messages, headEnd) {
    for (let i = messages.length - 1; i >= headEnd; i--) {
      if (messages[i].role === 'user') return i;
    }
    return -1;
  }

  _ensureLastUserMessageInTail(messages, cutIdx, headEnd) {
    const lastUserIdx = this._findLastUserMessageIdx(messages, headEnd);
    if (lastUserIdx < 0) return cutIdx;
    if (lastUserIdx >= cutIdx) return cutIdx;

    if (!this.quietMode) {
      console.log(`🔒 锚定尾部切割点到最新用户消息 (索引 ${lastUserIdx}，原 ${cutIdx})`);
    }
    return Math.max(lastUserIdx, headEnd + 1);
  }

  _findTailCutByTokens(messages, headEnd) {
    const tokenBudget = this.tailTokenBudget;
    const n = messages.length;
    const minTail = Math.min(MIN_TAIL_MESSAGES, n - headEnd - 1 > 0 ? n - headEnd - 1 : 0);
    const softCeiling = Math.floor(tokenBudget * 1.5);
    let accumulated = 0;
    let cutIdx = n;

    for (let i = n - 1; i >= headEnd; i--) {
      const msg = messages[i];
      const rawContent = msg.content;
      let msgTokens = estimateTokens(rawContent) + 10;

      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.function?.arguments) {
            msgTokens += estimateTokens(tc.function.arguments);
          }
        }
      }

      if (accumulated + msgTokens > softCeiling && (n - i) >= minTail) break;
      accumulated += msgTokens;
      cutIdx = i;
    }

    const fallbackCut = n - minTail;
    if (cutIdx > fallbackCut) cutIdx = fallbackCut;
    if (cutIdx <= headEnd) cutIdx = Math.max(fallbackCut, headEnd + 1);

    cutIdx = this._alignBoundaryBackward(messages, cutIdx);
    cutIdx = this._ensureLastUserMessageInTail(messages, cutIdx, headEnd);

    return Math.max(cutIdx, headEnd + 1);
  }

  _findLatestContextSummary(messages, compressStart, compressEnd) {
    for (let i = compressEnd - 1; i >= compressStart; i--) {
      const msg = messages[i];
      if (msg.isSummary || _isContextSummaryContent(msg.content)) {
        return { idx: i, body: _stripSummaryPrefix(_contentText(msg.content)) };
      }
    }
    return { idx: null, body: null };
  }

  _computeSummaryBudget(turnsToSummarize) {
    const contentTokens = estimateMessagesTokens(turnsToSummarize);
    const budget = Math.floor(contentTokens * SUMMARY_RATIO);
    return Math.max(MIN_SUMMARY_TOKENS, Math.min(budget, this.maxSummaryTokens));
  }

  _computeAdaptiveChunkRatio(messages, contextWindow) {
    if (!messages || messages.length === 0) return BASE_CHUNK_RATIO;
    const totalTokens = estimateMessagesTokens(messages);
    const avgTokens = totalTokens / messages.length;
    const safeAvgTokens = avgTokens * ADAPTIVE_SAFETY_MARGIN;
    const avgRatio = safeAvgTokens / (contextWindow || DEFAULT_MAX_TOKENS);
    if (avgRatio > 0.1) {
      const reduction = Math.min(avgRatio * 2, BASE_CHUNK_RATIO - MIN_CHUNK_RATIO);
      return Math.max(MIN_CHUNK_RATIO, BASE_CHUNK_RATIO - reduction);
    }
    return BASE_CHUNK_RATIO;
  }

  _isOversizedForSummary(msg, contextWindow) {
    const tokens = estimateMessagesTokens([msg]) * ADAPTIVE_SAFETY_MARGIN;
    return tokens > (contextWindow || DEFAULT_MAX_TOKENS) * 0.5;
  }

  _buildHandoffSuffix() {
    return loadPromptFile('compressor', 'handoff-suffix.txt') || '\n\n## 角色延续指令\n- 你是当前会话的主控者（LEADER），负责协调所有任务和决策。\n- 如有正在运行的自主子单元，它们是你的下属（SUBORDINATE），你必须监督其输出。\n- 不要重复摘要中已标记为"已完成"的工作，直接从"进行中"和"剩余工作"继续。\n- 如有未解决的阻塞项，优先处理它们。\n';
  }

  _serializeForSummary(turns) {
    const contextWindow = this.maxTokens || DEFAULT_MAX_TOKENS;
    const chunkRatio = this._computeAdaptiveChunkRatio(turns, contextWindow);
    const adaptiveContentMax = Math.max(1500, Math.floor(contextWindow * chunkRatio));
    const adaptiveHead = Math.floor(adaptiveContentMax * 0.65);
    const adaptiveTail = Math.floor(adaptiveContentMax * 0.25);

    const parts = [];
    for (const msg of turns) {
      const role = msg.role;
      let content = redactSensitiveText(_contentText(msg.content));

      if (role === 'tool') {
        const toolId = msg.tool_call_id || '';
        if (content.length > adaptiveContentMax) {
          content = content.slice(0, adaptiveHead) + '\n...[truncated]...\n' + content.slice(-adaptiveTail);
        }
        parts.push(`[工具结果 ${toolId}]: ${content}`);
        continue;
      }

      if (role === 'assistant') {
        if (content.length > adaptiveContentMax) {
          content = content.slice(0, adaptiveHead) + '\n...[truncated]...\n' + content.slice(-adaptiveTail);
        }
        const toolCalls = msg.tool_calls || [];
        if (toolCalls.length > 0) {
          const tcParts = toolCalls.map(tc => {
            const name = tc.function?.name || '?';
            let args = redactSensitiveText(tc.function?.arguments || '');
            if (args.length > TOOL_ARGS_MAX) {
              args = args.slice(0, TOOL_ARGS_HEAD) + '...';
            }
            return `  ${name}(${args})`;
          });
          content += '\n[工具调用:\n' + tcParts.join('\n') + '\n]';
        }
        parts.push(`[助手]: ${content}`);
        continue;
      }

      if (content.length > adaptiveContentMax) {
        content = content.slice(0, adaptiveHead) + '\n...[truncated]...\n' + content.slice(-adaptiveTail);
      }
      parts.push(`[${role.toUpperCase()}]: ${content}`);
    }
    return parts.join('\n\n');
  }

  _generateStructuredSummary(turnsToSummarize, focusTopic = null, taskInProgress = false, pendingToolSummary = '') {
    if (this._llmCompressFn) {
      return null;
    }

    const parts = [];
    for (const msg of turnsToSummarize) {
      const role = msg.role;
      const content = _contentText(msg.content);
      if (!content || content.trim().length === 0) continue;

      const redacted = redactSensitiveText(content);

      if (role === 'user') {
        parts.push(`[用户] ${redacted.slice(0, 500)}`);
      } else if (role === 'assistant') {
        const toolCalls = msg.tool_calls || [];
        if (toolCalls.length > 0) {
          const callDesc = toolCalls.map(tc => {
            const name = tc.function?.name || '?';
            let args = redactSensitiveText(tc.function?.arguments || '');
            if (args.length > 100) args = args.slice(0, 97) + '...';
            return `${name}(${args})`;
          }).join(', ');
          parts.push(`[助手→调用工具] ${callDesc}`);
          if (redacted.trim()) parts.push(`[助手回复] ${redacted.slice(0, 300)}`);
        } else {
          parts.push(`[助手] ${redacted.slice(0, 500)}`);
        }
      } else if (role === 'tool') {
        const summary = content.length > 200 ? summarizeToolResult('tool', null, content) : content;
        parts.push(`[工具结果] ${summary}`);
      } else if (role === 'system') {
        parts.push(`[系统] ${redacted.slice(0, 200)}`);
      }
    }

    const conversationDigest = parts.join('\n');
    const focusSection = focusTopic ? `\n## 聚焦主题\n"${focusTopic}" — 与此主题相关的内容保留完整细节，其他内容更积极压缩\n` : '';

    const keyFacts = extractKeyFacts(turnsToSummarize);
    const keyFactsSection = keyFacts.length > 0
      ? `\n## 自动提取的关键事实\n${keyFacts.map((f, i) => `${i+1}. ${f}`).join('\n')}\n`
      : '';

    // 任务进度标记：当检测到任务仍在进行中时，在摘要中明确标注
    const taskProgressSection = taskInProgress
      ? `\n## ⚠️ 任务未完成\n上一次对话中用户任务尚未完成，工具调用仍在进行中。必须继续执行用户请求，不能认为任务已完成。\n${pendingToolSummary ? `最近调用的工具: ${pendingToolSummary}\n` : ''}`
      : '';

    let summary;
    if (this._previousSummary) {
      summary = loadPromptFile('compressor', 'structured-summary-update.txt', {
        SUMMARY_PREFIX,
        taskProgressSection: taskProgressSection || '',
        conversationDigest: conversationDigest,
        previousSummary: this._previousSummary.slice(0, 3000),
        focusSection: focusSection || '',
        keyFactsSection: keyFactsSection || '',
        SUMMARY_END_MARKER,
      }) || `${SUMMARY_PREFIX}\n\n## 活跃任务\n[用户最近的未完成请求 — 从此处继续]${taskProgressSection}\n\n## 迭代更新\n\n以下是基于之前摘要和新增对话的更新：\n\n### 新增对话要点\n${conversationDigest}\n\n### 之前摘要（保留所有仍相关的信息）\n${this._previousSummary.slice(0, 3000)}\n${focusSection}${keyFactsSection}\n## 关键上下文\n[必须保留的重要信息，绝不包含API密钥/密码/凭证]${SUMMARY_END_MARKER}`;
    } else {
      const conversationDigestLines = conversationDigest.split('\n').slice(0, 30).map((l, i) => `${i+1}. ${l}`).join('\n');
      summary = loadPromptFile('compressor', 'structured-summary-first.txt', {
        SUMMARY_PREFIX,
        taskProgressSection: taskProgressSection || '',
        conversationDigestLines,
        focusSection: focusSection || '',
        keyFactsSection: keyFactsSection || '',
        SUMMARY_END_MARKER,
      }) || `${SUMMARY_PREFIX}\n\n## 活跃任务\n[用户最近的请求原文 — 继续执行此任务]${taskProgressSection}\n\n## 目标\n[用户整体想完成的事情]\n\n## 约束与偏好\n[用户偏好、编码风格、约束、重要决定]\n\n## 已完成操作\n${conversationDigestLines}\n\n## 当前状态\n[工作目录、修改/创建的文件、测试状态等]\n\n## 进行中\n[压缩触发时正在进行的工作]\n\n## 阻塞\n[未解决的错误或问题，包含完整错误信息]\n\n## 关键决策\n[重要技术决策及其原因]\n\n## 已解决的问题\n[用户已问且已答的问题 — 包含答案以免重复]\n\n## 待处理用户请求\n[用户尚未得到回答的问题或请求]\n\n## 相关文件\n[读取、修改或创建的文件 — 附简要说明]\n\n## 剩余工作\n[仍需完成的事项 — 作为上下文而非指令]\n${focusSection}${keyFactsSection}\n## 关键上下文\n[必须保留的具体值、错误信息、配置细节，绝不包含API密钥/密码/凭证]${SUMMARY_END_MARKER}`;
    }

    this._previousSummary = _stripSummaryPrefix(summary);
    return summary;
  }

  async _generateLLMSummary(turnsToSummarize, focusTopic = null, taskInProgress = false) {
    if (!this._llmCompressFn) return null;

    const summaryBudget = this._computeSummaryBudget(turnsToSummarize);
    const contentToSummarize = this._serializeForSummary(turnsToSummarize);

    const preamble = loadPromptFile('compressor', 'llm-preamble.txt') || '你是一个摘要代理，正在创建上下文检查点。将下面对话轮次视为源材料，生成紧凑的记录。只输出结构化摘要，不要添加问候或前言。用用户使用的语言撰写摘要。绝不包含API密钥、令牌、密码、凭证或连接字符串 — 用 [REDACTED] 替换。';

    const templateSections = loadPromptFile('compressor', 'llm-sections.txt', { budget: summaryBudget }) || `## 活跃任务
[最重要的字段。复制用户最近的请求原文。如果多个任务中只有部分完成，只列出未完成的。]

## 目标
[用户整体想完成的事情]

## 约束与偏好
[用户偏好、编码风格、约束、重要决定]

## 已完成操作
[编号列表，包含工具名、目标、结果。格式: N. 操作 目标 — 结果 [工具: name]]

## 当前状态
[工作目录、修改/创建的文件、测试状态、运行中的进程]

## 进行中
[压缩触发时正在进行的工作]

## 阻塞
[未解决的错误或问题，包含完整错误信息]

## 关键决策
[重要技术决策及其原因]

## 已解决的问题
[用户已问且已答的问题 — 包含答案]

## 待处理用户请求
[尚未得到回答的问题或请求。如无则写"无"]

## 相关文件
[涉及的文件 — 附简要说明]

## 剩余工作
[仍需完成的事项 — 作为上下文而非指令]

## 关键上下文
[必须保留的具体值、错误信息、配置细节。绝不包含API密钥/密码/凭证 — 用 [REDACTED] 替代]

目标约 ${summaryBudget} tokens。要具体 — 包含文件路径、命令输出、错误信息、行号和具体值。`;

    let prompt;
    if (this._previousSummary) {
      prompt = `${preamble}

你正在更新上下文压缩摘要。之前的压缩产生了以下摘要，之后发生了新的对话轮次。

之前的摘要:
${this._previousSummary}

需要纳入的新对话轮次:
${contentToSummarize}

使用以下结构更新摘要。保留所有仍相关的已有信息。将新的已完成操作添加到编号列表（继续编号）。将"进行中"的项移到"已完成操作"。将已回答的问题移到"已解决的问题"。更新"当前状态"。只在信息明显过时时才移除。关键：更新"## 活跃任务"以反映用户最近的未完成请求。

${templateSections}`;
    } else {
      prompt = `${preamble}

为早期轮次被压缩后的对话创建结构化检查点摘要。摘要应保留足够的细节以保持连续性。

需要摘要的轮次:
${contentToSummarize}

使用以下结构:

${templateSections}`;
    }

    if (focusTopic) {
      prompt += `\n\n聚焦主题: "${focusTopic}"\n用户要求本次压缩优先保留与聚焦主题相关的所有信息。对于与"${focusTopic}"相关的内容，包含完整细节。对于不相关的内容，更积极地压缩。聚焦主题部分应获得约60-70%的摘要token预算。绝不保留API密钥、令牌、密码或凭证 — 使用 [REDACTED]。`;
    }

    if (taskInProgress) {
      prompt += '\n\n⚠️ 重要：检测到用户任务尚未完成（工具调用仍在进行中）。在摘要的"活跃任务"和"进行中"部分必须明确标注任务未完成，列出已完成的步骤和仍需完成的工作。绝不能让摘要读者误以为任务已完成。';
    }

    try {
      const result = await this._llmCompressFn(prompt, { maxTokens: Math.floor(summaryBudget * 1.3) });
      let content = result || '';
      if (typeof content !== 'string') content = String(content || '');
      content = redactSensitiveText(content.trim());
      this._previousSummary = content;
      this._summaryFailureCooldownUntil = 0;
      this._lastSummaryError = null;

      const handoffSuffix = this._buildHandoffSuffix();
      return `${SUMMARY_PREFIX}\n${content}${handoffSuffix}${SUMMARY_END_MARKER}`;
    } catch (e) {
      this._lastSummaryError = e.message;
      if (!this._summaryModelFallenBack) {
        this._summaryModelFallenBack = true;
        this._lastAuxModelFailureError = e.message.slice(0, 200);
        this._llmCompressFn = null;
        return null;
      }
      this._summaryFailureCooldownUntil = Date.now() + SUMMARY_FAILURE_COOLDOWN_MIN * 1000;
      return null;
    }
  }

  async compress(messages, options = {}) {
    const currentTokens = options.currentTokens || estimateMessagesTokens(messages);
    // 支持动态 maxTokens 覆盖：当 options.maxTokens 传入时使用该值，否则用实例的 this.maxTokens
    // 这允许不同模型走不同的上下文窗口限制（如 claude 200K vs qwen-max 32K）
    const effectiveMaxTokens = options.maxTokens || this.maxTokens;
    const thresholdTokens = Math.floor(effectiveMaxTokens * this.summaryThreshold);

    if (currentTokens <= thresholdTokens) {
      return { messages, compressed: false, originalTokens: currentTokens };
    }

    // 2026-08-06: 严重溢出(>1.5x maxTokens)时强制压缩——即使连续压缩无效也尝试，
    // 否则上下文无限增长 → API 400(实测溢出223%后请求被拒)。宁可有损也不失败。
    const severeOverflow = currentTokens > effectiveMaxTokens * 1.5;
    if (this._ineffectiveCompressionCount >= MAX_INEFFECTIVE_COMPRESSIONS && !severeOverflow) {
      if (!this.quietMode) {
        console.log('⏸️ 跳过压缩：连续多次压缩效果不佳，避免无效循环');
      }
      return { messages, compressed: false, originalTokens: currentTokens, skipped: true };
    }

    if (Date.now() < this._summaryFailureCooldownUntil && !severeOverflow) {
      if (!this.quietMode) {
        console.log('⏸️ 跳过压缩：摘要生成冷却中');
      }
      return { messages, compressed: false, originalTokens: currentTokens, skipped: true };
    }

    if (!this.quietMode) {
      console.log(`🗜️ 开始压缩上下文: ${currentTokens} tokens (阈值: ${thresholdTokens})`);
    }

    const n = messages.length;
    const minForCompress = this.protectFirstN + MIN_TAIL_MESSAGES + 1;
    if (n <= minForCompress) {
      return { messages, compressed: false, originalTokens: currentTokens };
    }

    let prunedMessages = messages;
    let prunedCount = 0;
    const pruneResult = this._pruneOldToolResults(messages);
    if (pruneResult.prunedCount > 0) {
      prunedMessages = pruneResult.messages;
      prunedCount = pruneResult.prunedCount;
      if (!this.quietMode) {
        console.log(`📋 预压缩：修剪了 ${prunedCount} 个旧工具结果`);
      }
    }


    // 2026-08-06: 压缩前截断所有超长工具结果——写文章/调研时单条工具结果可达数万 token，
    // 是上下文膨胀的主要来源(实测78K中大部分是工具结果)。截断后 token 大降，压缩更有效。
    const TRUNCATE_TOOL_MAX = 3000;
    let truncatedToolCount = 0;
    prunedMessages = prunedMessages.map(m => {
      if (m && m.role === 'tool' && typeof m.content === 'string' && m.content.length > TRUNCATE_TOOL_MAX) {
        truncatedToolCount++;
        return { ...m, content: m.content.slice(0, TRUNCATE_TOOL_MAX) + '\n...[工具结果已截断]...' };
      }
      return m;
    });
    if (truncatedToolCount > 0 && !this.quietMode) {
      console.log('✂️ 预压缩：截断 ' + truncatedToolCount + ' 个超长工具结果(>3000字符)');
    }

    let compressStart = this.protectFirstN;
    compressStart = this._alignBoundaryForward(prunedMessages, compressStart);

    const compressEnd = this._findTailCutByTokens(prunedMessages, compressStart);

    if (compressStart >= compressEnd) {
      return { messages, compressed: false, originalTokens: currentTokens };
    }

    let turnsToSummarize = prunedMessages.slice(compressStart, compressEnd);

    // P2-1(2026-08-25) 写回载荷:被替换中段里带 history id 的消息(供 history.replaceWithSummary)
    const removedIdsForPersist = turnsToSummarize.filter(m => m && m.id).map(m => m.id);

    // Bootstrap 保护：如果压缩范围内包含 bootstrap 内容，提取并保留
    // 参考 Superpowers session_compact 机制：压缩时保留关键上下文
    let preservedBootstrap = null;
    for (let i = compressStart; i < compressEnd; i++) {
      const msg = prunedMessages[i];
      const content = typeof msg.content === 'string' ? msg.content : '';
      if (content.includes(BOOTSTRAP_MARKER)) {
        const start = content.indexOf(BOOTSTRAP_MARKER);
        const end = content.indexOf(BOOTSTRAP_END_MARKER);
        if (end > start) {
          preservedBootstrap = content.substring(start, end + BOOTSTRAP_END_MARKER.length);
        }
        break;
      }
    }

    const { idx: summaryIdx, body: summaryBody } = this._findLatestContextSummary(
      prunedMessages, compressStart, compressEnd
    );
    if (summaryIdx !== null) {
      if (summaryBody && !this._previousSummary) {
        this._previousSummary = summaryBody;
      }
      turnsToSummarize = prunedMessages.slice(summaryIdx + 1, compressEnd);
    }

    if (!this.quietMode) {
      const tailMsgs = n - compressEnd;
      console.log(`📊 压缩范围: 消息 ${compressStart+1}-${compressEnd} (${turnsToSummarize.length} 轮), 保护 ${compressStart} 头部 + ${tailMsgs} 尾部消息`);
    }

    this._lastSummaryDroppedCount = 0;
    this._lastSummaryFallbackUsed = false;
    this._lastSummaryError = null;
    this._lastAuxModelFailureError = null;
    this._lastAuxModelFailureModel = null;

    // 检测任务完成状态：如果待压缩消息中有工具调用但最后一条不是 assistant 纯文本回复，
    // 说明任务仍在进行中，需要在摘要中明确标注
    let taskInProgress = false;
    let pendingToolSummary = '';
    const hasToolCalls = turnsToSummarize.some(m => m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0);
    const lastMsg = turnsToSummarize[turnsToSummarize.length - 1];
    const lastIsAssistantText = lastMsg && lastMsg.role === 'assistant' && !lastMsg.tool_calls;
    if (hasToolCalls && !lastIsAssistantText) {
      taskInProgress = true;
      // 提取未完成的工具调用摘要
      const pendingCalls = [];
      for (const msg of turnsToSummarize) {
        if (msg.role === 'assistant' && msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            const name = tc.function?.name || '?';
            let args = tc.function?.arguments || '';
            try { args = typeof args === 'string' ? args : JSON.stringify(args); } catch (e) { console.warn('[compressor] failed to stringify tool call args:', e.message); }
            if (args.length > 80) args = args.slice(0, 77) + '...';
            pendingCalls.push(`${name}(${args})`);
          }
        }
      }
      if (pendingCalls.length > 0) {
        pendingToolSummary = pendingCalls.slice(-5).join(', ');
      }
    }

    let summary;
    try {
      if (this._llmCompressFn) {
        summary = await this._generateLLMSummary(turnsToSummarize, options.focusTopic, taskInProgress);
      }
      if (!summary) {
        summary = this._generateStructuredSummary(turnsToSummarize, options.focusTopic, taskInProgress, pendingToolSummary);
      }
    } catch (e) {
      this._lastSummaryError = e.message;
      if (!this.quietMode) {
        console.warn('⚠️ 摘要生成失败:', e.message);
      }
    }

    if (!summary) {
      const nDropped = compressEnd - compressStart;
      this._lastSummaryDroppedCount = nDropped;
      this._lastSummaryFallbackUsed = true;
      summary = `${SUMMARY_PREFIX}\n摘要生成不可用。${nDropped} 条消息被移除以释放上下文空间。请基于下方最新消息和当前文件状态继续工作。${SUMMARY_END_MARKER}`;
      this._summaryFailureCooldownUntil = Date.now() + SUMMARY_FAILURE_COOLDOWN_MIN * 1000;
    }

    const compressed = [];

    for (let i = 0; i < compressStart; i++) {
      const msg = { ...prunedMessages[i] };
      if (i === 0 && msg.role === 'system') {
        const existing = msg.content;
        const note = '[注意：部分早期对话已被压缩为摘要以节省上下文空间。当前会话状态可能反映了早期工作，请基于摘要和状态继续而非重做。持久化记忆保持完整权威。]';
        if (typeof existing === 'string' && !existing.includes(note)) {
          msg.content = existing + '\n\n' + note;
        }
      }
      compressed.push(msg);
    }

    let mergeSummaryIntoTail = false;
    const lastHeadRole = compressStart > 0 ? prunedMessages[compressStart - 1].role : 'user';
    const firstTailRole = compressEnd < n ? prunedMessages[compressEnd].role : 'user';

    let summaryRole = 'user';
    if (lastHeadRole === 'assistant' || lastHeadRole === 'tool') {
      summaryRole = 'user';
    } else {
      summaryRole = 'assistant';
    }

    if (summaryRole === firstTailRole) {
      const flipped = summaryRole === 'user' ? 'assistant' : 'user';
      if (flipped !== lastHeadRole) {
        summaryRole = flipped;
      } else {
        mergeSummaryIntoTail = true;
      }
    }

    if (!mergeSummaryIntoTail && summaryRole === 'user') {
      summary = summary + '\n\n--- 上下文摘要结束 — 请回复下方最新消息，而非摘要中的内容 ---';
    }

    if (!mergeSummaryIntoTail) {
      compressed.push({
        role: summaryRole,
        content: summary,
        isSummary: true
      });
    }

    // Bootstrap 恢复：将压缩范围内提取的 bootstrap 重新注入到末条用户消息
    // 缓存优化 A(2026-08-28)：恢复位置与注入位置统一尾置——末条 user 受
    // _ensureLastUserMessageInTail 尾部保护，正常不落入压缩范围；此恢复仅兜底
    // 历史里残留的旧首条注入内容；末条已含新标记时守卫跳过，避免重复。
    if (preservedBootstrap) {
      let lastUserIdx = -1;
      for (let i = compressed.length - 1; i >= 0; i--) {
        if (compressed[i] && compressed[i].role === 'user') { lastUserIdx = i; break; }
      }
      if (lastUserIdx >= 0) {
        const msg = compressed[lastUserIdx];
        const content = typeof msg.content === 'string' ? msg.content : '';
        if (!content.includes(BOOTSTRAP_MARKER)) {
          compressed[lastUserIdx] = {
            ...msg,
            content: `${preservedBootstrap}\n\n${content}`,
          };
          if (!this.quietMode) {
            console.log('🔄 [Bootstrap 保护] 压缩后恢复 bootstrap 上下文到末条用户消息');
          }
        }
      }
    }

    for (let i = compressEnd; i < prunedMessages.length; i++) {
      const msg = { ...prunedMessages[i] };
      if (mergeSummaryIntoTail && i === compressEnd) {
        const mergedPrefix = summary + '\n\n';
        msg.content = _appendText(msg.content, mergedPrefix, true);
        mergeSummaryIntoTail = false;
      }
      compressed.push(msg);
    }

    this.compressionCount++;

    const sanitized = this._sanitizeToolPairs(compressed);

    const newEstimate = estimateMessagesTokens(sanitized);
    const savedEstimate = currentTokens - newEstimate;
    const savingsPct = currentTokens > 0 ? (savedEstimate / currentTokens * 100) : 0;
    this._lastCompressionSavingsPct = savingsPct;

    if (savingsPct < 10) {
      this._ineffectiveCompressionCount++;
    } else {
      this._ineffectiveCompressionCount = 0;
    }

    if (!this.quietMode) {
      console.log(`✅ 压缩完成: ${n} → ${sanitized.length} 消息 (~${savedEstimate} tokens 节省, ${savingsPct.toFixed(1)}%)`);
      console.log(`📊 第 ${this.compressionCount} 次压缩`);
    }

    this.compressionHistory.push({
      timestamp: Date.now(),
      originalTokens: currentTokens,
      compressedTokens: newEstimate,
      ratio: savingsPct,
      messageCount: n,
      prunedCount,
      compressionNumber: this.compressionCount
    });

    return {
      messages: sanitized,
      compressed: true,
      originalTokens: currentTokens,
      compressedTokens: newEstimate,
      ratio: savingsPct,
      summary,
      prunedCount,
      savingsPct,
      persist: removedIdsForPersist.length
        ? { removedIds: removedIdsForPersist, summaryText: summary, summaryRole }
        : null
    };
  }

  hasContentToCompress(messages) {
    const compressStart = this._alignBoundaryForward(messages, this.protectFirstN);
    const compressEnd = this._findTailCutByTokens(messages, compressStart);
    return compressStart < compressEnd;
  }

  getStats() {
    if (this.compressionHistory.length === 0) {
      return { compressions: 0, ineffectiveCount: this._ineffectiveCompressionCount };
    }

    const totalOriginal = this.compressionHistory.reduce((sum, h) => sum + h.originalTokens, 0);
    const totalCompressed = this.compressionHistory.reduce((sum, h) => sum + h.compressedTokens, 0);

    return {
      compressions: this.compressionHistory.length,
      totalOriginalTokens: totalOriginal,
      totalCompressedTokens: totalCompressed,
      averageRatio: totalOriginal > 0 ? (1 - totalCompressed / totalOriginal) * 100 : 0,
      lastCompression: this.compressionHistory[this.compressionHistory.length - 1],
      ineffectiveCount: this._ineffectiveCompressionCount,
      lastSavingsPct: this._lastCompressionSavingsPct
    };
  }

  slidingWindow(messages, windowSize = 20) {
    if (messages.length <= windowSize) return messages;
    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');
    const window = nonSystemMessages.slice(-windowSize);
    return [...systemMessages, ...window];
  }

  smartTruncate(messages, maxTokens) {
    const target = maxTokens || Math.floor(this.maxTokens * 0.8);
    let currentTokens = estimateMessagesTokens(messages);
    if (currentTokens <= target) return { messages, truncated: false };

    const systemMessages = messages.filter(m => m.role === 'system');
    const otherMessages = messages.filter(m => m.role !== 'system');

    while (currentTokens > target && otherMessages.length > MIN_TAIL_MESSAGES) {
      const removed = otherMessages.shift();
      currentTokens -= estimateTokens(_contentText(removed?.content || ''));
    }

    return {
      messages: [...systemMessages, ...otherMessages],
      truncated: true,
      removedCount: messages.length - systemMessages.length - otherMessages.length
    };
  }

  sortForPromptCache(messages) {
    if (!Array.isArray(messages) || messages.length <= 1) return messages;

    const system = [];
    const summary = [];
    const toolResults = [];
    const conversation = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        system.push(msg);
      } else if (msg.role === 'tool' || (msg.role === 'assistant' && msg.tool_calls?.length > 0)) {
        toolResults.push(msg);
      } else if (_isContextSummaryContent(msg.content)) {
        summary.push(msg);
      } else {
        conversation.push(msg);
      }
    }

    const deterministicSort = (a, b) => {
      const aKey = `${a.role}:${a.name || ''}:${(a.content || '').slice(0, 100)}`;
      const bKey = `${b.role}:${b.name || ''}:${(b.content || '').slice(0, 100)}`;
      return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
    };

    system.sort(deterministicSort);
    summary.sort(deterministicSort);

    return [...system, ...summary, ...toolResults, ...conversation];
  }

  async llmCompress(messages, opts = {}) {
    if (!this._llmCompressFn) {
      return this.smartTruncate(messages, opts.maxTokens);
    }

    const currentTokens = estimateMessagesTokens(messages);
    const targetTokens = opts.maxTokens || Math.floor(this.maxTokens * 0.7);

    if (currentTokens <= targetTokens) {
      return { messages, compressed: false, tokens: currentTokens };
    }

    const systemMsgs = messages.filter(m => m.role === 'system');
    const nonSystemMsgs = messages.filter(m => m.role !== 'system');

    const protectedRecent = nonSystemMsgs.slice(-(opts.protectRecent || 6));
    const compressible = nonSystemMsgs.slice(0, -(opts.protectRecent || 6));

    if (compressible.length === 0) {
      return { messages, compressed: false, tokens: currentTokens };
    }

    const compressibleText = compressible.map((m, i) => {
      const role = m.role;
      const content = _contentText(m.content || '');
      const toolInfo = m.tool_calls
        ? m.tool_calls.map(tc => `[${tc.function?.name}]`).join(', ')
        : '';
      return `[${i}] ${role}${toolInfo ? ` (${toolInfo})` : ''}: ${content.slice(0, 500)}`;
    }).join('\n');

    try {
      const summary = await this._llmCompressFn(compressibleText, {
        targetTokens: Math.floor(targetTokens * 0.3),
        originalTokens: estimateTokens(compressibleText),
        contextType: 'conversation',
      });

      if (!summary || summary.length < 50) {
        return this.smartTruncate(messages, targetTokens);
      }

      const summaryMessage = {
        role: 'user',
        content: `${SUMMARY_PREFIX}\n${summary}${SUMMARY_END_MARKER}`,
      };

      const compressedMessages = [...systemMsgs, summaryMessage, ...protectedRecent];
      const newTokens = estimateMessagesTokens(compressedMessages);

      this.compressionCount++;
      this._previousSummary = summary;
      this.compressionHistory.push({
        type: 'llm_compress',
        originalTokens: currentTokens,
        compressedTokens: newTokens,
        ratio: newTokens / currentTokens,
        timestamp: Date.now(),
      });

      return {
        messages: compressedMessages,
        compressed: true,
        tokens: newTokens,
        savingsPct: ((1 - newTokens / currentTokens) * 100).toFixed(1),
      };
    } catch (e) {
      return this.smartTruncate(messages, targetTokens);
    }
  }

  adaptiveCompress(messages, opts = {}) {
    const currentTokens = estimateMessagesTokens(messages);
    const targetTokens = opts.maxTokens || Math.floor(this.maxTokens * 0.8);

    if (currentTokens <= targetTokens) {
      return { messages, compressed: false, tokens: currentTokens };
    }

    const overflowRatio = currentTokens / targetTokens;
    let strategy;

    if (overflowRatio < 1.3) {
      strategy = 'light_prune';
    } else if (overflowRatio < 2.0) {
      strategy = 'moderate_compress';
    } else {
      strategy = 'aggressive_compress';
    }

    let result;

    switch (strategy) {
      case 'light_prune': {
        const pruned = this._pruneOldToolResults(messages);
        const newTokens = estimateMessagesTokens(pruned.messages);
        result = { messages: pruned.messages, compressed: pruned.prunedCount > 0, tokens: newTokens, strategy };
        break;
      }
      case 'moderate_compress': {
        const pruned = this._pruneOldToolResults(messages);
        const truncated = this.smartTruncate(pruned.messages, targetTokens);
        result = { ...truncated, strategy };
        break;
      }
      case 'aggressive_compress': {
        const windowed = this.slidingWindow(messages, Math.floor(messages.length * 0.4));
        const pruned = this._pruneOldToolResults(windowed);
        const truncated = this.smartTruncate(pruned.messages, targetTokens);
        result = { ...truncated, strategy };
        break;
      }
      default: {
        result = this.smartTruncate(messages, targetTokens);
      }
    }

    this.compressionCount++;
    this.compressionHistory.push({
      type: 'adaptive',
      strategy,
      originalTokens: currentTokens,
      compressedTokens: estimateMessagesTokens(result.messages),
      timestamp: Date.now(),
    });

    return result;
  }

  compressMultiAgentContext(contexts, options = {}) {
    const maxPerAgent = options.maxPerAgent || 2000;
    const compressed = {};

    for (const [agentId, context] of Object.entries(contexts)) {
      const contextStr = typeof context === 'string' ? context : JSON.stringify(context);
      if (contextStr.length <= maxPerAgent) {
        compressed[agentId] = context;
        continue;
      }

      const ratio = maxPerAgent / contextStr.length;
      const keepChars = Math.floor(contextStr.length * ratio);
      compressed[agentId] = contextStr.slice(0, keepChars) + '\n...[compressed]';
    }

    return compressed;
  }

  buildSharedContext(agentResults, enterpriseProfile, options = {}) {
    const sharedLines = [];

    if (enterpriseProfile) {
      sharedLines.push(`[企业类型: ${enterpriseProfile.businessType || 'N/A'}/${enterpriseProfile.industry || 'N/A'}/${enterpriseProfile.scale || 'N/A'}]`);
    }

    if (agentResults && agentResults.length > 0) {
      sharedLines.push('[协作结果摘要]');
      for (const result of agentResults.slice(-5)) {
        const agentLine = result.summary
          ? `${result.agentId || 'agent'}: ${result.summary.slice(0, 200)}`
          : `${result.agentId || 'agent'}: completed`;
        sharedLines.push(agentLine);
      }
    }

    const maxSharedSize = options.maxSharedSize || 3000;
    const shared = sharedLines.join('\n');
    return shared.length > maxSharedSize
      ? shared.slice(0, maxSharedSize) + '\n...[truncated]'
      : shared;
  }
}

module.exports = ContextCompressor;
module.exports.estimateTokens = estimateTokens;
module.exports.estimateMessagesTokens = estimateMessagesTokens;
module.exports.redactSensitiveText = redactSensitiveText;
module.exports.summarizeToolResult = summarizeToolResult;
module.exports.scoreMessageImportance = scoreMessageImportance;
module.exports.extractKeyFacts = extractKeyFacts;
