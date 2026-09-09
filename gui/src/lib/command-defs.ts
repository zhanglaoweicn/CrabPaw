/**
 * command-defs — 命令三通道统一注册表(B2 2026-09-05)
 *
 * 同一语义三条通道:语音说(voice-panel-commands 规则匹配)、鼠标点(CommandPalette)、
 * 键盘按(全局快捷键)。本文件是"命令清单"的单一事实源:
 *  - CommandPalette 动作从 COMMAND_DEFS 派生(不再自维护一份 window 调用)
 *  - VoiceShell 全局快捷键按 def.shortcut 匹配(h/t/s/w/m),新增快捷键不碰 handler
 *  - voiceAliases 引用 voice-panel-commands 既有 RULES 规则表(引用不复制)——
 *    787 行口语变体调优资产(关掉新闻/开始会议纪要等)保持单源,新增变体仍只改那一处
 * 执行统一走 ui-command-registry(executeCommand)——与语音命令分发、UiCommandBridge
 * (agent ControlUI)同一执行通道。
 */
import { executeCommand, getCommandHost } from './ui-command-registry'
import { RULES, type CommandRule } from './voice-panel-commands'

export interface CommandDef {
  id: string
  /** 命令面板显示名 */
  label: string
  hint?: string
  /** 键盘快捷键(小写单键;VoiceShell 全局 keydown 消费,输入框聚焦时豁免) */
  shortcut?: string
  /** 语音别名——引用 voice-panel-commands 既有规则(单源),供对账/发现,执行仍走其匹配器 */
  voiceAliases?: RegExp[]
  /** 点击/命令面板执行 */
  run: () => void
  /** 键盘切换语义(打开↔关闭);声明后快捷键走 toggle,命令面板仍走 run */
  toggle?: () => void
}

/** 从语音规则表取别名(kind+action 过滤)——规则本体留在 voice-panel-commands */
const voice = (kind: string, action: CommandRule['action']): RegExp[] =>
  RULES.filter(r => r.kind === kind && r.action === action).flatMap(r => r.patterns)

/** PanelHandle setVisible+isVisible 组合成的开↔关切换 */
const toggleVisible = (host: string) => () => {
  const h = getCommandHost<{ setVisible?: (v: boolean) => void; isVisible?: () => boolean }>(host)
  if (!h || typeof h.setVisible !== 'function') return
  const open = typeof h.isVisible === 'function' ? h.isVisible() === true : false
  h.setVisible(!open)
}

export const COMMAND_DEFS: CommandDef[] = [
  {
    id: 'new-chat', label: '新建对话', hint: '清空当前对话',
    run: () => { executeCommand('voiceShell', 'newConversation') },
  },
  // ── 快捷键五连(h/t/s/w/m, DingDong 对齐)——面板 toggle ──
  {
    id: 'hotspot-toggle', label: '打开热点面板', hint: '今日热点 · 快捷键 H',
    shortcut: 'h', voiceAliases: voice('hotspot', 'open'),
    run: () => { executeCommand('hotspotPanel', 'setVisible', true) },
    toggle: toggleVisible('hotspotPanel'),
  },
  {
    id: 'typhoon-toggle', label: '打开台风路径', hint: '快捷键 T',
    shortcut: 't', voiceAliases: voice('typhoon', 'open'),
    run: () => { executeCommand('typhoonPanel', 'setVisible', true) },
    toggle: toggleVisible('typhoonPanel'),
  },
  {
    id: 'stock-toggle', label: '打开股票行情', hint: '快捷键 S',
    shortcut: 's', voiceAliases: voice('stock', 'open'),
    run: () => { executeCommand('stockPanel', 'setVisible', true) },
    toggle: toggleVisible('stockPanel'),
  },
  {
    id: 'weather-toggle', label: '打开天气', hint: '快捷键 W',
    shortcut: 'w', voiceAliases: voice('weather', 'open'),
    run: () => { executeCommand('weatherPanel', 'setVisible', true) },
    toggle: toggleVisible('weatherPanel'),
  },
  {
    id: 'music-toggle', label: '打开音乐面板', hint: '快捷键 M',
    shortcut: 'm', voiceAliases: voice('music', 'open'),
    run: () => { executeCommand('musicPanel', 'open') },
    toggle: () => {
      const h = getCommandHost<{ isVisible?: () => boolean }>('musicPanel')
      const open = typeof h?.isVisible === 'function' && h.isVisible() === true
      executeCommand('musicPanel', open ? 'close' : 'open')
    },
  },
  // ── 命令面板专属动作 ──
  {
    id: 'filegen-open', label: '打开文件面板', hint: '文件生成',
    voiceAliases: voice('filegen', 'open'),
    run: () => { executeCommand('filePanel', 'setVisible', true) },
  },
  {
    id: 'cockpit-settings', label: '打开设置', hint: '管理舱 → 设置',
    run: () => { executeCommand('cockpit', 'open', 'settings') },
  },
  {
    id: 'cockpit-model', label: '模型配置', hint: '管理舱 → 模型',
    run: () => { executeCommand('cockpit', 'open', 'model') },
  },
  {
    id: 'cockpit-mcp', label: 'MCP 服务', hint: '管理舱 → 连接',
    run: () => { executeCommand('cockpit', 'open', 'mcp') },
  },
  {
    id: 'cockpit-cost', label: '用量统计', hint: '管理舱 → 用量',
    run: () => { executeCommand('cockpit', 'open', 'cost') },
  },
  {
    id: 'schedule-open', label: '日程安排', hint: '日程卡片',
    voiceAliases: voice('schedule', 'open'),
    run: () => { executeCommand('schedulePanel', 'open') },
  },
  {
    id: 'cockpit-expert', label: '专家', hint: '管理舱 → 专家',
    run: () => { executeCommand('cockpit', 'open', 'expert') },
  },
]
