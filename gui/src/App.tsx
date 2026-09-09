import { useState, useEffect, useRef } from 'react'
import { registerCommandHost } from './lib/ui-command-registry'
import { TaskPanelHost } from './components/TaskPanelHost'
import { UiCommandBridge } from './components/UiCommandBridge'
import { VoiceStateProvider } from './contexts/VoiceStateContext'
import { VoiceShell } from './pages/VoiceShell'
import { SplashScreen } from './components/SplashScreen'
import { FloatingMusicPlayer } from './components/FloatingMusicPlayer'
import { WeatherPopup } from './components/WeatherPopup'
import { HotspotPanel } from './components/HotspotPanel'
import { TyphoonPanel } from './components/TyphoonPanel'
import { StockPanel } from './components/StockPanel'
import { MediaStageHost } from './components/MediaStage/MediaStageHost'
import { FileGenPanel } from './components/FileGenPanel'
import { MeetingPanel } from './components/MeetingPanel'
import BusinessReportPanel from './components/BusinessReportPanel'
import CommodityPanel from './components/CommodityPanel'
import { SchedulePanel } from './components/SchedulePanel'
import { KnowledgePanel } from './components/KnowledgePanel'
import { SkillStageHost } from './components/SkillStageHost'
import { ApprovalHost } from './components/ApprovalHost'
import { SetupWizard } from './components/SetupWizard'
import { apiGet, apiPost } from './lib/api'
import { startSceneClient, stopSceneClient } from './lib/scene-client'
import { toast } from 'sonner'

/**
 * 应用入口（单界面）
 *
 * 单界面：启动直接进 VoiceShell（语音优先）。
 * 全局 Provider（VoiceState/Plugin）——场景卡统一由 VoiceShell holo-stage 渲染
 * （Agent 场景卡片持续投影）。
 *
 * 2026-08-14: AgentHome 宣传页删除（G5 回滚）——启动恒进 shell;
 * 后端服务自动启动迁移至 VoiceShell 挂载 effect（service:start 幂等）。
 */
