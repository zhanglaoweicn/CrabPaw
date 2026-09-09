/**
 * deep-research executor — 迭代式深度研究引擎
 *
 * 算法（改编自 dzhng/deep-research）：
 *   1. 生成 SERP 查询 → 2. 并行搜索 → 3. 提取 learnings + directions
 *   → 4. 用 directions 生成新查询 → 5. 重复（depth 次） → 6. 编译报告
 *
 * 使用 CrabPaw 内置的 AI 和搜索技能，无外部依赖。
 */

// ── 工具函数 ────────────────────────────────────────────────

/** 调用 CrabPaw AI 生成文字 */
async function askAI(prompt) {
  try {
    const ai = require('../../src/core/ai');
    const result = await ai.chat(prompt, { userId: 'deep-research' });
    if (typeof result === 'string') return result;
    if (result && result.content) return result.content;
    if (result && result.error) throw new Error(result.error);
    return String(result || '');
  } catch (e) {
    console.warn('[deep-research] AI call failed:', e.message);
    return '';
  }
}

/** 调用多搜索引擎执行一次搜索，返回结果摘要 */
async function searchOnce(query) {
  try {
    const skills = require('../../src/core/skills');
    const registry = skills.load();
    const result = await skills.execute('multi-search-engine', { keyword: query }, registry);
    if (typeof result === 'string') return result;
    return result?.searchResult || result?.message || JSON.stringify(result || {}).substring(0, 2000);
  } catch (e) {
    console.warn('[deep-research] Search failed for:', query, e.message);
    return `[搜索失败: ${query}]`;
  }
}

/** 从搜索结果中提取关键发现 */
async function extractLearnings(query, searchResult) {
  const prompt = `你是一个研究助手。从以下针对「${query}」的搜索结果中，提取 2-4 条关键发现。每条一句话，用中文。

搜索结果:
${String(searchResult).substring(0, 3000)}

请用 JSON 格式返回：
{ "learnings": ["发现1", "发现2", ...], "directions": ["进一步研究的方向1", "方向2"] }`;

  try {
    const response = await askAI(prompt);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        learnings: (parsed.learnings || []).slice(0, 5),
        directions: (parsed.directions || []).slice(0, 3),
      };
    }
    const lines = response.split('\n').filter(l => l.trim().length > 10).slice(0, 6);
    return { learnings: lines.slice(0, 4), directions: lines.slice(4) };
  } catch {
    return { learnings: [searchResult.substring(0, 200)], directions: [] };
  }
}

/** 生成 SERP 查询 */
async function generateQueries(topic, numQueries, learnings) {
  const learningsContext = learnings && learnings.length > 0
    ? `\n已有发现:\n${learnings.map(l => `- ${l}`).join('\n')}\n请基于这些发现生成更深入的查询。`
    : '';
  const prompt = `你是一个研究助手。为以下主题生成${numQueries}个搜索查询，每个查询应聚焦不同的角度。

主题: ${topic}${learningsContext}

请用 JSON 格式返回：
{ "queries": [{ "query": "搜索查询", "goal": "这个查询要达成的目标" }] }`;

  const response = await askAI(prompt);
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return (parsed.queries || []).slice(0, numQueries).map(q => q.query || q);
    } catch {}
  }
  return [topic];
}

/** 编译最终报告 */
async function compileReport(topic, allLearnings, allSources) {
  const uniqueLearnings = [...new Set(allLearnings)].slice(0, 30);
  const prompt = `你是一个专业的研究分析师。基于以下研究发现，撰写一份结构化的研究报告。

研究主题: ${topic}

关键发现:
${uniqueLearnings.map((l, i) => `${i + 1}. ${l}`).join('\n')}

来源数量: ${allSources.length}

请用 Markdown 格式撰写报告，包含以下章节：
1. 概述（2-3句话）
2. 核心发现（编号列表）
3. 关键趋势
4. 建议与展望

报告风格: 专业、客观、数据驱动。`;

  const report = await askAI(prompt);
  return report || `# ${topic}\n\n## 核心发现\n\n${uniqueLearnings.map(l => `- ${l}`).join('\n')}`;
}

// ── 主算法 ──────────────────────────────────────────────────

async function execute(input, options, params) {
  let parsed;
  if (typeof input === 'string') { parsed = { query: input }; }
  else if (input && typeof input === 'object') { parsed = input; }
  else { parsed = {}; }

  const query = parsed.query || parsed.topic || parsed.message || '';
  const breadth = Math.max(1, Math.min(5, parsed.breadth || 3));
  const depth = Math.max(1, Math.min(4, parsed.depth || 2));

  if (!query) {
    return { success: false, error: '请提供研究主题（query）' };
  }

  console.log(`[deep-research] 开始研究: "${query}" breadth=${breadth} depth=${depth}`);

  const allLearnings = [];
  const allSources = [];
  let currentQueries = [query];

  // ── 迭代研究循环 ──
  for (let d = depth; d > 0; d--) {
    console.log(`[deep-research] Round ${depth - d + 1}/${depth}, ${currentQueries.length} queries`);

    // 1. 如果需要更多查询方向，生成新的
    if (currentQueries.length < breadth || d < depth) {
      const newQueries = await generateQueries(query, breadth, allLearnings);
      currentQueries = newQueries.slice(0, breadth);
    }

    // 2. 并行搜索
    const searchResults = await Promise.all(
      currentQueries.map(async (q) => {
        const result = await searchOnce(q);
        allSources.push(q);
        return { query: q, result };
      })
    );

    // 3. 提取 learnings
    for (const sr of searchResults) {
      const extracted = await extractLearnings(sr.query, sr.result);
      allLearnings.push(...extracted.learnings);
      if (d > 1 && extracted.directions.length > 0) {
        currentQueries = extracted.directions.slice(0, breadth);
      }
    }

    // 4. 去重 learnings
    const seen = new Set();
    const uniqueLearnings = [];
    for (const l of allLearnings) {
      const key = l.substring(0, 50);
      if (!seen.has(key)) { seen.add(key); uniqueLearnings.push(l); }
    }
    allLearnings.length = 0;
    allLearnings.push(...uniqueLearnings);
  }

  // ── 编译报告 ──
  console.log(`[deep-research] 编译报告: ${allLearnings.length} 条发现, ${allSources.length} 次搜索`);
  const report = await compileReport(query, allLearnings, allSources);

  const summary = allLearnings.slice(0, 5).map(l => `• ${l}`).join('\n');

  return {
    success: true,
    report,
    summary,
    learnings: allLearnings,
    sourceCount: allSources.length,
    depth,
    breadth,
    query,
    message: `深度研究完成: "${query}" — ${allLearnings.length} 条发现, ${allSources.length} 次搜索, ${depth} 层深度`,
  };
}

// ── Schema — for capability registry ────────────────────────
const schema = {
  name: 'deep-research',
  description: '迭代式深度研究：多轮搜索 → 提取发现 → 追问 → 再搜索 → 编译报告',
  capabilities: ['iterative_research', 'web_search', 'data_collection', 'report_writing'],
  input: {
    query:   { type: 'string', description: '研究主题' },
    breadth: { type: 'number', description: '每轮查询数（1-5，默认3）' },
    depth:   { type: 'number', description: '迭代层数（1-4，默认2）' },
  },
  output: {
    report:    { type: 'string', description: 'Markdown 格式研究报告' },
    learnings: { type: 'array',  description: '所有发现列表' },
    summary:   { type: 'string', description: '核心发现摘要' },
  },
};

module.exports = { execute, schema };
