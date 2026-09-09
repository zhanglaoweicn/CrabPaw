import { matchPanelCommand, stripCommandPrefix, extractSongQuery, detectMeetingCommand, detectExpertSummonCommand, detectExpertMeetingConfirmation } from './voice-panel-commands'

describe('matchPanelCommand (P5.5 语音面板命令)', () => {
  test('打开任务面板', () => {
    expect(matchPanelCommand('打开任务面板')).toEqual({ kind: 'task_panel', action: 'open' })
  })
  test('变体: 任务面板', () => {
    expect(matchPanelCommand('任务面板')).toEqual({ kind: 'task_panel', action: 'open' })
  })
  test('关闭任务面板', () => {
    expect(matchPanelCommand('关闭任务面板')).toEqual({ kind: 'task_panel', action: 'close' })
  })
  test('收起任务面板 变体', () => {
    expect(matchPanelCommand('收起任务面板')).toEqual({ kind: 'task_panel', action: 'close' })
  })
  test('打开资讯 / 打开新闻', () => {
    expect(matchPanelCommand('打开资讯')).toEqual({ kind: 'news', action: 'open' })
    expect(matchPanelCommand('打开新闻')).toEqual({ kind: 'news', action: 'open' })
  })
  test('关闭资讯', () => {
    expect(matchPanelCommand('关闭资讯')).toEqual({ kind: 'news', action: 'close' })
  })
  test('打开会议 / 会议面板 → 历史列表（target history）', () => {
    expect(matchPanelCommand('打开会议')).toEqual({ kind: 'meeting_recording', action: 'open', target: 'history' })
    expect(matchPanelCommand('会议面板')).toEqual({ kind: 'meeting_recording', action: 'open', target: 'history' })
    expect(matchPanelCommand('打开会议记录')).toEqual({ kind: 'meeting_recording', action: 'open', target: 'history' })
    expect(matchPanelCommand('会议纪要')).toEqual({ kind: 'meeting_recording', action: 'open', target: 'history' })
  })
  test('查看类措辞 → 历史列表（2026-09-01 R1: 此前落 LLM 被 meeting_mode show 误建空会议）', () => {
    expect(matchPanelCommand('查看会议纪要')).toEqual({ kind: 'meeting_recording', action: 'open', target: 'history' })
    expect(matchPanelCommand('看看纪要')).toEqual({ kind: 'meeting_recording', action: 'open', target: 'history' })
    expect(matchPanelCommand('翻一下这些记录')).toEqual({ kind: 'meeting_recording', action: 'open', target: 'history' })
    expect(matchPanelCommand('查看会议记录')).toEqual({ kind: 'meeting_recording', action: 'open', target: 'history' })
    expect(matchPanelCommand('看看这些会议纪要')).toEqual({ kind: 'meeting_recording', action: 'open', target: 'history' })
  })
  test('开始记录 / 记录一下 / 开始录音 → 录音（target start）', () => {
    expect(matchPanelCommand('开始记录')).toEqual({ kind: 'meeting_recording', action: 'open', target: 'start' })
    expect(matchPanelCommand('记录一下')).toEqual({ kind: 'meeting_recording', action: 'open', target: 'start' })
    expect(matchPanelCommand('开始录音')).toEqual({ kind: 'meeting_recording', action: 'open', target: 'start' })
    expect(matchPanelCommand('会议记录一下')).toEqual({ kind: 'meeting_recording', action: 'open', target: 'start' })
    expect(matchPanelCommand('开始会议录音')).toEqual({ kind: 'meeting_recording', action: 'open', target: 'start' })
    expect(matchPanelCommand('开启录音')).toEqual({ kind: 'meeting_recording', action: 'open', target: 'start' })
    // 2026-08-19: 「纪要」开录措辞——必须带开始/开启前缀,裸「会议纪要」仍走 history
    expect(matchPanelCommand('开始会议纪要')).toEqual({ kind: 'meeting_recording', action: 'open', target: 'start' })
    expect(matchPanelCommand('开启会议纪要')).toEqual({ kind: 'meeting_recording', action: 'open', target: 'start' })
    expect(matchPanelCommand('开始纪要')).toEqual({ kind: 'meeting_recording', action: 'open', target: 'start' })
    expect(matchPanelCommand('会议纪要')).toEqual({ kind: 'meeting_recording', action: 'open', target: 'history' })
    expect(matchPanelCommand('开始做饭')).toBeNull()
  })
  test('结束记录 / 停止记录 → 停止并总结（target stop）', () => {
    expect(matchPanelCommand('结束记录')).toEqual({ kind: 'meeting_recording', action: 'close', target: 'stop' })
    expect(matchPanelCommand('停止记录')).toEqual({ kind: 'meeting_recording', action: 'close', target: 'stop' })
    expect(matchPanelCommand('停止录音')).toEqual({ kind: 'meeting_recording', action: 'close', target: 'stop' })
    expect(matchPanelCommand('结束会议记录')).toEqual({ kind: 'meeting_recording', action: 'close', target: 'stop' })
    expect(matchPanelCommand('结束会议纪要')).toEqual({ kind: 'meeting_recording', action: 'close', target: 'stop' })
    expect(matchPanelCommand('停止纪要')).toEqual({ kind: 'meeting_recording', action: 'close', target: 'stop' })
  })
  test('扩展停止词（2026-08-25 用户反馈：会议结束/结束会议/录制结束等口语）', () => {
    expect(matchPanelCommand('会议结束')).toEqual({ kind: 'meeting_recording', action: 'close', target: 'stop' })
    expect(matchPanelCommand('结束会议')).toEqual({ kind: 'meeting_recording', action: 'close', target: 'stop' })
    expect(matchPanelCommand('录制结束')).toEqual({ kind: 'meeting_recording', action: 'close', target: 'stop' })
    expect(matchPanelCommand('停止会议')).toEqual({ kind: 'meeting_recording', action: 'close', target: 'stop' })
    expect(matchPanelCommand('关闭会议记录')).toEqual({ kind: 'meeting_recording', action: 'close', target: 'stop' })
  })
  test('detectMeetingCommand 替代 isMeetingStopPhrase（词表扩展+尾分句语义对齐）', () => {
    // 旧 isMeetingStopPhrase 的正例仍可通过 matchPanelCommand 会议 stop 规则命中
    expect(matchPanelCommand('结束记录')).toEqual({ kind: 'meeting_recording', action: 'close', target: 'stop' })
    expect(matchPanelCommand('会议结束')).toEqual({ kind: 'meeting_recording', action: 'close', target: 'stop' })
    expect(matchPanelCommand('结束会议')).toEqual({ kind: 'meeting_recording', action: 'close', target: 'stop' })
    expect(matchPanelCommand('录制结束')).toEqual({ kind: 'meeting_recording', action: 'close', target: 'stop' })
    // 长句/非命令语义不误杀
    expect(matchPanelCommand('这个项目我们下个月要结束会议讨论')).toBeNull()
  })

  test('关闭会议面板 → 面板关闭（无 target）', () => {
    expect(matchPanelCommand('关闭会议面板')).toEqual({ kind: 'meeting_recording', action: 'close' })
    expect(matchPanelCommand('把会议面板关了')).toEqual({ kind: 'meeting_recording', action: 'close' })
  })
  test('音乐面板开/关', () => {
    expect(matchPanelCommand('打开音乐')).toEqual({ kind: 'music', action: 'open' })
    expect(matchPanelCommand('关闭音乐')).toEqual({ kind: 'music', action: 'close' })
  })
  test('暂停音乐 命中 music pause（2026-08-15: 暂停保留面板,不关面板）', () => {
    expect(matchPanelCommand('暂停音乐')).toEqual({ kind: 'music', action: 'pause' })
    expect(matchPanelCommand('暂停播放')).toEqual({ kind: 'music', action: 'pause' })
    expect(matchPanelCommand('暂停')).toEqual({ kind: 'music', action: 'pause' })
    expect(matchPanelCommand('停一下')).toEqual({ kind: 'music', action: 'pause' })
    // "停止音乐"仍走 close——暂停规则不抢 stop 类动词
    expect(matchPanelCommand('停止音乐')).toEqual({ kind: 'music', action: 'close' })
    // "请暂停音乐"经 stripCommandPrefix 归一后命中（文本链路同款）
    expect(matchPanelCommand(stripCommandPrefix('请暂停音乐'))).toEqual({ kind: 'music', action: 'pause' })
  })
  test('通用关闭面板', () => {
    expect(matchPanelCommand('关闭面板')).toEqual({ kind: '*', action: 'close' })
  })
  test('无关文本不拦截', () => {
    expect(matchPanelCommand('帮我订明天上午的会议')).toBeNull()
    expect(matchPanelCommand('今天天气怎么样')).toBeNull()
  })
  test('关闭音乐 快速拦截兼容（命中 music close）', () => {
    expect(matchPanelCommand('关掉音乐')).toEqual({ kind: 'music', action: 'close' })
  })
  test('台风卡片变体（2026-08-25: "打开台风卡片"此前落 LLM 被错开后股票卡）', () => {
    expect(matchPanelCommand('打开台风卡片')).toEqual({ kind: 'typhoon', action: 'open' })
    expect(matchPanelCommand('打开台风')).toEqual({ kind: 'typhoon', action: 'open' })
    expect(matchPanelCommand('打开台风面板')).toEqual({ kind: 'typhoon', action: 'open' })
    expect(matchPanelCommand('台风')).toEqual({ kind: 'typhoon', action: 'open' })
    expect(matchPanelCommand('关闭台风卡片')).toEqual({ kind: 'typhoon', action: 'close' })
  })
  test('媒体/视频面板开/关（2026-08-16 补"视频/视频卡片"变体——此前"关闭视频"落 LLM）', () => {
    expect(matchPanelCommand('打开媒体')).toEqual({ kind: 'media', action: 'open' })
    expect(matchPanelCommand('打开视频面板')).toEqual({ kind: 'media', action: 'open' })
    expect(matchPanelCommand('关闭媒体')).toEqual({ kind: 'media', action: 'close' })
    expect(matchPanelCommand('关闭视频')).toEqual({ kind: 'media', action: 'close' })
    expect(matchPanelCommand('关闭视频面板')).toEqual({ kind: 'media', action: 'close' })
    expect(matchPanelCommand('关闭视频卡片')).toEqual({ kind: 'media', action: 'close' })
    expect(matchPanelCommand('收起视频卡')).toEqual({ kind: 'media', action: 'close' })
    expect(matchPanelCommand('隐藏媒体面板')).toEqual({ kind: 'media', action: 'close' })
  })
  test('播放歌曲/播首歌 命中 music open（R7 补变体）', () => {
    expect(matchPanelCommand('播放歌曲')).toEqual({ kind: 'music', action: 'open' })
    expect(matchPanelCommand('播首歌')).toEqual({ kind: 'music', action: 'open' })
    expect(matchPanelCommand('听首歌')).toEqual({ kind: 'music', action: 'open' })
  })
  test('带歌名播放请求命中 music open（R8）', () => {
    expect(matchPanelCommand('播放周杰伦的歌')).toEqual({ kind: 'music', action: 'open' })
    expect(matchPanelCommand('听周杰伦的歌')).toEqual({ kind: 'music', action: 'open' })
    expect(matchPanelCommand('来点周杰伦的歌')).toEqual({ kind: 'music', action: 'open' })
  })
  test('天气面板开/关（P5.5 补：weather 独立组件）', () => {
    expect(matchPanelCommand('打开天气')).toEqual({ kind: 'weather', action: 'open' })
    expect(matchPanelCommand('天气面板')).toEqual({ kind: 'weather', action: 'open' })
    expect(matchPanelCommand('打开天气预报')).toEqual({ kind: 'weather', action: 'open' })
    expect(matchPanelCommand('关闭天气面板')).toEqual({ kind: 'weather', action: 'close' })
    expect(matchPanelCommand('收起天气')).toEqual({ kind: 'weather', action: 'close' })
  })
  test('热点/热搜面板开/关（P5.5 补：hotspot 独立组件）', () => {
    expect(matchPanelCommand('打开热点')).toEqual({ kind: 'hotspot', action: 'open' })
    expect(matchPanelCommand('热搜')).toEqual({ kind: 'hotspot', action: 'open' })
    expect(matchPanelCommand('打开热搜榜')).toEqual({ kind: 'hotspot', action: 'open' })
    expect(matchPanelCommand('关闭热点面板')).toEqual({ kind: 'hotspot', action: 'close' })
    expect(matchPanelCommand('收起热搜')).toEqual({ kind: 'hotspot', action: 'close' })
  })
  test('天气提问类文本不误伤（非开关命令）', () => {
    expect(matchPanelCommand('今天天气怎么样')).toBeNull()
    expect(matchPanelCommand('上海天气')).toBeNull()
    expect(matchPanelCommand('帮我看看北京天气')).toBeNull()
  })
  test('文件面板关闭（2026-08-17: doc 规则迁移为 filegen）', () => {
    expect(matchPanelCommand('关闭文件面板')).toEqual({ kind: 'filegen', action: 'close' })
    expect(matchPanelCommand('关闭文件生成面板')).toEqual({ kind: 'filegen', action: 'close' })
    expect(matchPanelCommand('关闭文档面板')).toEqual({ kind: 'filegen', action: 'close' })
    expect(matchPanelCommand('关闭文档阅读器')).toEqual({ kind: 'filegen', action: 'close' })
    expect(matchPanelCommand('关闭文档生成舱')).toEqual({ kind: 'filegen', action: 'close' })
    expect(matchPanelCommand('关闭生成舱')).toEqual({ kind: 'filegen', action: 'close' })
    expect(matchPanelCommand('收起文档舱')).toEqual({ kind: 'filegen', action: 'close' })
    expect(matchPanelCommand('关掉文件面板')).toEqual({ kind: 'filegen', action: 'close' })
    expect(matchPanelCommand('关掉文档卡片')).toEqual({ kind: 'filegen', action: 'close' })
    expect(matchPanelCommand('把文档面板关掉')).toEqual({ kind: 'filegen', action: 'close' })
    expect(matchPanelCommand('把文档卡片关了')).toEqual({ kind: 'filegen', action: 'close' })
    // 旧 doc 规则退役:裸"文档"不再命中面板 close（落 LLM 由工具链路处理）
    expect(matchPanelCommand('关闭文档')).toBeNull()
    expect(matchPanelCommand('把文档关掉')).toBeNull()
  })
  test('文件面板打开（2026-08-17: 替代生成舱 open 变体）', () => {
    expect(matchPanelCommand('打开文件面板')).toEqual({ kind: 'filegen', action: 'open' })
    expect(matchPanelCommand('打开文件生成面板')).toEqual({ kind: 'filegen', action: 'open' })
    expect(matchPanelCommand('打开文档面板')).toEqual({ kind: 'filegen', action: 'open' })
    expect(matchPanelCommand('打开文档生成舱')).toEqual({ kind: 'filegen', action: 'open' })
    expect(matchPanelCommand('打开文档舱')).toEqual({ kind: 'filegen', action: 'open' })
    expect(matchPanelCommand('新建文档面板')).toEqual({ kind: 'filegen', action: 'open' })
    expect(matchPanelCommand('打开文档卡片')).toEqual({ kind: 'filegen', action: 'open' })
    expect(matchPanelCommand('把文件面板打开')).toEqual({ kind: 'filegen', action: 'open' })
    expect(matchPanelCommand('将文档面板调出来')).toEqual({ kind: 'filegen', action: 'open' })
  })
  test('转成 WORD 命中 filegen convert（打开面板,转换在面板内完成）', () => {
    expect(matchPanelCommand('转成Word')).toEqual({ kind: 'filegen', action: 'convert' })
    expect(matchPanelCommand('转成WORD')).toEqual({ kind: 'filegen', action: 'convert' })
    expect(matchPanelCommand('转成word文档')).toEqual({ kind: 'filegen', action: 'convert' })
    expect(matchPanelCommand('转换成Word')).toEqual({ kind: 'filegen', action: 'convert' })
    expect(matchPanelCommand('导出为文档')).toEqual({ kind: 'filegen', action: 'convert' })
    expect(matchPanelCommand('保存成word文档')).toEqual({ kind: 'filegen', action: 'convert' })
    expect(matchPanelCommand('把文档转成Word')).toEqual({ kind: 'filegen', action: 'convert' })
    expect(matchPanelCommand('将这份文档转换成word')).toEqual({ kind: 'filegen', action: 'convert' })
  })
  test('转成 HTML 命中 filegen convert（2026-08-22 补——此前落 LLM 走工具链,失败不可见）', () => {
    expect(matchPanelCommand('转成HTML')).toEqual({ kind: 'filegen', action: 'convert' })
    expect(matchPanelCommand('转成html')).toEqual({ kind: 'filegen', action: 'convert' })
    expect(matchPanelCommand('转成网页')).toEqual({ kind: 'filegen', action: 'convert' })
    expect(matchPanelCommand('转换成网页文件')).toEqual({ kind: 'filegen', action: 'convert' })
    expect(matchPanelCommand('把文档转成HTML')).toEqual({ kind: 'filegen', action: 'convert' })
    expect(matchPanelCommand('把这份文档转换成网页')).toEqual({ kind: 'filegen', action: 'convert' })
    // 负例:非转换语义不命中
    expect(matchPanelCommand('转成PDF')).toBeNull()
  })
  test('文档相关提问不误伤（非开关命令）', () => {
    expect(matchPanelCommand('帮我生成一份文档')).toBeNull()
    expect(matchPanelCommand('文档写好了吗')).toBeNull()
  })
  test('技能卡关闭（2026-08-04 补:SkillStageHost）', () => {
    expect(matchPanelCommand('关闭技能卡')).toEqual({ kind: 'skill', action: 'close' })
    expect(matchPanelCommand('收起技能面板')).toEqual({ kind: 'skill', action: 'close' })
    expect(matchPanelCommand('关掉技能卡')).toEqual({ kind: 'skill', action: 'close' })
    expect(matchPanelCommand('技能卡关了')).toEqual({ kind: 'skill', action: 'close' })
  })
  test('技能相关提问不误伤', () => {
    expect(matchPanelCommand('帮我生成一份网页')).toBeNull()
    expect(matchPanelCommand('使用技能生成报告')).toBeNull()
  })
})

