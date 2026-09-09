/**
 * voice-panel-commands — 语音面板开关命令匹配器（P5.5）。
 * 纯函数：命中返回 PanelCommand，未命中返回 null（零误伤正常对话）。
 * 面板 kind：task_panel 归 TaskPanelHost 浮层（通道 B，经 __taskPanel.setVisible），
 * weather/hotspot 归 WeatherPopup/HotspotPanel 独立组件（经 __weatherPanel/__hotspotPanel），
 * 其余与 SceneShell KIND_REGISTRY 一致：news/meeting_recording/music。
 */

export interface PanelCommand {
  kind: string          // '*' = 通用（当前最上层面板）; 'history' = 会话历史抽屉; 'guidance' = 引导语播报
  action: 'open' | 'close' | 'pause' | 'approve' | 'reject' | 'convert' | 'cancel'
  target?: string       // management_cockpit 深度链接目标 tab/section; guidance 携带引导文本
}

export interface CommandRule {
  kind: string
  action: 'open' | 'close' | 'pause' | 'approve' | 'reject' | 'convert' | 'cancel'
  target?: string       // management_cockpit 深度链接目标 tab/section
  patterns: RegExp[]
}

// ── 会议停止词表(2026-08-25 单一真值源) ─────────────────────
// 语音球管道(matchPanelCommand)与会议转录指令检测(detectMeetingCommand)共用,
// 「会议结束/结束会议/录制结束/停止会议/关闭会议记录」等口语说法全覆盖。
// 注意: 必须定义在 COMMAND_RULES 之前——规则数组初始化就引用它(TDZ)。
export const MEETING_STOP_PATTERNS: RegExp[] = [
  /^(结束|停止|停)(会议)?(记录|录音)(一下)?(了|吧)?$/,
  /^(结束|停止|停)(会议)?纪要(了|吧)?$/,
  /^(结束|停止|停)(掉|一下|吧)?(本次|这场)?会议(了|吧)?$/,
  /^(会议|录制|录音|记录)(结束|停止|停)(了|吧)?$/,
  /^(关闭|关掉)会议(记录|录音)?(了|吧)?$/,
  // 裸「关闭/关掉/停止/结束」(了/吧变体)——用户实机诉求「记录中说『关闭/结束』停录」;
  // 注意: 该组只被转录指令检测(detectMeetingCommand 裸词通道)使用, 不影响面板 close 组
  // (「关闭会议面板」仍走 B7 兜底关闭语义, 不停录)。
  /^(关闭|关掉)(了|吧|一下)?$/,
  /^(停|停止)(了|吧)?$/,
  // 2026-08-31(用户实机): 裸「结束/结束了」——ASR 转写常只输出"结束",
  // 此前未命中 → 被记入纪要。补入裸词(仅转录回路用; 长度约束防误杀长句)。
  /^(结束)(了|吧|一下)?$/,
]

// ── 会议书签词表(2026-09-01, P2a 语音书签用; P1 仅检测不接线) ─────
// 只走唤醒词通道(裸「重点」等误触发成本高), 不做裸词检测。
export const MEETING_BOOKMARK_PATTERNS: RegExp[] = [
  /^(标记|记录|打个?)(一下)?(重点|书签)$/,
  /^(重点|划重点)(一下)?$/,
]

interface ClauseSpan { text: string; start: number; end: number }

/** 按 。！？!?，,、；;… 及空白切分并保留原文下标（供 matched/cleanedText 精确切片） */
function splitClauses(text: string): ClauseSpan[] {
  const spans: ClauseSpan[] = []
  const re = /[。！？!?，,、；;…\s]+/g
  let start = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > start) spans.push({ text: text.slice(start, m.index), start, end: m.index })
    start = m.index + m[0].length
  }
  if (start < text.length) spans.push({ text: text.slice(start), start, end: text.length })
  return spans
}

export interface MeetingCommandHit {
  command: 'stop' | 'bookmark'
  matched: string      // 命中的指令子串（含唤醒词, 原文切片）
  cleanedText: string  // 剔除指令子串后的剩余文本（真实会议内容）
}

/**
 * 会议转录指令检测（2026-09-01 重构, 取代 isMeetingStopPhrase 的整句锚定模型）。
 *
 * 背景（spec §1.1）: 火山流式 ASR 尾段是累积增长且永不 definite 的——「结束记录」
 * 按定义恒为尾句, 整句锚定+≤6字永不命中（实机日志 14/14 帧 isFinal:false）。
 *
 * 双通道:
 *  - 唤醒词通道（即时）: 尾分句（或末两分句拼接, 处理「小龙女，结束记录」逗号分隔）
 *    以唤醒词开头 → 剥离后匹配停止/书签词表 → 立即命中, 无防抖无长度限制。
 *  - 裸词通道（防抖）: 尾分句 ≤6 字匹配停止词表, 且 final 或稳定 ≥800ms。
 *
 * @param stableMs 该段文本距上次变化的毫秒数（调用方按 seg 维护, 首帧传 0）
 */
