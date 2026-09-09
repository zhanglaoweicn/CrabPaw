/**
 * ui-command-registry — 面板/宿主命令注册表(GUI 全量修复 P7, G1 收编; A1 2026-09-05 类型化收口)
 *
 * 旧架构: 各宿主组件挂载时写 (window as any).__weatherPanel = {...} 等全局句柄,
 * 消费方(UiCommandBridge/CommandPalette/voiceCommands/语音命令)读 window.__x
 * 调用方法——66 个 window.__ 键无类型、无生命周期、无错误边界。
 *
 * 本注册表: registerCommandHost/unregister/getCommandHost/execute 统一管理。
 * A1(2026-09-05): 消费方已全部迁入(读走 getCommandHost/executeCommand),
 * window.__x 兼容镜像退役。仍留在 window 上的 __ 键只剩语音信号标记
 * (__tts 系列 / __speechQueue 等, 由 lib/tts-state 与各语音 hook 管辖)——
 * 那是跨 hook 状态信号, 不是命令宿主, 不属本注册表领域。
 *
 * 宿主分两类:
 *  - 面板类: 按 PanelHandle 注册(open/close/toggle/isVisible/setVisible 子集)
 *  - 功能类: approvalHost(approve/reject)/cockpit(openWith 带参)/voiceShell 等
 *            带参方法不强行归一, 沿用 CommandHost 松散类型
 */

type CommandHost = Record<string, (...args: any[]) => any>

/** 面板类宿主统一签名——新增面板宿主按此注册(实现子集即可) */
export interface PanelHandle {
  open?: (opts?: { query?: string }) => void
  close?: () => void
  toggle?: () => void
  isVisible?: () => boolean
  setVisible?: (v: boolean) => void
}

const hosts = new Map<string, CommandHost>()

/** 宿主组件挂载时注册, 返回注销函数(卸载时调用) */
export function registerCommandHost(name: string, host: CommandHost): () => void {
  hosts.set(name, host)
  let unregistered = false
  return () => {
    if (unregistered) return
    unregistered = true
    // 仅当自己仍是当前宿主时才注销(重复注册时旧 unreg 不得删除新 host)
    if (hosts.get(name) === host) hosts.delete(name)
  }
}

export function getCommandHost<T = CommandHost>(name: string): T | undefined {
  return hosts.get(name) as T | undefined
}

export function hasCommandHost(name: string): boolean {
  return hosts.has(name)
}

/**
 * 执行宿主方法——宿主未挂载/方法不存在时安全返回 undefined(不抛)。
 * 与旧 (window as any).__x?.method() 的可选链语义一致。
 */
export function executeCommand<T = any>(name: string, method: string, ...args: any[]): T | undefined {
  const host = hosts.get(name)
  if (!host) return undefined
  const fn = host[method]
  if (typeof fn !== 'function') return undefined
  try {
    return fn(...args)
  } catch (e) {
    console.error(`[ui-command-registry] ${name}.${method} 执行异常:`, e)
    return undefined
  }
}

/** 调试/测试 */
export function listRegisteredHosts(): string[] {
  return Array.from(hosts.keys())
}
