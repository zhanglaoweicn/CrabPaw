/**
 * useVoiceReply — 句子级流式 TTS 播放（v5 极速流式版）
 *
 * 对标 CrabPaw + 全面优化：
 * 1. AudioContext 流式播放 — MP3 边收边播，TTFF 从 2-5s 降至 200-500ms
 *    （绕开 MediaSource 不支持 audio/mpeg 的问题）
 * 2. 句子级预取队列，超前 2-3 段并行预取，段间零间隙
 * 3. 更早触发首句 TTS — 40 字即可切分（原来 60 字）
 * 4. 打断点追踪 — 记录已播放文本，支持 4s 撤回窗口
 * 5. 误触发恢复 — barge-in 误判后恢复中断段落
 * 6. duck 音量控制 — barge-in 时降低 TTS 音量而非立即停止
 */

import { useRef, useCallback, useEffect } from 'react'
import { getApiBaseUrl, getFetchOrigin } from '../lib/api'
// 2026-08-07: 移除 ambient-noise 导入——环境噪声监测(startNoiseMonitor)无调用者,
// getNoiseRms() 恒 0 → computeBoostVolume 恒 1,音量自适应是死代码(审查报告 P2);
// 原设计见已删除的 src/lib/ambient-noise.ts 头注释,播放音量统一为常量 1

/** Base URL for TTS HTTP fetches — uses Vite proxy in dev mode to avoid CORS */
async function ttsBaseUrl(): Promise<string> {
  const proxyOrigin = getFetchOrigin()
  return proxyOrigin || await getApiBaseUrl()
}
import { extractVoiceText, stripEmojis, stripMarkdownForSpeech } from '../lib/voice-utils'
import { trimSentenceQueue, MAX_TTS_QUEUE_DEPTH, duckVolumeFor } from '../lib/voice-engine-utils'
import { getTtsState, setTtsActive, setTtsAudioElement, setTtsAbortController } from '../lib/tts-state'

// 最大分段长度（字符数）
// 句子边界：中文句号/问号/感叹号/分号/冒号/顿号/省略号 + 英文对应标点 + 换行
const STTS_SENTENCE_RE = /[^。！？；：、…!?;\n,]+[。！？；：、…!?;\n,]+/g

function sttsHasReadable(s: string): boolean {
  return /[\p{L}\p{N}]/u.test(s)
}

function sttsIsUsefulPartial(s: string): boolean {
  // 2026-08-05 fix: 40字→18字——LLM 生成 40 字需 2-5s，首句语音干等造成
  // "文本先出半天才有声音"。18 字(约 4s 播报)足够自然且首句明显更快。
  // 2026-08-06 fix: 18→12字——edge-tts 整句合成有 2-7s 天然延迟,首句 18 字意味着
  // 文本已流式出 5s+ 语音才开始。12 字(约 2-3s 播报)显著提前首字出声。
  return s.length >= 12 && /[一-鿿\w]{4,}/u.test(s)
}

// ── 句末标点对齐：将打断位置对齐到最近的句末标点，避免半句截断 ──
const SENTENCE_END_RE = /[。！？；…!?;\n]/
function findSentenceBoundary(text: string, estimatedPos: number): { spokenUpTo: number; remaining: string } {
  if (!text || estimatedPos <= 0) return { spokenUpTo: 0, remaining: text }
  // 限制在文本长度范围内
  const pos = Math.min(estimatedPos, text.length)
  // 从估计位置向后搜索句末标点（最多30字）
  let boundary = pos
  for (let i = pos; i < Math.min(pos + 30, text.length); i++) {
    if (SENTENCE_END_RE.test(text[i])) {
      boundary = i + 1
      break
    }
  }
  // 如果向后没找到，向前搜索（最多30字）
  if (boundary === pos) {
    for (let i = pos - 1; i >= Math.max(0, pos - 30); i--) {
      if (SENTENCE_END_RE.test(text[i])) {
        boundary = i + 1
        break
      }
    }
  }
  return {
    spokenUpTo: boundary,
    remaining: text.substring(boundary),
  }
}

export interface VoiceConfig {
  replyEnabled: boolean
  continuousMode?: boolean
  ttsProvider: string
  defaultVoice: string
  speed: number
  doubaoVoice?: string
  volcanoVoice?: string
  style?: string  // P3: 情绪化音色（豆包 style 注入，非 doubao 提供商忽略）
}

export interface StreamTTSOptions {
  onSuspendMic?: () => void
  onResumeMic?: () => void
  onSegmentStart?: (text: string, index: number, total: number) => void
  onSegmentEnd?: (index: number) => void
  onComplete?: () => void
  onInterrupted?: () => void
}

function resolveVoice(config: VoiceConfig): string {
  if (config.ttsProvider === 'doubao') return config.doubaoVoice || 'zh_female_xiaohe_uranus_bigtts'
  if (config.ttsProvider === 'volcano') return config.volcanoVoice || 'BV001_streaming'
  if (config.defaultVoice === 'zh-CN-XiaomengNeural') return 'zh-CN-XiaoxiaoNeural'
  return config.defaultVoice
}

function resolveProvider(config: VoiceConfig): string {
  // R7: edge-tts → 传空串 provider——让后端 _buildProviderOrder 智能排序。
  // 此前强制 'edge': edge 在中国大陆被墙(403/超时)时后端无法自动降级 doubao,
  // GET 流式 stalled → 前端 3s 熔断降级 JSON 全量 → 语音滞后文本严重。
  // 传空串后,后端在 edge 被墙熔断时自动跳过 edge 直走 doubao(0.5s 合成)。
  if (config.ttsProvider === 'edge-tts') return ''
  return config.ttsProvider
}

/**
 * 构建 TTS 流式请求的通用参数
 */
function buildTTSRequestParams(text: string, voiceConfig: VoiceConfig): Record<string, any> {
  return {
    text,
    voice: resolveVoice(voiceConfig),
    provider: resolveProvider(voiceConfig),
    speed: voiceConfig.speed,
    style: voiceConfig.style,
    _refined: true,
  }
}

/**
 * (新) 流式 TTS — 下载完整音频后 AudioContext 解码播放（v5 稳定版）
 *
 * 原理：
 *   fetch POST /api/voice/tts/stream → ReadableStream<Uint8Array>
 *   → 收集完整 ArrayBuffer → AudioContext.decodeAudioData → BufferSourceNode.start()
 *
 * v4 → v5 修复：
 *   - v4 的"边收边解码"对 MP3 不可行（MP3 帧边界 ≠ HTTP chunk 边界，
 *     decodeAudioData 需要完整数据），导致解码失败、Promise 挂起、应用崩溃
 *   - v5 改为：先下载完整音频，再一次性解码播放
 *   - 配合更短句子切分（40字），每段音频更小，下载更快
 *   - 添加超时保护 + 打断检测，防止 Promise 挂起
 */

/**
 * (v7) GET 流式播放 — 流式播放（首帧延迟 < 500ms）
 *
 * 原理：用新增的 GET /api/voice/tts/stream?text=...&voice=... 端点，
 * <audio> 元素可以直接设 src = URL → Chrome 自动流式解码 MP3（边收边播），
 * 首帧延迟从 8-9s（完整下载后播放）降至 200-500ms。
 *
 * 返回 true 表示成功播放，false 表示端点不可用（降级到 playTTSStream）
 */
