'use strict';

/**
 * 意图识别模块（从 ai.js 拆分）
 *
 * 基于关键词正则识别用户消息意图，生成给 LLM 的提示词。
 * 同时根据渠道（channel）过滤不适用的工具。
 */

// 意图模式列表：每个意图含正则数组、提示词、关联工具
const INTENT_PATTERNS = [
  // 2026-08-14: 台风意图置于天气之前——"台风天气/台风路径"优先走台风追踪面板
  // 2026-08-25 强化版: 台风问题面板独占——禁止文字/ShowStock/ShowWeather/仅数据工具代替
  { patterns: [/台风|飓风|typhoon|hurricane/i], hint: '用户询问台风/台风路径/台风预警——必须调用 ShowTyphoon(action="show") 弹出台风面板(轨迹地图/风圈/登陆点)。严禁用文字回复替代, 严禁调用 ShowStock/ShowWeather 或只调 TyphoonQuery(数据查询不能代替面板展示)。数据来自政府实时发布系统, 暂不可用时如实告知并建议官方渠道, 不得虚构。', tool: 'ShowTyphoon' },
  { patterns: [/天气|weather|温度|气温|下雨|下雪|晴|阴/, /wttr/i], hint: '用户查询天气，调用 ShowWeather(city="城市名")。会以可视卡片形式展示在右上角。不要只用文字回复天气——调工具显示卡片才是用户期望的体验。', tool: 'ShowWeather' },
  { patterns: [/音乐|放首歌|听歌|播放|歌曲|唱首歌|来首歌|推荐音乐|music|song/i], hint: '用户想要听音乐，请使用 Music( action="search" ) 工具搜索并播放音乐。如果需要控制（暂停/下一首/关闭），使用 Music(action="stop"|"pause"|"next")。推荐优先使用统一的 Music 工具替代独立的 MusicSearch/PlayMusic/MusicControl。', tool: 'Music' },
  { patterns: [/股票|行情|涨跌|股价|A股|港股|美股|基金|指数|K线|市盈率/], hint: '用户询问股票行情/大盘/股价，先调用 ShowStock(queries="股票名") 展示行情面板（实时行情列表+K线+大盘指数）；用户要求深度分析（估值/动量/风险/建议）时再用 StockQuery 工具', tool: 'StockQuery' },
  // 2026-08-15: 车票意图——此前无显式路由, LLM 对"查动车票"自己拼 HttpRequest
  // 硬打 12306 被反爬(日志实锤 02:44-02:46 四次尝试), 失败降级 BrowserControl
  // 又误开文档生成舱。显式路由到专用 TrainQuery 工具(自带站点码表+余票解析)。
  { patterns: [/车票|动车|高铁|火车票|车次|余票|列车|12306/i], hint: '用户查询火车/动车/高铁票，必须调用 TrainQuery 工具：从用户消息提取 from(出发站中文名,如"北京")/to(到达站中文名,如"上海")/date(YYYY-MM-DD,未指定时默认明天)。不要用 HttpRequest/BrowserControl 直接访问 12306 官网(有反爬拦截)。若缺 from/to 信息,先向用户询问。', tool: 'TrainQuery' },
  // 2026-08-25 热点/资讯分流(用户实机反馈): 该条原 pattern 含"热点/资讯/新闻"且
  // hint 只说 WebSearch——「最近有什么热点」命中后被"请使用 WebSearch"引导 →
  // 热点卡片不弹反出文本(UI 弹卡与搜索回话必须一刀切, hint 与 router 同语义)。
  { patterns: [/热点|热搜|热榜|榜单|排行|ranking|trending/i], hint: '用户要热点/热搜榜单("最近有什么热点""今日热搜""打开热点面板")——必须调用 ShowHotspot(action="show", format="scene") 弹出热点面板卡片, 严禁用 WebSearch 或文本表格替代。只有用户明确问"资讯/新闻内容"时才走 WebSearch 文本回答。', tool: 'ShowHotspot' },
  // 2026-08-25 强化(台风同上款): 台风问题的数据/面板工具独占——禁止串站
  { patterns: [/资讯|新闻|头条|news/i], hint: '用户需要最新资讯/新闻/AI热门资讯——使用 WebSearch 搜索后以文本回答, 不弹出任何面板卡片, 也不列举技能列表。', tool: 'WebSearch' },
  { patterns: [/搜索|搜一下|search|google|百度|找一下|帮我找|最新/], hint: '用户需要搜索信息，请使用 WebSearch 工具', tool: 'WebSearch' },
  { patterns: [/调研|深入研究|深度研究|深度分析|行业报告|市场分析|竞品分析|技术选型|调查|全面了解/], hint: '用户需要深度研究，请应用 deep-research-pro 技能：拆分子问题→多源搜索→深度阅读→综合报告', tool: 'WebSearch' },
  { patterns: [/网页|网站|URL|链接|打开|访问|fetch|http/i], hint: '用户需要访问网页，请使用 WebFetch 工具', tool: 'WebFetch' },
  { patterns: [/总结一下|帮我看看|这个讲了什么|概括|提炼|摘要|总结报告|内容摘要|概括要点|核心观点|一句话总结/], hint: '用户需要摘要提炼，请应用 summarize-pro 技能：WebFetch获取内容→按模板提炼→质量保证', tool: 'WebFetch' },
  { patterns: [/图片|截图|照片|图像|识别|OCR|看图|分析图片/], hint: '用户需要处理图片，请使用 ImageAnalyze 或 ImageOCR 工具', tool: 'ImageAnalyze' },
  { patterns: [/文件|读取|查看文件|打开文件|file/i], hint: '用户需要操作文件，请使用 Read/Write/Edit 等文件工具', tool: 'Read' },
  { patterns: [/合同|法律|条款|协议|租赁|漏洞|风险/], hint: '用户需要分析文档内容，请直接基于已提供的文件内容回答，不要重新读取文件', tool: null },
  { patterns: [/生成.*Word|生成.*文档|写.*文档|创建.*文档|保存.*文档|生成.*报告|导出.*文档|导出.*Word|docx/i], hint: '用户需要生成文档', tool: 'MarkdownToWord' },
  { patterns: [/发送.*企微|企微.*发送|发.*企业微信|企业微信.*发|发送文件|send.*wecom/i], hint: '用户需要发送文件到企业微信', tool: 'SendWecomFile' },
  { patterns: [/日程|会议安排|日历|创建日程|安排会议/], hint: '用户需要管理日程——带具体时间+会议/约/日程语义（如「明天上午10点开会」）→ CreateCalendarEvent 创建日程（工具默认带提前10分钟提醒，无需再调 SetReminder；用户明说「不用提醒」则 reminders 传空数组）；时间说不清/有歧义 → 仍调 CreateCalendarEvent，工具会返回 needsClarification 并自动弹预填表单。', tool: 'CreateCalendarEvent' },
  // 2026-08-18: 会议记录意图——「开始记录/停止记录」触发会议纪要卡片。
  // 转写实时显示在卡片内，模型不要复述转写内容。
  { patterns: [/开始记录|记录一下|开始录音|会议记录|会议录音|帮我记录|停止记录|结束记录|记一下|纪要|历史会议|会议历史/i], hint: '开始/停止会议记录与查看历史分三种——开始记录→meeting_mode(action="show")（打开会议面板并开始录音，转写实时在卡片显示，不要复述）；停止→meeting_mode(action="hide")（结束录音，系统自动总结生成纪要）；用户要求查看/打开历史纪要/历史会议/会议历史（不含"开始"）→meeting_mode(action="history")（仅打开历史列表——严禁用 show 回应查看类请求，show 会新建一场空会议）。', tool: 'meeting_mode' },
  { patterns: [/提醒|到时候|别忘了|记得|定时提醒|到点/], hint: '用户需要设置提醒 → SetReminder（支持自然语言时间如「明天上午9点」）。消歧：带具体时间且是会议/约/日程类事项（开会/约饭局/面试等）→ 改用 CreateCalendarEvent 建日程（自带提醒），不要对同一诉求同时调两个工具；纯「提醒我 X 做 Y」（喝水/拿快递等非日程事项）→ SetReminder。', tool: 'SetReminder' },
  { patterns: [/任务|待办|TODO|todo/i], hint: '用户需要管理任务', tool: 'LarkCreateTask' },
  { patterns: [/提交.*审批|发起.*审批|申请.*报销|approve.*request/i], hint: '用户需要提交审批申请，请使用 WeComSubmitApproval 工具', tool: 'WeComSubmitApproval' },
  { patterns: [/客户.*列表|外部联系人|客户.*查询|external.*contact/i], hint: '用户需要查询外部联系人信息，请使用 WeComExternalContactList 或 WeComExternalContactGet 工具', tool: 'WeComExternalContactList' },
  { patterns: [/预约.*会议|创建.*会议|开会|schedule.*meeting/i], hint: '明确的企微在线会议诉求（拉会/发会议邀请）→ WeComCreateMeeting；只是「明天上午10点开会」这类日程安排 → CreateCalendarEvent 建日程（默认带提醒），不要调用 WeComCreateMeeting。', tool: 'WeComCreateMeeting' },
];