export function detectMeetingCommand(
  text: string,
  opts: { final: boolean; stableMs: number; wakeWords: string[] }
): MeetingCommandHit | null {
  const raw = (text || '').trim()
  if (!raw) return null
  const clauses = splitClauses(raw).filter(c => c.text)
  if (clauses.length === 0) return null
  const last = clauses[clauses.length - 1]
  // 候选: 尾分句; 或末两分句拼接（≤12 字, 处理「小龙女，结束记录」唤醒词独立成句）
  const candidates: { hitText: string; start: number }[] = [{ hitText: last.text, start: last.start }]
  if (clauses.length >= 2) {
    const prev = clauses[clauses.length - 2]
    const joined = prev.text + last.text
    if (joined.length <= 12) candidates.push({ hitText: joined, start: prev.start })
  }
  const words = [...(opts.wakeWords || [])].filter(w => w && w.trim()).sort((a, b) => b.length - a.length)
  // 唤醒词通道: 即时命中
  for (const c of candidates) {
    for (const w of words) {
      if (!c.hitText.startsWith(w)) continue
      const rest = c.hitText.slice(w.length).replace(/^[，,、.\s]+/, '')
      if (MEETING_STOP_PATTERNS.some(p => p.test(rest))) {
        return { command: 'stop', matched: raw.slice(c.start), cleanedText: raw.slice(0, c.start).replace(/\s+$/, '') }
      }
      if (MEETING_BOOKMARK_PATTERNS.some(p => p.test(rest))) {
        return { command: 'bookmark', matched: raw.slice(c.start), cleanedText: raw.slice(0, c.start).replace(/\s+$/, '') }
      }
    }
  }
  // 裸词通道: 尾分句 ≤6 字 + (final 或稳定 800ms)
  const stableOk = opts.final || opts.stableMs >= 800
  if (stableOk && last.text.length <= 6 && MEETING_STOP_PATTERNS.some(p => p.test(last.text))) {
    // 剥离指令前的分隔标点: 小分隔(，,、；;)直接剥离; 句末标点(。！？!?)仅在紧贴指令(无空白间隔)时剥离
    const before = raw.slice(0, last.start)
    let cleanedBare = before.replace(/[,，、；;]+$/, '')
    if (/[。！？!?]$/.test(cleanedBare)) cleanedBare = cleanedBare.replace(/[。！？!?]+$/, '')
    cleanedBare = cleanedBare.replace(/\s+$/, '')
    return { command: 'stop', matched: raw.slice(last.start), cleanedText: cleanedBare }
  }
  return null
}

