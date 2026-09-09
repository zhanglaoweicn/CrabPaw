/**
 * document-analyze-tools.js — 文档分析工具集（2026-08-19）
 *
 * 借鉴 DeepTutor (HKUDS) 知识库/文档分析范式（详见 deep-analysis 报告）：
 * 1) DocumentAnalyze —— 上传/指定文档（Word/PDF/Excel/文本）→ 解析 → LLM 结构化分析
 *    （摘要/核心要点/关键数字/风险/实体）→ 双输出：
 *    - 用户侧：markdown 分析报告写入 data/workspace/documents/，并以 document 卡推送到左侧阅读面板
 *    - 知识库侧：upsertDocument + ingestion-pipeline.ingestNow（chunk 1024/128 → FTS5 + 向量 + 实体索引）
 * 2) DashboardGenerate —— 表格（xlsx/csv）→ 服务端统计聚合（确定性，不依赖 LLM 算数）
 *    + LLM 分析 → 单文件 HTML 看板（Chart.js + dataviz 校验过的 8 槽调色板，深浅双主题）
 *
 * 设计要点：
 * - LLM 调用走 ai.chat(config, [], userId, prompt, {silent:true}) 内部任务通道
 *   （silent：不进对话历史、预算 internal 分类——与 meetings 总结同一范式）
 * - 入库命名空间 'global'（默认检索空间，HybridRetrievalEngine 不带 namespace 时只搜
 *   global——存 knowledge 空间将不可检索），metadata.source='document_analysis' 区分来源
 * - 图表数据全部服务端计算（computeSheetAnalysis），LLM 只写分析文字——避免 LLM 生成
 *   非法 JS/HTML 的注入面，也避免大表 token 爆炸
 * - 纯函数（flattenXlsxToTsv / computeSheetAnalysis / extractJsonFromLlmReply /
 *   buildAnalysisMarkdown / buildDashboardCharts）导出供单测
 */

const fs = require('fs');
const path = require('path');
const { registry } = require('./registry');
const filegen = require('../core/filegen-events');
// 2026-08-22: 产物文件名统一清洗（V8 字符类 `_-一` 相邻陷阱修复，中文不再被吞成下划线）
const { sanitizeFilename } = require('../core/filename-utils');
// SP-4 SA-1: 产物落盘目录单轨统一（REPORT_DIR → getDocumentArtifactsDir）
const { getDocumentArtifactsDir } = require('../core/doc-artifacts/registry');

// ============================================================
// 常量
// ============================================================

const DOC_ANALYZE_EXTS = ['.docx', '.pdf', '.xlsx', '.txt', '.md', '.csv'];
const DASHBOARD_EXTS = ['.xlsx', '.csv'];
const DEFAULT_MAX_CHARS = 30000;   // 送入 LLM 的文本上限（与 doc_to_markdown 同口径）
const TSV_SAMPLE_ROWS = 20;        // 看板 prompt 的样本行数
const REPORT_DIR = getDocumentArtifactsDir();
const DASHBOARD_DIR = path.join(__dirname, '..', '..', 'data', 'workspace', 'dashboards');
const KB_NAMESPACE = 'global';
const KB_SOURCE = 'document_analysis';

// ============================================================
// 纯函数：XLSX → TSV 扁平化（DeepTutor document_extractor 范式）
// "--- Sheet: 名称 ---" + tab 分隔行，喂 LLM 的黄金格式
// ============================================================

function flattenXlsxToTsv(data) {
  if (!data || !Array.isArray(data.sheets)) return '';
  const parts = [];
  for (const sheet of data.sheets) {
    parts.push(`--- Sheet: ${sheet.name} (${sheet.rowCount} rows) ---`);
    for (const row of sheet.rows || []) {
      parts.push(row.map((v) => (v === null || v === undefined ? '' : String(v))).join('\t'));
    }
  }
  return parts.join('\n');
}

// ============================================================
// 纯函数：表格统计聚合（服务端确定性计算，图表数据源）
// 首行视为表头（与 xlsx_query 同口径）；数值列 = 非空值 ≥60% 可转数字的列
// ============================================================

function computeSheetAnalysis(data, opts = {}) {
  const maxRows = opts.maxRows || 100;
  const sheets = [];
  for (const sheet of data.sheets || []) {
    const rows = sheet.rows || [];
    const headers = (rows[0] || []).map((h, i) =>
      h === null || h === undefined || String(h).trim() === '' ? `列${i + 1}` : String(h).trim()
    );
    const dataRows = rows.slice(1, maxRows + 1);

    const colStats = {};
    const numericCols = [];
    headers.forEach((h, i) => {
      const values = dataRows.map((r) => r[i]).filter((v) => v !== null && v !== undefined && v !== '');
      const nums = values.map((v) => Number(v)).filter((n) => Number.isFinite(n));
      if (nums.length > 0 && nums.length >= Math.floor(Math.max(values.length, 1) * 0.6)) {
        const sum = nums.reduce((a, b) => a + b, 0);
        colStats[h] = {
          numeric: true,
          min: Math.min(...nums),
          max: Math.max(...nums),
          sum,
          avg: sum / nums.length,
          count: nums.length,
        };
        numericCols.push(h);
      } else {
        const counts = {};
        for (const v of values) {
          const key = String(v);
          counts[key] = (counts[key] || 0) + 1;
        }
        colStats[h] = { numeric: false, distinct: Object.keys(counts).length, count: values.length };
      }
    });

    // 各列 Top 类目（前 8）——柱状/饼图数据源
    const topCategories = {};
    headers.forEach((h, i) => {
      const counts = {};
      for (const row of dataRows) {
        const v = row[i];
        if (v === null || v === undefined || String(v).trim() === '') continue;
        const key = String(v).trim();
        counts[key] = (counts[key] || 0) + 1;
      }
      topCategories[h] = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([value, count]) => ({ value, count }));
    });

    sheets.push({ name: sheet.name, rowCount: sheet.rowCount, parsedRows: dataRows.length, headers, dataRows, colStats, numericCols, topCategories });
  }
  return sheets;
}

