/**
 * NL Task Parser — 自然语言 → 结构化自动化任务配置
 *
 * 把用户的自然语言描述解析为结构化的定时任务配置：
 *   "每天早上9点抓竞品动态，用产品经理视角整理发我"
 *   → { name, prompt, cron, expert, skills, channel, ... }
 *
 * 用法: const parsed = await parseNLToTask("每天早上9点...");
 *       const { task, changes } = await editTaskByNL(existingTask, "改成下午5点执行");
 */

const { loadConfig } = require('../../core/config');

const { getWorkflowTemplateEngine } = require('../../taskflow/workflow-template-engine');

// ─── 专家角色列表（从 TaskFlow 统一数据源获取） ──────────
function getExpertList() {
  const engine = getWorkflowTemplateEngine();
  const roles = engine.listExpertRoles();
  return roles.map(r => ({
    id: r.id,
    name: r.name,
    description: r.description,
    emoji: r.emoji || '🤖',
  }));
}

// ─── 技能列表（精简版） ──────────────────────────────────────

const SKILL_LIST = [
  { id: 'multi-search-engine', name: '多引擎搜索', category: 'search' },
  { id: 'deep-research', name: '深度研究', category: 'research' },
  { id: 'deep-research-pro', name: '深度研究Pro', category: 'research' },
  { id: 'summarize-pro', name: '文本摘要', category: 'document' },
  { id: 'wechat-article-search', name: '公众号搜索', category: 'search' },
  { id: 'code-review', name: '代码审查', category: 'development' },
  { id: 'excel-xlsx', name: 'Excel处理', category: 'document' },
  { id: 'pdf-generator', name: 'PDF生成', category: 'document' },
  { id: 'html-generator', name: 'HTML生成', category: 'document' },
  { id: 'powerpoint-pptx', name: 'PPT处理', category: 'document' },
  { id: 'report-generator', name: '报告生成', category: 'document' },
  { id: 'email-assistant', name: '邮件助手', category: 'productivity' },
  { id: 'weather', name: '天气查询', category: 'information' },
  { id: 'stock-analyst-enhanced', name: '股票分析', category: 'finance' },
  { id: 'financial-analyst', name: '财务分析', category: 'finance' },
  { id: 'trending-monitor', name: '热点监控', category: 'information' },
  { id: 'chart-visualization', name: '图表可视化', category: 'document' },
  { id: 'browser-use', name: '浏览器控制', category: 'automation' },
  { id: 'wecom-daily-news', name: '企业微信日报', category: 'communication' },
  { id: 'desktop-control', name: '桌面控制', category: 'automation' },
  { id: 'knowledge-base', name: '知识库', category: 'productivity' },
  { id: 'image-analyze', name: '图片分析', category: 'media' },
  { id: 'healthcheck', name: '健康检查', category: 'system' },
  { id: 'file-manager', name: '文件管理', category: 'system' },
  { id: 'file-organizer', name: '文件整理', category: 'productivity' },
  { id: 'doc-processor', name: '文档处理', category: 'document' },
  { id: 'markdown-converter', name: 'Markdown转换', category: 'document' },
  { id: 'system-info', name: '系统信息', category: 'system' },
  { id: 'prompt-engineering-expert', name: '提示词专家', category: 'ai' },
  { id: 'self-improving-agent', name: '自我改进', category: 'ai' },
  { id: 'price-monitor', name: '价格监控', category: 'shopping' },
  { id: 'product-research', name: '产品调研', category: 'analysis' },
  { id: 'review-analyzer', name: '评论分析', category: 'analysis' },
  { id: 'content-planner', name: '内容规划', category: 'productivity' },
  { id: 'article-writer', name: '文章写作', category: 'writing' },
  { id: 'meeting-summary', name: '会议摘要', category: 'productivity' },
  { id: 'consulting-analysis', name: '咨询分析', category: 'analysis' },
];

const CHANNEL_LIST = [
  { id: 'wecom', name: '企业微信' },
  { id: 'lark', name: '飞书' },
  { id: 'both', name: '两者都发' },
  { id: 'none', name: '不推送' },
];

// ─── 构建系统提示词 ──────────────────────────────────────────

