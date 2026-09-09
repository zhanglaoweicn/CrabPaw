/**
 * smoke-doc-analyze.js — DocumentAnalyze / DashboardGenerate 端到端冒烟（2026-08-19）
 * 用法: node scripts/smoke-doc-analyze.js [docx|xlsx|all]
 * 链路: adapter 初始化(等价后端) → registry.execute → 真实解析 → LLM(silent/internal)
 *       → workspace 产物 → document 卡推送(scene-store) → 知识库落库（documents + chunks + FTS）
 * 2026-08-20: DocumentAnalyze 已去 FileGenPanel 插桩（分析报告改 document 卡）——
 *             DashboardGenerate 保留插桩（真实生成语义）；冒烟同步验证 document surface
 * 说明: LLM 调用真实消耗 token（silent 内部任务）；关键输出走 stderr（process.exit 不丢缓冲）
 */
'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

// 关键结果走 stderr（同步写）；普通日志留 stdout（异步缓冲，exit 时可能丢）
const KEY = (...a) => process.stderr.write(a.join(' ') + '\n');

const { registry } = require(path.join(ROOT, 'src/tools/registry'));
require(path.join(ROOT, 'src/tools/document-analyze-tools'));

const SAMPLES = {
  docx: path.join(ROOT, 'data/workspace/documents/e2e_智能体市场分析报告.docx'),
  xlsx: path.join(ROOT, 'data/workspace/financial_report.xlsx'),
};