// 2026-09-01: 2026-09-01 实机日志样本回放（data/.crabpaw/crabpaw.log 08:25-08:26）——
// 用户连说 6 种停止说法全部无效的根因样本, 必须全命中且保留真实内容
const WAKE = ['小龙女', '小螃蟹']

describe('detectMeetingCommand：裸词通道（尾分句+防抖）', () => {
  const base = { final: false, stableMs: 900, wakeWords: WAKE }

  test('实机样本: 累积尾段命中停止词且剔除指令保留内容', () => {
    const hit = detectMeetingCommand('是 OPC，OPC 适合的人群以及所面临的问题。结束记录', base)
    expect(hit).not.toBeNull()
    expect(hit!.command).toBe('stop')
    expect(hit!.matched).toBe('结束记录')
    expect(hit!.cleanedText).toBe('是 OPC，OPC 适合的人群以及所面临的问题')
  })

  test('实机样本: 尾分句「关闭会议」命中', () => {
    const hit = detectMeetingCommand('是 OPC，OPC 适合的人群以及所面临的问题。结束，关闭会议', base)
    expect(hit!.command).toBe('stop')
    expect(hit!.cleanedText).toBe('是 OPC，OPC 适合的人群以及所面临的问题。结束')
  })

  test('裸「结束/结束了/关闭/停止」短句命中（8-31 补的词表语义不回退）', () => {
    expect(detectMeetingCommand('结束', base)!.command).toBe('stop')
    expect(detectMeetingCommand('结束了', base)!.command).toBe('stop')
    expect(detectMeetingCommand('关闭', base)!.command).toBe('stop')
    expect(detectMeetingCommand('停止', base)!.command).toBe('stop')
    expect(detectMeetingCommand('会议结束了。', base)!.cleanedText).toBe('')
  })

  test('新增词形: 「记录结束」命中（ASR 把「录制结束」转成「记录结束」）', () => {
    expect(detectMeetingCommand('记录结束', base)!.command).toBe('stop')
  })

  test('不稳定且非 final 的裸词不触发（防抖）', () => {
    expect(detectMeetingCommand('结束', { ...base, stableMs: 100 })).toBeNull()
  })

  test('final 帧裸词立即触发（不等防抖）', () => {
    expect(detectMeetingCommand('结束', { ...base, stableMs: 0, final: true })!.command).toBe('stop')
  })

  test('长句中的停止词不误杀（「下个月要结束会议讨论」）', () => {
    expect(detectMeetingCommand('这个项目我们下个月要结束会议讨论', base)).toBeNull()
  })

  test('尾分句超 6 字不触发裸词通道', () => {
    expect(detectMeetingCommand('好那今天就到这里我们下周再继续', base)).toBeNull()
  })
})

