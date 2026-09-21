/**
 * useCommandIntercept — 本地命令拦截瀑布（2026-09-21 P2-1 第五批从 index.tsx 搬出）
 *
 * handleUserInput 的前置消费链：专注模式开关 → 裸「关闭」→ 例会确认环应答 →
 * 专家召唤/圆桌提案 → 面板命令大分发（matchPanelCommand 15+ kind）→ 音乐兜底 →
 * 会议录制期隔离。命中即消费（返回 true），未命中返回 false 由宿主落 LLM。
 *
 * pendingMeetingRef（例会确认环挂起提案）原为 index 内 ref，其全部读写都在
 * 本瀑布内，随迁为 hook 内部 ref。
 */
import { useCallback, useRef } from 'react'
import {
  matchPanelCommand,
  extractSongQuery,
  detectExpertSummonCommand,
  detectExpertMeetingConfirmation,
} from '../../lib/voice-panel-commands'
import { executeCommand, getCommandHost } from '../../lib/ui-command-registry'
import { closeActiveSheet } from '../../components/SideSheet/sheet-state'
import { summonExpert, fetchTeamPresets, fetchExpertDetail, fetchExpertsByDepartment } from '../../components/ExpertsPanel/api'
import { COCKPIT_TARGET_MAP } from '../../lib/cockpit-navigation'
import { apiGet, apiPost } from '../../lib/api'
import { resolveExpertTtsVoice } from '../../lib/expert-persona'
import type { useSpeechQueue } from '../../hooks/useSpeechQueue'
import type { CockpitTab } from '../../components/ManagementCockpit'

type SpeechQueue = ReturnType<typeof useSpeechQueue>

// 调试子页语音直达映射：voice target → DebugPanel 子页（未命中回退 'logs'）
// 2026-08-19 审计修复: 补 evolution/voice——此前仅 4 项 vs 语音命令拦截列表 6 项不同步,
// 开发者语音「打开进化日志/语音诊断」经 debugTabMap[target] ?? 'logs' 静默降级到 logs 子页
const debugTabMap: Record<string, string> = {
  logs: 'logs', status: 'status', gateway: 'gateway', memory: 'memory',
  evolution: 'evolution', voice: 'voice',
}

// P5.5: 面板确认播报的中文名
function panelLabel(kind: string): string {
  switch (kind) {
    case 'task_panel': return '任务面板'
    case 'news': return '资讯'
    case 'meeting_recording': return '会议面板'
    case 'music': return '音乐播放器'
    case 'weather': return '天气面板'
    case 'hotspot': return '热点面板'
    case 'typhoon': return '台风面板'
    case 'stock': return '股票面板'
    case 'filegen': return '文件生成面板'
    case 'web-preview': return '网页预览'
    case 'document': return '文章卡片'
    default: return '面板'
  }
}

// 2026-08-27 面板禁用开关: 语音直开 weather/stock 绕过了 registry 读面过滤
// (P2 防绕过核查实锤)——按 /api/panels/state 启用态门控, 12s TTL 缓存。
// 查询失败 → 返回 null(不拦截, 由后端 registry 读面兜底); 未知键 → 放行(向后兼容)。
let _panelEnabledCache: { at: number; map: Record<string, boolean> | null } = { at: 0, map: null }
async function checkPanelEnabled(kind: string): Promise<boolean | null> {
  if (!_panelEnabledCache.map || Date.now() - _panelEnabledCache.at > 12000) {
    try {
      const res = await apiGet<{ panels?: { key: string; enabled: boolean }[] }>('/api/panels/state')
      _panelEnabledCache = { at: Date.now(), map: Object.fromEntries((res?.data?.panels || []).map((p): [string, boolean] => [p.key, p.enabled])) }
    } catch (e) {
      console.warn('[shell] 面板启用态查询失败(门控放行):', e)
      return null
    }
  }
  return _panelEnabledCache.map![kind] ?? true
}