// 渠道工具排除表：某渠道下不可用的工具
const CHANNEL_TOOL_EXCLUSIONS = {
  wecom: [
    'LarkCreateDoc', 'LarkReadDoc', 'LarkUpdateDoc', 'LarkSearchDoc',
    'LarkCreateSheet', 'LarkReadSheet', 'LarkUpdateSheet',
    'LarkCreateBase', 'LarkReadBase', 'LarkUpdateBase',
    'LarkSendMessage', 'LarkSearchMessage',
    'LarkCreateApproval', 'LarkQueryApproval',
    'LarkUploadFile', 'LarkDownloadFile'
  ],
  lark: [
    'WeComSendMessage', 'WeComCreateTask'
  ],
  // 2026-08-06: GUI 语音场景禁用 Bash——语音无法点击审批,Bash 执行必然
  // 审批超时失败(实测24次连续失败),拖慢回复。引导模型用 WebFetch/WebExtract 解析。
  gui: [
    'Bash'
  ],
};

/**
 * 检测消息意图，返回给 LLM 的提示词列表
 * @param {string} message - 用户消息
 * @param {string} [channel] - 渠道（lark/wecom/cli/none）
 * @returns {string[]} 提示词列表
 */
function detectMessageIntent(message, channel) {
  const hints = [];
  for (const intent of INTENT_PATTERNS) {
    const matched = intent.patterns.some(p => p.test(message));
    if (!matched) continue;
    if (intent.tool && channel) {
      const exclusions = CHANNEL_TOOL_EXCLUSIONS[channel] || [];
      if (exclusions.includes(intent.tool)) {
        if (channel === 'wecom') {
          hints.push(intent.hint.replace(/请使用.*$/, '当前企业微信通道暂不支持此功能，请直接回答用户问题'));
        }
        continue;
      }
    }
    hints.push(intent.hint);
  }
  return hints;
}

/**
 * 根据渠道过滤工具列表
 * @param {Array} tools - 工具定义数组
 * @param {string} [channel] - 渠道
 * @returns {Array} 过滤后的工具数组
 */
function filterToolsByChannel(tools, channel) {
  if (!channel || channel === 'none') return tools;
  const exclusions = CHANNEL_TOOL_EXCLUSIONS[channel] || [];
  if (exclusions.length === 0) return tools;
  return tools.filter(tool => !exclusions.includes(tool.name));
}

module.exports = {
  INTENT_PATTERNS,
  CHANNEL_TOOL_EXCLUSIONS,
  detectMessageIntent,
  filterToolsByChannel,
};