describe('detectMeetingCommand：唤醒词通道（即时、无长度限制）', () => {
  const base = { final: false, stableMs: 0, wakeWords: WAKE }

  test('唤醒词+逗号分隔: 「小龙女，结束记录」即时命中', () => {
    const hit = detectMeetingCommand('我们刚才说的第一点。小龙女，结束记录', base)
    expect(hit!.command).toBe('stop')
    expect(hit!.cleanedText).toBe('我们刚才说的第一点。')
  })

  test('唤醒词连读无标点: 「小龙女结束记录」即时命中', () => {
    expect(detectMeetingCommand('小龙女结束记录', base)!.command).toBe('stop')
  })

  test('唤醒词通道无视防抖（stableMs=0 也命中）', () => {
    expect(detectMeetingCommand('小龙女，结束记录', base)).not.toBeNull()
  })

  test('书签指令命中 bookmark 通道', () => {
    expect(detectMeetingCommand('小龙女，标记重点', base)!.command).toBe('bookmark')
    expect(detectMeetingCommand('小龙女，标记重点', base)!.cleanedText).toBe('')
    expect(detectMeetingCommand('小龙女，划重点', base)!.command).toBe('bookmark')
  })

  test('唤醒词后非指令不误触发', () => {
    expect(detectMeetingCommand('小龙女同学的问题是什么', base)).toBeNull()
  })

  test('书签不走裸词通道（防误触发）', () => {
    expect(detectMeetingCommand('标记重点', { ...base, stableMs: 900 })).toBeNull()
  })
})

