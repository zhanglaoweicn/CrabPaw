/**
 * useSpeechQueue — 语音归因播报串行播放器（P5）。
 * 队列 FIFO 串行：fetch /api/voice/tts → Audio 播放 → onended → dequeue → 播下一段。
 * canSpeak 守卫：主对话播报中（isTtsPlaying）或静音（muted）时不抢播，等主对话空闲再播。
 *
 * B2 (死锁重构)：播放驱动 effect 与入队拾取 effect 分离——
 *   旧实现 effect 依赖 [state.jobs, isTtsPlaying, muted]，播放中 enqueue 会改变 jobs
 *   引用 → effect 重跑 → cleanup 对正在播放的音频 pause() 且不发 dequeue → reducer 的
 *   playingId 永久停在队首 → nextToPlay 返回 null → 队列永久卡死。
 *   现改为：播放驱动只依赖 [isTtsPlaying, muted]（守卫翻转才停音频）；
 *   入队/出队通过单独的 jobs effect 调 playIfIdle 拾取。enqueue 不再触发 cleanup 停音频。
 */
import { useCallback, useEffect, useReducer, useRef } from 'react'
import { speechQueueReducer, nextToPlay, type SpeechJob, type SpeechQueueState } from '../lib/speech-queue'
import { duckVolumeFor } from '../lib/voice-engine-utils'
import { setTtsActive } from '../lib/tts-state'

const EMPTY: SpeechQueueState = { jobs: [], playingId: null }

export interface UseSpeechQueueOptions {
  isTtsPlaying: boolean
  muted: boolean
  voice?: string
  /** TTS 语速(如 0.7/1.0/1.3)——2026-08-14: 跟随用户 TTS 配置,此前硬编码 1.0 */
  speed?: number
}

