/**
 * Centralized tool name normalization — single source of truth.
 * ALL modules that deal with tool name mapping should use this.
 */

const TOOL_NAME_MAP = Object.freeze({
  read: 'Read', write: 'Write', edit: 'Edit',
  exec: 'Bash', bash: 'Bash', shell: 'Bash', rm_rf: 'Bash', shutdown: 'Bash', format: 'Bash',
  str_replace: 'Edit', apply_patch: 'Edit',
  web_search: 'WebSearch', web_fetch: 'WebFetch', web_extract: 'WebExtract', fetch_url: 'WebFetch',
  glob: 'Glob', grep: 'Grep',
  sessions_spawn: 'SpawnSubagent', sessions_send: 'SendMessage',
  spawn_subagent: 'SpawnSubagent',
  delegate_to_researcher: 'DelegateToResearcher',
  delegate_to_executor: 'DelegateToExecutor',
  delegate_to_critic: 'DelegateToCritic',
  image_generate: 'ImageGenerate',
  memory_search: 'MemorySearch', memory_save: 'MemorySave',
  recall: 'Recall', current_time: 'CurrentTime',
  todowrite: 'TodoWrite',
  cron_add: 'CronAdd', cron_list: 'CronList', cron_remove: 'CronRemove',
  plan_exit: 'PlanExit',
  http_request: 'HttpRequest',
  // 2026-08-15 T7: 注册主名已收敛 PascalCase（registry 别名双向解析，旧名调用仍可用）
  skill_generate: 'SkillGenerate', skill_manage: 'SkillManage',
  skill_view: 'SkillView', skills_list: 'SkillsList',
  taskflow: 'Taskflow',
});

function normalizeToRegistry(name) {
  if (!name) return name;
  return TOOL_NAME_MAP[name] || (name[0].toUpperCase() + name.slice(1));
}

module.exports = { TOOL_NAME_MAP, normalizeToRegistry };
