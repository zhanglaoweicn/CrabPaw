/**
 * DebugPanel — 管理舱调试页签（仅开发者模式显示）。
 * 子页：日志/状态/网关/记忆/进化日志/语音诊断。
 * 容器契约：Logs/EvolutionLog 自身 h-full + 滚动；Status/Gateway 自带 p-6；MemoryPanel 自带 p-6。
 */

import { lazy, Suspense, useState } from 'react'
import { isDevMode, setDevMode } from '../../lib/dev-mode'

export type DebugPanelTab = 'logs' | 'status' | 'gateway' | 'memory' | 'evolution' | 'voice'

const Logs = lazy(() => import('../../pages/Logs').then(m => ({ default: m.Logs })))
const Status = lazy(() => import('../../pages/Status').then(m => ({ default: m.Status })))
const Gateway = lazy(() => import('../../pages/Gateway').then(m => ({ default: m.Gateway })))
const MemoryPanel = lazy(() => import('../../pages/Memory').then(m => ({ default: m.MemoryPanel })))
const EvolutionLog = lazy(() => import('../../pages/EvolutionLog').then(m => ({ default: m.EvolutionLog })))
const VoiceDiagnostics = lazy(() => import('../VoiceDiagnostics').then(m => ({ default: m.VoiceDiagnostics })))

const DEBUG_TABS: { id: DebugPanelTab; label: string }[] = [
  { id: 'logs', label: '日志' },
  { id: 'status', label: '状态' },
  { id: 'gateway', label: '网关' },
  { id: 'memory', label: '记忆' },
  { id: 'evolution', label: '进化日志' },
  { id: 'voice', label: '语音诊断' },
]

// 注意：本组件须同时导出 named + default——ManagementCockpit 的 lazy import
// 取 `m.DebugPanel`（index.tsx:20），与 Task 1 占位一致。
export function DebugPanel({ initialTab = 'logs' }: { initialTab?: DebugPanelTab }) {
  // 管理舱以 key={debugTab} 重新挂载子页（初始子页直达），内部 tab 切换不受影响
  const [tab, setTab] = useState<DebugPanelTab>(initialTab)

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-2 py-2 flex-shrink-0">
        {DEBUG_TABS.map(t => (
          <button
            key={t.id}
            type="button"
            className={`cockpit-tab${tab === t.id ? ' is-active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
        <span className="flex-1" />
        <label className="flex items-center gap-1.5 text-[11px] text-white/50 cursor-pointer">
          <input
            type="checkbox"
            defaultChecked={isDevMode()}
            onChange={(e) => { try { setDevMode(e.target.checked) } catch (err) { console.error('[cockpit] 开发者模式切换失败:', err) } }}
          />
          开发者模式
        </label>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <Suspense fallback={<div className="vs-config-loading">加载中…</div>}>
          {tab === 'logs' && <div className="h-full"><Logs /></div>}
          {tab === 'status' && <Status />}
          {tab === 'gateway' && <Gateway />}
          {tab === 'memory' && <MemoryPanel />}
          {tab === 'evolution' && <div className="h-full"><EvolutionLog /></div>}
          {tab === 'voice' && <VoiceDiagnostics />}
        </Suspense>
      </div>
    </div>
  )
}

export default DebugPanel