async function playTTSViaHttpGet(text: string, voiceConfig: VoiceConfig): Promise<boolean> {
  const baseUrl = await ttsBaseUrl()
  const params = buildTTSRequestParams(text, voiceConfig)

  // 构建 GET URL — URL-encoded 参数
  const queryParams = new URLSearchParams()
  queryParams.set('text', params.text)
  queryParams.set('voice', String(params.voice))
  queryParams.set('provider', String(params.provider))
  queryParams.set('speed', String(params.speed))
  queryParams.set('_refined', 'true')
  if (voiceConfig.style) queryParams.set('style', voiceConfig.style)

  // 2026-08-01: 修复无声——<audio> 无法设置 X-Api-Key header，
  // 此前 URL 无 token → 后端 401 → audio NotSupportedError。
  // 认证 URL：Electron 用 streamUrl IPC（token 注入查询参数），
  // 浏览器模式拼接 token 查询参数。
  const streamPath = `/api/voice/tts/stream?${queryParams.toString()}`
  let ttsUrl = `${baseUrl}${streamPath}`
  try {
    if (window.electronAPI?.api?.streamUrl) {
      const streamInfo = await window.electronAPI.api.streamUrl(streamPath)
      if (streamInfo?.url) ttsUrl = streamInfo.url
    } else {
      const { getCredentials } = await import('../lib/api')
      const creds = await getCredentials()
      if (creds?.token && !ttsUrl.includes('token=')) {
        ttsUrl += `&token=${encodeURIComponent(creds.token)}`
      }
    }
  } catch (e) {
    console.warn('[TTS] 认证 URL 构建失败，尝试无 token 播放:', e)
  }
  console.log('[TTS] playTTSViaHttpGet: GET URL (text=%d chars)', text.length)

  // HEAD 检测可选：某些代理/后端不支持 HEAD，404 不代表 GET 不行
  // 所以 HEAD 失败时不放弃，直接尝试 GET 流式播放
  try {
    const testResp = await fetch(ttsUrl, { method: 'HEAD', signal: AbortSignal.timeout(2000) })
    if (!testResp.ok) {
      console.log('[TTS] HEAD returned %d, will still try GET stream', testResp.status)
    }
  } catch (err: any) {
    console.warn('[TTS] HEAD check failed:', err?.message || err)
    console.log('[TTS] HEAD check failed, will try GET stream playback')
  }

  // ── 直接用 <audio> 元素流式播放 GET 响应 ──
  const ducked = (window as any).__ttsDucked === true
  const audio = new Audio()
  // P3: 音量自适应 — 环境噪声抬升（安静环境返回 1.0）
  audio.volume = duckVolumeFor(ducked) /* 音量自适应已移除: 原 computeBoostVolume(getNoiseRms()) 恒为 1 */
  setTtsAudioElement(audio)

  // v8: 不调 setSinkId！让 <audio> 使用系统默认音频输出设备。
  // setSinkId 在 Electron 中可能路由到虚拟/错误的设备导致无声。
  // 用户可通过系统音量设置选择输出设备，比应用内 setSinkId 更可靠。
  console.log('[TTS] GET stream: using system default audio output (no setSinkId)')

  // ── TTS 音频播放策略（v8 修复无声问题） ──
  // ⚠️ createMediaElementSource 会永久禁用 <audio> 的原生音频输出！
  // 在 Electron 中，AudioContext.destination 可能不正确地路由到系统默认设备
  // 或虚拟设备，导致声音完全消失。日志显示 "playback complete" 但无声，
  // 正是因为音频走了 AudioContext 图但 ctx.destination 没有输出到扬声器。
  //
  // v8 策略：<audio> 原生播放（保证声音），球体动画用模拟音量（不劫持音频流）
  // 这比 createMediaElementSource + analyser 更可靠，牺牲了精确音量分析，
  // 但保证了声音输出 — 语音助手中"听到声音"比"球体精确跳动"重要 100 倍。
  console.log('[TTS] GET stream: using native <audio> playback (no createMediaElementSource)')
  ;(window as any).__ttsAnalyser = null // 标记：没有真实 analyser
  ;(window as any).__ttsUseSimulatedVolume = true // 标记：使用模拟音量

  // v8 关键修复：清理残留的 AudioContext — 如果旧代码创建了 AudioContext
  // 并绑了 MediaElementSourceNode，即使不再使用，该 AudioContext 仍可能在后台
  // 干扰新的 <audio> 元素。关闭它！
  const staleCtx = (window as any).__ttsAudioCtx as AudioContext | undefined
  if (staleCtx && staleCtx.state !== 'closed') {
    console.warn('[TTS v8] Closing stale AudioContext (state=%s) to prevent interference', staleCtx.state)
    try { staleCtx.close() } catch (e) { console.warn('[TTS v8] Failed to close stale ctx:', e) }
    ;(window as any).__ttsAudioCtx = null
    ;(window as any).__ttsFxAudioCtx = null
    ;(window as any).__ttsFxSourceNode = null
  }
  // 清理残留的 MediaElementSourceNode 引用
  const staleSource = (window as any).__ttsFxSourceNode as MediaElementAudioSourceNode | undefined
  if (staleSource) {
    try { staleSource.disconnect() } catch (err: any) { console.warn('[TTS] staleSource disconnect 失败:', err?.message || err) }
    ;(window as any).__ttsFxSourceNode = null
  }

  // 设置 src → Chrome 自动开始流式下载+解码+播放
  audio.src = ttsUrl
  // 2026-08-04 诊断:3s 后打印 audio 元素加载状态——定位"8s 无进度挂起"根因
  // (readyState: 0=NONE 1=HAVE_METADATA 2=CURRENT_DATA 3=FUTURE_DATA 4=ENOUGH_DATA)
  setTimeout(() => {
    console.log('[TTS] GET diag: readyState=%s networkState=%s currentTime=%s paused=%s error=%s',
      audio.readyState, audio.networkState, audio.currentTime.toFixed(2), audio.paused, audio.error ? audio.error.code : 'none')
  }, 3000)

  // v8 详细诊断：记录播放前的完整状态
  console.log('[TTS v8 DIAG] Before play(): volume=%s, ducked=%s, paused=%s, __ttsActive=%s',
    audio.volume, ducked, audio.paused, (window as any).__ttsActive)
  console.log('[TTS v8 DIAG] __ttsDucked=%s, __audioOutputDeviceId=%s, __ttsUseSimulatedVolume=%s',
    (window as any).__ttsDucked, (window as any).__audioOutputDeviceId, (window as any).__ttsUseSimulatedVolume)
  console.log('[TTS v8 DIAG] stale AudioContext cleaned=%s, stale SourceNode cleaned=%s',
    staleCtx ? 'yes(closed)' : 'none', staleSource ? 'yes(disconnected)' : 'none')

  try {
    await new Promise<void>((resolve, reject) => {
      const checkInterrupt = setInterval(() => {
        if (!(window as any).__ttsActive) {
          console.warn('[TTS v8 DIAG] checkInterrupt: __ttsActive=false → pausing audio')
          clearInterval(checkInterrupt)
          clearTimeout(stallTimer)
          clearInterval(progressCheck)  // B1: 打断分支漏清 progressCheck——否则残留回调可能误清下一段 __ttsAudioElement
          setTtsAudioElement(null)
          audio.pause()
          resolve()
        }
      }, 100)

      // 2026-08-04 P0 修复(修订):播放挂起检测——GET 流中段挂起/后端不 ended 时
      // playNext await 永久 pending → 队列停播/onComplete 不触发/mic 挂起。
      // 注意:不能按固定 15s 截断——正常句子(40 字 @1.0x)可能播 15-20s,
      // 固定超时会 pause 打断正常播放(AbortError → 语音无声/中断)。
      // 挂起判定:N 秒内 currentTime 无任何前进(流未真正开始/卡死)才算挂起;
      // 播放中(currentTime 前进)则等待 ended,永不主动打断。
      // F1: 挂起窗口 8s → 3s——GET 为主路径后,挂起降级更快,避免用户白等
      // (熔断 __ttsHttpGetOk 保证每会话最多一次 3s 探测)。
      let lastProgressAt = Date.now()
      let lastProgressTime = 0
      const progressCheck = setInterval(() => {
        const t = audio.currentTime
        if (t !== lastProgressTime) {
          lastProgressTime = t
          lastProgressAt = Date.now()
        } else if (Date.now() - lastProgressAt > 3000 && t === 0) {
          // 3s 无任何进度(未开始播放)= 挂起 → 走降级链
          clearInterval(progressCheck)
          clearInterval(checkInterrupt)
          clearTimeout(stallTimer)
          try { audio.pause() } catch (err: any) { console.warn('[TTS] audio.pause 失败(挂起检测):', err?.message || err) }
          setTtsAudioElement(null)
          console.warn('[TTS] 播放挂起(3s 无进度),走降级')
          reject(new Error('TTS GET stream stalled'))
        }
      }, 1000)
      // 最终兜底:60s 无 ended 且无进度才强制结束(正常长句不受影响)
      const stallTimer = setTimeout(() => {
        clearInterval(progressCheck)
        clearInterval(checkInterrupt)
        try { audio.pause() } catch (err: any) { console.warn('[TTS] audio.pause 失败(超时):', err?.message || err) }
        setTtsAudioElement(null)
        console.warn('[TTS] 播放 60s 无结束,强制超时(防挂起)')
        resolve()
      }, 60000)

      audio.onended = () => {
        clearInterval(checkInterrupt)
        clearTimeout(stallTimer)
        clearInterval(progressCheck)
        // 2026-08-03: 空段检测 — 后端曾返回 200+0字节空音频（edge/doubao 全失败），
        // <audio> 加载空流立即 ended，无声假装"播放完成"→ 用户听到"播一半就停"。
        // duration 为 0/NaN 视为空段 → reject 触发降级/重试链
        if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
          reject(new Error('TTS empty audio (all providers failed?)'))
          return
        }
        resolve()
      }
      audio.onerror = () => {
        clearInterval(checkInterrupt)
        clearTimeout(stallTimer)
        clearInterval(progressCheck)
        reject(new Error('TTS GET stream playback error'))
      }

      audio.play().then(() => {
        console.log('[TTS v8 DIAG] audio.play() RESOLVED! duration=%s, currentTime=%s, readyState=%s',
          audio.duration, audio.currentTime, audio.readyState)
      }).catch(e => {
        clearInterval(checkInterrupt)
        clearTimeout(stallTimer)
        clearInterval(progressCheck)
        console.error('[TTS v8 DIAG] audio.play() REJECTED: %s: %s', e?.name, e?.message)
        reject(e)
      })
    })

    setTtsAudioElement(null)
    console.log('[TTS] GET stream playback complete')
    return true
  } catch (e: any) {
    setTtsAudioElement(null)
    console.warn('[TTS] GET stream playback failed:', e?.message)
    return false
  }
}