export const RULES: CommandRule[] = [
  {
    kind: 'task_panel',
    action: 'open',
    patterns: [/^(打开|显示)?任务面板$/, /^(打开|显示)任务(面板)?$/],
  },
  {
    kind: 'task_panel',
    action: 'close',
    patterns: [/^(关闭|收起|隐藏)任务面板$/, /^(关闭|收起|隐藏)任务$/],
  },
  // 2026-08-12(任务链复活 P1-5b): 语音"取消任务/停止任务/取消流程"——本地规则+事件,
  // VoiceShell 派发 crabpaw:cancel-task,由持有 store 的 TaskPanelHost 找最近 running flow 并 POST cancel
  {
    kind: 'cancel_task',
    action: 'cancel',
    patterns: [/^(取消|停止)(这个)?(任务|流程|工作流)$/],
  },
  {
    kind: 'news',
    action: 'open',
    patterns: [/^(打开|显示)?资讯$/, /^(打开|显示)?新闻$/],
  },
  {
    kind: 'news',
    action: 'close',
    // B7: 补"关掉"变体——"关掉新闻/资讯"此前未命中 → 落 LLM 可能幻觉"已关闭"
    patterns: [
      /^(关闭|关掉|收起|隐藏)资讯$/,
      /^(关闭|关掉|收起|隐藏)新闻$/,
      /^把(新闻|资讯)(关掉|关了|收起|隐藏)$/,
      /^(新闻|资讯)(关掉|关了|收起|隐藏)$/,
    ],
  },
  // ---- 会议记录（2026-08-18 会议卡片轮）----
  // target 区分语义：'start' → 开卡录音；'history' → 打开历史列表；'stop' → 停止并总结。
  // 语音/文本「开始记录」直达 MeetingPanel（不经 LLM，不依赖 intent 路由）。
  {
    kind: 'meeting_recording',
    action: 'open',
    target: 'start',
    patterns: [
      /^(开始|开启)?(会议)?(记录|录音)(一下)?$/,
      /^记录一下$/,
      /^(开始|开启)(会议记录|会议录音)$/,
      // 2026-08-19: 「开始会议纪要」开录(用户指定措辞)。独立 pattern——
      // 不能并进 (记录|录音|纪要) 否则裸「会议纪要」被本组先抢(history 组在其后)。
      // 强制「开始/开启」前缀:裸「会议纪要」仍走 history 打开历史列表。
      /^(开始|开启)(会议)?纪要$/,
    ],
  },
  {
    kind: 'meeting_recording',
    action: 'open',
    target: 'history',
    patterns: [
      /^(打开|显示)?(会议面板|会议记录|会议纪要|历史会议|会议历史)$/,
      /^(打开|显示)?会议$/,
      // 2026-09-01(R1): 查看类措辞补全——「查看/看看会议纪要」此前落 LLM 被
      // meeting_mode show 误建空会议
      /^(查看|看看|翻一下)(这?些?)(会议)?(纪要|记录|会议记录|会议纪要)$/,
    ],
  },
  {
    kind: 'meeting_recording',
    action: 'close',
    target: 'stop',
    // 2026-08-25(用户实机): 词表扩展——「会议结束/结束会议/录制结束/停止会议/关闭会议记录」
    // 此前不匹配, 语音管道与会议转录回路都无法识别; 与 detectMeetingCommand 共用常量
    patterns: MEETING_STOP_PATTERNS,
  },
  {
    kind: 'meeting_recording',
    action: 'close',
    // B7: 补"关掉"变体（关闭面板本身，不停止录音之外的动作——录音中关闭由
    // MeetingPanel handleClose 兜底保存转写）
    patterns: [
      /^(关闭|关掉|收起|隐藏)会议(面板)?$/,
      /^把会议(面板)?(关掉|关了|收起|隐藏)$/,
      /^会议(面板)?(关掉|关了|收起|隐藏)$/,
    ],
  },
  {
    kind: 'weather',
    action: 'open',
    // 2026-08-07: 补"重新打开"变体
    patterns: [/^(打开|显示|重新打开)?天气(面板)?$/, /^(打开|显示|重新打开)?天气预报$/],
  },
  {
    kind: 'weather',
    action: 'close',
    // 2026-08-03: 补口语变体——"把天气关了"等未匹配 → LLM 幻觉"已关闭"但面板没关
    patterns: [
      /^(关闭|收起|隐藏)(天气|天气预报|天气面板)$/,
      /^把天气(面板)?(关掉|关了|收起|隐藏)$/,
      /^天气(面板)?(关了|关掉|收起|隐藏)$/,
    ],
  },
  // 2026-08-14: 台风面板命令（对齐天气/热点模式，经 __typhoonPanel 全局接口）
  // 2026-08-25: 「卡片」变体补词(用户实机: 打开台风卡片→LLM 错弹股票卡)——
  // 命中即本地直达面板, 不经过 LLM/意图路由。
  {
    kind: 'typhoon',
    action: 'open',
    patterns: [/^(打开|显示)?台风(面板|卡片|追踪|路径|地图)?$/, /^(打开|显示)?台风预警$/],
  },
  {
    kind: 'typhoon',
    action: 'close',
    patterns: [
      /^(关闭|关掉|收起|隐藏)台风(面板|卡片|追踪|路径|地图)?$/,
      /^把台风(面板|卡片)?(关掉|关了|收起|隐藏)$/,
      /^台风(面板|卡片)?(关了|关掉|收起|隐藏)$/,
    ],
  },
  {
    kind: 'hotspot',
    action: 'open',
    patterns: [/^(打开|显示)?(热点|热搜)(面板|榜单)?$/, /^(打开|显示)?热搜榜$/],
  },
  {
    kind: 'hotspot',
    action: 'close',
    patterns: [/^(关闭|收起|隐藏)(热点|热搜)(面板|榜单)?$/],
  },
  {
    kind: 'music',
    action: 'open',
    // 2026-08-03: 补"播放音乐/放首歌"——此前未匹配面板命令 → LLM 调 Music(search)
    // 无歌名 → 空结果失败 → 熔断锁死。现在直达音乐面板（不依赖 LLM）
    // 2026-08-04: 补"音乐面板"变体——用户常说"打开音乐面板",此前未命中 → 进 LLM 无面板弹出
    // 2026-08-06: 补"歌曲/播首歌/唱首歌"——"播放歌曲"此前未命中 → 进 LLM 才怪
    patterns: [
      /^(打开|显示)?音乐(面板)?$/,
      /^(播放|放|来点|听)(音乐|歌|首歌|歌曲)$/,
      /^放(首)?歌(听)?$/,
      /^想听歌$/,
      /^播首歌$/,
      // R8: 带歌名的播放请求——"播放周杰伦的歌/听周杰伦的歌曲"→ 命中后由
      // VoiceShell 提取歌名自动搜索播放(不依赖 LLM)
      /^(播放|听|放|来点)(.+?)(的)?(歌|歌曲|音乐)$/,
    ],
  },
  {
    kind: 'music',
    action: 'close',
    // 2026-08-03: 补口语变体（"把音乐关掉"/"音乐停了"等 ASR 常见说法）
    patterns: [
      /^(关闭|关掉|收起|隐藏)音乐$/,
      /^(关闭|关掉|收起|隐藏)(音乐播放器|音乐面板)$/,
      /^把音乐(关掉|关了|停掉|停了)$/,
      /^音乐(关了|停掉|停了|关掉)$/,
      /^停止音乐$/,
    ],
  },
  {
    kind: 'music',
    action: 'pause',
    // 2026-08-15: "暂停音乐"本地即时暂停、保留面板——旧实现无 pause 规则落 LLM,
    // LLM 调 MusicControl(pause) 又因 FMP control 分支早退无效(已修复)。
    // 注意:"停止音乐"走 close(上面),"暂停"不匹配 stop 类动词。
    patterns: [
      /^(暂停|停一下)(音乐|播放|播放器)?$/,
    ],
  },
  // ---- 文件生成面板（2026-08-17: 替代 DocReader 生成舱，SideSheet 面板）----
  // 关闭/打开直达 FileGenPanel（window.__filePanel.setVisible）；
  // "转成 WORD"打开面板（转换操作在面板内完成）。
  {
    kind: 'filegen',
    action: 'close',
    patterns: [
      /^(关闭|收起|隐藏)(文件面板|文件生成面板|文档面板|文档阅读器|文档生成舱|生成舱|文档舱|文档卡片)$/,
      /^关掉(文件面板|文件生成面板|文档面板|文档卡片)$/,
      /^(把)(文件面板|文件生成面板|文档面板|文档卡片)(关掉|关了|收起|隐藏)$/,
    ],
  },
  {
    kind: 'filegen',
    action: 'open',
    patterns: [
      /^(打开|开启|新建|重新打开)(文件面板|文件生成面板|文档面板|文档生成舱|文档舱|文档卡片)$/,
      /^(把|将)?(文件面板|文件生成面板|文档面板)(打开|开启|显示|调出来|拿出来)$/,
    ],
  },
  {
    kind: 'filegen',
    action: 'convert',
    patterns: [
      // 2026-08-22: 补 html/网页 目标词——"转成HTML"此前不命中本地规则落入 LLM,
      // 依赖模型工具链(实机曾因 DocRead 参数名错位失败); 本地命中直接打开面板,
      // 转换链路(converting→done + 双栏预览)对用户可见。
      /^(转|转换|导出|保存)成?(为)?(word|Word|WORD|文档|word文档|html|HTML|网页|网页文件)$/,
      /^(把|将)?(文档|这份文档)(转|转换|导)成(word|Word|WORD|文档|html|HTML|网页|网页文件)$/,
    ],
  },
  {
    kind: 'media',
    action: 'open',
    patterns: [
      /^(打开|开启)(媒体|播放器|视频面板|媒体面板)$/,
      /^(打开|开启)一下(媒体|播放器|视频面板|媒体面板)$/,
    ],
  },
  // 2026-08-12: 场景文章/网页预览卡关闭——写文章后 web-preview/document 场景卡
  // 此前无规则命中 → 落 LLM 幻觉"已关闭"但卡片仍在屏。注意与 filegen(文件面板)规则
  // 区分:"文档卡片"归 filegen 文件面板,此处用"网页/文章/预览"措辞避免规则冲突。
  {
    kind: 'web-preview',
    action: 'close',
    patterns: [
      /^(关闭|关掉|收起|收起来|隐藏)(网页预览|网页卡|预览卡|网页预览卡)$/,
      /^把(网页预览|网页卡|预览卡)(关掉|关了|收起|收起来|隐藏)$/,
      /^(网页预览|网页卡|预览卡)(关掉|关了|收起|收起来|隐藏)$/,
    ],
  },
  {
    kind: 'document',
    action: 'close',
    patterns: [
      /^(关闭|关掉|收起|收起来|隐藏)(文章卡片|文章卡|文章面板)$/,
      /^把(文章卡片|文章卡)(关掉|关了|收起|收起来|隐藏)$/,
      /^(文章卡片|文章卡)(关掉|关了|收起|收起来|隐藏)$/,
    ],
  },
  // 2026-08-07: 对话面板（SceneShell 最上层场景卡）关闭——此前"关闭对话面板"
  // 无命令命中 → 落 LLM 幻觉"已关闭"但面板仍在屏
  {
    kind: 'scene',
    action: 'close',
    patterns: [/^(关闭|关掉|收起|隐藏)(对话面板|对话|场景面板|全息面板|场景卡)$/],
  },
  // 2026-08-12: 通用"收起/关闭卡片"——此前裸"卡片"被 doc close 规则误劫持（路由到
  // DocReader.close 而非场景卡）。此处新建 scene-card kind：命中后由 VoiceShell 派发
  // crabpaw:close-scene-card 事件关闭最上层场景卡。"文档卡片/文章卡片/技能卡片"等
  // 具体名词仍归各自规则（filegen/document/skill，且规则顺序在前，优先命中）。
  {
    kind: 'scene-card',
    action: 'close',
    patterns: [
      /^(收起|关闭|隐藏)(这?张?)(场景)?卡片$/,
      /^把(这?张?)(场景)?卡片(关掉|关了|收起|收起来|隐藏)$/,
      /^(这?张?)(场景)?卡片(关掉|关了|收起|收起来|隐藏)$/,
      // 2026-08-15: 合同卡片关闭补全——contract kind 此前无任何 close 规则
      /^(收起|关闭|隐藏)(这?张?)?(合同卡片|合同卡|合同面板|合同)$/,
      /^把(这?张?)?(合同卡片|合同卡)(关掉|关了|收起|收起来|隐藏)$/,
      /^(这?张?)?(合同卡片|合同卡)(关掉|关了|收起|收起来|隐藏)$/,
    ],
  },
  {
    kind: 'media',
    action: 'close',
    // 2026-08-16: 补"视频/视频卡片/视频卡"——"关闭视频"此前无规则命中落 LLM,
    // LLM 删 surface 不经 __mediaStage.close → 组合布局卡死不回归(与
    // MediaStageHost 可见性广播修复配套; 本地命中直达 close, 事件流完整)
    // 注意交替顺序: 长词(媒体面板/视频面板/视频卡片/视频卡)必须在前——"视频"先
    // 匹配则 "关闭视频面板" 的尾部"面板"锚定 $ 失败且交替不回溯, 规则整体落空
    // 2026-09-05: 补口语变体(ASR 弱麦转写常有缀词/倒装)——"关闭一下视频/
    // 把视频关掉/视频关掉/关闭视频了"
    patterns: [
      /^(关闭|收起|隐藏)(媒体面板|视频面板|视频卡片|视频卡|播放器|媒体|视频)$/,
      /^(关闭|收起|隐藏)一下(媒体面板|视频面板|视频卡片|视频卡|播放器|媒体|视频)(了)?$/,
      /^把(媒体面板|视频面板|视频卡片|视频卡|播放器|媒体|视频)(关闭|关掉|关了)$/,
      /^(媒体面板|视频面板|视频卡片|视频卡|播放器|媒体|视频)(关闭|关掉|关了)$/,
    ],
  },
  {
    kind: 'skill',
    action: 'close',
    // 2026-08-04: 技能执行全息卡关闭(SkillStageHost 全局接口)
    patterns: [/^(关闭|收起|隐藏)(技能卡|技能卡片|技能面板|技能舱)$/, /^关掉技能卡$/, /^技能卡(关了|关掉)$/],
  },
  // ---- 审批（ApprovalHost）——语音批准/拒绝 ----
  // 2026-08-12 (P2 杂项 5a): 补自然后缀变体——handleUserInput 已用 stripCommandPrefix
  // 剥"请/帮我/麻烦"前缀,"帮我批准一下"归一为"批准一下";此前 (请求|审批)?$ 锚定导致
  // "批准一下/同意吧/通过了吧"全部落 LLM。现覆盖 (一下)?(了吧|吧)? 口语后缀组合。
  {
    kind: 'approval',
    action: 'approve',
    patterns: [
      /^(批准|同意|确认|允许|通过|可以)(这个|该)?(请求|审批)?(一下)?(了吧|吧)?$/,
      /^同意$/, /^批准$/, /^通过$/,
    ],
  },
  {
    kind: 'approval',
    action: 'reject',
    patterns: [/^(拒绝|不同意|否决|驳回|不批准)(这个|该)?(请求|审批)?$/, /^拒绝$/, /^不同意$/, /^否决$/],
  },
  {
    kind: 'history',
    action: 'open',
    patterns: [/^(历史|历史会话|查看历史|会话记录)$/],
  },
  // 2026-08-15: 历史抽屉 close 补全——此前只有 open 规则,"关闭历史"落 LLM 幻觉
  {
    kind: 'history',
    action: 'close',
    patterns: [
      /^(关闭|关掉|收起|隐藏)(历史|历史会话|会话记录|历史抽屉)$/,
      /^把(历史|历史会话|会话记录)(关掉|关了|收起|隐藏)$/,
      /^(历史|历史会话|会话记录)(关掉|关了|收起|隐藏)$/,
    ],
  },
  {
    kind: '*',
    action: 'close',
    patterns: [/^(关闭|收起|隐藏)面板$/],
  },
  // ---- 管理舱（ManagementCockpit）命令（阶段 B：management_cockpit kind + target 深度链接）----
  // 命中后由 VoiceShell 路由（Task 5）：open → 打开管理舱并切换对应 tab；close → 关闭舱。
  // dev target（logs/status/gateway/memory）在非开发者模式下由路由层拦截，matcher 本身纯匹配。
  {
    kind: 'management_cockpit',
    action: 'open',
    target: 'settings',
    patterns: [/^(打开|显示)?管理舱$/, /^(打开|显示)?系统管理$/, /^(打开|显示)?系统设置$/],
  },
  {
    kind: 'management_cockpit',
    action: 'open',
    target: 'model',
    patterns: [/^(打开|去|进入)?(配置)?模型(配置|设置)?$/],
  },
  {
    kind: 'management_cockpit',
    action: 'open',
    target: 'mcp',
    patterns: [/^(打开|进入)?(MCP|Mcp|mcp)(配置|设置)?$/],
  },
  {
    kind: 'management_cockpit',
    action: 'open',
    target: 'plugin',
    patterns: [/^(打开|进入)?插件(管理|配置|设置)?$/],
  },
  {
    kind: 'management_cockpit',
    action: 'open',
    target: 'skills',
    // 2026-08-21: tab 改名「技能」——「打开技能」直达；「技能仓库/技能管理」旧词兼容
    patterns: [/^(打开|进入)?技能(仓库|管理)?$/],
  },
  {
    kind: 'management_cockpit',
    action: 'open',
    target: 'cost',
    patterns: [/^(打开|查看)?用量(统计)?$/],
  },
  {
    kind: 'management_cockpit',
    action: 'open',
    target: 'logs',
    patterns: [/^(打开|查看)?(系统)?日志$/],
  },
  {
    kind: 'management_cockpit',
    action: 'open',
    target: 'status',
    patterns: [/^(打开|查看)?(系统)?状态$/],
  },
  {
    kind: 'management_cockpit',
    action: 'open',
    target: 'gateway',
    patterns: [/^(打开|进入)?网关$/],
  },
  {
    kind: 'management_cockpit',
    action: 'open',
    target: 'memory',
    patterns: [/^(打开|查看)?记忆(图谱)?$/],
  },
  {
    kind: 'management_cockpit',
    action: 'close',
    // 2026-08-27: 经营数据/数据库注释清理——业务面板已退役, 这些能力在卡片与专家 tab,
    // 无 data tab; 关闭词随迁到管理舱关闭语义。
    patterns: [/^(关闭|收起|隐藏)(管理舱|系统管理|系统设置|专家|专家面板)$/],
  },
  // ---- 搜索命令（2026-08-12 搜索落地 4a）----
  // 语音"帮我找 X/搜索文档"此前无本地规则 → 落 LLM 等 4-6s 碰运气。命中后由 VoiceShell
  // 派发 crabpaw:open-search 事件（2026-08-19 起打开文件生成面板 FileGenPanel + 播报引导）。
  // 边界设计：
  //  - 只取"找/搜索/查找"开头；排除"查一下/查"——"查一下车次/日志/记忆/状态"语义各异
  //    （火车票走 TrainQuery、日志/记忆走管理舱调试），应留给 LLM 走对应工具，不能误开文件面板；
  //  - 动词后要求有内容（防裸"找/搜索"空开面板）；
  //  - 负向先行排除歌/音乐/曲/车次/火车票——"找首歌"是音乐意图（music 规则家族），
  //    "找车次"是出行查询，均不被搜索规则劫持。
  {
    kind: 'search',
    action: 'open',
    patterns: [/^(帮我)?(找|搜索|查找)(一?下)?(?!.*(歌|歌曲|音乐|曲|车次|火车票))(.+)$/],
  },
  // ---- 股票行情面板（2026-08-14 新增: ShowStock surface 'stock-panel'）----
  // "打开/关闭股票"直达行情面板（SideSheet）；"打开持仓/我的股票"不命中
  // 本地规则（2026-08-19 业务面板退役）→ 落 LLM 走股票工具链路。
  {
    kind: 'stock',
    action: 'open',
    patterns: [/^(打开|显示|进入)?(股票面板|股票行情|行情|股市|大盘)$/, /^(打开|显示)?股票$/],
  },
  {
    kind: 'stock',
    action: 'close',
    patterns: [
      /^(关闭|关掉|收起|隐藏)(股票面板|股票行情|行情|股市|大盘|股票)$/,
      /^把(股票面板|股票行情|股市|大盘)(关掉|关了|收起|隐藏)$/,
      /^(股票面板|股票行情|股市|大盘)(关掉|关了|收起|隐藏)$/,
    ],
  },
  // ---- 日程卡片（2026-08-19: SchedulePanel 卡片, 数据走 /api/calendar）----
  // "打开/关闭日程/日历"直达日程卡片(SideSheet)，承担日程增删管（内建表单，
  // 不再跳转业务面板——2026-08-19 业务面板已退役）。
  {
    kind: 'schedule',
    action: 'open',
    patterns: [
      /^(打开|显示|查看)?(日程卡片|日程卡|日历卡片|日历卡|日程|日历|日程安排)$/,
      /^(今天|今日)有什么日程$/,
      /^今天的日程$/,
      // 2026-08-19: 首页 chip「我的近期日程」直达(查询语义, 落 LLM 会被误判为创建意图)
      /^我的(近期)?(日程|日历|日程安排)$/,
    ],
  },
  {
    kind: 'schedule',
    action: 'close',
    patterns: [
      /^(关闭|关掉|收起|隐藏)(日程卡片|日程卡|日历卡片|日历卡|日程|日历|日程安排)$/,
      /^把(日程|日历|日程卡片|日程安排)(关掉|关了|收起|隐藏)$/,
      /^(日程|日历|日程卡片)(关掉|关了|收起|隐藏)$/,
    ],
  },
  // ---- 知识库面板（2026-08-20: KnowledgePanel 卡片, 数据走 /api/kb/*）----
  // "打开/关闭知识库"直达知识库卡片(SideSheet, 检索/文档清单/SRS 复习三 tab)。
  // 内容问题("知识库里XX是多少")不在此拦截——落 LLM 走 kb_query 意图 → KbSearch 文本回答。
  {
    kind: 'knowledge',
    action: 'open',
    patterns: [
      /^(打开|显示|查看)?(知识库面板|知识库卡片|知识库卡|知识库|文档库)$/,
      /^(知识库|文档库)里有什么$/,
    ],
  },
  {
    kind: 'knowledge',
    action: 'close',
    patterns: [
      /^(关闭|关掉|收起|隐藏)(知识库面板|知识库卡片|知识库卡|知识库|文档库)$/,
      /^把(知识库|文档库)(关掉|关了|收起|隐藏)$/,
      /^(知识库|文档库)(关掉|关了|收起|隐藏)$/,
    ],
  },
  // ---- 业务面板退役（2026-08-19）+ 「专家·数据」拆分（2026-08-21）----
  // BusinessPanel 已删除：日程→日程卡片(schedule 规则)、股票→行情卡片(stock 规则)、
  // 文件→文件面板(filegen 规则)/文档分析卡片；专家→管理舱 expert tab。
  // "打开业务面板/打开持仓"不再命中本地规则 → 落 LLM。
  {
    kind: 'management_cockpit',
    action: 'open',
    target: 'expert',
    // 2026-08-21: 原「专家·数据」合并规则拆分——专家类词 → expert tab
    patterns: [/^(打开|显示|进入)?(专家|专家列表|专家面板|专家与数据|专家和数据)$/],
  },
  // ---- 引导语（本地拦截，不进入 LLM） ----
  {
    kind: 'guidance',
    action: 'open',
    target: '车次查询请使用 TrainQuery 工具，对我说「帮我查今天到上海的高铁」。',
    patterns: [/^车次$/, /^火车票$/],
  },
  {
    kind: 'guidance',
    action: 'open',
    target: '请说：把上季度经营数据做成看板网页',
    patterns: [/^看板$/],
  },
]