function buildSystemPrompt() {
  const expertsMd = getExpertList().map(e => `  - ${e.id} (${e.emoji} ${e.name}): ${e.description}`).join('\n');
  const skillsMd = SKILL_LIST.map(s => `  - ${s.id}: ${s.name} [${s.category}]`).join('\n');
  const channelsMd = CHANNEL_LIST.map(c => `  - ${c.id}: ${c.name}`).join('\n');

  return `你是一个任务解析助手。用户会用自然语言描述一个自动化任务，你需要解析为结构化配置。

## 可用专家角色（用于切换 AI 的思维方式）
${expertsMd}

## 可用技能（为 AI 提供专业能力）
${skillsMd}

## 可用推送通道
${channelsMd}

## Cron 表达式说明
标准 5 字段: 分 时 日 月 周
- \`0 9 * * *\` = 每天早上 9:00
- \`30 9 * * 1-5\` = 每工作日 9:30
- \`0 9 * * 1\` = 每周一 9:00
- \`*/15 * * * *\` = 每 15 分钟
- \`0 0 1 * *\` = 每月 1 号
- \`0 9,18 * * *\` = 每天 9:00 和 18:00

## 输出要求
你必须输出一个 JSON 对象（且只输出 JSON，不要其他文字），格式如下：
{
  "name": "简短的任务名（中文，最多20字）",
  "prompt": "执行指令（用户的真实意图，保留具体内容）",
  "cron": "cron 表达式",
  "timezone": "Asia/Shanghai",
  "expert": "选中的专家 ID，如果没有合适的选择就填 null",
  "skills": ["技能 ID 数组，从可用技能列表中选择，0-3个"],
  "channel": "推送通道 ID",
  "skipHoliday": true,
  "confidence": {
    "overall": 0.95,
    "expert": 0.9,
    "skills": 0.85,
    "cron": 0.95
  }
}

## 规则
1. name 要简洁精准，来自用户的核心意图
2. prompt 保留用户说的具体内容，作为任务执行时的指令
3. cron 必须从用户描述中推断精确时间
4. expert 只有在用户明确提及或暗示了角色时才填（如"用产品经理视角"→ product_manager），否则 null
5. skills 只有在用户明确提及了具体能力时才填（如"搜索文章"→ wechat-article-search），最多 3 个，否则为空数组
6. channel 默认为 "wecom"
7. skipHoliday 只有在用户说"工作日""节假日跳过"等时才 true
8. confidence 中每个字段填 0-1 的置信度评估，低置信度表示不确定该字段`;
}

// ─── 调用 AI ────────────────────────────────────────────────

async function _callAI(systemPrompt, userText) {
  const config = loadConfig();
  const { createModelRouter, getModelRouter } = require('../../core/model-router');
  const { fetchWithRetry } = require('../../core/ai/http-helpers');

  let router = getModelRouter();
  if (!router) {
    createModelRouter(config);
    router = getModelRouter();
  }

  const routeResult = router.route(userText);
  if (routeResult.error) {
    throw new Error(`模型路由失败: ${routeResult.error}`);
  }

  // eslint-disable-next-line no-unused-vars
  const { model, baseUrl, apiKey, provider } = routeResult;

  const resp = await fetchWithRetry(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText },
      ],
      temperature: 0.1,
      max_tokens: 2000,
    }),
  });

  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`AI API 错误: ${resp.status} - ${errorText.substring(0, 200)}`);
  }

  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('AI 返回内容为空');
  }

  return content;
}

// ─── 尝试解析 AI 返回的 JSON ─────────────────────────────────

function _tryParseJSON(text) {
  // Try direct parse first
  try {
    return JSON.parse(text);
  } catch {
    // Try to extract JSON from code block
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      try {
        return JSON.parse(match[1].trim());
      } catch (e) { console.warn('[nlp-task-parser] failed to parse JSON from code block:', e.message); }
    }
    // Try to find { ... } in text
    const braceMatch = text.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try {
        return JSON.parse(braceMatch[0]);
      } catch (e) { console.warn('[nlp-task-parser] failed to parse JSON from brace block:', e.message); }
    }
  }
  return null;
}

// ─── 验证解析结果 ────────────────────────────────────────────

function _validateParsed(result) {
  const errors = [];

  if (!result || typeof result !== 'object') {
    return { valid: false, errors: ['返回格式无效'] };
  }

  if (!result.name || typeof result.name !== 'string') {
    errors.push('缺少有效的 name');
  }

  if (!result.prompt || typeof result.prompt !== 'string') {
    errors.push('缺少有效的 prompt');
  }

  if (!result.cron || typeof result.cron !== 'string') {
    errors.push('缺少有效的 cron');
  }

  if (result.expert !== null && result.expert !== undefined) {
    const validExpertIds = getExpertList().map(e => e.id);
    if (!validExpertIds.includes(result.expert)) {
      errors.push(`无效的 expert ID: ${result.expert}`);
      result.expert = null;
    }
  }

  if (Array.isArray(result.skills)) {
    const validSkillIds = SKILL_LIST.map(s => s.id);
    const invalid = result.skills.filter(s => !validSkillIds.includes(s));
    if (invalid.length > 0) {
      errors.push(`无效的技能 ID: ${invalid.join(', ')}`);
      result.skills = result.skills.filter(s => validSkillIds.includes(s));
    }
    if (result.skills.length > 3) {
      result.skills = result.skills.slice(0, 3);
    }
  } else {
    result.skills = [];
  }

  const validChannels = CHANNEL_LIST.map(c => c.id);
  if (!validChannels.includes(result.channel)) {
    result.channel = 'wecom';
  }

  if (typeof result.skipHoliday !== 'boolean') {
    result.skipHoliday = false;
  }

  if (!result.timezone) {
    result.timezone = 'Asia/Shanghai';
  }

  if (!result.confidence || typeof result.confidence !== 'object') {
    result.confidence = { overall: 0.5, expert: 0.5, skills: 0.5, cron: 0.5 };
  }

  return { valid: errors.length === 0, errors };
}