// ============================================================
// 纯函数：从 LLM 回复中稳健提取 JSON（围栏/前后缀/尾逗号容错）
// ============================================================

function extractJsonFromLlmReply(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : trimmed).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  const jsonStr = candidate.slice(start, end + 1);
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    try {
      return JSON.parse(jsonStr.replace(/,\s*([}\]])/g, '$1'));
    } catch (e2) {
      console.warn('[document-analyze] LLM JSON 提取失败:', e2.message);
      return null;
    }
  }
}

// ============================================================
// 纯函数：分析报告 markdown 组装
// ============================================================

function buildAnalysisMarkdown(analysis, meta = {}) {
  const lines = [];
  lines.push(`# ${meta.title || '文档'} — 分析报告`);
  lines.push('');
  if (meta.sourcePath) lines.push(`- 来源文件：${meta.sourcePath}`);
  if (meta.sourceFormat) lines.push(`- 文件格式：${meta.sourceFormat}`);
  lines.push(`- 分析时间：${new Date().toLocaleString('zh-CN')}`);
  if (meta.totalChars) {
    const truncNote = meta.truncated ? `（已截断，分析基于前 ${meta.maxChars || DEFAULT_MAX_CHARS} 字符）` : '';
    lines.push(`- 原文长度：${meta.totalChars} 字符${truncNote}`);
  }
  if (meta.focus) lines.push(`- 分析侧重：${meta.focus}`);
  lines.push('');

  lines.push('## 摘要');
  lines.push(analysis.summary || '（无）');
  lines.push('');
  lines.push('## 核心要点');
  const points = analysis.keyPoints || [];
  if (points.length) points.forEach((p, i) => lines.push(`${i + 1}. ${p}`));
  else lines.push('（无）');
  lines.push('');
  lines.push('## 关键数字');
  const numbers = analysis.numbers || [];
  if (numbers.length) numbers.forEach((n, i) => lines.push(`${i + 1}. ${n}`));
  else lines.push('（无）');
  lines.push('');
  lines.push('## 风险与注意点');
  const risks = analysis.risks || [];
  if (risks.length) risks.forEach((r, i) => lines.push(`${i + 1}. ${r}`));
  else lines.push('（无）');
  lines.push('');
  lines.push('## 关键实体');
  const entities = analysis.entities || [];
  if (entities.length) entities.forEach((e, i) => lines.push(`${i + 1}. ${e}`));
  else lines.push('（无）');
  return lines.join('\n');
}

// ============================================================
// 纯函数：看板图表数据（服务端确定性计算）
// bar: 第一列类目 × 第一数值列求和（Top 8）；line: 第一数值列按行序（≤200 点）
// pie: 第一列分布（Top 4 + 其他，dataviz all-pairs 系列上限 3 的保守实现）
// ============================================================

function buildDashboardCharts(sheets) {
  const charts = { bar: null, line: null, pie: null };
  const s = sheets && sheets[0];
  if (!s || !s.headers.length) return charts;

  const catCol = s.headers[0];
  const numCol = s.numericCols[0];

  if (numCol) {
    // bar：类目求和 Top 8
    const agg = {};
    for (const row of s.dataRows) {
      const k = String(row[0] === null || row[0] === undefined ? '(空)' : row[0]).trim() || '(空)';
      const n = Number(row[s.headers.indexOf(numCol)]);
      if (Number.isFinite(n)) agg[k] = (agg[k] || 0) + n;
    }
    const sorted = Object.entries(agg).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (sorted.length >= 2) {
      charts.bar = {
        title: `${numCol} 按 ${catCol} 汇总（Top ${sorted.length}）`,
        labels: sorted.map(([k]) => k),
        values: sorted.map(([, v]) => Math.round(v * 100) / 100),
      };
    }

    // line：第一数值列按行序
    const idx = s.headers.indexOf(numCol);
    const lineVals = s.dataRows
      .map((r) => Number(r[idx]))
      .filter((n) => Number.isFinite(n))
      .slice(0, 200);
    if (lineVals.length >= 3) {
      charts.line = {
        title: `${numCol} 行序趋势`,
        labels: lineVals.map((_, i) => `第${i + 1}行`),
        values: lineVals.map((v) => Math.round(v * 100) / 100),
      };
    }
  }

  // pie：第一列分布（Top 4 + 其他）
  const catCounts = s.topCategories[catCol] || [];
  if (catCounts.length >= 2) {
    const top = catCounts.slice(0, 4);
    const rest = catCounts.slice(4).reduce((a, c) => a + c.count, 0);
    const slices = top.map((c) => ({ value: c.count, label: c.value }));
    if (rest > 0) slices.push({ value: rest, label: '其他' });
    charts.pie = { title: `${catCol} 分布`, slices };
  }

  return charts;
}

// ============================================================
// LLM 内部调用（silent 通道：不进历史、预算 internal 分类）
// ============================================================

async function _callLLM(promptText, userId) {
  const ai = require('../core/ai');
  const { getConfig } = require('../core/config');
  const config = await getConfig();
  // noTools: 结构化提取必须纯文本作答。带工具定义时模型会抢着调 Bash 自己解析
  // 文档（被沙箱拦截后回退"数据处理完成。"）→ JSON 提取恒失败（2026-08-19 E2E 实锤）
  const reply = await ai.chat(config, [], userId || 'default', promptText, { silent: true, noTools: true });
  if (typeof reply === 'string') return reply;
  return JSON.stringify(reply);
}

async function _callLLMJson(promptText, userId) {
  const reply = await _callLLM(promptText, userId);
  const parsed = extractJsonFromLlmReply(reply);
  if (!parsed) {
    console.warn('[document-analyze] LLM 未返回可解析 JSON，回复片段:', String(reply || '').slice(0, 200));
    throw new Error('AI 未返回可解析的结构化分析结果，请重试');
  }
  return parsed;
}

// ============================================================
// 内部：文档解析（复用 document-tools 提取器，xlsx 走 TSV 扁平化）
// ============================================================

