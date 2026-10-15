/**
 * tool-hints — 工具执行提示与调用签名的单一事实源（2026-10-01）
 *
 * 背景（实机：对话窗口同时出现「正在执行命令」与「正在执行 Bash」）：
 *   ai.js 有两条互不知情的工具提示通道——原生函数调用分支用手写友好文案表，
 *   DSML 兜底分支用裸工具名，且各处（含 chat-handler 企微路径）共三份手写映射
 *   各自维护。本模块收敛为一份，并提供跨轮回声去重用的规范化调用签名。
 *
 * 跨轮回声问题：模型偶发在原生 tool_call 已执行后，下一轮又在文本里复述同一调用
 * （DSML 形式）。processWithStreaming 用 recentSignatures（随递归帧传递）记录最近
 * 执行过的签名，DSML 兜底在发提示/执行前先查——命中即静默跳过，不再重复执行。
 */

const TOOL_RUNNING_HINTS = {
  'Bash': '正在执行命令...',
  'ShellExec': '正在执行命令...',
  'Read': '正在读取文件...',
  'Write': '正在写入文件...',
  'Edit': '正在编辑文件...',
  'LS': '正在列出目录...',
  'Glob': '正在匹配文件...',
  'Grep': '正在搜索文本...',
  'SearchCodebase': '正在搜索代码库...',
  'WebSearch': '正在搜索网络...',
  'WebFetch': '正在获取网页...',
  'WebExtract': '正在提取网页内容...',
  'StockQuery': '正在查询股票数据...',
  'Weather': '正在查询天气...',
  'TodoRead': '正在读取任务列表...',
  'TodoWrite': '正在更新任务...',
  'DocRead': '正在读取文档...',
};

/**
 * 工具执行中的可读提示；未收录的工具回退为「正在执行 <工具名>...」。
 */
function toolRunningHint(name) {
  return TOOL_RUNNING_HINTS[name] || `正在执行 ${name}...`;
}

/** 稳定字符串化：键排序后拼接，保证同内容的不同键序/字符串|对象形态得到同一签名 */
function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/**
 * 规范化调用签名——「工具名:参数」。
 * 参数接受对象或 JSON 字符串（原生 FC 给字符串、DSML 解析给对象），内部统一
 * parse 后按键排序稳定化，避免键序/空格差异让"同一调用"对不上号。
 * 空参数各种形态（undefined/null/空对象/空串）归一为 `{}`——裸调用的回声
 * （原生 arguments:"" vs DSML params:{}）必须对上同一个签名。
 */
function toolCallSignature(name, args) {
  let normalized;
  if (typeof args === 'string') {
    const t = args.trim();
    if (!t) {
      normalized = null;
    } else {
      try { normalized = JSON.parse(t); } catch (e) { normalized = t; }
    }
  } else {
    normalized = args;
  }
  if (normalized == null) return `${name}:{}`;
  if (typeof normalized === 'object') {
    if (!Array.isArray(normalized) && Object.keys(normalized).length === 0) return `${name}:{}`;
    return `${name}:${stableStringify(normalized)}`;
  }
  // 标量或非 JSON 字符串: 字符串原样参与, 其余标量 JSON 化保持确定性
  return `${name}:${typeof normalized === 'string' ? normalized : JSON.stringify(normalized)}`;
}

module.exports = {
  TOOL_RUNNING_HINTS,
  toolRunningHint,
  toolCallSignature,
};