export function matchPanelCommand(text: string): PanelCommand | null {
  const t = text.trim().replace(/[，。！？\s]+/g, '')
  for (const rule of RULES) {
    if (rule.patterns.some(p => p.test(t))) {
      return { kind: rule.kind, action: rule.action, ...(rule.target ? { target: rule.target } : {}) }
    }
  }
  return null
}

/**
 * 剥离呼唤前缀（唤醒词/问候语/祈使词）——ASR 转写常带"小螃蟹，打开设置"等前缀，
 * 前缀污染导致命令匹配落空。返回剥离后的文本（无前缀时原样返回）。
 * 2026-08-12 (P1 缺陷 4): 唤醒词（小螃蟹/小龙女/小talk/小托克/crabpaw）允许零个或多个
 * 分隔符——ASR 连读"小螃蟹打开股票"中间无标点也必须剥离（唤醒词是品牌词，句首出现
 * 必然是对助手说话，不会误伤正常用词）；问候语"嗨/你好"仍要求至少一个分隔符——
 * 防"你好吗"被剥成"吗"送进 LLM。
 */
export function stripCommandPrefix(text: string): string {
  return text
    .replace(/^(小螃蟹|小龙女|小talk|小托克|crabpaw)\s*[，,。.\s]*/, '')
    .replace(/^(嗨|你好)\s*[，,。.\s]+/, '')
    .replace(/^(请|帮我|麻烦)\s*/, '')
}