/** 文件内容 SHA-256（流式读，避免大文件整读内存翻倍；DeepTutor content-hash dedup 精华） */
async function _hashFile(filePath) {
  const crypto = require('crypto');
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function _parseDocument(filePath, ext) {
  const { extractDocxText, extractXlsxData, extractPdfFull } = require('./document-tools');
  if (ext === '.docx') {
    return { kind: 'docx', text: await extractDocxText(filePath) };
  }
  if (ext === '.pdf') {
    const result = await extractPdfFull(filePath);
    if (!result.success) throw new Error(result.error || 'PDF 解析失败');
    let text = result.text || '';
    if (result.tables && result.tables.length) {
      text += '\n\n## Tables\n\n';
      for (const table of result.tables) {
        if (table.headers && table.headers.length) {
          text += '| ' + table.headers.join(' | ') + ' |\n';
          text += '| ' + table.headers.map(() => '---').join(' | ') + ' |\n';
          for (const row of table.rows) text += '| ' + row.join(' | ') + ' |\n';
          text += '\n';
        }
      }
    }
    return { kind: 'pdf', text };
  }
  if (ext === '.xlsx') {
    const data = await extractXlsxData(filePath);
    if (data.error) throw new Error(data.error);
    return { kind: 'xlsx', text: flattenXlsxToTsv(data), data };
  }
  // txt/md/csv
  const raw = fs.readFileSync(filePath, 'utf-8');
  return { kind: ext.slice(1), text: raw };
}

// ============================================================
// 内部：分析结果入库（documents 行 + chunks 管线 + FTS/向量/实体）
// ============================================================

async function _saveAnalysisToKnowledgeBase({ title, markdown, meta }) {
  const { getUnifiedStore } = require('../core/memory/unified-store');
  const { getIngestionPipeline } = require('../core/memory/ingestion-pipeline');
  const store = getUnifiedStore();

  // 2026-08-20 DeepTutor 精华落地: 内容寻址列——source_hash 供 findByHash 去重,
  // source_path 供溯源; 管道侧也会二次校验(source_hash 命中即跳过切块)。
  const sourceHash = meta.sourceHash || null;
  const sourcePath = meta.sourcePath || null;
  const documentId = store.upsertDocument({
    title: title || '文档分析',
    namespace: KB_NAMESPACE,
    content: markdown,
    source_hash: sourceHash,
    source_path: sourcePath,
    metadata: {
      source: KB_SOURCE,
      sourcePath: sourcePath || '',
      sourceFormat: meta.sourceFormat || '',
      analysisFocus: meta.focus || '',
      totalChars: meta.totalChars || 0,
      entities: meta.entities || [],
    },
  });

  // 文档类 chunk 用 1024/128（对话记忆 512/64 偏碎；DeepTutor 教训：文档应更大粒度）
  const pipeline = getIngestionPipeline();
  const item = await pipeline.ingestNow({
    type: 'document',
    content: markdown,
    namespace: KB_NAMESPACE,
    metadata: { documentId, source: KB_SOURCE, sourcePath: sourcePath || '', sourceHash, chunkSize: 1024, chunkOverlap: 128 },
  });

  return {
    documentId,
    chunks: item.chunkIds.length,
    entities: item.entityIds.length,
    embedded: item.embeddingGenerated,
  };
}

// ============================================================
// 内部：安全文件名
// ============================================================

function _safeName(name, fallback) {
  // 2026-08-22: 统一走 sanitizeFilename——旧规则 [^a-zA-Z0-9_\-一-鿿] 中 `_-一` 相邻被 V8
  // 解析成 U+005F~U+4E00 范围，中文全被替换为下划线（「智能体的 Harness 插件」→「_____Harness___」）
  return sanitizeFilename(name, fallback);
}

// ============================================================
// DocumentAnalyze 工具
// ============================================================

const DOC_ANALYZE_PROMPT = (content, opts) => `你是一位严谨的文档分析师。请分析下面的文档内容，只输出一个 JSON 对象（不要输出 JSON 以外的任何文字、不要用代码围栏）：

{
  "summary": "200字以内的总体摘要",
  "keyPoints": ["核心要点", "最多8条"],
  "numbers": ["关键数字或指标，如：合同金额 500 万元、毛利率 32.5%", "最多6条"],
  "risks": ["风险/注意点", "最多5条"],
  "entities": ["关键实体：人名/组织/合同号/项目名等", "最多10条"],
  "suggestedTitle": "建议的文档标题"
}

分析侧重：${opts.focus || '全面分析'}
文档类型：${opts.kind}${opts.truncated ? `\n注意：内容已截断，仅展示前 ${opts.maxChars} 字符（全文共 ${opts.totalChars} 字符），结论必须基于可见内容并在摘要中注明。` : ''}

文档内容：
---
${content}
---`;

registry.register({
  name: 'DocumentAnalyze',
  toolset: 'document',
  category: 'document',
  description: '分析文档（Word/PDF/Excel/文本）：提炼摘要、核心要点、关键数字、风险与实体，生成分析报告卡（左侧阅读面板展示）并默认存入知识库（后续对话可检索）。',
  whenNotToUse: [
    '不要用于简单读取文件内容，改用 doc_read',
    '不要用于生成/转换文档，改用 docx_generate / doc_to_markdown',
    '不要用于表格可视化，改用 DashboardGenerate',
  ],
  riskLevel: 'low',
  timeout: 180000,
  schema: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: '文档绝对路径（docx/pdf/xlsx/txt/md/csv），可指 data/workspace/uploads 下的已上传文件' },
      title: { type: 'string', description: '文档标题（默认取文件名），用于报告与知识库记录' },
      focus: { type: 'string', description: '分析侧重，如「合同条款」「财务数据」「风险点」；省略则全面分析' },
      saveToKnowledgeBase: { type: 'boolean', description: '是否将分析结果存入知识库（默认 true，后续对话可检索）' },
      maxChars: { type: 'number', description: '送入模型的内容上限（默认 30000）' },
    },
    required: ['filePath'],
  },
  async handler(params, context) {
    const { filePath, title, focus, maxChars } = params;
    const saveToKnowledgeBase = params.saveToKnowledgeBase !== false;
    const userId = (context && context.userId) || 'default';

    if (!fs.existsSync(filePath)) {
      return { success: false, error: '文件不存在: ' + filePath };
    }
    const ext = path.extname(filePath).toLowerCase();
    if (!DOC_ANALYZE_EXTS.includes(ext)) {
      return { success: false, error: `不支持的文档格式: ${ext}（支持 ${DOC_ANALYZE_EXTS.join(' ')}）` };
    }

    // 2026-08-20 DeepTutor 精华落地: 内容哈希去重——同一文件重复分析时跳过
    // 昂贵的解析 + LLM 分析, 直接返回已入库结果。哈希基于原始文件字节,
    // 文件有任何改动即视为新内容（对比: 文件名去重会被改名骗过）。
    const sourceHash = await _hashFile(filePath);
    if (saveToKnowledgeBase && sourceHash) {
      try {
        const { getUnifiedStore } = require('../core/memory/unified-store');
        const existing = getUnifiedStore().findByHash(sourceHash);
        if (existing) {
          console.log(`[DocumentAnalyze] 内容哈希命中, 跳过重复分析: ${filePath} (doc ${existing.id})`);
          return {
            success: true,
            deduped: true,
            summary: '该文档此前已分析过，内容未变化，直接复用知识库结果（如需重新分析请先修改文档内容）。',
            documentId: existing.id,
            title: existing.title,
            knowledgeBase: { deduped: true, documentId: existing.id },
            message: '内容未变化，已复用知识库既有分析',
          };
        }
      } catch (hashErr) {
        // 去重失败不阻塞主流程（降级为普通分析）
        console.warn('[DocumentAnalyze] 哈希去重检查失败(不阻塞):', hashErr.message);
      }
    }

    const baseTitle = title || path.basename(filePath);
    // 2026-08-20: 不再插桩 FileGenPanel 生成状态机——分析是单次工具调用,
    // 四步生成流程(collect/writing/done)对"分析"无意义,且 done 事件丢失会致
    // 面板永久卡"分析中"。分析报告改以 document 卡呈现(左侧阅读面板)。
    const fail = (message) => {
      console.error('[DocumentAnalyze]', message);
      // 2026-08-20 DeepTutor 精华落地: failures 记账（摄取韧性——失败可查可重试）
      try {
        require('../core/memory/kb-bookkeeping').recordFailure({ kind: 'analyze', path: filePath, hash: sourceHash, error: message });
      } catch (bkErr) { console.warn('[DocumentAnalyze] 记账失败(不阻塞):', bkErr.message); }
      return { success: false, error: message };
    };

    try {
      // 1. 解析
      const parsed = await _parseDocument(filePath, ext);
      const text = parsed.text || '';
      if (!text.trim()) {
        return fail('文档内容为空或解析失败（可能是不支持的格式或加密文件）');
      }

      // 2. 截断 + LLM 结构化分析
      const limit = Number(maxChars) || DEFAULT_MAX_CHARS;
      const truncated = text.length > limit;
      const content = truncated ? text.slice(0, limit) : text;
      const analysis = await _callLLMJson(
        DOC_ANALYZE_PROMPT(content, {
          kind: parsed.kind, focus, truncated, totalChars: text.length, maxChars: limit,
        }),
        userId
      );

      // 3. 用户侧：markdown 报告
      const md = buildAnalysisMarkdown(analysis, {
        title: analysis.suggestedTitle || baseTitle,
        sourcePath: filePath,
        sourceFormat: parsed.kind,
        focus,
        totalChars: text.length,
        truncated,
        maxChars: limit,
      });
      if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
      const outPath = path.join(REPORT_DIR, `${_safeName(analysis.suggestedTitle || baseTitle, 'document')}_分析_${Date.now()}.md`);
      fs.writeFileSync(outPath, md, 'utf-8');
      // 2026-08-25 用户指令(硬删除): 文档类内容场景卡不再推送(document kind 已停用),
      // 分析结果由对话/知识库侧呈现。

      // 4. 知识库侧：入库
      let kbInfo = null;
      if (saveToKnowledgeBase) {
        try {
          kbInfo = await _saveAnalysisToKnowledgeBase({
            title: analysis.suggestedTitle || baseTitle,
            markdown: md,
            meta: {
              sourceHash,
              sourcePath: filePath,
              sourceFormat: parsed.kind,
              focus,
              totalChars: text.length,
              entities: analysis.entities || [],
            },
          });
          // 2026-08-20 DeepTutor 精华落地: processed 记账（去重审计/清单核对）
          try {
            require('../core/memory/kb-bookkeeping').recordProcessed({
              path: filePath,
              hash: sourceHash || '',
              documentId: kbInfo.documentId || '',
              title: analysis.suggestedTitle || baseTitle,
            });
          } catch (bkErr) { console.warn('[DocumentAnalyze] processed 记账失败(不阻塞):', bkErr.message); }
        } catch (kbErr) {
          console.error('[DocumentAnalyze] 知识库入库失败(不影响报告):', kbErr.message);
          kbInfo = { error: kbErr.message };
          try {
            require('../core/memory/kb-bookkeeping').recordFailure({ kind: 'kb_save', path: filePath, hash: sourceHash || '', error: kbErr.message });
          } catch (bkErr) { console.warn('[DocumentAnalyze] 失败记账失败(不阻塞):', bkErr.message); }
        }
      }

      return {
        success: true,
        summary: analysis.summary || '',
        keyPoints: analysis.keyPoints || [],
        numbers: analysis.numbers || [],
        risks: analysis.risks || [],
        entities: analysis.entities || [],
        knowledgeBase: kbInfo,
        file: { path: outPath, name: path.basename(outPath), size: md.length, format: 'md', url: filegen.previewUrlFor('md', outPath) },
        message: `分析完成，报告已生成${saveToKnowledgeBase && kbInfo && !kbInfo.error ? `并存入知识库（${kbInfo.chunks} 个分块${kbInfo.embedded ? '，已向量化' : ''}）` : ''}`,
      };
    } catch (e) {
      return fail('文档分析失败: ' + (e && e.message ? e.message : String(e)));
    }
  },
});