describe('detectMeetingCommand：边界', () => {
  test('空文本/null 安全', () => {
    expect(detectMeetingCommand('', { final: true, stableMs: 0, wakeWords: [] })).toBeNull()
  })

  test('纯标点/空白安全', () => {
    expect(detectMeetingCommand('。，！ ', { final: true, stableMs: 0, wakeWords: [] })).toBeNull()
  })

  test('cleanedText 去除指令后不含尾随空白', () => {
    const hit = detectMeetingCommand('讨论结束。 结束记录', { final: true, stableMs: 0, wakeWords: [] })
    expect(hit!.cleanedText).toBe('讨论结束。')
  })
})

describe('管理舱命令（阶段 B）', () => {
  test('打开管理舱/系统管理 → settings tab', () => {
    expect(matchPanelCommand('打开管理舱')).toEqual({ kind: 'management_cockpit', action: 'open', target: 'settings' })
    expect(matchPanelCommand('系统管理')).toEqual({ kind: 'management_cockpit', action: 'open', target: 'settings' })
  })
  test('系统设置 → settings tab', () => {
    expect(matchPanelCommand('打开系统设置')).toEqual({ kind: 'management_cockpit', action: 'open', target: 'settings' })
  })
  test('去配置模型/模型配置 → target model', () => {
    expect(matchPanelCommand('去配置模型')).toEqual({ kind: 'management_cockpit', action: 'open', target: 'model' })
    expect(matchPanelCommand('打开模型配置')).toEqual({ kind: 'management_cockpit', action: 'open', target: 'model' })
  })
  test('MCP 设置 → target mcp', () => {
    expect(matchPanelCommand('打开MCP设置')).toEqual({ kind: 'management_cockpit', action: 'open', target: 'mcp' })
  })
  test('打开插件 → target plugin', () => {
    expect(matchPanelCommand('打开插件管理')).toEqual({ kind: 'management_cockpit', action: 'open', target: 'plugin' })
    expect(matchPanelCommand('插件管理')).toEqual({ kind: 'management_cockpit', action: 'open', target: 'plugin' })
  })
  test('技能 → target skills（2026-08-21 改名：技能仓库/技能管理旧词兼容）', () => {
    expect(matchPanelCommand('打开技能')).toEqual({ kind: 'management_cockpit', action: 'open', target: 'skills' })
    expect(matchPanelCommand('技能')).toEqual({ kind: 'management_cockpit', action: 'open', target: 'skills' })
    expect(matchPanelCommand('打开技能仓库')).toEqual({ kind: 'management_cockpit', action: 'open', target: 'skills' })
    expect(matchPanelCommand('技能仓库')).toEqual({ kind: 'management_cockpit', action: 'open', target: 'skills' })
  })
  test('用量统计 → target cost', () => {
    expect(matchPanelCommand('打开用量')).toEqual({ kind: 'management_cockpit', action: 'open', target: 'cost' })
  })
  test('日志/状态/网关/记忆 → dev targets', () => {
    expect(matchPanelCommand('打开日志')).toEqual({ kind: 'management_cockpit', action: 'open', target: 'logs' })
    expect(matchPanelCommand('打开系统状态')).toEqual({ kind: 'management_cockpit', action: 'open', target: 'status' })
    expect(matchPanelCommand('打开网关')).toEqual({ kind: 'management_cockpit', action: 'open', target: 'gateway' })
    expect(matchPanelCommand('打开记忆图谱')).toEqual({ kind: 'management_cockpit', action: 'open', target: 'memory' })
  })
  test('关闭管理舱', () => {
    expect(matchPanelCommand('关闭管理舱')).toEqual({ kind: 'management_cockpit', action: 'close' })
    expect(matchPanelCommand('收起管理舱')).toEqual({ kind: 'management_cockpit', action: 'close' })
  })
  test('日常管理类提问不误伤', () => {
    expect(matchPanelCommand('帮我管理一下任务')).toBeNull()
    expect(matchPanelCommand('模型是什么')).toBeNull()
    expect(matchPanelCommand('插件的原理')).toBeNull()
  })
})