function isDevMode(): boolean {
  try { return localStorage.getItem('crabpaw_dev_mode') === '1' } catch { return false }
}

export interface CommandInterceptHost {
  speech: SpeechQueue
  applyShellConfig: (patch: any) => void
  pushChat: (role: 'user' | 'ai' | 'tool', text: string) => void
  cockpit: {
    visible: boolean
    setVisible: (v: boolean) => void
    setTab: (t: CockpitTab) => void
    setNavSection: (s: string | null) => void
    setDebugTab: (t: string) => void
  }
  setHistoryDrawerOpen: (v: boolean) => void
  visibleSurfaces: unknown[]
}

export function useCommandIntercept(host: CommandInterceptHost) {
  const { speech, applyShellConfig, pushChat, cockpit, setHistoryDrawerOpen, visibleSurfaces } = host

  // 2026-09-04 P3 组队确认环: 例会提案挂起态（确认环应答 + 召唤段写入共用）
  const pendingMeetingRef = useRef<null | { label: string; expiresAt: number; launch: () => Promise<void> }>(null)

  return useCallback((t: string, ct: string): boolean => {
    // 专注模式语音开关（多人环境：仅 PTT 可用）
    if (/^(打开|开启|进入)(专注模式|仅按键模式|仅ptt模式)$/.test(t)) {
      applyShellConfig((v: any) => v.pttOnly ? v : { ...v, pttOnly: true, continuousMode: false, wakeWordEnabled: false })
      speech.enqueue({ id: `focus_${Date.now()}`, text: '已开启专注模式，仅按住空格说话', kind: 'panel' })
      return true
    }
    if (/^(关闭|退出)(专注模式|仅按键模式)$/.test(t)) {
      applyShellConfig((v: any) => v.pttOnly ? { ...v, pttOnly: false, continuousMode: true, wakeWordEnabled: true } : v)
      speech.enqueue({ id: `focus_${Date.now()}`, text: '已退出专注模式', kind: 'panel' })
      return true
    }
    // 2026-08-19 修复: 裸「关闭」本地拦截——此前「关闭」无目标词不命中任何面板规则
    // → 落 LLM 无反应(会议纪要卡打开时输入「关闭」期望关掉卡片)。
    // 命中条件: ① SideSheet 宿主卡(会议/热点/台风等)激活 → sheet-state 通用关闭;
    // ② 场景卡在屏 → closeTop 关最上层;③ 都无 → 不拦截,落 LLM(对话语境正常词)。
    if (/^(关闭|关掉|收起|隐藏)$/.test(ct)) {
      try {
        if (closeActiveSheet()) return true
      } catch (err) { console.error('[shell] 关闭活动面板失败:', err) }
      const shell = getCommandHost('sceneShell')
      if (visibleSurfaces.length > 0 && shell && typeof shell.closeTop === 'function') {
        try { shell.closeTop() } catch (err) { console.error('[shell] 关闭最上层场景卡失败:', err) }
        return true
      }
    }
    // 2026-09-04 P3 组队确认环: 例会提案挂起时优先消费确认/取消应答
    const pending = pendingMeetingRef.current
    if (pending) {
      if (Date.now() > pending.expiresAt) {
        pendingMeetingRef.current = null
      } else {
        const conf = detectExpertMeetingConfirmation(ct)
        if (conf === 'confirm') {
          pendingMeetingRef.current = null
          void (async () => {
            try {
              await pending.launch()
            } catch (e: any) {
              console.warn('[shell] 例会确认发车失败:', e?.message || e)
              speech.enqueue({ id: `experts_${Date.now()}`, text: '会议启动失败，请稍后再试', kind: 'panel' })
            }
          })()
          return true
        }
        if (conf === 'cancel') {
          pendingMeetingRef.current = null
          speech.enqueue({ id: `experts_${Date.now()}`, text: '好的，先不开了。', kind: 'panel' })
          return true
        }
        // 非应答语句：提案作废，该语句走正常链路
        pendingMeetingRef.current = null
      }
    }

    // 2026-09-04 部门化 P2/P3: 专家召唤/部门例会语音指令——命中即走 summon/collab API
    // 并语音播报结果(带岗位音色), 不落 LLM。例会走确认环: 提案阵容→应答→发车。
    const summonHit = detectExpertSummonCommand(ct)
    if (summonHit) {
      void (async () => {
        const say = (text: string, voice?: string) => speech.enqueue({ id: `experts_${Date.now()}`, text, kind: 'panel', ...(voice ? { voice } : {}) })
        try {
          if (summonHit.kind === 'department-meeting') {
            // 组队确认环: 先提案阵容，等"开始/取消"应答再发车。
            // 2026-09-20 二轮: 发车目标改圆桌会（roundtable，部门/班组模式）——统一会议
            // 体验（两轮讨论+多音色+收口三件套，全程 SSE 进对话流）；提案同时上屏
            // （此前只 TTS 播报，静音时零可见反馈——实测"发送后变空"的根因）。
            let goal = summonHit.goal || ''
            let roster: { name: string; voiceStyle?: string }[] = []
            let leadName = ''
            if (summonHit.presetId) {
              const presets = await fetchTeamPresets()
              const preset = presets.find(p => p.id === summonHit.presetId)
              goal = goal || preset?.defaultGoal || ''
              const details = await Promise.all((preset?.expertIds || []).map(id => fetchExpertDetail(id)))
              roster = details.filter(Boolean).map(d => ({ name: d!.name, voiceStyle: (d as any)!.voiceStyle }))
              leadName = roster[0]?.name || ''
            } else if (summonHit.departmentId) {
              const members = await fetchExpertsByDepartment(summonHit.departmentId)
              roster = members.slice(0, 4).map(m => ({ name: m.name, voiceStyle: m.voiceStyle }))
            }
            if (!goal) goal = '部门工作例检：当前状况、主要问题与本周重点建议'
            const label = (summonHit.label || '部门例会').replace('例会', '圆桌会')
            if (roster.length === 0) { say(`${label}暂无在编岗位，无法召开`); return }
            const startParams: Record<string, unknown> = { goal, sessionId: 'voice_shell_user' }
            if (summonHit.presetId) startParams.presetId = summonHit.presetId
            else if (summonHit.departmentId) startParams.department = summonHit.departmentId
            const rosterText = `${roster.map(r => r.name).join('、')}${leadName ? `（${leadName} 主持）` : ''}`
            pushChat('ai', `🪑 ${label}提案：${goal}\n参会：${rosterText}。回复"开始"发车，"取消"作废。`)
            pendingMeetingRef.current = {
              label,
              expiresAt: Date.now() + 90000,
              launch: async () => {
                const res = await apiPost<{ meetingId: string; alreadyRunning?: boolean }>('/api/experts/roundtable/start', startParams)
                if (!res || !res.success || !res.data) throw new Error((res && res.error) || '圆桌会启动失败')
                say(`${label}已开始，${rosterText}。两轮讨论后主持收口，结论和纪要会直接落进对话窗口；会议期间您随时说话=插话，全场会听取。`, resolveExpertTtsVoice(roster[0]?.voiceStyle))
                // 进度无需轮询——roundtable:* SSE 逐条发言/收口/文档驱动对话流（useRoundtableMeetings）
              },
            }
            say(`${label}提案：${goal}。我准备请 ${roster.map(r => r.name).join('、')} 参加${leadName ? `，由${leadName}主持` : ''}。开始吗？`, resolveExpertTtsVoice(roster[0]?.voiceStyle))
          } else {
            const r = await summonExpert(summonHit.target)
            if (!r) { say('没有找到对应的岗位或部门'); return }
            if (r.type === 'expert' && r.activated) {
              say(`已接通${r.expert!.departmentLabel || ''}「${r.expert!.name}」，请讲。`, resolveExpertTtsVoice(r.expert!.voiceStyle))
            } else if (r.type === 'department' && r.activated) {
              const leadVoice = resolveExpertTtsVoice(r.members?.find(m => m.id === r.department!.lead)?.voiceStyle)
              say(`已接通${r.department!.label}，${r.department!.memberCount} 位在编岗位，主管为您服务。`, leadVoice)
            } else if (r.type === 'ambiguous' && r.candidates?.length) {
              say(`找到 ${r.candidates.length} 个相关岗位：${r.candidates.map(c => c.name).join('、')}。请说得再具体些，或到专家面板选择。`)
            } else {
              say('召唤未生效，请重试或到专家面板操作。')
            }
          }
        } catch (e: any) {
          console.warn('[shell] 专家语音指令失败:', e?.message || e)
          speech.enqueue({ id: `experts_${Date.now()}`, text: '专家服务暂不可用，请稍后再试', kind: 'panel' })
        }
      })()
      return true
    }
    // P5.5: 语音面板命令拦截（命中则不进入 LLM）
    // 用剥离前缀后的文本匹配（见上方 ct 定义）；分发内取歌名等用 ct 而非 t
    const cmd = matchPanelCommand(ct)
    if (cmd) {
      // 2026-08-15 参考实现对齐: open 时本地无可恢复内容的面板(news/会议/媒体)
      // → 不拦截, 落 LLM 由对应工具创建内容（本地关键词兜底失败降级 LLM 工具）;
      // 其余命令命中即拦截（含本地失败播报）
      let fallthroughToLLM = false
      try {
        const shell = getCommandHost('sceneShell')
        let hasPanel = true
        // 音乐面板走 FloatingMusicPlayer 全局接口（非 SceneShell 面板流）
        if (cmd.kind === 'music') {
          // A1: 经 ui-command-registry(musicPanel/musicSearch 宿主)
          if (cmd.action === 'close') {
            executeCommand('musicPanel', 'close')
          } else if (cmd.action === 'pause') {
            // 2026-08-15: "暂停音乐"本地即时暂停、保留面板
            executeCommand('musicPanel', 'pause')
          } else if (cmd.action === 'open') {
            // R8: 提取歌名——"播放周杰伦的歌" → 歌名"周杰伦" → musicSearch.openWithQuery
            // 自动搜索并播放;无歌名("播放歌曲")→ 只打开面板手动选
            // 2026-08-07: 用剥离前缀后的 ct 提取（"小龙女，播放周杰伦的歌"不再混入"小龙女"）
            const songQuery = extractSongQuery(ct)
            if (songQuery) {
              executeCommand('musicSearch', 'openWithQuery', songQuery)
            } else {
              executeCommand('musicPanel', 'open')
            }
          }
        } else if (cmd.kind === 'approval') {
          const approvalHostRef = getCommandHost('approvalHost')
          if (!approvalHostRef) {
            speech.enqueue({ id: `approval_${Date.now()}`, text: '审批面板不可用', kind: 'panel' })
          } else {
            const ok = cmd.action === 'approve' ? approvalHostRef.approve() : approvalHostRef.reject()
            speech.enqueue({
              id: `approval_${Date.now()}`,
              text: ok ? (cmd.action === 'approve' ? '已批准' : '已拒绝') : '当前没有待审批的请求',
              kind: 'panel',
            })
          }
        } else if (cmd.kind === 'management_cockpit') {
          // 阶段 B: 管理舱（设置/插件/技能/用量/调试）
          const targetMap = COCKPIT_TARGET_MAP
          const sectionMap: Record<string, string | null> = {
            model: 'model', mcp: 'mcp',
          }
          if (cmd.action === 'open') {
            const target = cmd.target || 'settings'
            // 2026-08-26 同款(1183 按钮分流)对齐: memory/evolution 是核心记忆功能
            // (记忆图谱/进化/快照), 不属调试——移出 isDevMode 解锁清单; 调试项
            // (logs/status/gateway/voice) 维持开发者模式门槛。与 COCKPIT_TARGET_MAP
            // memory→debug 映射配合: 语音"打开记忆"同样直达记忆页。
            if (['logs', 'status', 'gateway', 'voice'].includes(target) && !isDevMode()) {
              // 非开发者模式：调试功能不可达，播报引导（hasPanel=true 抑制下方通用"无面板"播报，避免双 TTS）
              hasPanel = true
              try {
                speech.enqueue({
                  id: `cockpit_${Date.now()}`,
                  text: '调试功能需要先在管理舱内开启开发者模式',
                  kind: 'panel',
                })
              } catch (err) { console.error('[shell] 开发者模式提示播报失败:', err) }
            } else {
              try {
                cockpit.setTab(targetMap[target] || 'settings')
                cockpit.setNavSection(sectionMap[target] ?? null)
                cockpit.setDebugTab(debugTabMap[target] ?? 'logs')
                cockpit.setVisible(true)
                hasPanel = true
              } catch (err) { console.error('[shell] 打开管理舱失败:', err); hasPanel = false }
            }
          } else {
            // 2026-08-19 审计: 舱未开时播报而非静默——此前「关闭数据库」在舱未开时
            // hasPanel=true 吞掉反馈(与「打开数据库」本地命中不对称)
            if (!cockpit.visible) {
              try {
                speech.enqueue({ id: `cockpit_${Date.now()}`, text: '管理舱当前未打开', kind: 'panel' })
              } catch (err) { console.error('[shell] 管理舱未打开提示播报失败:', err) }
            } else {
              try {
                // 关闭走 __cockpit.close（dirty-aware requestClose）——与 __taskPanel/__weatherPanel 同款
                const cp = getCommandHost('cockpit')
                if (cp && typeof cp.close === 'function') cp.close()
                else cockpit.setVisible(false)
              } catch (err) { console.error('[shell] 关闭管理舱失败:', err) }
            }
            hasPanel = true
          }
        } else if (cmd.kind === 'search') {
          // 2026-08-12 (搜索落地 4a): 语音"帮我找 X/搜索 X"——本地直达,不落 LLM 等 4-6s 碰运气。
          // 派发 crabpaw:open-search 事件,由下方监听打开文件面板(FileGenPanel)并播报引导
          //（detail 携带剥离前缀后的原文,预留后续透传搜索词）
          try {
            window.dispatchEvent(new CustomEvent('crabpaw:open-search', { detail: { text: ct } }))
            hasPanel = true
          } catch (err) { console.error('[shell] 派发打开搜索事件失败:', err); hasPanel = false }
        } else if (cmd.kind === 'guidance') {
          // 引导语播报：本地拦截后直接 TTS 回复（不进入 LLM），如"车次""看板"
          if (cmd.target) {
            speech.enqueue({ id: `guidance_${Date.now()}`, text: cmd.target, kind: 'panel' })
          }
          hasPanel = true
        } else if (cmd.kind === 'task_panel') {
          // 任务面板统一归 TaskPanelHost 浮层（通道 B），SceneShell 不再渲染该 kind
          const tp = getCommandHost('taskPanel')
          // P3 修复: !== false 兼容 setVisible 返回 undefined(未显式返回)的场景
          hasPanel = tp && typeof tp.setVisible === 'function'
            ? tp.setVisible(cmd.action === 'open') !== false
            : false
        } else if (cmd.kind === 'cancel_task') {
          // 2026-08-12(任务链复活): 取消任务——本地规则+事件。TaskPanelHost 持有 store,
          // 由它找最近 running flow 面板并 POST /api/taskflows/:id/cancel(组件内自处置)
          try {
            window.dispatchEvent(new CustomEvent('crabpaw:cancel-task'))
            hasPanel = true
          } catch (err) { console.error('[shell] 派发取消任务事件失败:', err); hasPanel = false }
        } else if (cmd.kind === 'filegen') {
          // 文件生成面板打开/关闭/转换（2026-08-17: 替代 DocReader,经 __filePanel 全局接口）
          // convert：打开面板后由用户继续语音描述（如"把这篇文档转成 Word"）触发实际转换
          const panel = getCommandHost('filePanel')
          hasPanel = panel && typeof panel.setVisible === 'function'
            ? panel.setVisible(cmd.action !== 'close') !== false
            : false
          if (cmd.action === 'open' && !hasPanel) {
            // 兜底：无任务时打开面板显示空态引导
            hasPanel = true
          }
        } else if (cmd.kind === 'meeting_recording') {
          // 会议记录面板（2026-08-18 会议卡片轮）——MeetingPanel 常驻挂载,宿主恒在:
          // open+target:'start' → 开卡录音;open+target:'history' → 历史列表;
          // close+target:'stop' → 停止并总结;其余 close → 关闭面板。
          // 语音「开始记录/记录一下」直达宿主,不经 LLM,不依赖 intent 路由。
          const mp = getCommandHost('meetingPanel')
          if (!mp) {
            // 宿主未挂载（异常场景）→ 落 LLM 由 meeting_mode 工具接管
            hasPanel = false
            fallthroughToLLM = true
          } else {
            try {
              if (cmd.action === 'open') {
                if (cmd.target === 'start' && typeof mp.startRecording === 'function') mp.startRecording()
                else if (typeof mp.openHistory === 'function') mp.openHistory()
              } else if (cmd.target === 'stop' && typeof mp.stopRecording === 'function') {
                mp.stopRecording()
              } else if (typeof mp.close === 'function') {
                mp.close()
              }
              hasPanel = true // 宿主恒在,本地已接管
            } catch (err) { console.error('[shell] 会议面板命令执行失败:', err); hasPanel = false }
          }
        } else if (cmd.kind === 'schedule') {
          // 日程卡片（2026-08-19）——SchedulePanel 常驻挂载,宿主恒在:
          // open → 打开日程卡片(近 7 天日程);close → 关闭卡片。
          // 语音「打开日程/日历」直达宿主,不经 LLM(数据走 /api/calendar)。
          const sp = getCommandHost('schedulePanel')
          if (!sp) {
            // 宿主未挂载（异常场景）→ 落 LLM 由 SceneSet 工具接管
            hasPanel = false
            fallthroughToLLM = true
          } else {
            try {
              if (cmd.action === 'open' && typeof sp.open === 'function') sp.open()
              else if (typeof sp.close === 'function') sp.close()
              hasPanel = true // 宿主恒在,本地已接管
            } catch (err) { console.error('[shell] 日程卡片命令执行失败:', err); hasPanel = false }
          }
        } else if (cmd.kind === 'knowledge') {
          // 知识库面板（2026-08-20）——KnowledgePanel 常驻挂载,宿主恒在:
          // open → 打开知识库卡片(检索/文档清单/SRS 复习);close → 关闭面板。
          // 语音「打开知识库」直达宿主,不经 LLM(数据走 /api/kb/*)。
          // 内容问题("知识库里 XX 是多少")不在此拦截 → 落 LLM 走 kb_query 意图。
          const kp = getCommandHost('knowledgePanel')
          if (!kp) {
            // 宿主未挂载（异常场景）→ 落 LLM 由 SceneSet 工具接管
            hasPanel = false
            fallthroughToLLM = true
          } else {
            try {
              if (cmd.action === 'open' && typeof kp.open === 'function') kp.open()
              else if (typeof kp.close === 'function') kp.close()
              hasPanel = true // 宿主恒在,本地已接管
            } catch (err) { console.error('[shell] 知识库卡片命令执行失败:', err); hasPanel = false }
          }
        } else if (cmd.kind === 'history') {
          // Task 13: 会话历史抽屉——语音命令"历史/历史会话/查看历史/会话记录"
          if (cmd.action === 'open') {
            // A2: 语音开历史抽屉与按钮同口径——管理舱由 sheet-state 互斥自动收起
            setHistoryDrawerOpen(true)
            hasPanel = true
          } else {
            setHistoryDrawerOpen(false)
            hasPanel = false
          }
        } else if (cmd.kind === 'media') {
          // 媒体面板打开/关闭（MediaStage 全局接口）
          const ms = getCommandHost('mediaStage')
          if (cmd.action === 'open') {
            if (ms && typeof ms.open === 'function') { ms.open(); hasPanel = true }
            else {
              // 2026-08-15: 接口仅在媒体场景卡挂载时注册——无卡即无接口,
              // open 落 LLM（SceneMedia/GenerateImage 等工具创建卡后自动弹出）
              hasPanel = false
              fallthroughToLLM = true
            }
          } else {
            if (ms && typeof ms.close === 'function') {
              ms.close()
              // 2026-09-05: 关闭执行反馈——此前静默执行, 用户感知"没反应"
              speech.enqueue({ id: `media_${Date.now()}`, text: '好的，媒体面板已关闭', kind: 'panel' })
            }
            hasPanel = false
          }
        } else if (cmd.kind === 'scene') {
          // 对话面板/场景卡关闭——SceneShell 关闭最上层面板
          const shellScene = getCommandHost('sceneShell')
          if (shellScene && typeof shellScene.closeTop === 'function') shellScene.closeTop()
          hasPanel = false
        } else if (cmd.kind === 'scene-card') {
          // 通用"收起/关闭卡片"（P1 缺陷 2：此前被 doc close 规则劫持）——
          // 派发统一事件，由 crabpaw:close-scene-card 监听关闭最上层场景卡
          try { window.dispatchEvent(new CustomEvent('crabpaw:close-scene-card')) }
          catch (err) { console.error('[shell] 派发关闭场景卡事件失败:', err) }
          hasPanel = false
        } else if (cmd.kind === 'skill') {
          // 技能执行全息卡关闭（SkillStageHost 全局接口）
          const ss = getCommandHost('skillStage')
          if (ss && typeof ss.close === 'function') ss.close()
          hasPanel = false
        } else if (cmd.kind === 'weather' || cmd.kind === 'hotspot' || cmd.kind === 'typhoon' || cmd.kind === 'stock') {
          // 天气/热点/台风/股票归独立组件（App 根层常驻），走全局显隐接口
          const panel = getCommandHost(({ weather: 'weatherPanel', hotspot: 'hotspotPanel', typhoon: 'typhoonPanel', stock: 'stockPanel' } as Record<string, string>)[cmd.kind])
          // P3: !== false 兼容 setVisible 返回 undefined
          hasPanel = panel && typeof panel.setVisible === 'function'
            ? panel.setVisible(cmd.action === 'open') !== false
            : false
          // 2026-08-15: 无数据可恢复的 open(天气/台风/股票) → **前端自取数据直开面板**
          // (GET /panels/<name>, 后端自动 upsert surface)——不再落 LLM。此前落 LLM 的
          // 问题: 按需工具注入的意图分类器可能把"打开股票面板"判成 file_operation,
          // 工具集裁剪后无 ShowStock → LLM 换文档工具 → 文档生成舱误开(用户实锤)。
          // 天气端点不自动 upsert, 前端映射后手动 upsert surface。
          if (cmd.action === 'open' && !hasPanel && cmd.kind !== 'hotspot') {
            hasPanel = true // 已本地接管
            const kind = cmd.kind
            // 2026-08-27 面板禁用开关: 语音直开绕过了 registry 读面过滤（P2 核查实锤）——
            // weather/stock 直开改按面板启用态门控（12s 缓存, 复用 /api/panels/state 面板集语义）。
            // handleUserInput 非 async, 门控以 promise 链前置实现（语义同 await 版）。
            const gate = (kind === 'weather' || kind === 'stock') ? checkPanelEnabled(kind) : Promise.resolve(null as boolean | null)
            gate.then(enabled => {
              if (enabled === false) {
                speech.enqueue({ id: `panel_disabled_${Date.now()}`, text: `${kind === 'weather' ? '天气' : '股票'}面板已停用，可在管理舱插件页启用`, kind: 'panel' })
                return
              }
              apiGet<any>(`/panels/${kind}${kind === 'weather' ? '' : '?refresh=1'}`)
                .then(res => {
                  if (kind === 'weather' && res?.data) {
                    const w = res.data.data || {}
                    apiPost('/api/scene/upsert', {
                      id: 'weather-panel',
                      data: {
                        kind: 'weather',
                        data: {
                          city: w.city || '北京',
                          temp: w.current?.temp || '',
                          condition: w.current?.condition || '',
                          humidity: w.current?.humidity || '',
                          wind: w.current?.wind || '',
                          forecast: (w.forecast || []).slice(0, 5),
                        },
                        intent: 'inform',
                      },
                    }).catch(e => console.warn('[shell] 天气 surface upsert 失败:', e))
                  }
                  // typhoon/stock 端点已自动 upsert surface → 面板自动打开
                })
                .catch(e => {
                  console.error(`[shell] 面板自取数据失败(${kind}):`, e)
                  speech.enqueue({ id: `panel_fail_${Date.now()}`, text: `${panelLabel(kind as any)}数据获取失败，请稍后再试`, kind: 'panel' })
                })
            })
          }
        } else if (cmd.kind === '*') {
          if (shell?.closeTop) shell.closeTop()
        } else if (shell?.setVisible) {
          // P3: !== false 兼容 setVisible 返回 undefined
          hasPanel = shell.setVisible(cmd.kind, cmd.action === 'open') !== false
          // 2026-08-15: news/meeting_recording 的 open 在无卡可恢复时落 LLM
          // （对应工具: ShowHotspot(format=scene)/meeting_mode 创建场景卡）
          if (cmd.action === 'open' && !hasPanel && (cmd.kind === 'news' || cmd.kind === 'meeting_recording')) {
            fallthroughToLLM = true
          }
        }
        // R11: 动作型命令成功执行 → 静默(用户从 UI 看到效果,如面板打开/歌曲播放),
        // 不再播报"已打开XX/已关闭XX"确认——语音播报只留给"失败/需说明"的场景。
        // 仅当"请求打开但实际没有该面板"时简短播报说明（落 LLM 的除外）。
        if (!fallthroughToLLM && cmd.action === 'open' && !hasPanel) {
          speech.enqueue({
            id: `panel_${Date.now()}`,
            text: `当前没有进行中的${panelLabel(cmd.kind)}`,
            kind: 'panel',
          })
        }
      } catch (e) {
        console.error('[shell] 面板命令执行失败:', e)
      }
      // 2026-08-15: fallthrough → 不拦截, 落到下方 LLM 发送流程
      if (!fallthroughToLLM) return true
    }
    // 本地命令快速拦截（音乐/热点面板关闭 —— 全局事件，Dashboard 同款）
    if (/关闭.*音乐|关掉.*音乐|停止音乐/.test(t)) {
      try {
        executeCommand('musicPanel', 'close')
      } catch (e) {
        console.error('[shell] 关闭音乐面板:', e)
      }
      return true
    }
    // 2026-08-18: 会议录制期语音隔离——开会转写只进卡片,不进 AI 对话流。
    // 本地命令分发在其上方已完成(「结束记录/停止记录」照常工作),其余语音
    // 一律吞掉,不 pushChat、不进 LLM;卡片内实时转写由 ASR 通道直连。
    if (getCommandHost('meetingPanel')?.isRecording?.()) return true
    return false
  }, [speech, applyShellConfig, pushChat, cockpit, setHistoryDrawerOpen, visibleSurfaces])
}