async function playTTSStream(text: string, voiceConfig: VoiceConfig): Promise<void> {
  const params = buildTTSRequestParams(text, voiceConfig)

  // 创建 AbortController，TTS 打断时可以中止 fetch 请求
  const controller = new AbortController()
  const prevAbort = getTtsState().aborted
  if (prevAbort) { try { prevAbort.abort() } catch (e) { console.warn('[TTS] 中止前一个 TTS 请求失败:', e) } }
  setTtsAbortController(controller)

  // 诊断：记录 TTS 请求开始
  console.log('[TTS] playTTSStream: fetch start, text=(%d chars)', text.length)
  try { localStorage.setItem('crabpaw_tts_diag', JSON.stringify({ step: 'fetch_start', textLen: text.length, ts: Date.now() })) } catch (e) { console.warn('[TTS] localStorage 写入失败 (fetch_start):', e) }

  let response: Response
  try {
    // 2026-08-04 修复:渲染进程 fetch 到 38767 需带鉴权——getApiHeaders 在
    // Electron S4 下无 token(api:credentials 不返回)→ 401 → 降级路径无声。
    // 改用 resolveApiUrl(streamUrl token 注入 query,后端鉴权认 query token)
    const { resolveApiUrl } = await import('../lib/api')
    const url = await resolveApiUrl('/api/voice/tts/stream')
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    try {
      const { getApiHeaders } = await import('../lib/api')
      Object.assign(headers, await getApiHeaders())
    } catch (err: any) { console.warn('[TTS] 操作失败:', err?.message || err) }
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
      signal: controller.signal,
    })
  } catch (fetchErr: any) {
    if (fetchErr?.name === 'AbortError') return // 打断，正常中止
    throw fetchErr
  }

  console.log('[TTS] playTTSStream: fetch response %d', response.status)
  try { localStorage.setItem('crabpaw_tts_diag', JSON.stringify({ step: 'fetch_done', status: response.status, ts: Date.now() })) } catch (e) { console.warn('[TTS] localStorage 写入失败 (fetch_done):', e) }

  if (!response.ok) {
    throw new Error(`TTS API error: ${response.status}`)
  }
  if (!response.body) {
    throw new Error('No response body')
  }

  // ─── 1. 收集完整音频数据 ───
  const chunks: Uint8Array[] = []
  const reader = response.body.getReader()

  // B1: read 循环加 stall 超时——后端推流中断时 await reader.read() 会永久 pending,
  // playNext 随之永久挂起、__ttsActive 悬挂、mic 一直 suspend。12s 无数据判挂起降级。
  let readStalled = false
  const stallTimer = setTimeout(() => {
    readStalled = true
    try { reader.cancel() } catch (e) {
      /* best-effort */
      console.warn('[useVoiceReply.ts] 空 catch 补日志:', e instanceof Error ? e.message : e);
    }

  }, 12000)

  try {
    while (true) {
      if (!(window as any).__ttsActive) {
        reader.cancel().catch(() => {})
        clearTimeout(stallTimer)
        return
      }
      const { done, value } = await reader.read()
      if (readStalled) {
        clearTimeout(stallTimer)
        throw new Error('TTS stream read stalled')
      }
      if (done) break
      chunks.push(value)
    }
  } catch (e: any) {
    clearTimeout(stallTimer)
    if (e?.name === 'AbortError') return // 打断中止
    if (readStalled) throw e // 挂起 → 走降级链
    console.warn('[TTS] 流式读取失败:', (e as Error)?.message)
    return
  } finally {
    clearTimeout(stallTimer)
    // 清理 AbortController 引用
    if (getTtsState().aborted === controller) {
      setTtsAbortController(null)
    }
  }

  if (chunks.length === 0) {
    // 2026-08-03: 空响应不再静默成功 — 抛错触发 playTTSAndTrack 降级/重试链
    // （此前 return → 段"无声播放完成"→ 用户听到"播一半就停"）
    console.warn('[TTS] 无音频数据')
    throw new Error('TTS empty audio (all providers failed?)')
  }

  // 合并 chunks
    const totalLen = chunks.reduce((s, c) => s + c.length, 0)
    const combined = new Uint8Array(totalLen)
    let offset = 0
    for (const c of chunks) { combined.set(c, offset); offset += c.length }

    // ─── 2. 打断检测 ───
    if (!(window as any).__ttsActive) return

    // 诊断：记录解码前
    console.log('[TTS] playTTSStream: decoding %d bytes', totalLen)
    try { localStorage.setItem('crabpaw_tts_diag', JSON.stringify({ step: 'decode_start', bytes: totalLen, ts: Date.now() })) } catch (e) { console.warn('[TTS] localStorage 写入失败 (decode_start):', e) }

    // ─── 3. 使用 <audio> 元素播放（避免 AudioContext.decodeAudioData 崩溃） ───
  // ⚠️ 不使用 AudioContext.decodeAudioData！
  // Chrome Web Audio 存在 "use after free" 漏洞 (CVE-2024-0807)，
  // 在 Electron 28 中 decodeAudioData 处理 MP3 时可能导致渲染进程崩溃。
  // <audio> 元素使用独立的媒体管线，不经过 Web Audio，完全绕开此问题。
  const ducked = (window as any).__ttsDucked === true

  try {
    // 创建 Blob URL
    const blob = new Blob([combined], { type: 'audio/mpeg' })
    const blobUrl = URL.createObjectURL(blob)

    // 诊断：创建 Blob URL 成功
    console.log('[TTS] Blob URL created: %d bytes, ducked=%s', totalLen, ducked)
    try { localStorage.setItem('crabpaw_tts_diag', JSON.stringify({ step: 'blob_url_ok', bytes: totalLen, ts: Date.now() })) } catch (e) { console.warn('[TTS] localStorage 写入失败 (blob_url_ok):', e) }

    // 再次检查打断
    if (!(window as any).__ttsActive) {
      URL.revokeObjectURL(blobUrl)
      return
    }

    // 创建 <audio> 元素播放
				    const audio = new Audio()
				    audio.volume = duckVolumeFor(ducked) /* 音量自适应已移除: 原 computeBoostVolume(getNoiseRms()) 恒为 1 */

				    // V7 fix: 保存 audio 元素到全局，使 AudioOutputManager 可监听 ended/error 事件
				    setTtsAudioElement(audio)

				    // v8: 清理残留的 AudioContext（可能干扰新 <audio> 播放）
				    const blobStaleCtx = (window as any).__ttsAudioCtx as AudioContext | undefined
				    if (blobStaleCtx && blobStaleCtx.state !== 'closed') {
				      console.warn('[TTS v8] Blob: closing stale AudioContext (state=%s)', blobStaleCtx.state)
				      try { blobStaleCtx.close() } catch (err: any) { console.warn('[TTS] blobStaleCtx close 失败:', err?.message || err) }
				      ;(window as any).__ttsAudioCtx = null
				      ;(window as any).__ttsFxAudioCtx = null
				      ;(window as any).__ttsFxSourceNode = null
				    }

			    // v8: 不再用 createMediaElementSource！它会禁用 <audio> 原生输出，
			    // 在 Electron 中 AudioContext.destination 可能不输出到扬声器导致无声。
			    // 改为 <audio> 原生播放 + 模拟音量驱动球体动画
			    console.log('[TTS] Blob: using native <audio> playback (no createMediaElementSource)')
				    ;(window as any).__ttsAnalyser = null
				    ;(window as any).__ttsUseSimulatedVolume = true

		    // v8: 不调 setSinkId，使用系统默认输出
			    audio.src = blobUrl

    // 等待播放完成
	    await new Promise<void>((resolve, reject) => {
	      // 检查打断
	      const checkInterrupt = setInterval(() => {
	        if (!(window as any).__ttsActive) {
	          clearInterval(checkInterrupt)
	          // V7 fix: 打断时清除全局 audio 元素引用
	          setTtsAudioElement(null)
	          audio.pause()
	          URL.revokeObjectURL(blobUrl)
	          resolve()
	        }
	      }, 100)

	      audio.onended = () => {
	        clearInterval(checkInterrupt)
	        URL.revokeObjectURL(blobUrl)
	        console.log('[TTS] Blob playback complete')
	        resolve()
	      }
	      audio.onerror = (err) => {
	        clearInterval(checkInterrupt)
	        URL.revokeObjectURL(blobUrl)
	        console.warn('[TTS] Blob audio.onerror:', err)
	        reject(new Error('TTS audio playback error'))
	      }

	      // 关键修复：不依赖 oncanplaythrough 事件来触发播放！
	      // Blob URL 的数据在创建时已完整可用，oncanplaythrough 可能在
	      // 设置 handler 之前就已触发（竞态条件），导致 audio.play() 永远不会被调用。
	      // 改为：直接调用 audio.play()，如果音频尚未就绪，浏览器会自动缓冲后播放。
	      console.log('[TTS] Blob: calling audio.play(), volume=%s', audio.volume)
	      audio.play().then(() => {
	        console.log('[TTS] Blob: audio.play() succeeded')
	      }).catch(e => {
	        clearInterval(checkInterrupt)
	        URL.revokeObjectURL(blobUrl)
	        console.warn('[TTS] Blob: audio.play() FAILED:', e?.name, e?.message)
	        reject(e)
	      })
	    })

    // V7 fix: 播放完成后清除全局 audio 元素引用
	    setTtsAudioElement(null)
	    console.log('[TTS] playback complete')
	    try { localStorage.setItem('crabpaw_tts_diag', JSON.stringify({ step: 'playback_ok', ts: Date.now() })) } catch (e) { console.warn('[TTS] localStorage 写入失败 (playback_ok):', e) }
	    return
	  } catch (e: any) {
	    // V7 fix: 播放出错时也清除全局 audio 元素引用
	    setTtsAudioElement(null)
	    console.warn('[TTS] 播放失败:', e?.message)
	    try { localStorage.setItem('crabpaw_tts_diag', JSON.stringify({ step: 'playback_error', error: e?.message, ts: Date.now() })) } catch (_e) { console.warn('[TTS] localStorage 写入失败 (playback_error):', _e) }
	    return
	  }
}