/**
 * 提取播放命令中的歌名——"播放周杰伦的歌" → "周杰伦"；"放首歌/播放歌曲"
 * （无具体歌名）→ ''（调用方降级为只开面板手选）。
 * 2026-08-15 修复: 歌名至少 2 字——"放首歌"前缀"放"被吃后 (.+?) 非贪婪
 * 误取"首"为歌名 → 搜出《首饰》而非开面板。单字歌名罕见, 落入降级路径可接受
 * （面板打开后用户可再语音搜索或手动选）。
 */
export function extractSongQuery(text: string): string {
  const clean = text.replace(/[，。！？、\s]+/g, '')
  const m = clean.match(/(?:播放|听|放|来点)?(.+?)(?:的)?(?:歌|歌曲|音乐)$/)
  const q = m && m[1] ? m[1].trim() : ''
  return q.length >= 2 && !/^(播放|听|放|来点|打开|显示)$/.test(q) ? q : ''
}

/**
 * 空态建议提问——VoiceShell 无对话时展示的引导 chips。
 * 2026-08-19: 按智能体实际能力重写——每条都对应实机验证过的链路:
 *   - 「开始会议纪要」→ 本地命令直达 MeetingPanel 开录(不经 LLM,
 *     命中 ^(开始|开启)(会议)?纪要$ → target:'start')
 *   - 「我的近期日程」→ 本地命令直达 SchedulePanel(命中
 *     ^我的(近期)?(日程|日历|日程安排)$ → kind:'schedule')
 *   - 「今天有什么热点新闻」「看看今天的股票行情」
 *     → 落 LLM → 热点/股票行情面板(面板自取真实数据)
 *   - 「生成一个网页」→ 落 LLM → 文件生成面板 + 模型追问主题/受众（FILEGEN_TASK_HINT
 *     步骤0 追问分支），追问后任务转 paused"等待补充需求信息"，用户补充即续跑
 * 2026-09-06(用户反馈): 引导词必须是通用形态「生成一个网页」——专用词（介绍
 * CrabPaw 的主页）点击后只让用户"知道能生成"，没有演示价值。无主题空洞指令
 * 此前会掷硬币（追问则孤儿卡死/瞎编则产物无关），现由 v2 状态机 paused +
 * 追问引导 + 补充需求恢复链路兜住（filegen 2026-09-06 轮），空洞词反而成为
 * 追问流程的正确演示。约束(2026-08-13 ag-ui 借鉴): 必须是完整提问句,不能以"车次/看板/
 * 打开/显示"等命令触发词开头,否则被 matchPanelCommand 本地拦截
 * 转成引导语/开面板 TTS 而非进入 LLM(「开始记录会议」为刻意直达例外)。
 */
