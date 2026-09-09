/**
 * BrowserControl 参数单一事实源 (2026-09-06 契约对齐轮)
 *
 * 消费方:
 *   - src/tools/browser-tools.js  → registry schema（LLM 视野的参数文档）
 *   - src/core/tool-contract.js   → TOOL_CONTRACTS.BrowserControl.schema（编排层 ajv 校验）
 *
 * 此前两处各写一份且互相漂移：静态契约缺 maxChars/value/direction 等十余参数，
 * 靠 ai.js 启动期 registerIntoRegistry 合并兜底（任何不经全量工具加载的校验方都会被拒）；
 * 反向 registry 又缺 method/params/button/clickCount，LLM 看不到 raw_cdp 的参数文档。
 * 现在改参数只改本文件，两处自动一致。
 */

'use strict';

const BROWSER_CONTROL_ACTIONS = [
  'status', 'start', 'stop', 'profiles',
  'navigate', 'snapshot', 'screenshot',
  'click', 'type', 'fill', 'select', 'hover', 'scroll', 'press',
  'evaluate',
  'tabs', 'open_tab', 'focus_tab', 'close_tab',
  'go_back', 'go_forward',
  'wait_for_selector', 'console',
  'extract_data', 'scroll_collect', 'paginate_collect',
  'wait_for_login',
  'connect_cdp', 'disconnect_cdp', 'cdp_status',
  'vision',
  'stealth_status', 'stealth_toggle',
  'recording_toggle',
  'click_at_cdp', 'raw_cdp', 'screenshot_with_coords',
];