/**
 * (v6→BLM) MediaSource 流式播放 TTS — 边收边播，首包到达即出声
 * Ported from 早期 playTTSViaMediaSource 实现
 *
 * 关键修复：
 *   - sourceopen({ once: true }) 避免重复触发
 *   - audio.onended 在 read 循环开始前注册，不漏短句先播完的事件
 *   - async IIFE 读循环带 try/catch，任何异常路径都 safeResolve()
 *   - 24s 安全超时兜底防止 Promise 挂起
 */
async function playAudioFile(filePath: string): Promise<void> {
  if (window.electronAPI?.voice?.play) {
    await window.electronAPI.voice.play(filePath)
  }
}

/**
 * (旧) 非流式 TTS — base64 → blob → Audio 播放
 */
async function playAudioBase64(audioBase64: string, audioFormat: string): Promise<void> {
  const binary = atob(audioBase64)
  const bytes = new Uint8Array(binary.length)
  for (let j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j)
  const mime = audioFormat === 'wav' ? 'audio/wav' : 'audio/mpeg'
  const blobUrl = URL.createObjectURL(new Blob([bytes], { type: mime }))
  const ducked = (window as any).__ttsDucked === true
  await new Promise<void>((resolve, reject) => {
    const audio = new Audio()
    audio.setAttribute('data-tts', '1')
    // V7 fix: 保存 audio 元素到全局，使 AudioOutputManager 可监听 ended/error 事件
    setTtsAudioElement(audio)
    // 挂载到 DOM，使 Jarvis 音效可接入
    const container = document.getElementById('tts-audio-container') || (() => {
      const el = document.createElement('div')
      el.id = 'tts-audio-container'
      el.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none'
      document.body.appendChild(el)
      return el
    })()
    container.appendChild(audio)
    audio.volume = duckVolumeFor(ducked) /* 音量自适应已移除: 原 computeBoostVolume(getNoiseRms()) 恒为 1 */
    // v8: 不调 setSinkId，使用系统默认输出
		    audio.src = blobUrl
	    const checkInterrupt = setInterval(() => {
	      if (!(window as any).__ttsActive) {
	        clearInterval(checkInterrupt)
	        // V7 fix: 打断时清除全局 audio 元素引用
	        setTtsAudioElement(null)
	        audio.pause()
	        URL.revokeObjectURL(blobUrl)
        try { if (audio.parentNode) audio.parentNode.removeChild(audio) } catch (e) { console.warn('[TTS] 移除 audio 元素失败:', e) }
        resolve()
	      }
	    }, 100)
audio.onended = () => { clearInterval(checkInterrupt); URL.revokeObjectURL(blobUrl); try { if (audio.parentNode) audio.parentNode.removeChild(audio) } catch (e) { console.warn('[TTS] onended 移除 audio 元素失败:', e) }; resolve() }
audio.onerror = () => { clearInterval(checkInterrupt); URL.revokeObjectURL(blobUrl); try { if (audio.parentNode) audio.parentNode.removeChild(audio) } catch (e) { console.warn('[TTS] onerror 移除 audio 元素失败:', e) }; reject(new Error('TTS base64 playback error')) }
    audio.play().catch(() => { clearInterval(checkInterrupt); reject(new Error('TTS base64 play rejected')) })
  })
  // V7 fix: 播放完成后清除全局 audio 元素引用
  setTtsAudioElement(null)
}

/**
 * 统一 TTS 播放入口：proxy JSON 主路径(渲染进程网络层到 38767 挂起,
 * fetch/audio 全挂,仅 api.proxy 通),失败降级到流式/文件
 */
async function playTTSAndTrack(
  text: string,
  voiceConfig: VoiceConfig,
): Promise<void> {
  console.log('[TTS v9] playTTSAndTrack: text=(%d chars) — GET 流式主路径',
    text.length)
  // F1: GET 流式(<audio> 边收边播,首帧延迟数百 ms)为第一优先——
  // 消除"文本先出半天才有声音"的逐句全量下载滞后。
  // 会话级熔断 __ttsHttpGetOk: 每会话最多一次挂起探测(3s)；
  // 之后本会话剩余段直接走 proxy JSON,避免逐段等待。
  if ((window as any).__ttsHttpGetOk !== false) {
    try {
      const ok = await playTTSViaHttpGet(text, voiceConfig)
      if (ok) {
        ;(window as any).__ttsHttpGetOk = true
        return
      }
      // GET 不可用(挂起/播放错误) → 本会话熔断,降级 proxy JSON
      ;(window as any).__ttsHttpGetOk = false
      console.warn('[TTS] GET 流式不可用,熔断(本会话降级 JSON 全量下载)')
    } catch (e: any) {
      ;(window as any).__ttsHttpGetOk = false
      console.warn('[TTS] GET 流式异常,熔断:', e?.message || e)
    }
  }

  // proxy JSON 主路径(整段下载,可用性最稳——主进程代理 200 + audioBase64)
  try {
    const result: any = await fetchTTSJSON(text, voiceConfig)
    if (result?.success && result.audioBase64) {
      await playAudioBase64(result.audioBase64, result.audioFormat || 'mp3')
      return
    }
    console.warn('[TTS] proxy JSON 主路径失败:', result?.error || 'unknown')
  } catch (e: any) {
    console.warn('[TTS] proxy JSON 主路径异常:', e?.message || e)
  }

  // POST 流式降级
  try {
    await playTTSStream(text, voiceConfig)
    return
  } catch (e: any) {
    console.warn(`[TTS] POST 流式播放失败:`, e?.message || e)
  }

  // 最后尝试:文件路径降级——失败则抛错给上游终止队列
  try {
    const result: any = await fetchTTSJSON(text, voiceConfig)
    if (result?.success && result.filePath) {
      await playAudioFile(result.filePath)
    } else if (result?.success && result.audioBase64) {
      await playAudioBase64(result.audioBase64, result.audioFormat)
    } else {
      // P2 修复: 所有降级路径均失败 → 抛错给上游(而非静默 return),
      // 使 playNext 能跳过剩余段并触发用户可见反馈。
      throw new Error('TTS 全链路失败：' + (result?.error || '所有降级路径均不可用'))
    }
  } catch (e: any) {
    // P2 修复: 不再静默吞错——重新抛出使调用方可感知
    console.error('[TTS] 所有播放方式均失败:', e?.message || e)
    throw e
  }
}

/**
 * 降级用的 JSON 模式 TTS
 */
async function fetchTTSJSON(text: string, config: VoiceConfig): Promise<any> {
  const params = buildTTSRequestParams(text, config)
  // 2026-08-04 修复:渲染进程 fetch 到 38767 不稳(Failed to fetch/401,与 DocReader 同款
  // 网络层问题)→ JSON 模式走 api.proxy(主进程代理,audioBase64 在 JSON 内无损传输)
  if (typeof window !== 'undefined' && window.electronAPI?.api?.proxy) {
    const res = await window.electronAPI.api.proxy('POST', '/api/voice/tts', params)
    if (res?.success && typeof res.data === 'object' && res.data !== null) return res.data
    return { success: false, error: res?.error || `HTTP ${res?.status || 'unknown'}` }
  }
  const { resolveApiUrl } = await import('../lib/api')
  const url = await resolveApiUrl('/api/voice/tts')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  try {
    const { getApiHeaders } = await import('../lib/api')
    Object.assign(headers, await getApiHeaders())
  } catch (err: any) { console.warn('[TTS] 操作失败:', err?.message || err) }
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
  })
  return res.json()
}