// ============================================================
// DashboardGenerate 工具
// ============================================================

const DASHBOARD_PROMPT = (sample, statsSummary, opts) => `你是一位数据分析师。以下是表格「${opts.title}」的统计概览与样本数据，请输出一个 JSON 对象（不要输出 JSON 以外的任何文字、不要用代码围栏）：

{
  "summary": "150字以内的数据概览（规模、趋势、异常点）",
  "keyPoints": ["数据洞察", "最多6条"],
  "insights": ["基于数据的业务建议", "最多4条"]
}

分析侧重：${opts.focus || '数据概览'}

统计概览：
${statsSummary}

样本数据（前 ${TSV_SAMPLE_ROWS} 行）：
${sample}`;

registry.register({
  name: 'DashboardGenerate',
  toolset: 'document',
  category: 'document',
  description: '表格数据可视化看板：上传/指定 Excel(xlsx) 或 CSV，服务端统计聚合（数值列合计/均值/极值、类目分布）+ AI 分析，生成单文件 HTML 看板（柱状/折线/饼图 + 统计瓦片 + 数据表，深浅双主题，FileGenPanel 预览）。',
  whenNotToUse: [
    '不要用于 Word/PDF 文档分析，改用 DocumentAnalyze',
    '不要用于生成演示文稿，改用 presentation-builder',
    '不要用于查询表格局部数据，改用 xlsx_query',
  ],
  riskLevel: 'low',
  timeout: 180000,
  schema: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: '表格文件绝对路径（xlsx/csv），可指 data/workspace/uploads 下的已上传文件' },
      title: { type: 'string', description: '看板标题（默认取文件名）' },
      focus: { type: 'string', description: '分析侧重，如「销售趋势」「成本结构」；省略则全面概览' },
      saveToKnowledgeBase: { type: 'boolean', description: '是否将分析摘要存入知识库（默认 true）' },
      maxRows: { type: 'number', description: '参与统计的行数上限（默认 100）' },
    },
    required: ['filePath'],
  },
  async handler(params, context) {
    const { filePath, title, focus, maxRows } = params;
    const saveToKnowledgeBase = params.saveToKnowledgeBase !== false;
    const userId = (context && context.userId) || 'default';

    if (!fs.existsSync(filePath)) {
      return { success: false, error: '文件不存在: ' + filePath };
    }
    const ext = path.extname(filePath).toLowerCase();
    if (!DASHBOARD_EXTS.includes(ext)) {
      return { success: false, error: `不支持的文件格式: ${ext}（支持 ${DASHBOARD_EXTS.join(' ')}）` };
    }

    const baseTitle = title || path.basename(filePath);
    let fgTaskId = null;
    try {
      fgTaskId = filegen.ensureFileGenTask({ title: baseTitle, format: 'html', phase: 'collect', label: '正在读取表格…' });
    } catch (fgErr) {
      console.error('[DashboardGenerate] filegen 插桩失败(不阻塞):', fgErr.message);
    }
    const fail = (message) => {
      console.error('[DashboardGenerate]', message);
      try { if (fgTaskId) filegen.failFileGen(fgTaskId, message); } catch (fgErr) { console.error('[DashboardGenerate] failFileGen 失败:', fgErr.message); }
      return { success: false, error: message };
    };

    try {
      // 1. 解析
      try { if (fgTaskId) filegen.phaseFileGen(fgTaskId, 'writing', '正在解析表格…'); } catch (e) { console.warn('[DashboardGenerate] phase 插桩失败(不阻塞):', e.message); }
      let sheetData;
      if (ext === '.xlsx') {
        const { extractXlsxData } = require('./document-tools');
        sheetData = await extractXlsxData(filePath);
        if (sheetData.error) throw new Error(sheetData.error);
      } else {
        sheetData = { sheets: [{ name: path.basename(filePath), rowCount: 0, rows: _parseCsv(filePath) }] };
        sheetData.sheets[0].rowCount = sheetData.sheets[0].rows.length;
      }

      // 2. 服务端统计聚合（确定性图表数据）
      const sheets = computeSheetAnalysis(sheetData, { maxRows: Number(maxRows) || 100 });
      const s0 = sheets[0];
      if (!s0 || !s0.headers.length) {
        return fail('表格内容为空或无可分析的数据行');
      }
      const charts = buildDashboardCharts(sheets);

      // 3. LLM 分析文字
      try { if (fgTaskId) filegen.phaseFileGen(fgTaskId, 'writing', '正在生成分析…'); } catch (e) { console.warn('[DashboardGenerate] phase 插桩失败(不阻塞):', e.message); }
      const statsSummary = sheets
        .map((s) => {
          const cols = s.numericCols.map((c) => {
            const st = s.colStats[c];
            return `${c}: 合计 ${_fmt(st.sum)}，平均 ${_fmt(st.avg)}，范围 [${_fmt(st.min)}, ${_fmt(st.max)}]，${st.count} 个非空值`;
          });
          const cats = Object.entries(s.topCategories)
            .filter(([, v]) => v.length)
            .map(([c, v]) => `${c} 分布: ${v.map((x) => `${x.value}×${x.count}`).join('，')}`);
          return `工作表「${s.name}」${s.rowCount} 行 × ${s.headers.length} 列，解析 ${s.parsedRows} 行\n数值列: ${s.numericCols.length ? s.numericCols.join('、') : '无'}\n${cols.join('\n')}\n${cats.join('\n')}`;
        })
        .join('\n\n');
      const sampleTsv = flattenXlsxToTsv({ sheets: sheets.map((s) => ({ name: s.name, rowCount: s.rowCount, rows: [s.headers, ...s.dataRows.slice(0, TSV_SAMPLE_ROWS - 1)] })) });
      const analysis = await _callLLMJson(
        DASHBOARD_PROMPT(sampleTsv.slice(0, 6000), statsSummary.slice(0, 4000), { title: baseTitle, focus }),
        userId
      );

      // 4. 组装单文件 HTML 看板
      try { if (fgTaskId) filegen.phaseFileGen(fgTaskId, 'writing', '正在组装看板…'); } catch (e) { console.warn('[DashboardGenerate] phase 插桩失败(不阻塞):', e.message); }
      const tiles = _buildStatTiles(s0);
      const previewRows = s0.dataRows.slice(0, 20).map((r) => r.map((v) => (v === null || v === undefined ? '' : String(v))));
      const html = buildDashboardHtml({
        title: baseTitle,
        sourceName: path.basename(filePath),
        tiles,
        charts,
        analysis,
        headers: s0.headers,
        previewRows,
      });

      if (!fs.existsSync(DASHBOARD_DIR)) fs.mkdirSync(DASHBOARD_DIR, { recursive: true });
      const outPath = path.join(DASHBOARD_DIR, `dashboard_${_safeName(baseTitle, 'sheet')}_${Date.now()}.html`);
      // 2026-08-22: html 产物加 UTF-8 BOM——WPS 文字打开无 BOM UTF-8 按 ANSI 检测乱码（同 file-tools Write 处理）
      fs.writeFileSync(outPath, /\.html?$/i.test(outPath) && !html.startsWith('﻿') ? '﻿' + html : html, 'utf-8');
      try {
        if (fgTaskId) {
          filegen.doneFileGen(fgTaskId, {
            path: outPath,
            name: path.basename(outPath),
            size: html.length,
            format: 'html',
            url: filegen.previewUrlFor('html', outPath),
          });
        }
      } catch (fgErr) { console.error('[DashboardGenerate] done 插桩失败(不阻塞):', fgErr.message); }

      // 5. 可选入库（分析摘要）
      let kbInfo = null;
      if (saveToKnowledgeBase) {
        const analysisMd = buildAnalysisMarkdown(
          { summary: analysis.summary, keyPoints: analysis.keyPoints, numbers: [], risks: [], entities: [] },
          { title: `${baseTitle} — 数据看板分析`, sourcePath: filePath, sourceFormat: ext.slice(1), focus, totalChars: s0.rowCount, truncated: false }
        );
        try {
          kbInfo = await _saveAnalysisToKnowledgeBase({
            title: `${baseTitle} — 数据看板分析`,
            markdown: analysisMd,
            meta: { sourcePath: filePath, sourceFormat: ext.slice(1), focus, totalChars: s0.rowCount },
          });
        } catch (kbErr) {
          console.error('[DashboardGenerate] 知识库入库失败(不影响看板):', kbErr.message);
          kbInfo = { error: kbErr.message };
        }
      }

      return {
        success: true,
        summary: analysis.summary || '',
        keyPoints: analysis.keyPoints || [],
        insights: analysis.insights || [],
        stats: {
          sheets: sheets.length,
          rows: s0.rowCount,
          parsedRows: s0.parsedRows,
          numericColumns: s0.numericCols,
        },
        knowledgeBase: kbInfo,
        file: { path: outPath, name: path.basename(outPath), size: html.length, format: 'html', url: filegen.previewUrlFor('html', outPath) },
        message: `看板已生成${saveToKnowledgeBase && kbInfo && !kbInfo.error ? '，分析摘要已存入知识库' : ''}`,
      };
    } catch (e) {
      return fail('看板生成失败: ' + (e && e.message ? e.message : String(e)));
    }
  },
});

