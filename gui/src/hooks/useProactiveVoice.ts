/**
 * useProactiveVoice — 主动播报（proactive_speak 的 TTS 侧）
 * 配置：启动时拉取 /config 的 voice 段；播报经打扰抑制守卫（__ttsActive 时不插嘴）。
 * 情绪化音色：Task 5 的 PROACTIVE_STYLE_BY_INTENT 在此注入 voiceConfig.style。
 */
import { useCallback, useEffect, useRef } from 'react'
import { useVoiceReply, type VoiceConfig } from './useVoiceReply'
import { apiGet } from '../lib/api'

/**
 * 情绪化音色：豆包 style 注入（设计规格 §8.2 指定文案），
 * 仅 provider === 'doubao' 生效；其余提供商自动忽略。
 */
export const PROACTIVE_STYLE_BY_INTENT: Record<string, string> = {
  confront: 'deep, calm, emotionally rich, metallic AI butler, authoritative',
  inform: 'deep, calm, emotionally rich, metallic AI butler',
  ambient: '',
  silent: '',
}

export function useProactiveVoice() {
  const { handleVoiceReply } = useVoiceReply()
  const voiceRef = useRef<VoiceConfig>({
    replyEnabled: true,
    ttsProvider: 'edge-tts',
    defaultVoice: 'zh-CN-XiaoxiaoNeural',
    speed: 1.0,
  })

  useEffect(() => {
    let cancelled = false
    apiGet('/config')
      .then((data: any) => {
        if (cancelled || !data?.voice) return
        voiceRef.current = {
          replyEnabled: true,
          ttsProvider: data.voice.ttsProvider || 'edge-tts',
          defaultVoice: data.voice.defaultVoice || 'zh-CN-XiaoxiaoNeural',
          speed: typeof data.voice.speed === 'number' ? data.voice.speed : 1.0,
          doubaoVoice: data.voice.doubaoVoice || undefined,
          volcanoVoice: data.voice.volcanoVoice || undefined,
        }
      })
      .catch((e) => console.error('[proactive] 加载语音配置失败:', (e as any)?.message || e))
    return () => { cancelled = true }
  }, [])

  /** 主动播报；返回是否真的发声（false = 正在播报/被抑制，仅面板展示） */
  const speak = useCallback((text: string, intent?: string, style?: string) => {
    try {
      if (!text || !text.trim()) return false
      if ((window as any).__ttsActive) return false // 打扰抑制：不打断当前播报
      const vc = { ...voiceRef.current }
      const resolvedStyle = style || PROACTIVE_STYLE_BY_INTENT[intent || 'inform'] || ''
      if (resolvedStyle) vc.style = resolvedStyle
      handleVoiceReply(text, vc).catch((e) =>
        console.error('[proactive] 主动播报失败:', (e as any)?.message || e)
      )
      return true
    } catch (err) {
      console.error('[proactive] 主动播报失败:', (err as any)?.message || err)
      return false
    }
  }, [handleVoiceReply])

  return { speak }
}
