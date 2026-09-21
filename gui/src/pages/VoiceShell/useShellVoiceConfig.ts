/**
 * useShellVoiceConfig — VoiceShell 语音配置状态域（2026-09-21 P2-1 第三批从 index.tsx 搬出）
 *
 * 状态搬家（非纯 JSX 搬运）：shellConfig state + 启动加载（localStorage 一次性
 * 迁移/配置自愈/音效开关应用/agent 名与头像同步）+ config-updated 监听重载 +
 * 派生值（muted/dialogChannel/voiceConfig）+ 单源化写入通道（applyShellConfig
 * 乐观更新 + persistShellConfig 异步落盘）。
 *
 * 接口约定与原实现逐字一致：state 初始值、effect 依赖数组、console 文案均不变。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiPost, apiGet } from '../../lib/api'
import { resolveVoiceStyle } from '../../lib/expert-persona'
import { setSoundEnabled } from '../../hooks/useSoundEffects'
import type { VoiceConfig } from '../../hooks/useVoiceReply'
import {
  SHELL_VOICE_KEY,
  SHELL_VOICE_DEFAULTS,
  normalizeVoiceSection,
  voiceSectionForShell,
  fetchConfigForShell,
  type ShellVoiceConfig,
} from './shellVoiceConfig'

export function useShellVoiceConfig() {
  const [shellConfig, setShellConfig] = useState<ShellVoiceConfig>(SHELL_VOICE_DEFAULTS)
  // ── 智能体显示名：单源来自 cfg.agent.name（SetupWizard/管理舱配置页写入）
  //         默认值 'CrabPaw'——本项目 BossAgent 自身代号，不硬编码第三方品牌名 ──
  const [agentDisplayName, setAgentDisplayName] = useState<string>('CrabPaw')
  // 2026-08-25(用户反馈): 对话窗口头像应对齐智能体配置页——activeProfile 的
  // icon(默认 🦀);此前用名字首字(「小」=小龙女首字), 配置页头像形同虚设。
  const [agentDisplayIcon, setAgentDisplayIcon] = useState<string>('🦀')

  // ── 语音配置 + 智能体名：启动从 config.json 同一次加载 ──
  const configLoadedRef = useRef(false)
  useEffect(() => {
    let cancelled = false
    const loadShellConfigOnce = async () => {
      try {
        const cfg = await fetchConfigForShell()
        if (cancelled) return
        let voice: Record<string, unknown> = (cfg?.voice as Record<string, unknown>) || {}
        // 平滑迁移：旧 localStorage 配置合并进 config（localStorage 值优先），成功后清除——
        // 一次性迁移，此后 config.json 成为唯一源；写入失败则保留 localStorage 下次重试
        try {
          const raw = localStorage.getItem(SHELL_VOICE_KEY)
          if (raw) {
            const legacy = JSON.parse(raw) as Record<string, unknown>
            voice = { ...voice, ...legacy }
            try {
              await apiPost('/config', { voice })
              localStorage.removeItem(SHELL_VOICE_KEY)
              console.log('[shell] 已迁移 localStorage 语音配置到 config.json（单源化完成）')
            } catch (e) {
              console.error('[shell] 语音配置迁移写入失败，保留 localStorage 待重试:', e)
            }
          }
        } catch (e) {
          console.error('[shell] 语音配置迁移解析失败:', e)
        }
        // ── 2026-08-15 配置自愈(唤醒词失效根因): "默认"模式(pttOnly=false &&
        // continuousMode=false)的语义就是"唤醒词+空格可用", 但持久配置可能出现
        // wakeWordEnabled=false 的不一致组合(如专注模式遗留)——此时 KWS 订阅
        // 永不建立, 唤醒词命中无人消费("说了唤醒词没反应")。启动即修复并回写。
        const healed = normalizeVoiceSection(voice)
        if (!healed.pttOnly && !healed.continuousMode && !healed.wakeWordEnabled) {
          console.warn('[shell] 配置自愈: 默认模式下 wakeWordEnabled=false → 修复为 true')
          healed.wakeWordEnabled = true
          try {
            apiPost('/config', { voice: voiceSectionForShell(healed) }).catch((e) => console.warn('[shell] 配置自愈保存失败:', e?.message || e))
          } catch (e) { console.warn('[shell] 配置自愈回写失败:', e) }
        }
        setShellConfig(healed)
        // 2026-08-31 修复: Jarvis 音效总闸接通真实逻辑——启动按持久化的
        // config.voice.ttsFxEnabled 应用 useSoundEffects 开关(缺省视为开, 与
        // localStorage 默认 behavior 及设置页缺省一致)。
        try {
          setSoundEnabled(healed.ttsFxEnabled !== false)
        } catch (e) { console.warn('[shell] 应用音效开关失败:', e instanceof Error ? e.message : String(e)) }
        // ── 2026-08-14 取消硬编码：agent 名使用配置页真实值 ──
        const agentCfg = cfg?.agent as Record<string, unknown> | undefined
        const cfgName = typeof agentCfg?.name === 'string' && agentCfg.name.trim()
          ? agentCfg.name.trim()
          : null
        if (cfgName) setAgentDisplayName(cfgName)
        // 2026-08-25: 头像同步配置页 activeProfile.icon(失败静默默认 🦀, 不阻塞)
        try {
          const pres = await apiGet('/api/profiles')
          const plist = (pres?.data?.profiles || []) as Array<{ id: string; icon?: string; isDefault?: boolean }>
          const actId = pres?.data?.activeProfile as string | null | undefined
          const p = plist.find(x => actId ? x.id === actId : x.isDefault) || plist[0]
          if (p?.icon) setAgentDisplayIcon(String(p.icon))
        } catch (err: any) { console.warn('[shell] 加载智能体头像失败(默认 🦀):', err?.message || err) }
        configLoadedRef.current = true
      } catch (e) {
        console.error('[shell] 加载语音配置失败，使用默认值:', e)
        setShellConfig(SHELL_VOICE_DEFAULTS)
        configLoadedRef.current = true
      }
    }
    loadShellConfigOnce()
    return () => { cancelled = true }
  }, [])

  // 监听 Settings 页保存（config-updated / config-updated-voice）→ 重新拉取并刷新
  useEffect(() => {
    const onConfigUpdated = () => {
      if (!configLoadedRef.current) return
      ;(async () => {
        try {
          const cfg = await fetchConfigForShell()
          if (cfg === null) return // 拉取失败：保持当前状态，避免误重置
          setShellConfig(normalizeVoiceSection((cfg.voice as Record<string, unknown>) || {}))
        } catch (e) {
          console.error('[shell] 配置更新事件重载失败:', e)
        }
      })()
    }
    window.addEventListener('config-updated', onConfigUpdated)
    window.addEventListener('config-updated-voice', onConfigUpdated)
    return () => {
      window.removeEventListener('config-updated', onConfigUpdated)
      window.removeEventListener('config-updated-voice', onConfigUpdated)
    }
  }, [])

  // 构建 useVoiceChatFlow 所需的 VoiceConfig
  // P4 style 注入：当前固定 orchestrator 音色；运行时按 activeArchetype 切换待 Task 5 接线（useVoiceChatFlow 尚未暴露 onRoute 回调）
  // personaPrefix 同理 — 当前无 TTS 文本单一组装点，前缀注入随轨道图接线（Task 5）
  const voiceConfig: VoiceConfig = {
    replyEnabled: shellConfig.replyEnabled,
    continuousMode: shellConfig.continuousMode,
    ttsProvider: shellConfig.ttsProvider,
    defaultVoice: shellConfig.defaultVoice,
    speed: shellConfig.speed,
    doubaoVoice: shellConfig.doubaoVoice,
    volcanoVoice: shellConfig.volcanoVoice,
    style: resolveVoiceStyle('orchestrator'),
  }

  // 2026-08-15: muted 派生自 shellConfig(持久化)——重启后保持静音
  const muted = shellConfig.muted === true
  // 2026-09-17: 语音对话通道——classic=ASR+TTS 接力; realtime=豆包全双工端到端
  // 2026-09-22 用户实测: 专注模式(pttOnly)与 realtime 不兼容——切专注会停掉 realtime
  // 常驻会话(effectiveContinuous=false→stopSession), 之后每次按空格都是冷启动建连
  // (豆包 WS 握手+凭证 1-2s), 按住说话的时长内连接未就绪, 语音上行全丢="按了没反应"。
  // 且 realtime 协议无 PTT 门控帧(mute/unmute 是播报回灌防护, 非 PTT 门控), 正解需改
  // useVoiceSession(现挂用户 WIP)。故专注模式下运行时强制 classic(经典 PTT 管线是
  // 专注模式原生场景), 配置项不动, 退出专注自动恢复 realtime。
  const dialogChannel: 'classic' | 'realtime' = shellConfig.pttOnly
    ? 'classic'
    : shellConfig.dialogChannel === 'realtime' ? 'realtime' : 'classic'

  // ── 单源化写入通道：乐观更新本地 state + 异步 POST /api/config（合并 voice 段） ──
  // 写入失败仅 console.error，不阻塞交互（UI 已乐观更新，重启后可能回退到旧值）
  const shellConfigRef = useRef<ShellVoiceConfig>(shellConfig)
  shellConfigRef.current = shellConfig
  const persistShellConfig = useCallback(async (next: ShellVoiceConfig) => {
    try {
      const cfg = await fetchConfigForShell()
      const voice = { ...(cfg?.voice as Record<string, unknown> || {}), ...voiceSectionForShell(next) }
      await apiPost('/config', { voice })
    } catch (e) {
      console.error('[shell] 语音配置持久化失败（UI 已生效）:', e)
    }
  }, [])
  const applyShellConfig = useCallback((patch: Partial<ShellVoiceConfig> | ((v: ShellVoiceConfig) => ShellVoiceConfig)) => {
    const next = typeof patch === 'function' ? patch(shellConfigRef.current) : { ...shellConfigRef.current, ...patch }
    shellConfigRef.current = next
    setShellConfig(next)
    void persistShellConfig(next)
  }, [persistShellConfig])

  return {
    shellConfig,
    muted,
    dialogChannel,
    voiceConfig,
    agentDisplayName,
    agentDisplayIcon,
    applyShellConfig,
    persistShellConfig,
  }
}
