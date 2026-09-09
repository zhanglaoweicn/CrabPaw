import { useEffect, useRef, useCallback } from 'react'
import { duckVolumeFor } from '../lib/voice-engine-utils'
import { useSse } from './useSSE'

/**
 * 消费后端 TextToSpeech 工具广播的 voice_play SSE 事件。
 * 后端（voice-tool.js）生成音频文件后广播文件路径，此处负责在前端播放。
 *
 * 互斥协议（2026-08-07 修复——此前污染 __ttsActive 导致主回复语音被掐断）：
 * - 本组件使用独立标记 `__voicePlayActive`，**绝不读写 `__ttsActive`**
 *   （__ttsActive 归流式 TTS useVoiceReply 单一管理；旧实现播放完复位
 *   __ttsActive=false，流式播放器的 checkInterrupt 误判"被打断"→ pause 主回复）
 * - 播报队列（useSpeechQueue）播放期间（__speechQueuePlaying）跳过——
 *   同一音频后端会广播 voice_play，speech-queue 已自行播放，避免双重播放
 * - 流式 TTS 接管时（__ttsActive 变 true）通过 __voicePlayStop 被主动停掉
 *
 * 2026-08-14 审计: SSE 通道由裸 new EventSource('/events') 改为 useSse——
 * Electron 生产下相对路径 EventSource 无 origin 且无 token(401/失效),
 * useSse 走 api:sse IPC / streamUrl 注入凭据,并统一重连与卸载清理。
 */
export function useVoicePlayConsumer() {
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const stopPlayback = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    try {
      audio.pause()
      audio.src = ''
    } catch (err) {
      console.debug('[VoicePlayConsumer] 停止播放失败:', err)
    }
    audioRef.current = null
    ;(window as any).__voicePlayActive = false
  }, [])

  // 暴露全局停止接口（流式 TTS 接管时主动打断本消费方）
  useEffect(() => {
    ;(window as any).__voicePlayStop = stopPlayback
    return () => {
      try { delete (window as any).__voicePlayStop } catch (err) { console.debug('[VoicePlayConsumer] 清理 __voicePlayStop 失败:', err) }
    }
  }, [stopPlayback])

  useSse({
    path: '/events',
    handlers: {
      voice_play: (data: any) => {
        try {
          if (!data?.filePath) return
          // 流式 TTS 播放中 → 跳过（__ttsActive 归 useVoiceReply 管理）
          if ((window as any).__ttsActive === true) return
          // 播报队列正在播放同一音频 → 跳过防双声
          if ((window as any).__speechQueuePlaying === true) return
          // 上一个 voice_play 仍在播 → 跳过（重复事件）
          if ((window as any).__voicePlayActive === true) return
          const base = String(data.filePath).split(/[\\/]/).pop() || ''
          if (!base) return
          const url = `/api/voice/audio/${encodeURIComponent(base)}`
          const audio = new Audio(url)
          // 2026-08-08: 统一 duck 音量——旧实现不设 volume(恒 1.0),主 TTS ducked
          // (0.15) 时 voice_play 突然满音量 → "忽大"（音量忽大忽小修复）
          audio.volume = duckVolumeFor((window as any).__ttsDucked === true)
          audioRef.current = audio
          ;(window as any).__voicePlayActive = true
          // 2026-08-15 S8(审计 P1): 播放期间挂起会话麦克风, 播放结束恢复——
          // 此前喇叭声直入开着的麦克风, 连续模式被转写并自动发送(幻听消息)。
          // suspendForMedia 置 mediaActive 标志, 与 resumeAfterMedia 配对
          // (resumeAfterMedia 仅在 mediaActive 时重建采集)。
          const cv = (window as any).crabpawVoice
          let suspended = false
          if (cv && typeof cv.suspendForMedia === 'function') {
            try { cv.suspendForMedia(); suspended = true } catch (err) { console.warn('[VoicePlayConsumer] 挂起会话失败:', err) }
          }
          const resume = () => {
            if (suspended && cv && typeof cv.resumeAfterMedia === 'function') {
              try { cv.resumeAfterMedia(); suspended = false } catch (err) { console.warn('[VoicePlayConsumer] 恢复会话失败:', err) }
            }
          }
          audio.play().catch((err) => {
            console.warn('[VoicePlayConsumer] 音频播放失败:', err)
            resume()
            audioRef.current = null
            ;(window as any).__voicePlayActive = false
          })
          audio.addEventListener('ended', () => { resume(); stopPlayback() }, { once: true })
          audio.addEventListener('error', () => { resume(); stopPlayback() }, { once: true })
        } catch (err) {
          console.warn('[VoicePlayConsumer] 播放 voice_play 失败:', err)
        }
      },
    },
  })

  // 卸载时停止播放
  useEffect(() => () => { stopPlayback() }, [stopPlayback])
}