function App() {
  // 2026-08-03: scene-client 提升到 App 根层（常驻）——此前只在管理控制台启动，
  // 贾维斯模式前端收不到任何 surface → 音乐/天气/热点面板全部无法打开
  useEffect(() => {
    try {
      startSceneClient()
      console.log('[app] scene-client 已启动（常驻）')
    } catch (e) {
      console.error('[app] scene-client 启动失败:', e)
    }
    // 2026-08-15 用户反馈: 重启应用后不应自动打开任何面板——面板类 surface
    // (天气/热点/台风/股票/音乐)可能因上次会话遗留, 启动即清理, 干净开局。
    // fire-and-forget: 失败仅告警, 不影响启动。
    // 2026-08-25 修复: 补 media/media_stage——重启窗口后媒体 surface 复活自动播放
    // (视频卡聚合恢复 → 黑屏+音频; 8-15 裁决「启动不自动打开任何面板」口径)
    const PANEL_SURFACE_IDS = ['weather-panel', 'hotspot-panel', 'typhoon-panel', 'stock-panel', 'music-player', 'file-panel', 'media', 'media_stage']
    for (const id of PANEL_SURFACE_IDS) {
      apiPost('/api/scene/remove', { id }).catch(e => console.warn(`[app] 启动清理面板 surface 失败(${id}):`, e))
    }
    return () => {
      try { stopSceneClient() } catch (e) { console.error('[app] scene-client 停止失败:', e) }
    }
  }, [])

  // 2026-08-31 深度检查修复: index.html 静态 bootstrap 闪屏(#splash-bootstrap,
  // z-index:9999 全屏遮罩)的移除不再依赖 SplashScreen 挂载——skipSplash 路径
  // 不渲染 SplashScreen, 此前无人移除该遮罩 → 应用被永久盖死
  useEffect(() => {
    const el = document.getElementById('splash-bootstrap')
    if (el) el.remove()
  }, [])

  // P2-1 (2026-08-12): KWS 致命状态提示——useKwsWakeWord 在 wake:status fatal 时派发
  // crabpaw:kws-fatal 事件（唤醒进程崩溃/模型缺失，唤醒不可用）。App 是全局外壳、
  // 与 VoiceShell 生命周期解耦，常驻监听最稳妥；提示引导重启或用手动按钮。
  // 2026-08-15: 记录致命 toast id——KWS 自愈恢复后 dismiss 掉,避免"已禁用"与
  // "已恢复"两条相互矛盾的提示同时挂在屏幕上(duration:0 的 toast 不自动消失)
  const kwsFatalToastRef = useRef<number | string | null>(null)
  useEffect(() => {
    const onKwsFatal = () => {
      try {
        kwsFatalToastRef.current = toast.error('唤醒功能已禁用（KWS 异常），请重启应用或使用手动按钮', { duration: 0 })
      } catch (err) { console.error('[app] KWS 致命提示展示失败:', err) }
    }
    const onKwsRecovered = () => {
      try {
        if (kwsFatalToastRef.current !== null) {
          toast.dismiss(kwsFatalToastRef.current)
          kwsFatalToastRef.current = null
        }
        toast.success('唤醒功能已恢复')
      } catch (err) { console.error('[app] KWS 恢复提示展示失败:', err) }
    }
    window.addEventListener('crabpaw:kws-fatal', onKwsFatal)
    window.addEventListener('crabpaw:kws-recovered', onKwsRecovered)
    return () => {
      window.removeEventListener('crabpaw:kws-fatal', onKwsFatal)
      window.removeEventListener('crabpaw:kws-recovered', onKwsRecovered)
    }
  }, [])

  // P5.5: 启动闪屏（服务扫描可视化）
  const [checkingConfig, setCheckingConfig] = useState(true)
  const [isFirstLaunch, setIsFirstLaunch] = useState(false)
  const [splashComplete, setSplashComplete] = useState(() =>
    (window as any).__crabpawSplashDone === true ||
    new URLSearchParams(window.location.search).has('skipSplash')
  )

  // P5.5: 浮动音乐播放器提升到 App 层（常驻，VoiceShell 语音命令可开）
  const [musicVisible, setMusicVisible] = useState(false)
  const [musicQuery, setMusicQuery] = useState('')
  // 2026-08-15: 查询 nonce——同 query 重复请求（再次说"放周杰伦的歌"）时 React
  // 相同 state 不触发重渲染 → FMP initialQuery effect 不重跑。nonce 每次 +1 强制重搜。
  const [musicQueryNonce, setMusicQueryNonce] = useState(0)

  // P5.5: 全局带查询词开音乐（SSE music_search 事件用）
  useEffect(() => {
    // A1(2026-09-05): 经 ui-command-registry 注册(旧 window.__openMusicWithQuery 退役)
    const unregisterMusicSearch = registerCommandHost('musicSearch', {
      openWithQuery: (query: string) => {
        setMusicQuery(query)
        setMusicVisible(true)
        setMusicQueryNonce(n => n + 1)
      },
    })
    return () => { unregisterMusicSearch() }
  }, [])

  useEffect(() => {
    if (splashComplete) return
    const loadConfigOnce = async () => {
      try {
        // 2026-08-03: 优先主进程 IPC 读配置（不依赖后端就绪）。
        // 此前走 HTTP /api/config——启动早期后端未起时 2s 超时必失败 →
        // isFirstLaunch 误判 true → 误切管理后台 + 弹设置向导（setupCompleted 实际为 true）
        if (window.electronAPI?.config?.get) {
          const cfg = await window.electronAPI.config.get()
          if (cfg && typeof cfg.setupCompleted === 'boolean') {
            setIsFirstLaunch(cfg.setupCompleted !== true)
            setCheckingConfig(false)
            return
          }
        }
        // 降级：HTTP /config（非 Electron 或 IPC 不可用）
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 2000)
        const result = await apiGet('/config', { signal: controller.signal })
        clearTimeout(timeout)
        if (result.success && result.data) {
          setIsFirstLaunch(result.data.setupCompleted !== true)
        } else {
          setIsFirstLaunch(true)
        }
      } catch (e) {
        console.error('[app] splash config 检查失败, 按首次启动处理:', e)
        setIsFirstLaunch(true)
      } finally {
        setCheckingConfig(false)
      }
    }
    loadConfigOnce()
  }, [splashComplete])

  return (
    <VoiceStateProvider>
      {!splashComplete ? (
          <SplashScreen
            checkingConfig={checkingConfig}
            isFirstLaunch={isFirstLaunch}
            onSplashComplete={() => {
              ;(window as any).__crabpawSplashDone = true
              setSplashComplete(true)
            }}
          />
        ) : isFirstLaunch ? (
          /* 首启：SetupWizard 直接渲染（替换 VoiceShell，避免唤醒词测试与 shell KWS 双订阅）。
             onStartService 传 channel 'none'——首启无已配置渠道，与既有
             chatChannelRef 初值一致；SetupWizard 保存配置时已写入 chatChannel，后端 service:start
             会按 config 自动启用 bridge（main/index.ts 1498-1505）。 */
          <SetupWizard
            onComplete={() => setIsFirstLaunch(false)}
            onStartService={async () => {
              if (window.electronAPI?.service?.start) {
                await window.electronAPI.service.start({ channel: 'none' })
              }
            }}
          />
        ) : (
          <>
            <VoiceShell />
            <TaskPanelHost />
            {/* 2026-08-13 P2-3: ControlUI 命令桥(agent 操作界面,唯一订阅者) */}
            <UiCommandBridge />
          </>
        )}
        {/* P5.5: 浮动音乐播放器（常驻） */}
        <FloatingMusicPlayer
          visible={musicVisible}
          onClose={() => {
            setMusicVisible(false)
            apiPost('/api/scene/remove', { id: 'music-player' }).catch((e) => console.error('[app] music-player 场景移除失败:', e))
            apiPost('/api/scene/panel-state', { panel: 'music', state: 'closed' }).catch((e) => console.error('[app] music 面板状态写入失败:', e))
          }}
          initialQuery={musicQuery}
          queryNonce={musicQueryNonce}
        />
        {/* P5.5: 天气/热点面板（常驻） */}
        <WeatherPopup />
        <HotspotPanel />
        {/* 2026-08-14: 台风追踪面板（常驻，同热点 70% 组合布局） */}
        <TyphoonPanel />
        {/* 2026-08-14: 股票行情面板（常驻，SideSheet 互斥） */}
        <StockPanel />
        {/* 2026-08-15: 媒体/视频面板常驻宿主（70vw 组合布局, 修复"打不开"） */}
        <MediaStageHost />
        {/* 2026-08-17: 文件生成面板（常驻，替代 DocReader 生成舱 + 阅读器） */}
        <FileGenPanel />
        {/* 2026-08-18: 会议记录面板（常驻，语音「开始记录」弹出录音并生成纪要） */}
        <MeetingPanel />
        <BusinessReportPanel />
        <CommodityPanel />
        {/* 2026-08-19: 日程卡片（常驻，语音「打开日程/日历」弹出近 7 天日程） */}
        <SchedulePanel />
        {/* 2026-08-20: 知识库面板（常驻，语音「打开知识库」弹出检索/文档清单/SRS 复习） */}
        <KnowledgePanel />
        {/* 2026-08-04: 技能执行全息卡（常驻） */}
        <SkillStageHost />
        {/* 2026-08-04: 全局审批宿主（常驻） */}
        <ApprovalHost />
    </VoiceStateProvider>
  )
}

export default App