export const SUGGESTED_PROMPTS: string[] = [
  '开始会议纪要',
  '我的近期日程',
  '今天有什么热点新闻',
  '看看今天的股票行情',
  '生成一个网页',
]


// ── 专家召唤/部门例会检测（2026-09-04 部门化 P2 语音层） ──────────────────
// 与 matchPanelCommand 分离：本 detector 不做面板开关，而是捕获召唤对象（岗位/部门/
// 班组）与例会目标，由调用方（VoiceShell）走 POST /api/experts/summon 与
// POST /api/experts/collab/department。命中后调用方必须 return（不落 LLM）。

export interface ExpertSummonHit {
  kind: 'expert-summon' | 'department-meeting'
  /** expert-summon: 召唤对象（岗位别名/部门名）; department-meeting: 目标为空时用班组默认目标 */
  target: string
  /** department-meeting: 命中的班组/部门显示名（播报用） */
  label?: string
  presetId?: string
  departmentId?: string
  goal?: string
  /** 命中的指令子串（播报回显用） */
  matched: string
}

/** 召唤动词：叫/请/找/让 + (X来|X看看|X上线|X参会) 等——宽松覆盖口语，误召由 summon API 消歧 */
const SUMMON_VERB = '(?:叫|请|找|让|喊|把|召(?:唤|来)|请出|接通|连线)'
/** 班组固定措辞："开/召开/开个 + 经营分析会/营销作战会/销售冲刺会" */
const MEETING_PRESETS: { presetId: string; label: string; patterns: RegExp[] }[] = [
  {
    presetId: 'ops_review',
    label: '经营分析会',
    patterns: [/^(?:开|召开|开个|开一下|给我开)(?:一个)?经营分析(?:会|会议)?$/, /^(?:经营分析会?)(?:现在)?(?:开|召开)(?:会|起来)?$/],
  },
  {
    presetId: 'marketing_war_room',
    label: '营销作战会',
    patterns: [/^(?:给我)?(?:开|召开|开个|开一下)(?:一个)?营销(?:部)?作战会?$/, /^(?:营销作战会?)(?:现在)?(?:开|召开)(?:会|起来)?$/],
  },
  {
    presetId: 'sales_push',
    label: '销售冲刺会',
    patterns: [/^(?:给我)?(?:开|召开|开个|开一下)(?:一个)?销售(?:部)?冲刺会?$/, /^(?:销售冲刺会?)(?:现在)?(?:开|召开)(?:会|起来)?$/],
  },
]

