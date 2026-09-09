/**
 * NL2SQL 引擎 — 自然语言转 SQL（只读安全门 + LLM 翻译）
 *
 * 安全模型（分层防御）：
 *   1. LLM 翻译出的 SQL 必须通过 isSafeSelect 静态检查（写语句/多语句/系统表拒绝）
 *   2. 下游 DatabaseQuery 保留其原有只读契约与路径白名单（Task 2）
 *   3. 所有查询强制 LIMIT（由 Task 2 执行层叠加）
 */

const WRITE_PATTERN = /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|TRUNCATE|GRANT|REINDEX|VACUUM|ATTACH|EXEC|CALL)\b/i;
const SYSTEM_TABLE_PATTERN = /sqlite_(master|sequence|schema|temp_master)\b/i;

/**
 * 剥离字符串字面量、行注释与块注释后检测危险 SQL
 * @param {string} sql
 * @returns {{ safe: boolean, reason?: string }}
 */
function isSafeSelect(sql) {
  if (!sql || typeof sql !== 'string') return { safe: false, reason: 'SQL 为空' };
  // 剥字符串字面量（单双引号，含转义）
  let stripped = sql
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
    .replace(/"(?:[^"\\]|\\.|"")*"/g, '""');
  // 剥行注释与块注释
  stripped = stripped.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

  if (WRITE_PATTERN.test(stripped)) return { safe: false, reason: `不允许的写操作` };
  // 多语句：剥离后剩余分号 = 多语句
  if (stripped.includes(';')) return { safe: false, reason: '多语句查询被拒绝' };
  if (SYSTEM_TABLE_PATTERN.test(stripped)) return { safe: false, reason: '不允许访问 sqlite 系统表' };
  const first = stripped.trim().toUpperCase();
  const allowed = ['SELECT', 'EXPLAIN', 'PRAGMA', 'SHOW', 'DESCRIBE', 'ANALYZE', 'WITH', '.MODE', '.HEADERS', '.TABLES', '.SCHEMA', '.DATABASES'];
  if (!allowed.some((p) => first.startsWith(p))) return { safe: false, reason: `不允许的 SQL 操作，仅允许: ${allowed.join(', ')}` };
  return { safe: true };
}

function defaultLlmCall(messages) {
  const { getAuxiliaryClient } = require('../auxiliary-client');
  return getAuxiliaryClient().callLlm({
    taskType: 'nl2sql',
    messages,
    maxTokens: 800,
    temperature: 0.1,
    timeout: 30000,
  });
}

function buildSystemPrompt(schemaInfo) {
  const tables = (schemaInfo && schemaInfo.tables) || [];
  const schemaText = tables.length
    ? tables.map((t) => {
        const cols = (t.columns || []).map((c) => `${c.name}${c.type ? ` (${c.type})` : ''}`).join(', ');
        return `表 ${t.name}: ${cols || '(无列信息)'}`;
      }).join('\n')
    : '(无可用表信息，请基于问题推断，并标注推断)';
  const bizPrompt = schemaInfo && schemaInfo.bizTablesPrompt;
  return [
    '你是企业数据库查询专家。把用户的自然语言问题翻译成 SQLite 兼容的只读 SQL 查询。',
    `可用数据表:\n${schemaText}${bizPrompt ? `\n经营数据表（导入的业务报表）:\n${bizPrompt}` : ''}`,
    '规则：',
    '1. 只输出 JSON: {"sql": "...", "explanation": "一句话说明", "confidence": 0-1}',
    '2. SQL 必须是单条只读 SELECT（可含 WITH/EXPLAIN），禁止写语句、禁止分号多语句、禁止访问 sqlite_ 系统表',
    '3. 中文时间表达映射：这个月=date(\'now\',\'start of month\')，上个月=date(\'now\',\'start of month\',\'-1 month\')，昨天=date(\'now\',\'-1 day\')，今年=date(\'now\',\'start of year\')',
    '4. 日期列筛选用 date() 包裹列名做比较',
    '5. 聚合查询默认返回列别名（如 SUM(amount) AS total）',
    '6. 不确定的列名/表名时 confidence 给低值并说明',
  ].join('\n');
}

function parseLlmResult(content) {
  if (!content || typeof content !== 'string') throw new Error('LLM 返回为空');
  let text = content.trim();
  // 剥 markdown 围栏
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) throw new Error('LLM 返回不是 JSON');
  return JSON.parse(text.slice(first, last + 1));
}

class Nl2SqlEngine {
  /**
   * @param {{ llmCall?: (messages: Array<{role: string, content: string}>) => Promise<{content: string}> }} opts
   */
  constructor({ llmCall } = {}) {
    this._llmCall = llmCall || defaultLlmCall;
  }

  /**
   * 自然语言 → 安全 SQL
   * @param {string} question 自然语言问题（中文/英文均可）
   * @param {{ tables?: Array<{ name: string, columns?: Array<{ name: string, type?: string }> }> }} schemaInfo
   * @returns {Promise<{ sql: string|null, explanation: string, confidence: number, error?: string }>}
   */
  async translate(question, schemaInfo = {}) {
    if (!question || typeof question !== 'string') {
      return { sql: null, explanation: '', confidence: 0, error: '问题为空' };
    }
    try {
      const messages = [
        { role: 'system', content: buildSystemPrompt(schemaInfo) },
        { role: 'user', content: `问题: ${question}\n请只返回 JSON。` },
      ];
      const resp = await this._llmCall(messages);
      const parsed = parseLlmResult(resp.content);
      const sql = typeof parsed.sql === 'string' ? parsed.sql.trim() : '';
      if (!sql) throw new Error('LLM 未返回 SQL');
      const check = isSafeSelect(sql);
      if (!check.safe) return { sql: null, explanation: '', confidence: 0, error: `生成的 SQL 未通过安全门: ${check.reason}` };
      return {
        sql,
        explanation: typeof parsed.explanation === 'string' ? parsed.explanation : '',
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      };
    } catch (e) {
      console.error('[nl2sql] 翻译失败:', e.message || e);
      return { sql: null, explanation: '', confidence: 0, error: e.message || '翻译失败' };
    }
  }
}

module.exports = { Nl2SqlEngine, isSafeSelect };