export function useVoiceReply(hookOptions?: any) {
  // 2026-08-01: 移除 Proxy 诊断——__ttsActive 已由本 hook 单一管理
  // （VoiceStateContext 不再写入），无需追踪多写入者。
  const playbackIdRef = useRef(0)
  const abortRef = useRef(false)
  const optionsRef = useRef(hookOptions)

  // P1 修复: 模块级会话序列号——多实例(useVoiceChatFlow + useProactiveVoice)
  // 共享全局 __ttsActive/__ttsAbortController/__ttsAudioElement 导致双声与打断错乱。
  // 每个 beginStreamingTTS 领取自增 token,playNext/markDone/interruptTTS 只对
  // "当前 token 持有者"生效,被取代实例的异步续播直接退出。
  const sessionSeqRef = useRef(0)
  // 2026-08-12: 极端裁剪累计计数(诊断浮层展示)
  const trimTotalRef = useRef(0)
  // 保证 render 期间也能读到(模块闭包 + window 双保险)
  if ((window as any).__ttsSessionSeq === undefined) {
    ;(window as any).__ttsSessionSeq = 0
  }

  // ── 流式 TTS 状态 ──
  const sttsActiveRef = useRef(false)
  const sttsConsumedRef = useRef(0)
  const sttsBufRef = useRef('')
  const sttsQueueRef = useRef<string[]>([])
  const sttsExtractedRef = useRef<Set<string>>(new Set())
  const sttsPlayingRef = useRef(false)
  const sttsSpokenRef = useRef('')
  const sttsCurSegRef = useRef('')
  const sttsCurSegIdxRef = useRef(0)
  const sttsSegCountRef = useRef(0)
  const sttsStreamDoneRef = useRef(false)
  const sttsMicSuspendedRef = useRef(false)
  const sttsVoiceConfigRef = useRef<VoiceConfig | null>(null)
  const sttsOptionsRef = useRef<StreamTTSOptions | null>(null)
  const sttsPlayNextFnRef = useRef<(() => void) | null>(null)
  const currentPlaybackIdRef = useRef(0)
  // B1: feed 节流时间戳——实例级（避免多 useVoiceReply 实例共享全局时间戳互相丢弃 chunk）
  const sttsLastFeedTsRef = useRef(0)

  // ── TTS 预取缓存 — 当前句播放时预取下一句的音频数据 ──
  const sttsPrefetchMapRef = useRef<Map<string, { status: 'loading' | 'ready' | 'error'; audioData?: ArrayBuffer }>>(new Map())

  const interruptTTS = useCallback(async (_fireCallbacks?: boolean) => {
    abortRef.current = true
    playbackIdRef.current++
    currentPlaybackIdRef.current = playbackIdRef.current
    // P1: 递增全局会话序列号——多实例协调:被取代实例的 playNext/checkInterrupt
    // 发现 __ttsSessionSeq 不匹配即退出,防止双声
    const newSeq = ((window as any).__ttsSessionSeq || 0) + 1
    ;(window as any).__ttsSessionSeq = newSeq
    sessionSeqRef.current = 0 // 当前实例也失去 token,beginStreamingTTS 会重新领取
    setTtsActive('stts', false)
    ;(window as any).__ttsPlaybackId = playbackIdRef.current

    // 中止正在进行的 TTS fetch 请求，防止后端继续推数据导致 EPIPE
    const activeAbort = getTtsState().aborted
    if (activeAbort) { try { activeAbort.abort() } catch (e) { console.warn('[TTS] activeAbort.abort 失败:', e) } }
    setTtsAbortController(null)

    if (window.electronAPI?.voice?.stop) window.electronAPI.voice.stop()

    // ── 计算精确打断位置（对齐句末标点） ──
    // 流式逐句模式：已播段文本就是精确的已说内容
    const spokenText = sttsSpokenRef.current
    // 合并当前正在播放的段 + 队列中尚未播放的段 = 完整剩余文本
    const curSeg = sttsCurSegRef.current
    const queueText = sttsQueueRef.current.join('')
    const fullText = spokenText + curSeg + queueText + sttsBufRef.current

    // 使用句末标点对齐确定已说/未说分界
    const { spokenUpTo } = findSentenceBoundary(fullText, spokenText.length)
    const alignedSpoken = fullText.substring(0, spokenUpTo)
    const remainingText = fullText.substring(spokenUpTo)

    // 立即重置状态（必须在任何 async 之前，防止 race condition）
    // B1: 打断前记录 mic 是否被本会话挂起——打断后需恢复（playNext 的
    // onSuspendMic 已调用但 interruptTTS 不回调 onResumeMic → 消费方 mic 永久挂起）
    const wasMicSuspended = sttsMicSuspendedRef.current
    sttsActiveRef.current = false
    sttsQueueRef.current = []
    sttsExtractedRef.current = new Set()
    sttsBufRef.current = ''
    sttsCurSegRef.current = ''
    sttsSpokenRef.current = ''
    sttsPlayingRef.current = false
    sttsSegCountRef.current = 0
    sttsCurSegIdxRef.current = 0
    sttsMicSuspendedRef.current = false
    sttsPrefetchMapRef.current.clear()  // 清理预取缓存
    if (wasMicSuspended) {
      try { sttsOptionsRef.current?.onResumeMic?.() } catch (e) { console.warn('[TTS] interruptTTS onResumeMic 回调异常:', e) }
    }
    ;(window as any).__ttsInterruptedSpoken = alignedSpoken
    ;(window as any).__ttsInterruptedAt = Date.now()
    ;(window as any).__ttsSegmentPulse = { segmentIndex: 0, active: false }
    ;(window as any).__ttsInterruptedRemaining = remainingText  // 保存剩余文本，用于续播

    // ── 延迟 4 秒写 DB（对标参考实现：给误报恢复留窗口） ──
    // 取消之前的延迟写入定时器（防止重复写入）
    const prevDbTimer = (window as any).__ttsInterruptionDbTimer as ReturnType<typeof setTimeout> | undefined
    if (prevDbTimer) { clearTimeout(prevDbTimer) }

    if (alignedSpoken.length > 0) {
      ;(window as any).__ttsInterruptionDbTimer = setTimeout(async () => {
        ;(window as any).__ttsInterruptionDbTimer = undefined
        try {
          const baseUrl = await ttsBaseUrl()
          fetch(`${baseUrl}/api/voice/tts/interrupted`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ spokenContent: alignedSpoken, interruptedAt: Date.now() }),
          }).catch(e => console.warn('[TTS] 打断记录请求失败:', e))  // fire-and-forget
        } catch (e) { console.warn('[TTS] 打断记录异常:', e) }
      }, 4000)  // 延迟 4 秒，误报恢复可在此窗口内撤销
    }

    // 2026-08-04 P0 修复:打断必然触发 onInterrupted——此前 fireCallbacks 未传时
    // (stopSpeaking/静音切换/onError 路径)回调不触发 → setIsSpeaking(false) 永不执行
    // → isSpeaking 死锁:球体永久"播报中"、ASR 会话永久挂起(连续对话死锁)
    try { sttsOptionsRef.current?.onInterrupted?.() } catch (e) { console.warn('[TTS] onInterrupted 回调异常:', e) }
  }, [])

  // I6 修复: __voiceInterruptTTS 改为广播——多实例注册,遍历列表全部调用。
  // 注意: seq-token 代际兜底仍在 interruptTTS 内部生效(递增 __ttsSessionSeq),
  // 被取代实例的 playNext 发现 token 不匹配即退出,不会产生双声。
  useEffect(() => {
    if (!(window as any).__voiceInterruptTTSList) {
      ;(window as any).__voiceInterruptTTSList = []
    }
    const list: Array<() => void> = (window as any).__voiceInterruptTTSList
    list.push(interruptTTS)
    ;(window as any).__voiceInterruptTTS = () => {
      for (const fn of list) { try { fn() } catch (e) { console.warn('[TTS] interruptTTS 广播异常:', e) } }
    }
    return () => {
      const idx = list.indexOf(interruptTTS)
      if (idx >= 0) list.splice(idx, 1)
      if (list.length === 0) {
        ;(window as any).__voiceInterruptTTS = null
      }
    }
  }, [interruptTTS])

  // ── 段脉冲卸载清理：组件卸载时恢复初始值（防 active 残留 → KPI 辉光悬挂） ──
  // 若另一实例正在播放，其 playNext 会在下一段开始时重新写入脉冲，短暂清空无碍
  useEffect(() => {
    return () => {
      try {
        ;(window as any).__ttsSegmentPulse = { segmentIndex: 0, active: false }
      } catch (e) { console.warn('[TTS] 卸载清理段脉冲失败:', e) }
    }
  }, [])

  // ── TTS 预取：当前句播放时异步预取下一句的音频数据 ──
  const prefetchSegment = useCallback(async (seg: string, voiceConfig: VoiceConfig) => {
    if (sttsPrefetchMapRef.current.has(seg)) return // 已在预取或已就绪
    sttsPrefetchMapRef.current.set(seg, { status: 'loading' })
    try {
      const params = buildTTSRequestParams(seg, voiceConfig)
      // 2026-08-04 修复:渲染进程 fetch 到 38767 挂起(prefetch 一直失败→每句串行
      // 等合成→语音严重滞后)。Electron 走 api.proxy JSON(主进程代理已验证 200),
      // audioBase64 转 Uint8Array 缓存——与主路径同机制,支持并行预取
      let audioData: ArrayBuffer | null = null
      if (typeof window !== 'undefined' && window.electronAPI?.api?.proxy) {
        const res = await window.electronAPI.api.proxy('POST', '/api/voice/tts', params)
        if (!res?.success || typeof res.data?.audioBase64 !== 'string') {
          throw new Error(res?.error || 'TTS prefetch failed')
        }
        const binary = atob(res.data.audioBase64)
        const bytes = new Uint8Array(binary.length)
        for (let j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j)
        audioData = bytes.buffer
      } else {
        const { resolveApiUrl } = await import('../lib/api')
        const url = await resolveApiUrl('/api/voice/tts/stream')
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        try {
          const { getApiHeaders } = await import('../lib/api')
          Object.assign(headers, await getApiHeaders())
        } catch (err: any) { console.warn('[TTS] 操作失败:', err?.message || err) }
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(params),
          signal: getTtsState().aborted?.signal as AbortSignal | undefined,
        })
        if (!response.ok) throw new Error(`TTS prefetch error: ${response.status}`)
        audioData = await response.arrayBuffer()
      }
      // 2026-08-03: 空音频不缓存为 ready（否则 playNext 预取命中播 0 字节无声段）
      if (!audioData || audioData.byteLength === 0) {
        sttsPrefetchMapRef.current.set(seg, { status: 'error' })
        console.warn('[TTS] 预取空音频: seg=(%d chars) (0 bytes)', seg.length)
        return
      }
      sttsPrefetchMapRef.current.set(seg, { status: 'ready', audioData })
      console.log('[TTS] 预取完成: seg=(%d chars) (%d bytes)', seg.length, audioData.byteLength)
    } catch (e: any) {
      sttsPrefetchMapRef.current.set(seg, { status: 'error' })
      if (e?.name !== 'AbortError') console.warn('[TTS] 预取失败:', (e as Error)?.message)
    }
  }, [])

  const playNext = useCallback(async () => {
    if (!sttsActiveRef.current || sttsPlayingRef.current) return
    const seg = sttsQueueRef.current.shift()
    if (!seg) {
      console.log('[TTS] playNext: queue empty (streamDone=%s)', sttsStreamDoneRef.current)
      if (sttsStreamDoneRef.current) endStreamingTTS()
      return
    }

    // P1: 检查自身是否仍持有全局会话 token——被另一实例 beginStreamingTTS
    // 抢占后 sessionSeqRef 已过期,直接退出不播放(防双声)
    const mySeq = sessionSeqRef.current
    sttsPlayingRef.current = true
    // ── 段脉冲：记录当前段索引并发出 active 信号（P7 Task9） ──
    const segIdx = sttsSegCountRef.current++
    sttsCurSegIdxRef.current = segIdx
    ;(window as any).__ttsSegmentPulse = { segmentIndex: segIdx, active: true }
    sttsCurSegRef.current = seg
    currentPlaybackIdRef.current = playbackIdRef.current
    setTtsActive('stts', true)
    ;(window as any).__ttsPlaybackId = playbackIdRef.current
    ;(window as any).__ttsCurrentPlaybackId = playbackIdRef.current

    const options = sttsOptionsRef.current
    const voiceConfig = sttsVoiceConfigRef.current!

    console.log('[TTS] playNext: seg=(%d chars)', seg.length)

    // 首帧时机诊断
    if (!(window as any).__ttsFirstAudioStart) {
      ;(window as any).__ttsFirstAudioStart = Date.now()
      const latency = (window as any).__ttsFirstAudioStart - (window as any).__ttsStreamStartTs
      if (latency > 100) console.log(`[TTS] 首句合成延迟: ${latency}ms`)
    }

    if (!sttsMicSuspendedRef.current) {
      sttsMicSuspendedRef.current = true
      options?.onSuspendMic?.()
    }

    options?.onSegmentStart?.(seg.substring(0, 80), 0, 0)

    // 保存当前段到全局，用于 barge-in 误触发恢复
    ;(window as any).__ttsCurrentSegment = seg

    // ── 并行预取下一句 — 当前句播放时预取队列中下一句 ──
    const nextSeg = sttsQueueRef.current[0]
    if (nextSeg && voiceConfig) {
      prefetchSegment(nextSeg, voiceConfig) // fire-and-forget，不阻塞当前播放
    }

    try {
      // 检查预取缓存
      const cached = sttsPrefetchMapRef.current.get(seg)
      if (cached?.status === 'ready' && cached.audioData) {
        // ── 预取命中：直接用缓存的音频数据播放，零延迟 ──
        console.log('[TTS] 预取命中: seg=(%d chars)', seg.length)
        sttsPrefetchMapRef.current.delete(seg)
        // 使用 <audio> 元素播放（避免 AudioContext.decodeAudioData 崩溃）
        const audioData = new Uint8Array(cached.audioData)
        const ducked = (window as any).__ttsDucked === true
        try {
          const blob = new Blob([audioData as any], { type: 'audio/mpeg' })
	          const blobUrl = URL.createObjectURL(blob)
	          const audio = new Audio()
	          audio.volume = duckVolumeFor(ducked) /* 音量自适应已移除: 原 computeBoostVolume(getNoiseRms()) 恒为 1 */
	          // V7 fix: 保存 audio 元素到全局，使 AudioOutputManager 可监听 ended/error 事件
		          setTtsAudioElement(audio)
		          // v8: 不调 setSinkId，使用系统默认输出
	          console.log('[TTS] prefetch hit: using system default audio output, volume=%s', audio.volume)
			          audio.src = blobUrl
          // 诊断：播放开始
          console.log('[TTS] prefetch hit: blobUrl set, audio.play() starting, volume=%s', audio.volume)
          await new Promise<void>((resolve, reject) => {
            // 打断检查（对标 playTTSStream 的 100ms 检查机制）
            const checkInterrupt = setInterval(() => {
              if (!(window as any).__ttsActive) {
                clearInterval(checkInterrupt)
                // V7 fix: 打断时清除全局 audio 元素引用
                setTtsAudioElement(null)
                audio.pause()
                URL.revokeObjectURL(blobUrl)
                resolve()
              }
            }, 100)
            audio.onended = () => { clearInterval(checkInterrupt); URL.revokeObjectURL(blobUrl); console.log('[TTS] prefetch hit: playback complete'); resolve() }
            audio.onerror = (e) => { clearInterval(checkInterrupt); URL.revokeObjectURL(blobUrl); console.warn('[TTS] prefetch hit: audio.onerror', e); reject(new Error('prefetch hit audio error')) }
            audio.play().then(() => { console.log('[TTS] prefetch hit: audio.play() succeeded') }).catch((playErr) => {
              clearInterval(checkInterrupt); URL.revokeObjectURL(blobUrl)
              console.warn('[TTS] prefetch hit: audio.play() FAILED:', playErr?.name, playErr?.message)
              reject(playErr)
            })
          })
	          // V7 fix: 播放完成后清除全局 audio 元素引用
	          setTtsAudioElement(null)
	        } catch (e: any) {
          // B1: 预取命中播放失败不再静默吞掉——抛给外层统一走"清队列+广播错误"
          // 降级链（与 playTTSAndTrack 路径一致），否则段无声"播放完成"被记为已播。
          console.warn('[TTS] 预取命中播放失败:', e?.message)
          throw e
        }
      } else {
        // ── 预取未命中或未预取：走正常流式播放 ──
        sttsPrefetchMapRef.current.delete(seg)
        await playTTSAndTrack(seg, voiceConfig)
      }
    } catch (e) {
      // P2 修复: TTS 全链路失败 → 跳过剩余段并触发用户可见反馈。
      // 清空队列防止每段都走四层降级(auth 失效时避免级联 401),
      // 广播全局错误事件供 VoiceShell/Notify 展示。
      console.warn('[TTS] segment failed:', (e as Error)?.message)
      sttsQueueRef.current = []
      sttsPrefetchMapRef.current.clear()
      try {
        window.dispatchEvent(new CustomEvent('crabpaw:tts-error', {
          detail: { message: '语音播报失败，请检查网络与 TTS 配置' }
        }))
      } catch (_evtErr) { console.warn('[TTS] 广播 TTS 错误事件失败:', _evtErr) }
      // I5 修复: catch 后 return——失败段不记为"已播"，不触发 onSegmentEnd，不续播下一段
      // C1 修复: 段播放失败时复位脉冲信号，防止 KPI 辉光持续至下次 beginStreamingTTS
      ;(window as any).__ttsSegmentPulse = { segmentIndex: 0, active: false }
      sttsPlayingRef.current = false
      return
    }

    if (abortRef.current) {
      sttsPlayingRef.current = false
      return
    }

    // P1: 播放完成后检查是否仍持有全局会话 token——被另一实例抢占后
    // sessionSeqRef 已过期,不再链式播放下一段(防双声)
    if ((window as any).__ttsSessionSeq !== mySeq) {
      sttsPlayingRef.current = false
      return
    }

    sttsSpokenRef.current += seg
    ;(window as any).__ttsSpokenRef = sttsSpokenRef.current
    sttsCurSegRef.current = ''
    sttsPlayingRef.current = false
    options?.onSegmentEnd?.(0)
    // ── 段脉冲：段播放完毕，active=false（P7 Task9） ──
    ;(window as any).__ttsSegmentPulse = { segmentIndex: sttsCurSegIdxRef.current, active: false }

    // 立即播下一段（零间隙）— 捕获异常防止未处理的 Promise rejection
    if (sttsQueueRef.current.length > 0) {
      Promise.resolve(playNext()).catch((e) => console.warn('[TTS] playNext chain error:', (e as Error)?.message))
    } else if (sttsStreamDoneRef.current) {
      endStreamingTTS()
    }
  }, [prefetchSegment])

  // 保持 playNext 引用最新
  sttsPlayNextFnRef.current = playNext

  // ── 恢复 TTS（用于 barge-in 误触发恢复） ──
  // 对标参考实现：续播时撤销延迟 DB 写入 + 从剩余文本恢复
  const setupResumeTTS = useCallback(() => {
    ;(window as any).__voiceResumeTTS = () => {
      // 撤销延迟的 DB 写入（4s 窗口内续播 → 打断未真正发生）
      const dbTimer = (window as any).__ttsInterruptionDbTimer as ReturnType<typeof setTimeout> | undefined
      if (dbTimer) { clearTimeout(dbTimer); (window as any).__ttsInterruptionDbTimer = undefined }

      if (!sttsActiveRef.current) {
        // sttsActive 已被 interruptTTS 重置，需要从剩余文本恢复整个流式会话
        const remainingText = (window as any).__ttsInterruptedRemaining as string | undefined
        if (remainingText && remainingText.length > 0) {
          const voiceConfig = sttsVoiceConfigRef.current
          const options = sttsOptionsRef.current
          if (voiceConfig && options) {
            // 重新启动流式 TTS，从剩余文本开始
            sttsActiveRef.current = true
            setTtsActive('stts', true)
            // B1/H6: interruptTTS 已把 sessionSeqRef 置 0 并递增全局 __ttsSessionSeq,
            // 恢复会话必须重领 token——否则 playNext 首段播完后的代际检查
            // (__ttsSessionSeq !== mySeq) 必然失败,只续播一段即停、__ttsActive 悬挂。
            const mySeq = ((window as any).__ttsSessionSeq || 0) + 1
            ;(window as any).__ttsSessionSeq = mySeq
            sessionSeqRef.current = mySeq
            sttsQueueRef.current = []
            sttsExtractedRef.current = new Set()
            sttsBufRef.current = remainingText
            sttsStreamDoneRef.current = true  // 剩余文本是完整的，不需要等更多 chunk
            sttsSpokenRef.current = ''
            sttsSegCountRef.current = 0
            sttsCurSegIdxRef.current = 0
            sttsCurSegRef.current = ''
            sttsPlayingRef.current = false
            sttsMicSuspendedRef.current = false
            playbackIdRef.current++
            currentPlaybackIdRef.current = playbackIdRef.current
            abortRef.current = false
            ;(window as any).__ttsPlaybackId = playbackIdRef.current
            ;(window as any).__ttsSegmentPulse = { segmentIndex: 0, active: false }
            // 切分句子并开始播放
            extractSentences({ flushPartial: true })
            console.log('[TTS] resumeTTS: 从剩余文本恢复 (%d chars)', remainingText.length)
            return
          }
        }
        return
      }
      // sttsActive 仍为 true 的情况（当前段被暂停但队列未清空）
      const curSeg = (window as any).__ttsCurrentSegment
      const pn = sttsPlayNextFnRef.current
      if (!pn) return
      if (curSeg && !sttsPlayingRef.current && sttsQueueRef.current.length === 0) {
        sttsQueueRef.current.unshift(curSeg)
        Promise.resolve(pn()).catch((e: any) => console.warn('[TTS] resumeTTS playNext error:', e?.message))
      } else if (curSeg && !sttsPlayingRef.current) {
        Promise.resolve(pn()).catch((e: any) => console.warn('[TTS] resumeTTS playNext error:', e?.message))
      }
    }
  }, [])

  // ── 句子提取 ──
  function extractSentences({ flushPartial = false, markDone = false } = {}) {
    if (!sttsActiveRef.current) return
    const buf = sttsBufRef.current
    let lastIdx = 0
    let match: RegExpExecArray | null

    STTS_SENTENCE_RE.lastIndex = 0
    while ((match = STTS_SENTENCE_RE.exec(buf)) !== null) {
      const s = match[0].trim()
      if (s && sttsHasReadable(s) && !sttsExtractedRef.current.has(s)) {
        sttsExtractedRef.current.add(s)
        sttsQueueRef.current.push(s)
      }
      lastIdx = STTS_SENTENCE_RE.lastIndex
    }

    let remaining = buf.slice(lastIdx)

    // 残留文本 > 18 字强制切分（首句尽早触发 TTS，原 40 字仍太保守——见 sttsIsUsefulPartial）
    if (!flushPartial && remaining.length >= 18 && sttsIsUsefulPartial(remaining)) {
      const breakMatch = remaining.match(/.{14,18}[\s，、]/)
      if (breakMatch) {
        const breakPos = breakMatch.index! + breakMatch[0].length
        const frag = remaining.substring(0, breakPos).trim()
        if (frag && sttsHasReadable(frag) && !sttsExtractedRef.current.has(frag)) {
            sttsExtractedRef.current.add(frag)
            sttsQueueRef.current.push(frag)
          remaining = remaining.substring(breakPos)
        }
      } else {
        const frag = remaining.substring(0, 50).trim()
        if (frag && sttsHasReadable(frag) && !sttsExtractedRef.current.has(frag)) {
            sttsExtractedRef.current.add(frag)
            sttsQueueRef.current.push(frag)
          remaining = remaining.substring(50)
        }
      }
    }

    sttsBufRef.current = remaining

    if (flushPartial) {
      const tail = sttsBufRef.current.trim()
      sttsBufRef.current = ''
      if (tail && sttsHasReadable(tail) && !sttsExtractedRef.current.has(tail)) {
        sttsExtractedRef.current.add(tail)
        sttsQueueRef.current.push(tail)
      }
    }

    if (markDone) sttsStreamDoneRef.current = true

    // F2: 播放队列速率控制——防失控上限（MAX_TTS_QUEUE_DEPTH=50）。
    // 2026-08-07: 不再"丢旧保新"裁剪正常回复——长回复/文档播报必须完整
    // （用户反馈"挑着内容播放/最后几个字没播完"根因）。仅当队列极端失控
    // （>50 段,约 2-4 分钟播报量）才丢队尾(丢新保新)防内存无界。
    const trim = trimSentenceQueue(sttsQueueRef.current, markDone ? Number.MAX_SAFE_INTEGER : MAX_TTS_QUEUE_DEPTH)
    if (trim.dropped > 0) {
      trimTotalRef.current += trim.dropped
      ;(window as any).__ttsTrimTotal = trimTotalRef.current
      console.warn('[TTS] 队列极端超限,跳过 %d 段最新积压(剩余 %d 段,累计 %d 段)',
        trim.dropped, sttsQueueRef.current.length, trimTotalRef.current)
    }

    if (sttsQueueRef.current.length > 0) {
      console.log('[TTS] extractSentences: queue=%d', sttsQueueRef.current.length)
    }

    // 如果没有在播放，启动播放链 — 捕获异常防止未处理的 Promise rejection
    if (!sttsPlayingRef.current) Promise.resolve(playNext()).catch((e) => console.warn('[TTS] extractSentences playNext error:', (e as Error)?.message))
  }

  function endStreamingTTS() {
    sttsActiveRef.current = false
    setTtsActive('stts', false)
    const options = sttsOptionsRef.current
    if (options) {
      if (sttsMicSuspendedRef.current) {
        sttsMicSuspendedRef.current = false
        options.onResumeMic?.()
      }
      options.onComplete?.()
    }
    sttsQueueRef.current = []
    sttsExtractedRef.current = new Set()
    sttsBufRef.current = ''
    sttsCurSegRef.current = ''
    sttsSpokenRef.current = ''
    sttsSegCountRef.current = 0
    sttsCurSegIdxRef.current = 0
    sttsPlayingRef.current = false
    sttsPrefetchMapRef.current.clear()  // 清理预取缓存
    ;(window as any).__ttsSegmentPulse = { segmentIndex: 0, active: false }
  }

  const beginStreamingTTS = useCallback((voiceConfig: VoiceConfig, options: StreamTTSOptions = {}) => {
    if (!voiceConfig.replyEnabled && !voiceConfig.continuousMode) {
      console.log('[TTS] beginStreamingTTS skipped: replyEnabled=false continuousMode=%s', voiceConfig.continuousMode)
      return
    }
    console.log('[TTS] beginStreamingTTS: provider=%s voice=%s',
      voiceConfig.ttsProvider, voiceConfig.defaultVoice)
    // 诊断数据
    ;(window as any).__ttsProvider = voiceConfig.ttsProvider
    ;(window as any).__ttsVoice = resolveVoice(voiceConfig)
    interruptTTS()
    // 2026-08-07: 流式接管——停掉正在播放的 voice_play 播报（useVoicePlayConsumer），
    // 防双声；voice_play 消费者不复位 __ttsActive，不再误伤本播放器
    try { ;(window as any).__voicePlayStop?.() } catch (err) { console.warn('[TTS] 停 voice_play 失败:', err) }

    playbackIdRef.current++
    abortRef.current = false
    currentPlaybackIdRef.current = playbackIdRef.current
    // P1: 领取新的全局会话 token——interruptTTS 已递增 seq 使旧实例失效,
    // 此处再递增一次作为新会话的 token,确保唯一
    const mySeq = ((window as any).__ttsSessionSeq || 0) + 1
    ;(window as any).__ttsSessionSeq = mySeq
    sessionSeqRef.current = mySeq
    sttsActiveRef.current = true
    sttsConsumedRef.current = 0
    sttsBufRef.current = ''
    sttsQueueRef.current = []
    sttsPlayingRef.current = false
    sttsSpokenRef.current = ''
    sttsSegCountRef.current = 0
    sttsCurSegIdxRef.current = 0
    sttsCurSegRef.current = ''
    sttsStreamDoneRef.current = false
    sttsMicSuspendedRef.current = false
    sttsVoiceConfigRef.current = voiceConfig
    sttsOptionsRef.current = options
    ;(window as any).__ttsSegmentPulse = { segmentIndex: 0, active: false }

    // 清除之前的打断记录
    ;(window as any).__ttsInterruptedSpoken = ''
    ;(window as any).__ttsInterruptedAt = 0

    // 首帧时间诊断
    ;(window as any).__ttsFirstAudioStart = 0
    ;(window as any).__ttsStreamStartTs = Date.now()

    // F1: 新会话重置 GET 流式熔断(每会话重新探测)
    ;(window as any).__ttsHttpGetOk = undefined

    setupResumeTTS()
  }, [interruptTTS, setupResumeTTS])

  const feedStreamingTTS = useCallback((rawFull: string) => {
    if (!sttsActiveRef.current) {
      return
    }

    // 性能保护：限制 feedStreamingTTS 的调用频率
    // 在流式输出中每个 chunk 都会调用此函数，但文本变化不大时无需重复处理
    // B1: 节流时间戳改实例级 ref——全局 __ttsLastFeedTime 会被多实例共享,
    // 实例 B 首个 chunk 若距实例 A 末次 feed <80ms 会被错误丢弃。
    const now = Date.now()
    const lastFeedTime = sttsLastFeedTsRef.current || 0
    if (now - lastFeedTime < 80) return // 至少间隔 80ms（约 12fps）
    sttsLastFeedTsRef.current = now

    const cleaned = rawFull
      .replace(/\[(?:RECALL:[\s\S]*?|SET_TASK:[\s\S]*?|CLEAR_TASK|UPDATE_PERSONA:[\s\S]*?)\]/g, '')
      .replace(/<\/?[\s｜]*DSML[\s｜]*[^>]*>/gi, '')
      // 流式路径也清理 Markdown — 防止 TTS 朗读 ##、**、- 等语法字符
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`]+`/g, '')
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/[*_~]{1,3}([^*_~\[\]]+)[*_~]{1,3}/g, '$1')
      .replace(/^[\s]*[-*+]\s+/gm, '')
      .replace(/^[\s]*\d+[.)]\s+/gm, '')
      .replace(/^>\s+/gm, '')
      .replace(/^[-*_]{3,}\s*$/gm, '')
      .replace(/\|/g, ' ')
      .replace(/[\u{1F600}-\u{1F64F}]/gu, '')
      .replace(/[\u{1F300}-\u{1F5FF}]/gu, '')
      .replace(/[\u{1F680}-\u{1F6FF}]/gu, '')
      .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '')
      .replace(/[\u{2600}-\u{26FF}]/gu, '')
      .replace(/[\u{2700}-\u{27BF}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim()

    if (cleaned.length <= sttsConsumedRef.current) return

    const newText = cleaned.slice(sttsConsumedRef.current)
    if (!newText.trim()) return

    sttsBufRef.current += newText
    sttsConsumedRef.current = cleaned.length
    extractSentences()
  }, [])

  const flushStreamingTTSBuf = useCallback(() => {
    if (sttsActiveRef.current) extractSentences({ flushPartial: true })
  }, [])

  const finalizeStreamingTTS = useCallback(() => {
    if (sttsActiveRef.current) extractSentences({ flushPartial: true, markDone: true })
  }, [])

  const playStreamingTTS = useCallback(async (
    fullReply: string,
    voiceConfig: VoiceConfig,
    options: StreamTTSOptions = {},
  ) => {
    if (!voiceConfig.replyEnabled && !voiceConfig.continuousMode) return

    const rawSegments = extractVoiceText(fullReply)
    const totalText = stripMarkdownForSpeech(stripEmojis(rawSegments.join('。')))
    if (!totalText.trim()) return

    const sentences = totalText.match(STTS_SENTENCE_RE) || [totalText]
    const ttsSegments = sentences.map(s => s.trim()).filter(s => s.length > 0)
    if (ttsSegments.length === 0) return

    interruptTTS()
    const currentPlaybackId = ++playbackIdRef.current
    abortRef.current = false
    // B1/H1: 主动播报/整段回复必须置 __ttsActive=true——playTTSAndTrack 内
    // checkInterrupt(100ms) 以它为"播放进行中"标志,否则每段刚播即被掐断(或无声)。
    // interruptTTS 在开头已把它置 false,这里重新置 true 表示本会话进入播放。
    setTtsActive('stts', true)
    options.onSuspendMic?.()
    // F1: 新会话重置 GET 流式熔断(每会话重新探测)
    ;(window as any).__ttsHttpGetOk = undefined

    // V8 fix: 调用 setupResumeTTS 挂载完整恢复逻辑（含 DB 定时器撤销 + 剩余文本续播）
    setupResumeTTS()
    // playStreamingTTS 使用 abortRef 控制循环，需额外重置
    const _savedResume = (window as any).__voiceResumeTTS
    ;(window as any).__voiceResumeTTS = () => {
      if (currentPlaybackId === playbackIdRef.current) {
        abortRef.current = false
      }
      _savedResume?.()
    }

    try {
      for (let i = 0; i < ttsSegments.length; i++) {
        if (currentPlaybackId !== playbackIdRef.current || abortRef.current) {
          options.onInterrupted?.()
          return
        }
        const seg = ttsSegments[i]
        options.onSegmentStart?.(seg.substring(0, 100), i, ttsSegments.length)
        await playTTSAndTrack(seg, voiceConfig)
        options.onSegmentEnd?.(i)
      }
    } finally {
      // V14 fix: 清理 __voiceResumeTTS
      ;(window as any).__voiceResumeTTS = undefined
      // B1: 正常完成时复位 __ttsActive；被打断时 interruptTTS 已置 false，此处不再覆盖。
      if (currentPlaybackId === playbackIdRef.current) {
        setTtsActive('stts', false)
      }
      // B1: 无条件恢复 mic——打断时 interruptTTS 不回调 onResumeMic,
      // 若在此 skip 则消费方 mic 永久挂起（onSuspendMic 已在此前调用）。
      options.onResumeMic?.()
      if (currentPlaybackId === playbackIdRef.current && !abortRef.current) {
        options.onComplete?.()
      }
    }
  }, [interruptTTS, setupResumeTTS])

  const handleVoiceReply = useCallback(async (fullReply: string, currentVoiceConfig: VoiceConfig) => {
    const opts: StreamTTSOptions = {}
    if (optionsRef.current?.onSuspendMic) opts.onSuspendMic = optionsRef.current.onSuspendMic
    if (optionsRef.current?.onResumeMic) opts.onResumeMic = optionsRef.current.onResumeMic
    const setVoiceState = optionsRef.current?.setVoiceState
    if (setVoiceState) {
      opts.onSegmentStart = () => setVoiceState({ playing: true })
      opts.onComplete = () => setVoiceState({ playing: false })
      opts.onInterrupted = () => setVoiceState({ playing: false })
    }
    await playStreamingTTS(fullReply, currentVoiceConfig, opts)
  }, [playStreamingTTS])

  return {
    handleVoiceReply,
    playStreamingTTS,
    interruptTTS,
    refineForVoice: (r: string) => stripMarkdownForSpeech(stripEmojis(extractVoiceText(r).join('。'))),
    extractVoiceText,
    stripEmojis,
    beginStreamingTTS,
    feedStreamingTTS,
    flushStreamingTTSBuf,
    finalizeStreamingTTS,
  }
}
