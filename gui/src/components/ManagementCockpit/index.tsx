/**
 * ManagementCockpit — 管理舱（贾维斯单界面·阶段 B）。
 * 全屏玻璃浮层（复用 VoiceShell 配置浮层 CSS），薄 tab 壳：
 *   overview  → 总览主屏（OverviewPanel，六卡健康矩阵+告警聚合）
 *   settings  → 完整 Settings（navSection 深度链接模型/MCP/权限等 section）
 *   plugin    → PluginManagerPanel（零 props）
 *   skills    → SkillsManagement（零 props，自身 h-full）
 *   cost      → CostDashboardPanel（零 props）
 *   debug     → 调试子页（仅开发者模式，见 Task 2）
 * 每次开关/切 tab 重新挂载目标组件（各组件自取数据，安全 remount）。
 * 未保存设置变更（Settings onDirtyChange）→ 切 tab/关闭前弹确认。
 */

import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { LayoutDashboard, Settings2, Plug, BrainCircuit, Puzzle, Sparkles, Gauge, Bug } from 'lucide-react'
import { isDevMode } from '../../lib/dev-mode'
import { registerCommandHost } from '../../lib/ui-command-registry'
import type { DebugPanelTab } from './DebugPanel'

const SettingsPanel = lazy(() => import('../../pages/Settings').then(m => ({ default: m.Settings })))
const PluginManagerPanel = lazy(() => import('../../pages/Settings/PluginManagerPanel').then(m => ({ default: m.default })))
const SkillsManagement = lazy(() => import('../../pages/SkillsManagement').then(m => ({ default: m.SkillsManagement })))
const CostDashboardPanel = lazy(() => import('../CostDashboard').then(m => ({ default: m.CostDashboardPanel })))
const DebugPanel = lazy(() => import('./DebugPanel').then(m => ({ default: m.DebugPanel })))
const OverviewPanel = lazy(() => import('./OverviewPanel').then(m => ({ default: m.default })))
// 2026-08-19: 业务面板退役——专家/数据库连接/经营数据迁入管理舱「专家·数据」tab
// 2026-08-21: 「专家·数据」拆分为「专家」+「数据」两个 tab
const ExpertsPanel = lazy(() => import('../ExpertsPanel').then(m => ({ default: m.ExpertsPanel })))
const MCPConfigSection = lazy(() => import('../MCPConfigSection').then(m => ({ default: m.MCPConfigSection })))

export type CockpitTab = 'overview' | 'settings' | 'plugin' | 'skills' | 'cost' | 'expert' | 'debug' | 'mcp'

interface ManagementCockpitProps {
  visible: boolean
  onClose: () => void
  initialTab?: CockpitTab
  navSection?: string | null   // 深度链接 Settings section（如 'model'）
  debugTab?: string            // 深度链接 DebugPanel 子页（如 'logs' | 'status' | 'gateway' | 'memory'）
  /** 全局搜索 keyword——透传技能/专家/插件面板 initialKeyword（挂载时初始化过滤） */
  keyword?: string | null
  /** 专家"召唤"→ 插入聊天并自动发送（VoiceShell 侧处理，空串语义=不插） */
  onInsertToChat?: (text: string) => void
}

const TABS: { id: CockpitTab; label: string; icon: any }[] = [
  { id: 'overview', label: '总览', icon: LayoutDashboard },
  { id: 'settings', label: '系统设置', icon: Settings2 },
  // 2026-08-21: MCP 服务从设置页提出，与插件/技能同级，改名「连接」
  { id: 'mcp', label: '连接', icon: Plug },
  // 2026-08-21: 「专家·数据」拆分——专家独立一页（ExpertsPanel），数据页收纳数据库连接+经营数据
  { id: 'expert', label: '专家', icon: BrainCircuit },
  { id: 'plugin', label: '插件', icon: Puzzle },
  { id: 'skills', label: '技能', icon: Sparkles },
  { id: 'cost', label: '用量', icon: Gauge },
]