describe('业务面板退役后语音路由（2026-08-19 阶段 C + 2026-08-21 专家·数据拆分）', () => {
  test('专家/专家列表/专家面板 → 管理舱 expert tab（2026-08-21 拆分）', () => {
    expect(matchPanelCommand('打开专家')).toEqual({ kind: 'management_cockpit', action: 'open', target: 'expert' })
    expect(matchPanelCommand('专家列表')).toEqual({ kind: 'management_cockpit', action: 'open', target: 'expert' })
    expect(matchPanelCommand('专家面板')).toEqual({ kind: 'management_cockpit', action: 'open', target: 'expert' })
  })
  test('数据页删除后：打开数据/经营数据 不再命中本地规则 → 落 LLM（2026-08-21 数据 tab 整体删除）', () => {
    expect(matchPanelCommand('打开数据')).toBeNull()
    expect(matchPanelCommand('打开经营数据')).toBeNull()
    expect(matchPanelCommand('打开数据库')).toBeNull()
    expect(matchPanelCommand('营收')).toBeNull()
  })
  test('关闭专家/专家面板 → 管理舱 close；经营数据/数据库关闭词已删（2026-08-27 无打开路径）→ 落 LLM', () => {
    expect(matchPanelCommand('关闭专家')).toEqual({ kind: 'management_cockpit', action: 'close' })
    expect(matchPanelCommand('关闭专家面板')).toEqual({ kind: 'management_cockpit', action: 'close' })
    expect(matchPanelCommand('关闭经营数据')).toBeNull()
    expect(matchPanelCommand('关闭数据库')).toBeNull()
  })
  test('业务面板/文件浏览器/持仓 不再命中本地规则 → 落 LLM', () => {
    expect(matchPanelCommand('打开业务面板')).toBeNull()
    expect(matchPanelCommand('关闭业务面板')).toBeNull()
    expect(matchPanelCommand('打开文件')).toBeNull()
    expect(matchPanelCommand('打开文件浏览器')).toBeNull()
    expect(matchPanelCommand('打开持仓')).toBeNull()
  })
  test('日程卡片（2026-08-19: 日程/日历升级为 SchedulePanel 卡片）', () => {
    expect(matchPanelCommand('打开日程')).toEqual({ kind: 'schedule', action: 'open' })
    expect(matchPanelCommand('日程')).toEqual({ kind: 'schedule', action: 'open' })
    expect(matchPanelCommand('日历')).toEqual({ kind: 'schedule', action: 'open' })
    expect(matchPanelCommand('日程安排')).toEqual({ kind: 'schedule', action: 'open' })
    expect(matchPanelCommand('打开日程卡片')).toEqual({ kind: 'schedule', action: 'open' })
    expect(matchPanelCommand('查看日历卡片')).toEqual({ kind: 'schedule', action: 'open' })
    expect(matchPanelCommand('今天有什么日程')).toEqual({ kind: 'schedule', action: 'open' })
    expect(matchPanelCommand('今天的日程')).toEqual({ kind: 'schedule', action: 'open' })
    // 首页 chip 直达（2026-08-19: 查询语义, 不能落 LLM 被误判为创建意图）
    expect(matchPanelCommand('我的近期日程')).toEqual({ kind: 'schedule', action: 'open' })
    expect(matchPanelCommand('我的日程')).toEqual({ kind: 'schedule', action: 'open' })
    expect(matchPanelCommand('关闭日程')).toEqual({ kind: 'schedule', action: 'close' })
    expect(matchPanelCommand('关闭日历')).toEqual({ kind: 'schedule', action: 'close' })
    expect(matchPanelCommand('把日程关了')).toEqual({ kind: 'schedule', action: 'close' })
    expect(matchPanelCommand('日程卡片关掉')).toEqual({ kind: 'schedule', action: 'close' })
    // 非命令形态不拦截（落 LLM 走 /api/calendar 或日程创建链路）
    expect(matchPanelCommand('帮我安排日程')).toBeNull()
    expect(matchPanelCommand('明天下午3点开会')).toBeNull()
  })
  test('知识库面板（2026-08-20: KnowledgePanel 卡片, 数据走 /api/kb/*）', () => {
    expect(matchPanelCommand('打开知识库')).toEqual({ kind: 'knowledge', action: 'open' })
    expect(matchPanelCommand('知识库')).toEqual({ kind: 'knowledge', action: 'open' })
    expect(matchPanelCommand('查看知识库面板')).toEqual({ kind: 'knowledge', action: 'open' })
    expect(matchPanelCommand('显示知识库卡片')).toEqual({ kind: 'knowledge', action: 'open' })
    expect(matchPanelCommand('打开文档库')).toEqual({ kind: 'knowledge', action: 'open' })
    expect(matchPanelCommand('知识库里有什么')).toEqual({ kind: 'knowledge', action: 'open' })
    expect(matchPanelCommand('关闭知识库')).toEqual({ kind: 'knowledge', action: 'close' })
    expect(matchPanelCommand('关掉知识库面板')).toEqual({ kind: 'knowledge', action: 'close' })
    expect(matchPanelCommand('把知识库关了')).toEqual({ kind: 'knowledge', action: 'close' })
    expect(matchPanelCommand('知识库关掉')).toEqual({ kind: 'knowledge', action: 'close' })
    // 内容问题不拦截——落 LLM 走 kb_query 意图 → KbSearch 文本回答（弹卡守卫）
    expect(matchPanelCommand('知识库里之前分析的合同里金额是多少')).toBeNull()
    expect(matchPanelCommand('查一下知识库中的文档')).toBeNull()
    expect(matchPanelCommand('帮我搜知识库')).toBeNull()
  })
  test('日常业务类提问不误伤', () => {
    expect(matchPanelCommand('帮我安排日程')).toBeNull()
    expect(matchPanelCommand('这个文件很大')).toBeNull()
    expect(matchPanelCommand('专家你好')).toBeNull()
  })
})

describe('通用"收起/关闭卡片"规则（2026-08-12 P1 缺陷 2 修复）', () => {
  test('裸"卡片"不再被 doc close 规则劫持——命中独立 scene-card kind', () => {
    expect(matchPanelCommand('收起卡片')).toEqual({ kind: 'scene-card', action: 'close' })
    expect(matchPanelCommand('关闭卡片')).toEqual({ kind: 'scene-card', action: 'close' })
    expect(matchPanelCommand('隐藏卡片')).toEqual({ kind: 'scene-card', action: 'close' })
    expect(matchPanelCommand('收起这张卡片')).toEqual({ kind: 'scene-card', action: 'close' })
    expect(matchPanelCommand('关闭这张场景卡片')).toEqual({ kind: 'scene-card', action: 'close' })
  })
  test('口语变体命中 scene-card close', () => {
    expect(matchPanelCommand('把这张卡片关掉')).toEqual({ kind: 'scene-card', action: 'close' })
    expect(matchPanelCommand('把场景卡片收起来')).toEqual({ kind: 'scene-card', action: 'close' })
    expect(matchPanelCommand('这张卡片关了')).toEqual({ kind: 'scene-card', action: 'close' })
    expect(matchPanelCommand('卡片关了')).toEqual({ kind: 'scene-card', action: 'close' })
  })
  test('具体名词卡片不被通用规则抢走（filegen/document/skill 仍优先）', () => {
    expect(matchPanelCommand('关闭文档卡片')).toEqual({ kind: 'filegen', action: 'close' })
    expect(matchPanelCommand('关闭文章卡片')).toEqual({ kind: 'document', action: 'close' })
    expect(matchPanelCommand('关闭技能卡片')).toEqual({ kind: 'skill', action: 'close' })
  })
  test('"打开卡片"不误开文件面板（filegen open 规则同样去掉裸卡片）', () => {
    expect(matchPanelCommand('打开卡片')).toBeNull()
    expect(matchPanelCommand('打开文档卡片')).toEqual({ kind: 'filegen', action: 'open' })
  })
})