export function useSpeechQueue({ isTtsPlaying, muted, voice = 'zh-CN-XiaoxiaoNeural', speed = 1.0 }: UseSpeechQueueOptions) {
  const [state, dispatch] = useReducer(speechQueueReducer, EMPTY)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const optsRef = useRef({ isTtsPlaying, muted, voice, speed })
  optsRef.current = { isTtsPlaying, muted, voice, speed }
  // B2: state 最新值存 ref，供 playIfIdle 读取（effect 依赖分离后避免闭包过期）
  const stateRef = useRef(state)
  stateRef.current = state
  // P1 修复: 用 ref 追踪播放中状态,消除 effect 对 state.playingId 的依赖——
  // effect 内 dispatch('start') 本会改变 state.playingId → effect 重跑 → cleanup
  // cancelled=true → play() 中途返回且不发 dequeue → playingId 永久卡死。
  // ref 不受 React 渲染周期影响,dispatch('start') 仅用于 UI/队列计数。
  const playingRef = useRef(false)
  // 2026-08-07: 播放代际 token——cleanup 作废旧播放协程后,旧协程的 catch 分支
  // 因 seq 失配不再写 playingRef(否则覆盖新 job 播放标记 → 防重入失效 → 双声播报)
  const playSeqRef = useRef(0)

  // P3: 入队时自动附加 2 分钟过期时间——静音期间累积的旧播报过期后自动丢弃,
  // 解除静音后不集中补播陈旧 jobs(避免语音轰炸)。
  const enqueue = useCallback((job: SpeechJob) => {
    const DEFAULT_TTL_MS = 2 * 60 * 1000
    dispatch({ type: 'enqueue', job: { ...job, expiresAt: job.expiresAt ?? (Date.now() + DEFAULT_TTL_MS) } })
  }, [])
  const reset = useCallback(() => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null }
    playingRef.current = false
    dispatch({ type: 'reset' })
  }, [])
  // B7: 只清指定前缀的 job——供 CollabOrbit 收球清理协作播报,不动共享队列其他来源
  // (面板确认/阶段播报)
  const clearByPrefix = useCallback((prefix: string) => {
    dispatch({ type: 'clearByPrefix', prefix })
  }, [])

  // B2: 核心播放逻辑抽成 playIfIdle——空闲且队列非空且主对话空闲时播队首。
  // 由两个 effect 调用：守卫翻转 effect + jobs 变化 effect。
  const playIfIdle = useCallback(() => {
    if (playingRef.current) return // 防重入
    const { isTtsPlaying, muted, voice: v, speed: sp } = optsRef.current
    // P5(GUI 全量修复 P1): 主回复流进行中(含合成间隙)不抢播——
    // 旧实现只看 isTtsPlaying(__ttsActive), 而 beginStreamingTTS 先 interruptTTS
    // 清 active、首段 playNext 才置回(间隙 200-500ms) → 归因播报乘隙开播并最终
    // 清掉 __ttsActive → 主回复被 100ms checkInterrupt 轮询 pause 掐断后半段
    if (muted || isTtsPlaying) return
    try { if ((window as any).__ttsStreamStarted) return } catch (e) { console.warn('[speech-queue] 流标记检查失败:', e) }
    const jobId = nextToPlay(stateRef.current)
    if (jobId === null) return
    const job = stateRef.current.jobs.find(j => j.id === jobId)
    if (!job) return
    // P3: 过期检查——静音期间入队的旧 job 超时后丢弃,不集中补播
    if (job.expiresAt && Date.now() > job.expiresAt) {
      dispatch({ type: 'dequeue' })
      return
    }
    // 标记播放中 (ref 立即生效,dispatch 仅用于 UI 计数/测试可见)
    playingRef.current = true
    // 2026-08-07: 全局播报标记——useVoicePlayConsumer 据此跳过同一音频的
    // voice_play 事件（防双声：后端合成时既广播 voice_play 又被本队列播放）
    ;(window as any).__speechQueuePlaying = true
    // 2026-08-07: 播报也置 __ttsActive——barge-in 帧分类器靠它启用 25 帧
    // 长确认保护；否则播报声被麦克风捕获 → 0.5s 短确认即误打断主回复
    // （"语音播放时有时正常有时不正常"根因之一）。owner 标记保证结束时
    // 只复位自己的状态，不误伤流式主回复。
    setTtsActive('speech-queue', true)
    const seq = ++playSeqRef.current
    dispatch({ type: 'start' })
    let cancelled = false
    const play = async () => {
      try {
        // 2026-08-04 修复:渲染进程 fetch 到 38767 不稳定(Failed to fetch,与 DocReader 同款
        // 网络层问题)→ 语音队列 TTS 全失败(无播报)。Electron 走 api.proxy(主进程代理,
        // 与后端直连同行为,完全绕开渲染进程网络层)
        let data: any = null
        // 2026-09-04 部门化 P3: job.voice 优先——岗位音色(voiceStyle→TTS voice), 缺省回落队列配置
        const effectiveVoice = job.voice || v
        if (typeof window !== 'undefined' && window.electronAPI?.api?.proxy) {
          const res = await window.electronAPI.api.proxy('POST', '/api/voice/tts', { text: job.text, voice: effectiveVoice, speed: sp })
          if (cancelled) { playingRef.current = false; (window as any).__speechQueuePlaying = false; setTtsActive('speech-queue', false); return }
          if (!res?.success) { console.error('[speech-queue] TTS 合成失败:', res?.error || res?.status); playingRef.current = false; (window as any).__speechQueuePlaying = false; setTtsActive('speech-queue', false); dispatch({ type: 'dequeue' }); return }
          data = res.data
        } else {
          const { resolveApiUrl } = await import('../lib/api')
          const url = await resolveApiUrl('/api/voice/tts')
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: job.text, voice: effectiveVoice, speed: sp }),
          })
          if (cancelled) { playingRef.current = false; (window as any).__speechQueuePlaying = false; setTtsActive('speech-queue', false); return }
          if (!res.ok) { console.error('[speech-queue] TTS 合成失败:', res.status); playingRef.current = false; (window as any).__speechQueuePlaying = false; setTtsActive('speech-queue', false); dispatch({ type: 'dequeue' }); return }
          data = await res.json()
        }
        if (cancelled) { playingRef.current = false; (window as any).__speechQueuePlaying = false; setTtsActive('speech-queue', false); return }
        if (!data.audioBase64) { console.error('[speech-queue] TTS 响应缺音频:', data.error || 'unknown'); playingRef.current = false; (window as any).__speechQueuePlaying = false; setTtsActive('speech-queue', false); dispatch({ type: 'dequeue' }); return }
        const audio = new Audio(`data:audio/${data.audioFormat || 'mp3'};base64,${data.audioBase64}`)
        // 2026-08-08: 统一 duck 音量——旧实现不设 volume(恒 1.0),与主 TTS duck
        // 状态不一致 → 播报忽大（音量忽大忽小修复）
        audio.volume = duckVolumeFor((window as any).__ttsDucked === true)
        audioRef.current = audio
        const finishPlayback = () => {
          audioRef.current = null
          playingRef.current = false
          ;(window as any).__speechQueuePlaying = false
          // setTtsActive 内部 owner 守卫——仅当播报仍是 owner 时才复位，不误伤流式主回复
          setTtsActive('speech-queue', false)
          dispatch({ type: 'dequeue' })
        }
        audio.onended = finishPlayback
        audio.onerror = () => {
          console.error('[speech-queue] 音频播放失败:', job.id)
          finishPlayback()
        }
        await audio.play()
      } catch (e: any) {
        console.error('[speech-queue] 播报异常:', e?.message || e)
        // 2026-08-07: 仅当代际 token 仍匹配(未被 cleanup 作废)时才写 playingRef——
        // 旧协程被中断时 cleanup 已置 false 并 dequeue,此处覆写会破坏新 job 播放标记
        if (seq === playSeqRef.current) {
          playingRef.current = false
          ;(window as any).__speechQueuePlaying = false
          setTtsActive('speech-queue', false)
          if (!cancelled) dispatch({ type: 'dequeue' })
        }
      }
    }
    play()
  }, [])

  // B2: 守卫翻转 effect——isTtsPlaying/muted 变化时：若变为空闲则拾取；cleanup 只在
  // 守卫变化时停音频（主对话开始/静音）。enqueue 不触发此 effect（依赖不含 state.jobs）。
  // 注意:cleanup 里 pause 后必须 dispatch dequeue 释放 playingId,否则 reducer 的
  // playingId 非空 → nextToPlay 返回 null → 队列卡死（旧实现的 bug）。
  useEffect(() => {
    if (playingRef.current) return
    const jobId = nextToPlay(stateRef.current)
    if (jobId !== null) playIfIdle()
    return () => {
      // 守卫翻转(主对话开始/静音):停掉正在播的队列音频。置 playingRef=false 并
      // dequeue 释放 playingId——该 job 被丢弃,后续 job 可播(避免死锁)。
      // 2026-08-07: 递增代际 token 作废旧播放协程——其 catch 分支因 seq 失配
      // 不再写 playingRef(否则覆盖新 job 的播放标记 → 防重入失效 → 双声播报)
      playSeqRef.current++
      if (audioRef.current) { audioRef.current.pause(); audioRef.current = null }
      if (playingRef.current) {
        playingRef.current = false
        ;(window as any).__speechQueuePlaying = false
        setTtsActive('speech-queue', false)
        dispatch({ type: 'dequeue' })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTtsPlaying, muted, playIfIdle])

  // B2: 入队/出队拾取 effect——enqueue/onended-dequeue 改变 jobs 引用后,若空闲则拾取。
  // playingRef 防重入:播放中 enqueue 不会打断当前音频,播完 dequeue 后再次触发拾取。
  useEffect(() => {
    if (playingRef.current) return
    const jobId = nextToPlay(stateRef.current)
    if (jobId !== null) playIfIdle()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.jobs, playIfIdle])

  // 2026-08-08: 暴露播放状态——VoiceShell 语音球据此切换 speaking(蓝色)态。
  // reducer 的 playingId 非空即播放中(dispatch start 置位、dequeue 清空,自动触发重渲染)
  return { enqueue, reset, clearByPrefix, pending: state.jobs.length, isPlaying: state.playingId !== null }
}