export function ManagementCockpit({ visible, onClose, initialTab = 'overview', navSection = null, debugTab, keyword = null, onInsertToChat }: ManagementCockpitProps) {
  const [tab, setTab] = useState<CockpitTab>(initialTab)
  const [section, setSection] = useState<string | null>(navSection)
  const [debugTabState, setDebugTabState] = useState<string>(debugTab ?? 'logs')
  const [settingsDirty, setSettingsDirty] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)

  const wasVisibleRef = useRef(false)
  // 待应用的重定向目标（脏时经确认后应用）：{ tab, section, debugTab }
  const pendingTargetRef = useRef<{ tab: CockpitTab; section: string | null; debugTab?: string } | null>(null)
  // 上次生效的 props 目标——检测"已打开时"的 re-target（避免与内部 tab/section 状态变化打架）
  const lastTargetRef = useRef<{ tab: CockpitTab; section: string | null; debugTab: string } | null>(null)
  const requestCloseRef = useRef<() => void>(() => {})

  const requestClose = () => {
    if (settingsDirty) { setConfirmClose(true); return }
    onClose()
  }
  requestCloseRef.current = requestClose   // 保持最新闭包

  // 切 tab 统一入口：tabbar 按钮 / 调试 tab / OverviewPanel onNavigate 共用。
  // 同 tab 幂等；settings 脏 → 存 pendingTarget + 弹确认，不静默丢弃未保存更改。
  // 2026-08-28 CK3: 支持可选 section——总览快捷动作(模型/安全配置)直达设置对应分区。
  const switchTab = (t: CockpitTab, section: string | null = null) => {
    if (t === tab) {
      if (section) setSection(section)
      return
    }
    if (settingsDirty) {
      pendingTargetRef.current = { tab: t, section, debugTab: undefined }
      setConfirmClose(true)
      return
    }
    setTab(t)
    if (section) setSection(section)
  }

  // 仅在 closed→open 过渡时重置到目标 tab/section（re-target 走下方脏检查路径）
  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      setTab(initialTab)
      setSection(navSection)
      setDebugTabState(debugTab ?? 'logs')
      setSettingsDirty(false)
      setConfirmClose(false)
      pendingTargetRef.current = null
    }
    wasVisibleRef.current = visible
  }, [visible])   // 注意：不含 initialTab/navSection

  // re-target：已打开时收到新的 initialTab/navSection/debugTab props → 走脏检查
  // （脏 → 存 pendingTargetRef + 弹确认；非脏 → 直接应用）
  useEffect(() => {
    const next = { tab: initialTab, section: navSection, debugTab: debugTab ?? 'logs' }
    if (!visible) { lastTargetRef.current = null; return }
    if (!lastTargetRef.current) { lastTargetRef.current = next; return }  // 首次（open 过渡已由上方 effect 重置）
    const prev = lastTargetRef.current
    const changed = prev.tab !== next.tab || prev.section !== next.section || prev.debugTab !== next.debugTab
    if (changed) {
      if (settingsDirty) {
        pendingTargetRef.current = { tab: initialTab, section: navSection, debugTab }
        setConfirmClose(true)
      } else {
        setTab(initialTab)
        setSection(navSection)
        setDebugTabState(debugTab ?? 'logs')
      }
    }
    lastTargetRef.current = next
  }, [visible, initialTab, navSection, debugTab, settingsDirty])

  // Esc 关闭：走 requestClose（脏检查）而非直接 onClose——与 Settings 浮层对齐，
  // 防止未保存的设置编辑被 Esc 静默丢弃
  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (confirmClose) { setConfirmClose(false); pendingTargetRef.current = null; return }
      requestClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, confirmClose, settingsDirty])

  // crabpaw:navigate（Status/Gateway/News 的"去设置"按钮）→ 切到 settings 并定位 section。
  // 2026-08-19 审计修复: 与 tab 按钮同款 dirty 检查——此前直接 setTab 会在用户有未保存
  // 更改时静默丢弃（Settings 自身也监听该事件直接 setActiveSection,已挂载时双响应同向无害）。
  useEffect(() => {
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail && detail.tab === 'settings') {
        if (settingsDirty) {
          pendingTargetRef.current = { tab: 'settings', section: detail.section || null, debugTab: undefined }
          setConfirmClose(true)
        } else {
          setTab('settings')
          setSection(detail.section || null)
        }
      }
    }
    window.addEventListener('crabpaw:navigate', onNav)
    return () => window.removeEventListener('crabpaw:navigate', onNav)
  }, [settingsDirty])

  // 全局接口：close（dirty-aware requestClose）+ open/openWith（经 custom event 通知 VoiceShell）。
  // 2026-08-27 全局搜索: openWith 带 section/keyword 直达（CommandPalette 管理舱分组选中）
  useEffect(() => {
    // A1(2026-09-05): 全局接口经 ui-command-registry 注册(旧 window.__cockpit 镜像退役)
    const unregisterCockpit = registerCommandHost('cockpit', {
      close: () => requestCloseRef.current(),
      open: (tab?: string) => {
        window.dispatchEvent(new CustomEvent('crabpaw:open-cockpit', { detail: { tab: tab || 'settings' } }))
      },
      openWith: (tab?: string, section?: string | null, keyword?: string) => {
        window.dispatchEvent(new CustomEvent('crabpaw:open-cockpit', { detail: { tab: tab || 'settings', section, keyword } }))
      },
    })
    return () => { unregisterCockpit() }
  }, [])

  if (!visible) return null

  return (
    <>
      <div className="voice-shell-config-mask" onClick={requestClose}>
        <div className="voice-shell-config-full" onClick={(e) => e.stopPropagation()}>
          <div className="vs-config-full-head">
            <span>⚙ 管理舱</span>
            <span className="vs-config-full-sub">系统管理 · 与控制台设置页一致</span>
            <button type="button" className="vs-config-close" onClick={requestClose} title="关闭">✕</button>
          </div>
          <div className="cockpit-tabbar">
            {TABS.map(t => (
              <button
                key={t.id}
                type="button"
                className={`cockpit-tab inline-flex items-center gap-1.5${tab === t.id ? ' is-active' : ''}`}
                onClick={() => switchTab(t.id)}
              >
                <t.icon className="w-3.5 h-3.5" />
                {t.label}
              </button>
            ))}
            {isDevMode() && (
              <button
                type="button"
                className={`cockpit-tab inline-flex items-center gap-1.5${tab === 'debug' ? ' is-active' : ''}`}
                onClick={() => switchTab('debug')}
              >
                <Bug className="w-3.5 h-3.5" />
                调试
              </button>
            )}
          </div>
          <div className="vs-config-full-body">
            <Suspense fallback={<div className="vs-config-loading">加载中…</div>}>
              {tab === 'overview' && (
                <div className="p-6 overflow-y-auto h-full">
                  <OverviewPanel onNavigate={switchTab} />
                </div>
              )}
              {tab === 'settings' && (
                // 2026-08-19 审计修复: 去掉 key={section ?? 'default'}——此前 navSection 定位后
                // onNavConsumed 清空 section → key 变化 → Settings 卸载重挂 → 定位闪回默认页。
                // 切 tab 重挂由条件渲染本身保证;重复定位改由 Settings 内 effect([navSection])承载。
                <SettingsPanel
                  navSection={section}
                  onNavConsumed={() => setSection(null)}
                  onDirtyChange={setSettingsDirty}
                />
              )}
              {tab === 'mcp' && (
                <div className="p-6 overflow-y-auto h-full">
                  <MCPConfigSection />
                </div>
              )}
              {tab === 'plugin' && (
                <div className="p-6 overflow-y-auto h-full">
                  <PluginManagerPanel key={keyword ?? 'kw-default'} initialKeyword={keyword ?? ''} />
                </div>
              )}
              {tab === 'skills' && (
                <div className="h-full">
                  <SkillsManagement key={keyword ?? 'kw-default'} initialKeyword={keyword ?? ''} />
                </div>
              )}
              {tab === 'cost' && <div className="p-6 overflow-y-auto h-full"><CostDashboardPanel /></div>}
              {/* 2026-08-21: 「专家·数据」拆分——专家独立一页；数据页(数据库连接+经营数据面板)已整体删除 */}
              {tab === 'expert' && (
                <section className="p-6 h-full flex flex-col min-h-0">
                  <h3 className="font-medium mb-3 theme-text-primary">🤖 专家</h3>
                  <div className="flex-1 min-h-0 overflow-hidden">
                    <ExpertsPanel
                      key={keyword ?? 'kw-default'}
                      initialKeyword={keyword ?? ''}
                      // 2026-08-26 E2: 召唤 → 插入引导话术(对齐 WorkBuddy 显式指令模式)——
                      // 纯专家名在输入框里 LLM 只当普通文本(后端人设不生效),
                      // 话术自带"以 X 身份回答"指令 + 用户可追加具体问题。
                      // 后端 expert-context 同此按 routingKeywords 识别激活人设。
                      onSummon={expert => {
                        const roleLine = expert.title ? `（${expert.title}）` : ''
                        onInsertToChat?.(`请以「${expert.name}」${roleLine}的身份回答：`)
                        onClose?.()
                      }}
                      onNavigateChat={onClose}
                    />
                  </div>
                </section>
              )}
              {tab === 'debug' && <DebugPanel key={debugTabState ?? 'logs'} initialTab={(debugTabState as DebugPanelTab) ?? 'logs'} />}
            </Suspense>
          </div>
          <div className="vs-config-full-foot">
            <span>Esc 关闭 · 修改后需点击「保存所有」生效</span>
            <button type="button" className="vs-config-close-btn" onClick={requestClose}>关闭</button>
          </div>
        </div>
      </div>

      {confirmClose && (
        <div className="voice-shell-config-mask" style={{ zIndex: 90 }} onClick={() => { setConfirmClose(false); pendingTargetRef.current = null }}>
          <div className="vs-config-confirm" onClick={(e) => e.stopPropagation()}>
            <h3 className="vs-config-confirm-title">放弃未保存的更改？</h3>
            <p className="vs-config-confirm-text">您有未保存的配置更改。确定放弃并继续吗？</p>
            <div className="vs-config-confirm-actions">
              <button type="button" className="vs-config-confirm-cancel" onClick={() => { setConfirmClose(false); pendingTargetRef.current = null }}>继续编辑</button>
              <button type="button" className="vs-config-confirm-ok" onClick={() => {
                setConfirmClose(false)
                setSettingsDirty(false)
                const pending = pendingTargetRef.current
                pendingTargetRef.current = null
                if (pending) {
                  setTab(pending.tab)
                  setSection(pending.section)
                  if (pending.debugTab) setDebugTabState(pending.debugTab)
                } else {
                  onClose()
                }
              }}>确定放弃</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