const BROWSER_CONTROL_PROPERTIES = {
  action: {
    type: 'string',
    enum: BROWSER_CONTROL_ACTIONS,
    description: '要执行的浏览器操作类型',
  },
  profile: {
    type: 'string',
    description: '浏览器Profile名称（可选，默认智能选择：优先已有会话，否则default）',
  },
  url: {
    type: 'string',
    description: '导航URL（navigate/open_tab/wait_for_login时使用），仅允许http/https协议',
  },
  mode: {
    type: 'string',
    enum: ['aria', 'role', 'html', 'text'],
    description: '快照模式（snapshot时可选，默认aria）',
  },
  maxChars: {
    type: 'integer',
    description: '快照最大字符数（snapshot时可选，默认80000）',
  },
  ref: {
    type: 'string',
    description: '元素ref编号（click/type/fill/select/hover时使用），来自snapshot返回的ref值',
  },
  selector: {
    type: 'string',
    description: 'CSS选择器（click/type/fill/select/wait_for_selector/screenshot时可选）',
  },
  text: {
    type: 'string',
    description: '要输入的文本（type时使用），最大50000字符',
  },
  value: {
    type: 'string',
    description: '要填写的值（fill时使用），最大50000字符',
  },
  values: {
    type: 'array',
    items: { type: 'string' },
    description: '下拉选择值（select时使用）',
  },
  key: {
    type: 'string',
    description: '要按下的键（press时使用），仅允许白名单内的按键',
  },
  modifiers: {
    type: 'array',
    items: { type: 'string' },
    description: '修饰键（press时可选），仅允许Control/Alt/Shift/Meta',
  },
  expression: {
    type: 'string',
    description: '要执行的JS表达式（evaluate时使用）。⚠️ 任意代码执行，高风险：仅在确需页面内计算/DOM读取时使用，禁止用于操控页面状态以外的目的。禁止require/import/eval等危险模式，最大10000字符',
  },
  targetId: {
    type: 'string',
    description: '标签页ID（focus_tab/close_tab时使用），格式如t0/t1/...',
  },
  label: {
    type: 'string',
    description: '标签页标签（open_tab时可选）',
  },
  direction: {
    type: 'string',
    enum: ['up', 'down'],
    description: '滚动方向（scroll时使用，默认down）',
  },
  amount: {
    type: 'integer',
    description: '滚动量（scroll时可选，1-20，默认3）',
  },
  x: {
    type: 'number',
    description: 'X坐标（click/hover/click_at_cdp时可选）',
  },
  y: {
    type: 'number',
    description: 'Y坐标（click/hover/click_at_cdp时可选）',
  },
  button: {
    type: 'string',
    description: '鼠标按钮（click_at_cdp时可选），left/right/middle，默认left',
  },
  clickCount: {
    type: 'integer',
    description: '点击次数（click_at_cdp时可选），默认1',
  },
  delay: {
    type: 'integer',
    description: '输入延迟毫秒（type时可选，默认30ms）',
  },
  fullPage: {
    type: 'boolean',
    description: '是否全页截图（screenshot/vision时可选，默认false）',
  },
  imageType: {
    type: 'string',
    enum: ['png', 'jpeg'],
    description: '截图格式（screenshot时可选，默认png）',
  },
  timeout: {
    type: 'integer',
    description: '超时毫秒（wait_for_selector/wait_for_login时可选）',
  },
  state: {
    type: 'string',
    enum: ['attached', 'detached', 'visible', 'hidden'],
    description: '等待状态（wait_for_selector时可选，默认visible）',
  },
  containerSelector: {
    type: 'string',
    description: '数据容器CSS选择器（extract_data/scroll_collect/paginate_collect时使用，如 .product-card, .result-item）',
  },
  fields: {
    type: 'object',
    description: '字段映射（extract_data/scroll_collect/paginate_collect时使用），键为字段名，值为CSS选择器。如 {"title": "h3 a", "price": ".price", "link": "a"}',
    additionalProperties: { type: 'string' },
  },
  limit: {
    type: 'integer',
    description: '最大采集条数（extract_data默认100，scroll_collect/paginate_collect默认500）',
  },
  maxScrolls: {
    type: 'integer',
    description: '最大滚动次数（scroll_collect时可选，默认20）',
  },
  scrollDelay: {
    type: 'integer',
    description: '滚动间隔毫秒（scroll_collect时可选，默认1000）',
  },
  scrollSelector: {
    type: 'string',
    description: '滚动容器CSS选择器（scroll_collect时可选，默认整个页面滚动）',
  },
  nextButton: {
    description: '下一页按钮（paginate_collect时使用），可以是CSS选择器字符串或包含ref的对象如 {"ref": "5"}',
    oneOf: [
      { type: 'string' },
      { type: 'object', properties: { ref: { type: 'string' } } },
    ],
  },
  maxPages: {
    type: 'integer',
    description: '最大翻页次数（paginate_collect时可选，默认10）',
  },
  pageDelay: {
    type: 'integer',
    description: '翻页间隔毫秒（paginate_collect时可选，默认1500）',
  },
  loginSignal: {
    type: 'string',
    description: '登录成功信号（wait_for_login时可选）：URL中包含的关键词，如"home"、"dashboard"。不提供则自动检测页面登录标识',
  },
  wsEndpoint: {
    type: 'string',
    description: 'CDP WebSocket端点（connect_cdp时使用），如 ws://localhost:9222 或 localhost:9222。不提供则默认 ws://localhost:9222。仅允许本机端点，远程地址需配置白名单',
  },
  method: {
    type: 'string',
    description: 'CDP方法名（raw_cdp时使用），如 DOM.querySelector、Page.captureScreenshot',
  },
  params: {
    type: 'object',
    description: 'CDP方法参数对象（raw_cdp时使用），如 {"url": "https://..."}',
  },
  prompt: {
    type: 'string',
    description: '视觉分析提示（vision时使用），如"描述图表内容"、"这个验证码是什么"、"页面布局有什么问题"',
  },
  maxTokens: {
    type: 'integer',
    description: '视觉分析最大输出token（vision时可选）',
  },
  enabled: {
    type: 'boolean',
    description: '开关状态（stealth_toggle/recording_toggle时使用），true启用/false禁用',
  },
  headless: {
    type: 'boolean',
    description: '无头模式（start时兼容参数，实际以profile配置为准）',
  },
};

/**
 * registry（LLM 视野）参数 schema——不做 additionalProperties 限制，保持注册表宽松语义
 */
function buildRegistryParameters() {
  return {
    type: 'object',
    properties: { ...BROWSER_CONTROL_PROPERTIES },
    required: ['action'],
  };
}

/**
 * 编排层契约 schema——additionalProperties:false，属性集与 registry 同源
 */
function buildContractSchema() {
  return {
    type: 'object',
    properties: { ...BROWSER_CONTROL_PROPERTIES },
    required: ['action'],
    additionalProperties: false,
  };
}

module.exports = {
  BROWSER_CONTROL_ACTIONS,
  BROWSER_CONTROL_PROPERTIES,
  buildRegistryParameters,
  buildContractSchema,
};
