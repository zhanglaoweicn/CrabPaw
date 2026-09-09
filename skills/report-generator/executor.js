/**
 * report-generator — 结构化研究报告生成
 * 用法：execute({ topic, sections?: number(1-5), format?: 'markdown'|'html', keyword?, engine? })
 * 流程：多轮搜索收集素材 → 汇总为结构化报告 → 可选 HTML 输出
 */
const { handleWebSearch } = require('../../src/tools/web-tools');
const { _generateHtml } = require('../../src/tools/document-tools');

async function collect(topic, rounds, engine) {
  const queries = [topic];
  if (rounds >= 2) queries.push(`${topic} 最新进展 2026`);
  if (rounds >= 3) queries.push(`${topic} 市场规模 数据`);
  const notes = [];
  for (const q of queries.slice(0, rounds)) {
    try {
      const r = await handleWebSearch({ query: q, engine });
      // 成功判定：ok === true 或 results 非空
      const ok = r?.ok === true || (r?.results && r.results.length > 0);
      if (ok) {
        const items = (r.results || []).slice(0, 5);
        if (items.length > 0) {
          notes.push(`### 关于「${q}」的检索结果\n${items.map((it, i) => `${i + 1}. ${it.title}\n   ${it.url}`).join('\n')}`);
        }
      }
    } catch (err) {
      console.warn(`[report-generator] 第 ${q} 轮搜索失败:`, err.message);
    }
  }
  return notes;
}

async function execute(params = {}) {
  try {
    // 支持 keyword → query 映射（兼容旧调用）
    const topic = String(params.topic || params.keyword || '').trim();
    if (!topic) return { success: false, error: '缺少主题 topic（或 keyword）' };

    const rounds = Math.max(1, Math.min(5, Number(params.sections) || 3));
    const engine = params.engine || null;

    const notes = await collect(topic, rounds, engine);
    if (notes.length === 0) return { success: false, error: '未能收集到资料，请稍后重试' };

    const body = `# ${topic} 研究报告\n\n${notes.join('\n\n')}\n\n> 本报告由多轮搜索汇总生成，数据以原文链接为准。`;

    if (params.format === 'html') {
      // _generateHtml 签名：(content, { style, title, inputType }) —— 同步，两参数
      const html = _generateHtml(body, {
        style: params.style || params.template || '商务报告',
        title: `${topic} 研究报告`,
        inputType: 'markdown',
      });
      return { success: true, format: 'html', html, topic, size: html.length };
    }

    return { success: true, format: 'markdown', content: body, topic };
  } catch (err) {
    console.error('[report-generator] 失败:', err);
    return { success: false, error: `报告生成失败: ${err.message}` };
  }
}

module.exports = { execute };
