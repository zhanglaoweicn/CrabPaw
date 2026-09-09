/**
 * Template Selector — intelligent workflow template matching
 *
 * Combines IntentAnalyzer results with fuzzy keyword matching to select
 * the best workflow template. Falls back to presenting Top-3 candidates
 * when confidence is low.
 */

const WORKFLOW_KEYWORDS = {
  'market_research': ['市场调研', '行业分析', '竞品分析', '市场分析', '行业调研', '市场报告', '竞争分析'],
  'code_review': ['代码审查', 'code review', '代码检查', 'review代码', '代码审计', '安全审查'],
  'product_launch': ['产品发布', '产品上线', 'launch', '发布计划', '上线方案'],
  'contract_review': ['合同审查', '合同审核', '合同分析', '法务审查', '条款分析'],
  'financial_report': ['财务报告', '财报', '财务分析', '财务报表', '营收分析', '利润分析'],
  'daily_report': ['日报', '每日报告', 'daily report', '今日总结', '工作日报'],
  'weekly_summary': ['周报', '每周总结', '周总结', 'weekly', '本周回顾'],
  'data_analysis': ['数据分析', '数据可视化', '图表', '统计分析', '数据报告'],
  'document_writing': ['写文章', '写文档', '撰写', '编写报告', '写作', '文档生成'],
  'planning': ['规划', '计划', '方案设计', '路线图', 'roadmap', '规划方案'],
  'meeting_summary': ['会议纪要', '会议总结', 'meeting summary', '会议记录', '讨论总结'],
  'research': ['研究', '调研', 'research', '探索', '深度分析'],
};

/**
 * Score a message against a keyword group
 */
function _scoreKeywords(message, keywords) {
  const lower = message.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    if (lower.includes(kw.toLowerCase())) {
      score += kw.length >= 4 ? 3 : 1; // longer keywords = stronger signal
    }
  }
  return score;
}

/**
 * Select the best workflow template for a user message.
 *
 * @param {string} message - user input
 * @param {object|null} intentResult - result from IntentAnalyzer.analyze()
 * @returns {{workflowId: string, confidence: number, candidates?: Array}}
 */
function selectTemplate(message, intentResult) {
  // 1. IntentAnalyzer direct match
  if (intentResult && intentResult.suggestedWorkflow && intentResult.confidence >= 0.7) {
    return {
      workflowId: intentResult.suggestedWorkflow,
      confidence: intentResult.confidence,
      source: 'intent_analyzer',
    };
  }

  // 2. Keyword scoring
  const scores = {};
  for (const [workflowId, keywords] of Object.entries(WORKFLOW_KEYWORDS)) {
    scores[workflowId] = _scoreKeywords(message, keywords);
  }

  // 3. Rank candidates
  const ranked = Object.entries(scores)
    .filter(([, score]) => score > 0)
    .sort(([, a], [, b]) => b - a);

  if (ranked.length === 0) {
    return { workflowId: null, confidence: 0, candidates: [], source: 'none' };
  }

  const topScore = ranked[0][1];
  const maxPossible = 10; // rough normalization
  const confidence = Math.min(topScore / maxPossible, 1.0);

  // 4. High confidence → return best
  if (confidence >= 0.6) {
    return {
      workflowId: ranked[0][0],
      confidence,
      source: 'keyword_match',
    };
  }

  // 5. Low confidence → return Top-3 candidates for user selection
  const candidates = ranked.slice(0, 3).map(([id, score]) => {
    const templateNames = {
      'market_research': 'Market Research',
      'code_review': 'Code Review',
      'product_launch': 'Product Launch',
      'contract_review': 'Contract Review',
      'financial_report': 'Financial Report',
      'daily_report': 'Daily Report',
      'weekly_summary': 'Weekly Summary',
      'data_analysis': 'Data Analysis',
      'document_writing': 'Document Writing',
      'planning': 'Planning',
      'meeting_summary': 'Meeting Summary',
      'research': 'Research',
    };
    return {
      workflowId: id,
      name: templateNames[id] || id,
      score,
      confidence: score / maxPossible,
    };
  });

  return {
    workflowId: ranked[0][0],
    confidence,
    candidates,
    source: 'keyword_match_low_confidence',
  };
}

/**
 * Format candidates as a user-friendly suggestion message
 */
function formatCandidateSuggestions(candidates) {
  if (!candidates || candidates.length === 0) return null;

  const lines = ['I detected these possible workflows for your task:',''];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    lines.push(`  ${i + 1}. **${c.name}** (${(c.confidence * 100).toFixed(0)}% match)`);
  }
  lines.push('');
  lines.push('Reply with the workflow number or name to proceed.');

  return lines.join('\n');
}

module.exports = { selectTemplate, formatCandidateSuggestions, WORKFLOW_KEYWORDS };