/**
 * 检测语音中的专家召唤 / 部门例会指令。
 * 设计约束：
 *  - 只拦截"明确的召唤句式"（动词开头/班组固定措辞），避免"财务报表怎么看"这类
 *    普通提问被误拦——普通提问应走 /chat 的自动路由（L0 说事转接）。
 *  - 部门名从原子串匹配（"叫财务来看看"→财务），岗位交给 summon API 的别名解析
 *    （"找个懂小红书的"→ target='懂小红书的' 由后端四形态解析）。
 */
export function detectExpertSummonCommand(text: string): ExpertSummonHit | null {
  const raw = (text || '').trim()
  if (!raw) return null
  const t = raw.replace(/[，。！？、\s]+/g, '')

  // 1) 班组固定措辞（最高优先级——完整匹配才命中，不误伤普通提问）
  for (const p of MEETING_PRESETS) {
    for (const re of p.patterns) {
      if (re.test(t)) {
        return { kind: 'department-meeting', target: '', presetId: p.presetId, label: p.label, matched: raw }
      }
    }
  }

  // 2) "开/召开 + 部门名 + 例会/会议"（部门例会，无目标→调用方需补目标或走默认）
  const deptMeeting = t.match(new RegExp(`^(?:开|召开|开个|开一下)(?:一个)?(${Object.keys(DEPT_ALIAS_MAP).map(k => DEPT_ALIAS_MAP[k]).flat().join('|')})(?:部)?(?:例会|会议)$`))
  if (deptMeeting) {
    const deptId = resolveDeptIdByAlias(deptMeeting[1])
    if (deptId) return { kind: 'department-meeting', target: '', departmentId: deptId, label: `${DEPT_LABEL_MAP[deptId]}例会`, matched: raw }
  }

  // 3) 召唤句式：动词 + 对象（对象 = 部门别名/岗位别名/自由描述）
  const summon = t.match(new RegExp(`^(?:${SUMMON_VERB})?(?:把|让)?(.{2,12}?)(?:叫来|喊来|拉(?:进|过)来|请来|叫过来看看|来看看|来看下|上线|参会|过来|出马|接管|接手|负责(?:这个|此事|一下)?)[吧呀啊]?$`))
  if (summon && summon[1]) {
    const target = summon[1].replace(/^(?:一下|这个|那个|先|让)/, '').trim()
    if (target.length < 2) return null
    const deptId = resolveDeptIdByAlias(target)
    if (deptId) {
      return { kind: 'expert-summon', target, departmentId: deptId, label: DEPT_LABEL_MAP[deptId], matched: raw }
    }
    // 多部门点名（"营销部和财务部"）不在本地单选——落 LLM 由 /chat 自动路由提案组队
    const multiDept = Object.values(DEPT_ALIAS_MAP)
      .filter(aliases => aliases.some(a => target.includes(a))).length > 1
    if (multiDept) return null
    return { kind: 'expert-summon', target, matched: raw }
  }
  return null
}