describe('关闭股票/经营数据（2026-08-19 业务面板退役后路由）', () => {
  test('close 规则与 open 对称', () => {
    // 2026-08-14 变更: "打开/关闭股票"改路由到新股票行情面板（stock kind,
    // ShowStock surface 'stock-panel'）；2026-08-19: 业务面板退役——持仓不再
    // 命中本地规则(落 LLM 走股票工具)；2026-08-21: 数据 tab 删除——「打开经营数据」落 LLM；
    // 2026-08-27: 「关闭经营数据/数据库」关闭词随 data tab 一并删除 → 落 LLM
    expect(matchPanelCommand('关闭股票')).toEqual({ kind: 'stock', action: 'close' })
    expect(matchPanelCommand('关闭持仓')).toBeNull()
    expect(matchPanelCommand('关闭经营数据')).toBeNull() // 2026-08-27: data tab 无打开路径, 关闭词已删 → 落 LLM
    expect(matchPanelCommand('打开股票')).toEqual({ kind: 'stock', action: 'open' })
    expect(matchPanelCommand('打开持仓')).toBeNull()
    expect(matchPanelCommand('打开经营数据')).toBeNull()
  })
  test('通用"关闭面板"不受影响（日程已升级为 schedule 卡片）', () => {
    expect(matchPanelCommand('关闭业务面板')).toBeNull() // 业务面板已删,落 LLM
    expect(matchPanelCommand('关闭日程')).toEqual({ kind: 'schedule', action: 'close' })
    expect(matchPanelCommand('关闭面板')).toEqual({ kind: '*', action: 'close' })
  })
})

describe('股票行情面板规则（2026-08-14 新增: ShowStock surface）', () => {
  test('open 变体命中 stock kind', () => {
    expect(matchPanelCommand('打开股票')).toEqual({ kind: 'stock', action: 'open' })
    expect(matchPanelCommand('打开股票面板')).toEqual({ kind: 'stock', action: 'open' })
    expect(matchPanelCommand('打开行情')).toEqual({ kind: 'stock', action: 'open' })
    expect(matchPanelCommand('看看大盘')).toBeNull() // 非命令形态, 落 LLM 走 ShowStock
  })
  test('close 变体命中 stock kind（2026-08-19: business_panel 已退役,股票独立持有 open/close）', () => {
    expect(matchPanelCommand('关闭股票')).toEqual({ kind: 'stock', action: 'close' })
    expect(matchPanelCommand('关掉股票面板')).toEqual({ kind: 'stock', action: 'close' })
    expect(matchPanelCommand('把股市关掉')).toEqual({ kind: 'stock', action: 'close' })
    expect(matchPanelCommand('大盘关了')).toEqual({ kind: 'stock', action: 'close' })
  })
  test('持仓/我的股票 不再命中本地规则（业务面板退役,落 LLM 走股票工具）', () => {
    expect(matchPanelCommand('打开持仓')).toBeNull()
    expect(matchPanelCommand('打开我的股票')).toBeNull()
  })
})

describe('history close / contract close 规则（2026-08-15 补全）', () => {
  test('历史抽屉关闭——此前只有 open,"关闭历史"落 LLM 幻觉', () => {
    expect(matchPanelCommand('关闭历史')).toEqual({ kind: 'history', action: 'close' })
    expect(matchPanelCommand('收起历史会话')).toEqual({ kind: 'history', action: 'close' })
    expect(matchPanelCommand('把会话记录关了')).toEqual({ kind: 'history', action: 'close' })
    expect(matchPanelCommand('历史')).toEqual({ kind: 'history', action: 'open' }) // open 不受影响
  })
  test('合同卡片关闭——contract kind 此前无任何 close 规则', () => {
    expect(matchPanelCommand('关闭合同卡片')).toEqual({ kind: 'scene-card', action: 'close' })
    expect(matchPanelCommand('收起合同卡')).toEqual({ kind: 'scene-card', action: 'close' })
    expect(matchPanelCommand('把合同卡片关掉')).toEqual({ kind: 'scene-card', action: 'close' })
  })
  test('合同词不误伤其他规则', () => {
    expect(matchPanelCommand('合同')).toBeNull() // 裸词不命中, 落 LLM
  })
})

describe('stripCommandPrefix（2026-08-12 P1 缺陷 4 修复）', () => {
  test('默认唤醒词"小螃蟹"被剥离（含零分隔符连读）', () => {
    expect(stripCommandPrefix('小螃蟹打开股票')).toBe('打开股票')
    expect(stripCommandPrefix('小螃蟹，打开设置')).toBe('打开设置')
    expect(stripCommandPrefix('小螃蟹 打开设置')).toBe('打开设置')
  })
  test('其他唤醒词/称呼前缀剥离', () => {
    expect(stripCommandPrefix('小龙女打开日历')).toBe('打开日历')
    expect(stripCommandPrefix('小龙女，关闭音乐')).toBe('关闭音乐')
    expect(stripCommandPrefix('小talk，打开技能')).toBe('打开技能')
    expect(stripCommandPrefix('小托克打开技能')).toBe('打开技能')
    expect(stripCommandPrefix('crabpaw 打开设置')).toBe('打开设置')
  })
  test('问候语"嗨/你好"要求至少一个分隔符——防过度剥离普通词', () => {
    expect(stripCommandPrefix('你好，打开设置')).toBe('打开设置')
    expect(stripCommandPrefix('嗨，打开日历')).toBe('打开日历')
    expect(stripCommandPrefix('你好吗')).toBe('你好吗')
    expect(stripCommandPrefix('嗨喽')).toBe('嗨喽')
  })
  test('祈使词 请/帮我/麻烦 剥离', () => {
    expect(stripCommandPrefix('请打开设置')).toBe('打开设置')
    expect(stripCommandPrefix('帮我打开日历')).toBe('打开日历')
    expect(stripCommandPrefix('麻烦打开股票')).toBe('打开股票')
  })
  test('无前缀文本原样返回', () => {
    expect(stripCommandPrefix('打开设置')).toBe('打开设置')
    expect(stripCommandPrefix('今天天气怎么样')).toBe('今天天气怎么样')
    expect(stripCommandPrefix('帮我写一篇文章')).toBe('写一篇文章')
  })
})

