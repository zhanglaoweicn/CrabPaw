/**
 * UiCommandBridge — crabpaw_ui 命令桥(P2-3, ag-ui Frontend Tools 借鉴)
 *
 * 唯一订阅后端 ControlUI 工具广播的 crabpaw_ui 命令,映射到
 * ui-command-registry 宿主(executeCommand)与 custom event(VoiceShell 既有
 * 监听)——零新状态路径,天然规避"双订阅双开面板"。面板状态仍归
 * VoiceShell/各宿主组件。
 *
 * 设计约束: 只派发既有事件/经 registry 调宿主方法,不直接 setState;
 * executeCommand 本身对宿主未挂载/方法缺失/异常静默降级(不抛)。
 */

import { useSse } from '../../hooks/useSSE'
import { executeCommand } from '../../lib/ui-command-registry'

interface UiCommand {
  command: string
  tab?: string
  query?: string
}

export function UiCommandBridge() {
  useSse({
    path: '/events',
    handlers: {
      crabpaw_ui: (data: UiCommand) => {
        executeUiCommand(data)
      },
    },
  })

  // 空组件:所有副作用在 useSse 内(挂载即订阅,卸载即断开)
  return null
}

/** 执行界面命令——映射到 registry 宿主方法 / custom event(A1 2026-09-05: 旧 window.__* 直读退役) */
export function executeUiCommand({ command, tab, query }: UiCommand): void {
  const dispatch = (name: string, detail?: Record<string, unknown>) => {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail }))
    } catch (e) {
      console.error(`[UiCommandBridge] 派发 ${name} 失败:`, (e as Error)?.message || e)
    }
  }

  switch (command) {
    case 'open_cockpit':
      dispatch('crabpaw:open-cockpit', { tab: tab || 'settings' })
      break
    case 'close_cockpit':
      executeCommand('cockpit', 'close')
      break
    // 2026-08-19: 业务面板退役——open/close_business_panel 命令随契约删除（工具层同删）
    case 'open_search':
      dispatch('crabpaw:open-search', { query })
      break
    case 'open_doc':
      // 2026-08-17: DocReader 退役 → 命令名保留（后端 ControlUI 契约不变），直达 FileGenPanel
      executeCommand('filePanel', 'setVisible', true)
      break
    case 'open_music':
      executeCommand('musicPanel', 'open')
      break
    case 'close_music':
      executeCommand('musicPanel', 'close')
      break
    case 'open_hotspot':
      executeCommand('hotspotPanel', 'setVisible', true)
      break
    case 'close_hotspot':
      executeCommand('hotspotPanel', 'setVisible', false)
      break
    case 'open_weather':
      executeCommand('weatherPanel', 'setVisible', true)
      break
    case 'close_weather':
      executeCommand('weatherPanel', 'setVisible', false)
      break
    case 'open_task_panel':
      executeCommand('taskPanel', 'setVisible', true)
      break
    case 'close_task_panel':
      executeCommand('taskPanel', 'setVisible', false)
      break
    case 'close_scene_card':
      dispatch('crabpaw:close-scene-card')
      break
    case 'new_conversation':
      executeCommand('voiceShell', 'newConversation')
      break
    default:
      console.warn('[UiCommandBridge] 未知界面命令:', command)
  }
}