const ctx = { userId: 'e2e-smoke' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 模拟后端初始化（等价 cli/index.js:48-113 的 adapter 注册路径）：
// loadConfig 是主配置入口（providers 带 key）；getConfig/yaml 路径被 model-router 弃用
async function initAdapterRegistry() {
  const config = require(path.join(ROOT, 'src/core/config'));
  const appConfig = config.loadConfig();
  try {
    const { getAdapterRegistry } = require(path.join(ROOT, 'src/core/llm'));
    const adapterReg = getAdapterRegistry();
    await adapterReg.registerFromConfig(appConfig.models?.providers || {});
    // 关键：CLI 环境下 getModelRouter() 是 null（惰性单例从未创建），
    // ai.chat 会用 getConfig()（空 models）createModelRouter → 恒"未配置"。
    // 必须先 createModelRouter(appConfig) 再绑 adapter。
    const { createModelRouter, getModelRouter } = require(path.join(ROOT, 'src/core/model-router'));
    createModelRouter(appConfig);
    const router = getModelRouter();
    if (router) router.setAdapterRegistry(adapterReg);
    KEY(`[adapter] providers: ${adapterReg.listProviders().join(', ') || '(空)'} | router.providers: ${Object.keys(router ? router.providers : {}).join(', ') || '(空)'}`);
  } catch (e) {
    KEY(`[adapter] 初始化失败: ${e.message}`);
  }
}

async function runTool(name, params) {
  KEY(`\n===== ${name} =====`);
  const t0 = Date.now();
  try {
    const r = await registry.execute(name, params, ctx);
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    const inner = r.data || {};
    KEY(`耗时 ${sec}s | execute.success=${r.success} | tool.success=${inner.success}`);
    KEY(`→ ${JSON.stringify(inner).slice(0, 900)}`);
    return inner;
  } catch (e) {
    KEY(`${name} 抛异常: ${e.message}`);
    return null;
  }
}

async function verifyKb(titleFragment, expectChunks) {
  KEY(`\n----- 知识库验证 (title 含 "${titleFragment}") -----`);
  const { getUnifiedStore } = require(path.join(ROOT, 'src/core/memory/unified-store'));
  const store = getUnifiedStore();
  const docs = store.queryDocuments({ namespace: 'global', titleContains: titleFragment, limit: 5 });
  if (!docs.length) { KEY('✗ documents 表无命中'); return false; }
  for (const d of docs) {
    KEY(`✓ doc ${String(d.id).slice(0, 8)} | ns=${d.namespace} | title=${d.title}`);
    KEY(`  metadata: source=${d.metadata && d.metadata.source} format=${d.metadata && d.metadata.sourceFormat} chars=${d.metadata && d.metadata.totalChars}`);
    KEY(`  content 前 120 字: ${String(d.content || '').slice(0, 120).replace(/\n/g, ' ')}`);
    if (expectChunks) {
      const chunks = store.getChunksByDocument(d.id);
      KEY(`  chunks: ${chunks.length} 块 (${chunks.reduce((s, c) => s + String(c.content || '').length, 0)} 字)`);
    }
  }
  // FTS 命中验证（hybrid retrieval 的入口路径）
  const fts = store.searchChunksFts(titleFragment.split('-')[0] || titleFragment, 'global', 3);
  if (fts.length) KEY(`✓ FTS5 命中 ${fts.length} 块`);
  else KEY('⚠ FTS5 无命中（可能检索词与内容不匹配，chunks 仍已入库）');
  return true;
}

async function main() {
  const mode = process.argv[2] || 'all';
  await initAdapterRegistry();

  for (const f of Object.values(SAMPLES)) {
    if (!fs.existsSync(f)) { KEY(`✗ 样例文件不存在: ${f}`); process.exit(1); }
  }

  let kbOk = true;

  if (mode === 'docx' || mode === 'all') {
    // 2026-08-20: 内容哈希去重（findByHash）会跳过重复分析 → 用临时副本强制走
    // 全链路。副本=原文件经 adm-zip 重写 comment（zip 结构合法、字节变化、哈希
    // 不同；直接 append 字节会破坏 zip 中央目录致解析失败）。副本随冒烟结束删除。
    const tmp = SAMPLES.docx + '.smoke.tmp.docx';
    {
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(SAMPLES.docx);
      zip.addFile('smoke-marker-' + Date.now() + '.txt', Buffer.from('smoke'));
      zip.writeZip(tmp);
    }
    const r = await runTool('DocumentAnalyze', {
      filePath: tmp,
      title: '端到端冒烟-智能体市场分析',
      focus: '市场趋势、风险与关键数字',
      saveToKnowledgeBase: true,
      maxChars: 6000,
    });
    if (r && r.success && r.file && r.file.path && fs.existsSync(r.file.path)) {
      KEY(`✓ 报告产物存在: ${r.file.path} (${(fs.statSync(r.file.path).size / 1024).toFixed(1)}KB)`);
      KEY(`✓ previewUrl: ${r.file.url || '(无)'}`);
      // 2026-08-20: document 卡推送验证（分析报告 → 左侧阅读面板的承载物）
      try {
        const { getSceneStore } = require(path.join(ROOT, 'src/core/scene/scene-store'));
        const surf = getSceneStore().getSnapshot().surfaces.find(s => s.kind === 'document' && String(s.id || '').startsWith('doc-analyze-'));
        if (surf) {
          const pages = (surf.data && surf.data.pages) || [];
          const chars = pages.reduce((n, p) => n + String(p.text || '').length, 0);
          KEY(`✓ document 卡已推送: id=${surf.id} title=${surf.data && surf.data.title} pages=${pages.length} (${chars} 字)`);
        } else { KEY('✗ document 卡未推送（scene-store 无 doc-analyze-* surface）'); kbOk = false; }
      } catch (se) { KEY(`✗ surface 验证异常: ${se.message}`); kbOk = false; }
      // docx 入库标题 = 模型 suggestedTitle（真实文档标题），不含冒烟前缀
      await sleep(1500);
      kbOk = kbOk && await verifyKb('智能体市场分析', true);
    } else {
      KEY('✗ 产物缺失或失败');
      kbOk = false;
    }
    try { fs.unlinkSync(tmp); } catch (_e) { /* 清理失败不阻塞 */ }
  }

  if (mode === 'xlsx' || mode === 'all') {
    const r = await runTool('DashboardGenerate', {
      filePath: SAMPLES.xlsx,
      title: '端到端冒烟-财报看板',
      focus: '营收、利润与同比趋势',
      saveToKnowledgeBase: true,
      maxRows: 50,
    });
    if (r && r.success && r.file && r.file.path && fs.existsSync(r.file.path)) {
      KEY(`✓ 看板产物存在: ${r.file.path} (${(fs.statSync(r.file.path).size / 1024).toFixed(1)}KB)`);
      const html = fs.readFileSync(r.file.path, 'utf8');
      KEY(`✓ 看板结构: ${['<!DOCTYPE html>', 'chart.umd', 'barChart', 'data-theme'].every(s => html.includes(s)) ? '齐全' : '缺失'}`);
      await sleep(1500);
      kbOk = kbOk && await verifyKb('端到端冒烟', true);
    } else {
      KEY('✗ 看板产物缺失或失败');
      kbOk = false;
    }
  }

  KEY(`\n========== 冒烟${kbOk ? '✅ 通过' : '❌ 部分失败'} ==========`);
  process.exit(kbOk ? 0 : 1);
}

main().catch(e => { KEY('FATAL: ' + (e.stack || e.message)); process.exit(1); });