describe('语音取消任务命令（2026-08-12 任务链复活 P1-5b）', () => {
  test('取消任务/停止任务/取消流程 命中 cancel_task', () => {
    expect(matchPanelCommand('取消任务')).toEqual({ kind: 'cancel_task', action: 'cancel' })
    expect(matchPanelCommand('取消这个任务')).toEqual({ kind: 'cancel_task', action: 'cancel' })
    expect(matchPanelCommand('停止任务')).toEqual({ kind: 'cancel_task', action: 'cancel' })
    expect(matchPanelCommand('取消流程')).toEqual({ kind: 'cancel_task', action: 'cancel' })
    expect(matchPanelCommand('停止工作流')).toEqual({ kind: 'cancel_task', action: 'cancel' })
  })
  test('相关说法不误伤（音乐/会议/任务面板仍归原规则）', () => {
    expect(matchPanelCommand('停止音乐')).toEqual({ kind: 'music', action: 'close' })
    expect(matchPanelCommand('取消会议')).toBeNull()
    expect(matchPanelCommand('关闭任务面板')).toEqual({ kind: 'task_panel', action: 'close' })
    expect(matchPanelCommand('帮我取消订单')).toBeNull()
    expect(matchPanelCommand('任务')).toBeNull()
  })
})

describe('场景文章/网页预览卡关闭（2026-08-12 修复）', () => {
  test('关闭网页预览 → web-preview close', () => {
    expect(matchPanelCommand('关闭网页预览')).toEqual({ kind: 'web-preview', action: 'close' })
    expect(matchPanelCommand('关掉网页卡')).toEqual({ kind: 'web-preview', action: 'close' })
    expect(matchPanelCommand('把预览卡收起来')).toEqual({ kind: 'web-preview', action: 'close' })
  })
  test('关闭文章卡片 → document close（不与 filegen 文件面板规则冲突）', () => {
    expect(matchPanelCommand('关闭文章卡片')).toEqual({ kind: 'document', action: 'close' })
    expect(matchPanelCommand('把文章卡关掉')).toEqual({ kind: 'document', action: 'close' })
    expect(matchPanelCommand('文章卡关了')).toEqual({ kind: 'document', action: 'close' })
  })
  test('生成舱命令由 filegen 文件面板承接（不与文章卡规则冲突）', () => {
    expect(matchPanelCommand('关闭文档卡片')).toEqual({ kind: 'filegen', action: 'close' })
    expect(matchPanelCommand('关闭生成舱')).toEqual({ kind: 'filegen', action: 'close' })
  })
  test('日常说法不误伤', () => {
    expect(matchPanelCommand('这篇文章写得不错')).toBeNull()
    expect(matchPanelCommand('预览一下效果')).toBeNull()
  })
})

describe('语音审批命令（2026-08-12 P2 杂项 5a）', () => {
  test('裸批准/同意/确认/允许/通过/可以 命中 approve', () => {
    expect(matchPanelCommand('批准')).toEqual({ kind: 'approval', action: 'approve' })
    expect(matchPanelCommand('同意')).toEqual({ kind: 'approval', action: 'approve' })
    expect(matchPanelCommand('确认')).toEqual({ kind: 'approval', action: 'approve' })
    expect(matchPanelCommand('允许')).toEqual({ kind: 'approval', action: 'approve' })
    expect(matchPanelCommand('通过')).toEqual({ kind: 'approval', action: 'approve' })
    expect(matchPanelCommand('可以')).toEqual({ kind: 'approval', action: 'approve' })
  })
  test('自然口语后缀（一下/吧/了吧/一下吧）命中 approve', () => {
    expect(matchPanelCommand('批准一下')).toEqual({ kind: 'approval', action: 'approve' })
    expect(matchPanelCommand('同意一下')).toEqual({ kind: 'approval', action: 'approve' })
    expect(matchPanelCommand('批准吧')).toEqual({ kind: 'approval', action: 'approve' })
    expect(matchPanelCommand('批准了吧')).toEqual({ kind: 'approval', action: 'approve' })
    expect(matchPanelCommand('同意一下吧')).toEqual({ kind: 'approval', action: 'approve' })
    expect(matchPanelCommand('通过吧')).toEqual({ kind: 'approval', action: 'approve' })
    expect(matchPanelCommand('通过一下吧')).toEqual({ kind: 'approval', action: 'approve' })
  })
  test('带请求对象的变体命中 approve', () => {
    expect(matchPanelCommand('同意这个请求')).toEqual({ kind: 'approval', action: 'approve' })
    expect(matchPanelCommand('批准这个审批')).toEqual({ kind: 'approval', action: 'approve' })
    expect(matchPanelCommand('同意这个请求吧')).toEqual({ kind: 'approval', action: 'approve' })
    expect(matchPanelCommand('批准该请求一下')).toEqual({ kind: 'approval', action: 'approve' })
  })
  test('"帮我批准一下" 经 stripCommandPrefix 归一后命中（语音链路同款）', () => {
    expect(matchPanelCommand(stripCommandPrefix('帮我批准一下'))).toEqual({ kind: 'approval', action: 'approve' })
    expect(matchPanelCommand(stripCommandPrefix('帮我批准'))).toEqual({ kind: 'approval', action: 'approve' })
    expect(matchPanelCommand(stripCommandPrefix('请同意这个请求'))).toEqual({ kind: 'approval', action: 'approve' })
    expect(matchPanelCommand(stripCommandPrefix('麻烦批准'))).toEqual({ kind: 'approval', action: 'approve' })
  })
  test('拒绝类命中 reject，日常说法不误伤', () => {
    expect(matchPanelCommand('拒绝')).toEqual({ kind: 'approval', action: 'reject' })
    expect(matchPanelCommand('不同意')).toEqual({ kind: 'approval', action: 'reject' })
    expect(matchPanelCommand('不批准')).toEqual({ kind: 'approval', action: 'reject' })
    expect(matchPanelCommand('批准是什么')).toBeNull()
    expect(matchPanelCommand('同意的理由')).toBeNull()
    expect(matchPanelCommand('通过了吗')).toBeNull()
  })
})

