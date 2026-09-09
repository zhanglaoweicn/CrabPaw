/**
 * capability-map — 子代理工具集 → 能力声明派生(D1, Runtime差距分析实施)
 *
 * 此前 agent-contract-validator 的 requiredCapabilities 全部为空数组:生产调用链
 * 从不传 capabilities,直接回填会硬拦全部 spawn。现在派生函数以"该类型实际可用的
 * 工具白名单"推导能力声明,spawn 时自动携带——契约校验因此有了真实输入:
 * 白名单与契约漂移(如 implement 被移除 exec)会在 spawn 时报 "Missing capability",
 * 强制重新评审契约,而不是静默放行。
 *
 * 键覆盖两套 runner 的工具名体系:
 * - subagent-enhanced SUBAGENT_TOOL_SETS(read/write/edit/exec/web_search/...)
 * - subagent.js DEFAULT_ALLOWED_TOOLS(read/grep/glob/bash/str_replace/...)
 */

const TOOL_CAPABILITY_MAP = {
  read: 'file_read',
  grep: 'file_read',
  glob: 'file_read',
  write: 'file_write',
  edit: 'file_write',
  str_replace: 'file_write',
  exec: 'code_execution',
  bash: 'code_execution',
  web_search: 'web_search',
  web_fetch: 'web_fetch',
  memory_search: 'memory_access',
  sessions_spawn: 'subagent_spawn',
  sessions_send: 'subagent_spawn',
};

/**
 * 从工具白名单派生能力声明(去重,保持首现顺序)
 * @param {string[]} tools
 * @returns {string[]}
 */
function deriveSubagentCapabilities(tools) {
  const caps = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    const cap = TOOL_CAPABILITY_MAP[tool];
    if (cap && !caps.includes(cap)) caps.push(cap);
  }
  return caps;
}

module.exports = { TOOL_CAPABILITY_MAP, deriveSubagentCapabilities };