// 部门别名表（与后端 departments.js voiceAliases 对齐的精简版——语音端做初筛，权威在后端）
const DEPT_ALIAS_MAP: Record<string, string[]> = {
  finance: ['财务', '会计', '账务'],
  marketing: ['营销', '市场', '品牌', '推广'],
  sales: ['销售'],
  hr_admin: ['人事', '人力', '行政'],
  tech_digital: ['技术', '研发', '数字'],
  legal: ['法务', '法律'],
  strategy_invest: ['战略', '投资', '经营分析'],
}
const DEPT_LABEL_MAP: Record<string, string> = {
  finance: '财务部', marketing: '营销部', sales: '销售部', hr_admin: '人力行政部',
  tech_digital: '技术与数字部', legal: '法务合规部', strategy_invest: '战略投资部',
}
function resolveDeptIdByAlias(word: string): string | null {
  const w = word.replace(/部$/, '')
  const hitDepts = Object.entries(DEPT_ALIAS_MAP)
    .filter(([, aliases]) => aliases.some(a => w === a || w.includes(a)))
    .map(([id]) => id)
  // 多部门点名（"营销部和财务部"）不在本地单选——落 LLM 由 /chat 自动路由提案组队
  return hitDepts.length === 1 ? hitDepts[0] : null
}

/** 例会确认环应答检测（2026-09-04 P3 组队确认环）——仅在 pending 提案挂起时调用 */
export type MeetingConfirmation = 'confirm' | 'cancel' | null
export function detectExpertMeetingConfirmation(text: string): MeetingConfirmation {
  const t = (text || '').trim().replace(/[，。！？\s]+/g, '')
  if (!t) return null
  // 多词组合支持（"好的开始吧"=好+的?不对——按已知关键词序列拼接）: + 量词允许关键词连用
  if (/^(?:好|好的|好呀|行|行吧|可以|确认|开始|发车|开吧|就这样|嗯+|同意|没问题|开)+(?:吧|了|呀|啊)?$/.test(t)) return 'confirm'
  if (/^(?:取消|算了|先不开|先不要|不要了|不开了|停下|先放一放)+(?:吧|了)?$/.test(t)) return 'cancel'
  return null
}