// ─── 公开 API ────────────────────────────────────────────────

/**
 * 解析自然语言 → 结构化任务配置
 * @param {string} text 用户自然语言描述
 * @param {object} [options]
 * @param {number} [options.retries=2] 解析失败重试次数
 * @returns {Promise<{
 *   success: boolean,
 *   task: object|null,
 *   error: string|null,
 *   raw: string|null
 * }>}
 */
async function parseNLToTask(text, options = {}) {
  const maxRetries = options.retries ?? 2;

  if (!text || typeof text !== 'string' || !text.trim()) {
    return { success: false, task: null, error: '输入文本不能为空', raw: null };
  }

  const systemPrompt = buildSystemPrompt();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const raw = await _callAI(systemPrompt, text.trim());
      const parsed = _tryParseJSON(raw);

      if (!parsed) {
        if (attempt < maxRetries) continue;
        return { success: false, task: null, error: 'AI 返回了无法解析的格式', raw };
      }

      const validation = _validateParsed(parsed);
      if (!validation.valid && attempt < maxRetries) {
        continue;
      }

      // Normalize
      const task = {
        name: parsed.name || text.trim().slice(0, 20),
        prompt: parsed.prompt || text.trim(),
        cron: parsed.cron || '0 9 * * *',
        timezone: parsed.timezone || 'Asia/Shanghai',
        expert: parsed.expert || null,
        skills: parsed.skills || [],
        channel: parsed.channel || 'wecom',
        skipHoliday: parsed.skipHoliday || false,
        confidence: parsed.confidence || {},
      };

      return {
        success: true,
        task,
        raw,
        warnings: validation.errors.length > 0 ? validation.errors : undefined,
      };
    } catch (err) {
      if (attempt < maxRetries) continue;
      return { success: false, task: null, error: err.message, raw: null };
    }
  }

  return { success: false, task: null, error: '解析失败（未知错误）', raw: null };
}

/**
 * 用自然语言修改已有任务的配置
 * @param {object} existingTask 当前任务配置
 * @param {string} editText 修改描述，如 "改成下午5点执行" 或 "再加一个数据分析技能"
 * @returns {Promise<{
 *   success: boolean,
 *   changes: object|null,     只包含修改过的字段
 *   merged: object|null,      完整合并后的任务
 *   error: string|null
 * }>}
 */
async function editTaskByNL(existingTask, editText) {
  if (!existingTask || !editText) {
    return { success: false, changes: null, merged: null, error: '缺少现有任务或修改描述' };
  }

  const currentConfig = {
    name: existingTask.name || '',
    prompt: existingTask.prompt || existingTask.action || '',
    cron: existingTask.cron || '0 9 * * *',
    timezone: existingTask.timezone || 'Asia/Shanghai',
    expert: existingTask.expert || null,
    skills: existingTask.skills || [],
    channel: existingTask.channel || 'wecom',
    skipHoliday: existingTask.skipHoliday || false,
  };

  // Build a prompt that tells AI what to change
  const systemPrompt = buildSystemPrompt() + `\n\n## 额外说明
用户当前任务的配置如下：
${JSON.stringify(currentConfig, null, 2)}

用户想要修改此任务。请分析用户的修改请求，输出完整的新的 JSON 配置（不是只输出修改的部分）。
如果某个字段没有变化，保持原值即可。`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await _callAI(systemPrompt, editText.trim());
      const parsed = _tryParseJSON(raw);

      if (!parsed) continue;

      const validation = _validateParsed(parsed);
      if (!validation.valid) continue;

      // Calculate what actually changed
      const changes = {};
      for (const key of Object.keys(currentConfig)) {
        const oldVal = JSON.stringify(currentConfig[key]);
        const newVal = JSON.stringify(parsed[key]);
        if (oldVal !== newVal) {
          changes[key] = parsed[key];
        }
      }

      const merged = { ...currentConfig };
      for (const key of Object.keys(parsed)) {
        if (parsed[key] !== undefined) merged[key] = parsed[key];
      }

      return { success: true, changes, merged, raw };
    } catch (err) {
      console.warn('[nlp-task-parser] editTaskByNL AI call failed:', err.message);
    }
  }

  return { success: false, changes: null, merged: null, error: 'AI 无法解析修改请求' };
}

module.exports = {
  parseNLToTask,
  editTaskByNL,
  getExpertList,
  SKILL_LIST,
  CHANNEL_LIST,
};