// ============================================================
// 内部：CSV 简单解析（逗号分隔 + 引号剥离；不依赖第三方库）
// ============================================================

function _parseCsv(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .slice(0, 101)
    .map((line) => line.split(',').map((cell) => cell.replace(/^"|"$/g, '').trim()));
}

// ============================================================
// 内部：统计瓦片（dataviz: hero number + 次级说明）
// ============================================================

function _fmt(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return String(n ?? '');
  if (Math.abs(n) >= 1e6) return n.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function _buildStatTiles(sheet) {
  const tiles = [];
  tiles.push({ label: '数据行数', value: _fmt(sheet.rowCount), sub: `已解析 ${sheet.parsedRows} 行` });
  tiles.push({ label: '字段数', value: _fmt(sheet.headers.length), sub: `${sheet.numericCols.length} 个数值列` });
  const numCol = sheet.numericCols[0];
  if (numCol) {
    const st = sheet.colStats[numCol];
    tiles.push({ label: `${numCol} 合计`, value: _fmt(st.sum), sub: `${st.count} 个非空值` });
    tiles.push({ label: `${numCol} 均值`, value: _fmt(st.avg), sub: `范围 [${_fmt(st.min)}, ${_fmt(st.max)}]` });
  } else {
    tiles.push({ label: '类目最多列', value: String(Object.entries(sheet.topCategories).sort((a, b) => (b[1][0] ? b[1][0].count : 0) - (a[1][0] ? a[1][0].count : 0))[0]?.[0] || '—'), sub: '无数值列' });
    tiles.push({ label: '工作表数', value: '1', sub: '仅首表参与统计' });
  }
  return tiles;
}

// ============================================================
// 内部：单文件 HTML 看板模板
// dataviz 规范（2026-08-19 校验）：8 槽分类调色板（CVD 相邻 ΔE≥8），深浅双主题
// 自定义属性一处换肤；柱/线单系列（身份在轴标签，免图例）；饼图 Top4+其他；
// 2px 表面环、圆角柱端、tabular-nums 统计数字；数据表兜底（无障碍）；
// Chart.js CDN v4 加载失败时降级显示数据表。
// ============================================================

function buildDashboardHtml({ title, sourceName, tiles, charts, analysis, headers, previewRows }) {
  const chartData = JSON.stringify({ charts }).replace(/</g, '\\u003c');
  const tilesHtml = tiles
    .map(
      (t) => `<div class="tile"><div class="tile-value">${t.value}</div><div class="tile-label">${t.label}</div><div class="tile-sub">${t.sub || ''}</div></div>`
    )
    .join('');
  const analysisHtml = `
    <section class="card">
      <h2>数据分析</h2>
      <p class="summary">${(analysis.summary || '').replace(/</g, '&lt;')}</p>
      ${(analysis.keyPoints || []).length ? `<h3>关键洞察</h3><ul>${analysis.keyPoints.map((k) => `<li>${String(k).replace(/</g, '&lt;')}</li>`).join('')}</ul>` : ''}
      ${(analysis.insights || []).length ? `<h3>建议</h3><ul>${analysis.insights.map((k) => `<li>${String(k).replace(/</g, '&lt;')}</li>`).join('')}</ul>` : ''}
    </section>`;
  const previewHtml = previewRows.length
    ? `<table><thead><tr>${headers.map((h) => `<th>${String(h).replace(/</g, '&lt;')}</th>`).join('')}</tr></thead><tbody>${previewRows
        .map((r) => `<tr>${r.map((c) => `<td>${String(c).replace(/</g, '&lt;')}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>`
    : '<p>（无样本数据）</p>';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${String(title).replace(/</g, '&lt;')} — 数据看板</title>
<style>
.viz-root{color-scheme:light;--surface-1:#fcfcfb;--page:#f9f9f7;--ink-1:#0b0b0b;--ink-2:#52514e;--ink-3:#898781;--grid:#e1e0d9;--baseline:#c3c2b7;--border:rgba(11,11,11,.10);--series-1:#2a78d6;--series-2:#eb6834;--series-3:#1baf7a;--series-4:#eda100;--series-5:#e87ba4;--series-6:#008300;--series-7:#4a3aa7;--series-8:#e34948;--other:#898781;}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz-root{color-scheme:dark;--surface-1:#1a1a19;--page:#0d0d0d;--ink-1:#ffffff;--ink-2:#c3c2b7;--ink-3:#898781;--grid:#2c2c2a;--baseline:#383835;--border:rgba(255,255,255,.10);--series-1:#3987e5;--series-2:#d95926;--series-3:#199e70;--series-4:#c98500;--series-5:#d55181;--series-6:#008300;--series-7:#9085e9;--series-8:#e66767;--other:#898781;}}
:root[data-theme="dark"] .viz-root{color-scheme:dark;--surface-1:#1a1a19;--page:#0d0d0d;--ink-1:#ffffff;--ink-2:#c3c2b7;--ink-3:#898781;--grid:#2c2c2a;--baseline:#383835;--border:rgba(255,255,255,.10);--series-1:#3987e5;--series-2:#d95926;--series-3:#199e70;--series-4:#c98500;--series-5:#d55181;--series-6:#008300;--series-7:#9085e9;--series-8:#e66767;--other:#898781;}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:var(--page);color:var(--ink-1);padding:24px;line-height:1.6}
.viz-root{max-width:1080px;margin:0 auto;background:var(--page)}
header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:20px}
h1{font-size:22px;font-weight:600;letter-spacing:-.01em}
.source{color:var(--ink-2);font-size:13px;margin-top:4px}
.theme-btn{border:1px solid var(--border);background:var(--surface-1);color:var(--ink-2);border-radius:8px;padding:6px 12px;font-size:13px;cursor:pointer}
.theme-btn:hover{border-color:var(--baseline)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:20px}
.tile{background:var(--surface-1);border:1px solid var(--border);border-radius:10px;padding:14px 16px}
.tile-value{font-size:26px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.02em;color:var(--ink-1)}
.tile-label{font-size:13px;color:var(--ink-2);margin-top:2px}
.tile-sub{font-size:12px;color:var(--ink-3);margin-top:2px}
.card{background:var(--surface-1);border:1px solid var(--border);border-radius:12px;padding:18px 20px;margin-bottom:20px}
.card h2{font-size:16px;font-weight:600;margin-bottom:12px}
.card h3{font-size:14px;font-weight:600;margin:14px 0 6px;color:var(--ink-2)}
.card p.summary{font-size:14px}
.card ul{padding-left:20px;margin:6px 0}
.card li{font-size:14px;margin:4px 0}
.charts{display:grid;grid-template-columns:1fr;gap:20px;margin-bottom:20px}
.chart-box{background:var(--surface-1);border:1px solid var(--border);border-radius:12px;padding:16px 18px}
.chart-box h2{font-size:15px;font-weight:600;margin-bottom:10px}
.chart-canvas{position:relative;height:300px}
.chart-fallback{display:none;color:var(--ink-3);font-size:13px;padding:20px;text-align:center}
table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}
th{text-align:left;font-weight:600;color:var(--ink-2);border-bottom:1px solid var(--baseline);padding:8px 10px}
td{border-bottom:1px solid var(--grid);padding:7px 10px}
tbody tr:hover{background:rgba(128,128,128,.06)}
.table-scroll{overflow-x:auto}
footer{color:var(--ink-3);font-size:12px;text-align:center;margin-top:8px}
</style>
</head>
<body>
<div class="viz-root">
  <header>
    <div>
      <h1>${String(title).replace(/</g, '&lt;')} — 数据看板</h1>
      <div class="source">数据来源：${String(sourceName).replace(/</g, '&lt;')} · 由 CrabPaw 自动生成</div>
    </div>
    <button class="theme-btn" id="themeBtn" type="button">切换深色</button>
  </header>

  <div class="tiles">${tilesHtml}</div>

  ${analysisHtml}

  <div class="charts">
    <div class="chart-box" id="barBox" style="display:none"><h2 id="barTitle"></h2><div class="chart-canvas"><canvas id="barChart"></canvas></div><div class="chart-fallback" id="barFallback"></div></div>
    <div class="chart-box" id="lineBox" style="display:none"><h2 id="lineTitle"></h2><div class="chart-canvas"><canvas id="lineChart"></canvas></div><div class="chart-fallback" id="lineFallback"></div></div>
    <div class="chart-box" id="pieBox" style="display:none"><h2 id="pieTitle"></h2><div class="chart-canvas"><canvas id="pieChart"></canvas></div><div class="chart-fallback" id="pieFallback"></div></div>
  </div>

  <section class="card">
    <h2>数据明细</h2>
    <div class="table-scroll">${previewHtml}</div>
  </section>

  <footer>图表规范：dataviz 校验调色板 · 深浅双主题 · ${new Date().toLocaleDateString('zh-CN')}</footer>
</div>

<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<script>
(() => {
  const DATA = ${chartData};
  const root = document.querySelector('.viz-root');
  const cssVar = (name) => getComputedStyle(root).getPropertyValue(name).trim();

  const themeBtn = document.getElementById('themeBtn');
  const setTheme = (dark) => {
    root.setAttribute('data-theme', dark ? 'dark' : 'light');
    themeBtn.textContent = dark ? '切换浅色' : '切换深色';
    renderAll();
  };
  themeBtn.addEventListener('click', () => setTheme(root.getAttribute('data-theme') !== 'dark'));
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches && root.getAttribute('data-theme') !== 'light') {
    root.setAttribute('data-theme', 'dark');
    themeBtn.textContent = '切换浅色';
  }
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (root.getAttribute('data-theme') !== 'light') setTheme(e.matches);
    });
  }

  let charts = { bar: null, line: null, pie: null };
  const showBox = (id, titleId, title, fallbackId, fallbackMsg) => {
    const box = document.getElementById(id);
    box.style.display = 'none';
    document.getElementById(fallbackId).style.display = 'none';
    if (!title) return false;
    document.getElementById(titleId).textContent = title;
    return true;
  };
  const fallback = (fallbackId, msg) => {
    document.getElementById(fallbackId).textContent = msg;
    document.getElementById(fallbackId).style.display = 'block';
  };

  const gridColor = () => cssVar('--grid');
  const inkColor = () => cssVar('--ink-2');
  const seriesColor = (i) => cssVar('--series-' + (i + 1)) || cssVar('--series-1');
  const tooltipOpts = () => ({
    backgroundColor: cssVar('--surface-1'),
    titleColor: cssVar('--ink-1'),
    bodyColor: cssVar('--ink-1'),
    borderColor: cssVar('--border'),
    borderWidth: 1,
    padding: 10,
    cornerRadius: 8,
  });

  function renderAll() {
    const hasChart = typeof Chart !== 'undefined';
    const c = DATA.charts || {};
    for (const key of ['bar', 'line', 'pie']) {
      if (charts[key]) { try { charts[key].destroy(); } catch (e) { console.warn('chart destroy failed', e); } charts[key] = null; }
    }
    if (!hasChart) {
      const msg = '图表库加载失败（离线环境），请查看下方数据明细表';
      fallback('barFallback', msg); fallback('lineFallback', msg); fallback('pieFallback', msg);
      return;
    }

    if (c.bar && showBox('barBox', 'barTitle', c.bar.title, 'barFallback', '')) {
      document.getElementById('barBox').style.display = 'block';
      try {
        charts.bar = new Chart(document.getElementById('barChart'), {
          type: 'bar',
          data: {
            labels: c.bar.labels,
            datasets: [{
              data: c.bar.values,
              backgroundColor: c.bar.labels.map((_, i) => seriesColor(i)),
              borderRadius: 4,
              borderSkipped: false,
              maxBarThickness: 56,
            }],
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: tooltipOpts() },
            scales: {
              x: { grid: { display: false }, ticks: { color: inkColor(), maxRotation: 45 } },
              y: { beginAtZero: true, grid: { color: gridColor() }, border: { display: false }, ticks: { color: inkColor() } },
            },
          },
        });
      } catch (e) { console.error('bar chart failed', e); fallback('barFallback', '柱状图渲染失败'); }
    }

    if (c.line && showBox('lineBox', 'lineTitle', c.line.title, 'lineFallback', '')) {
      document.getElementById('lineBox').style.display = 'block';
      try {
        charts.line = new Chart(document.getElementById('lineChart'), {
          type: 'line',
          data: {
            labels: c.line.labels,
            datasets: [{
              data: c.line.values,
              borderColor: seriesColor(0),
              backgroundColor: seriesColor(0) + '22',
              borderWidth: 2,
              pointRadius: 3,
              pointHoverRadius: 5,
              tension: 0.2,
              fill: false,
            }],
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: tooltipOpts() },
            scales: {
              x: { grid: { display: false }, ticks: { color: inkColor(), maxTicksLimit: 12 } },
              y: { beginAtZero: false, grid: { color: gridColor() }, border: { display: false }, ticks: { color: inkColor() } },
            },
          },
        });
      } catch (e) { console.error('line chart failed', e); fallback('lineFallback', '折线图渲染失败'); }
    }

    if (c.pie && showBox('pieBox', 'pieTitle', c.pie.title, 'pieFallback', '')) {
      document.getElementById('pieBox').style.display = 'block';
      try {
        charts.pie = new Chart(document.getElementById('pieChart'), {
          type: 'doughnut',
          data: {
            labels: c.pie.slices.map((s) => s.label),
            datasets: [{
              data: c.pie.slices.map((s) => s.value),
              backgroundColor: c.pie.slices.map((s, i) => (s.label === '其他' ? cssVar('--other') : seriesColor(i))),
              borderColor: cssVar('--surface-1'),
              borderWidth: 2,
              borderRadius: 4,
            }],
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            cutout: '45%',
            plugins: { legend: { position: 'right', labels: { color: inkColor(), boxWidth: 12, boxHeight: 12 } }, tooltip: tooltipOpts() },
          },
        });
      } catch (e) { console.error('pie chart failed', e); fallback('pieFallback', '饼图渲染失败'); }
    }
  }

  renderAll();
})();
</script>
</body>
</html>`;
}

// ============================================================
// 导出（纯函数供单测）
// ============================================================

module.exports = {
  DOC_ANALYZE_EXTS,
  DASHBOARD_EXTS,
  DEFAULT_MAX_CHARS,
  flattenXlsxToTsv,
  computeSheetAnalysis,
  extractJsonFromLlmReply,
  buildAnalysisMarkdown,
  buildDashboardCharts,
  buildDashboardHtml,
};