describe('搜索命令（2026-08-12 搜索落地 4a）', () => {
  test('帮我找 X / 找文件 / 搜索文档 / 查找资料 命中 search', () => {
    expect(matchPanelCommand('帮我找合同')).toEqual({ kind: 'search', action: 'open' })
    expect(matchPanelCommand('找文件')).toEqual({ kind: 'search', action: 'open' })
    expect(matchPanelCommand('找一下文档')).toEqual({ kind: 'search', action: 'open' })
    expect(matchPanelCommand('搜索文档')).toEqual({ kind: 'search', action: 'open' })
    expect(matchPanelCommand('查找资料')).toEqual({ kind: 'search', action: 'open' })
    expect(matchPanelCommand('搜索季度报表')).toEqual({ kind: 'search', action: 'open' })
    expect(matchPanelCommand('帮我查找上周的合同')).toEqual({ kind: 'search', action: 'open' })
  })
  test('音乐/车次类"找/搜索"不被劫持（负向先行）', () => {
    expect(matchPanelCommand('找首歌')).toBeNull()
    expect(matchPanelCommand('搜索音乐')).toBeNull()
    expect(matchPanelCommand('找车次')).toBeNull()
    expect(matchPanelCommand('查找火车票')).toBeNull()
  })
  test('裸"找/搜索"无内容不命中；"查/查一下"不误伤（留给 LLM 走对应工具）', () => {
    expect(matchPanelCommand('找')).toBeNull()
    expect(matchPanelCommand('搜索')).toBeNull()
    expect(matchPanelCommand('查一下车次')).toBeNull()
    expect(matchPanelCommand('查一下记忆')).toBeNull()
    expect(matchPanelCommand('查日志')).toBeNull()
  })
  test('既有命令不被搜索规则抢走', () => {
    expect(matchPanelCommand('打开文件')).toBeNull() // 2026-08-19: 业务面板退役,裸"打开文件"落 LLM
    expect(matchPanelCommand('查看记忆')).toEqual({ kind: 'management_cockpit', action: 'open', target: 'memory' })
    expect(matchPanelCommand('播放周杰伦的歌')).toEqual({ kind: 'music', action: 'open' })
  })
  test('stripCommandPrefix 后"帮我找"归一为"找"仍命中', () => {
    expect(matchPanelCommand(stripCommandPrefix('帮我找合同'))).toEqual({ kind: 'search', action: 'open' })
  })
})

describe('extractSongQuery (R8 歌名提取, 2026-08-15 修复)', () => {
  test('带歌名: 播放周杰伦的歌 → 周杰伦', () => {
    expect(extractSongQuery('播放周杰伦的歌')).toBe('周杰伦')
    expect(extractSongQuery('听周杰伦的歌')).toBe('周杰伦')
    expect(extractSongQuery('来点周杰伦的歌曲')).toBe('周杰伦')
    expect(extractSongQuery('放邓丽君的歌曲')).toBe('邓丽君')
  })
  test('无歌名: 放首歌 → 空 (旧实现误取"首"搜出《首饰》)', () => {
    expect(extractSongQuery('放首歌')).toBe('')
    expect(extractSongQuery('播放歌曲')).toBe('')
    expect(extractSongQuery('来点音乐')).toBe('')
    expect(extractSongQuery('听音乐')).toBe('')
    expect(extractSongQuery('放歌听')).toBe('')
  })
  test('标点剥离: 播放，周杰伦的歌 → 周杰伦', () => {
    expect(extractSongQuery('播放，周杰伦的歌')).toBe('周杰伦')
  })
  test('歌名含"歌"字: 播放好汉歌 → 好汉 (尾部"歌"被正则吃掉, 搜索仍可命中)', () => {
    expect(extractSongQuery('播放好汉歌')).toBe('好汉')
    expect(extractSongQuery('放一首好汉歌')).toBe('一首好汉')
  })
  test('无匹配文本 → 空', () => {
    expect(extractSongQuery('今天天气怎么样')).toBe('')
    expect(extractSongQuery('')).toBe('')
  })
})

describe('detectExpertSummonCommand (2026-09-04 部门化 P2 语音层)', () => {
  test('班组固定措辞: 开经营分析会 → presetId', () => {
    const hit = detectExpertSummonCommand('开经营分析会')
    expect(hit?.kind).toBe('department-meeting')
    expect(hit?.presetId).toBe('ops_review')
    expect(hit?.label).toBe('经营分析会')
  })
  test('班组变体: 给我开一个营销作战会 / 销售冲刺会召开', () => {
    expect(detectExpertSummonCommand('给我开一个营销作战会')?.presetId).toBe('marketing_war_room')
    expect(detectExpertSummonCommand('销售冲刺会召开')?.presetId).toBe('sales_push')
  })
  test('部门例会: 开法务部例会 → departmentId=legal', () => {
    const hit = detectExpertSummonCommand('开法务部例会')
    expect(hit?.kind).toBe('department-meeting')
    expect(hit?.departmentId).toBe('legal')
  })
  test('岗位/部门召唤: 叫财务来看看 → expert-summon+finance; 把小红书专家叫来', () => {
    const h1 = detectExpertSummonCommand('叫财务来看看')
    expect(h1?.kind).toBe('expert-summon')
    expect(h1?.departmentId).toBe('finance')
    const h2 = detectExpertSummonCommand('把小红书专家叫来')
    expect(h2?.kind).toBe('expert-summon')
    expect(h2?.target).toContain('小红书')
  })
  test('普通提问不误拦: 小红书怎么运营 / 财务报表怎么看 / 请把账算一下', () => {
    expect(detectExpertSummonCommand('小红书怎么运营')).toBeNull()
    expect(detectExpertSummonCommand('财务报表怎么看')).toBeNull()
    expect(detectExpertSummonCommand('请把账算一下')).toBeNull()
  })
  test('多部门点名不本地单选: 把营销部和财务部叫来 → null(落 LLM 提案组队)', () => {
    expect(detectExpertSummonCommand('把营销部和财务部叫来')).toBeNull()
  })
  test('空/无关文本 → null', () => {
    expect(detectExpertSummonCommand('')).toBeNull()
    expect(detectExpertSummonCommand('今天天气怎么样')).toBeNull()
  })
})

describe('detectExpertMeetingConfirmation (2026-09-04 P3 组队确认环)', () => {
  test('确认: 开始/发车/好的/可以/就这样', () => {
    expect(detectExpertMeetingConfirmation('开始')).toBe('confirm')
    expect(detectExpertMeetingConfirmation('发车')).toBe('confirm')
    expect(detectExpertMeetingConfirmation('好的，开始吧')).toBe('confirm')
    expect(detectExpertMeetingConfirmation('嗯嗯')).toBe('confirm')
  })
  test('取消: 取消/算了/先不开', () => {
    expect(detectExpertMeetingConfirmation('取消')).toBe('cancel')
    expect(detectExpertMeetingConfirmation('算了，先不开')).toBe('cancel')
  })
  test('其他语句 → null（不消耗 pending）', () => {
    expect(detectExpertMeetingConfirmation('把预算表给我看看')).toBeNull()
    expect(detectExpertMeetingConfirmation('')).toBeNull()
  })
})
