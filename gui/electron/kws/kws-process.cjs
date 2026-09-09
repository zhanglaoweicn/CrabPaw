// kws-process.cjs —— 语音唤醒(KWS)子进程，运行在 Electron utilityProcess 中
//
// 独立进程原因: sherpa-onnx 自带一份 onnxruntime，与后端 transformers 的
// onnxruntime-node 同进程会原生崩溃，必须隔离。
//
// 协议(parentPort):
//   收 {type:'init', modelDir, keywordsFile} → 构建 KeywordSpotter, 回 {type:'ready'} / {type:'error'}
//   收 {type:'pcm',  buf}                   → 喂 16kHz Float32, 命中回 {type:'hit', keyword}
//   收 {type:'reload', keywordsFile}        → 热更新词表, 重建 spotter, 回 {type:'ready'}
const path = require('path')

const KEYWORDS_THRESHOLD = 0.35
// 2026-08-03: 3.0 → 2.0——本机环境（TTS 声/环境音）下 3.0 完全不命中（0 召回），
// 2.0 提高灵敏度（参考项目实测 2.0 召回 9/17），宁可偶发误触发（打断可接受）
const KEYWORDS_SCORE = 2.0
// 2026-08-08 fix: 800→1500——0.5s 分块喂入时同一唤醒词跨块边界可命中多次,
// 800ms 冷却拦不住(两次命中间隔可达 1s+),导致"叫一次唤醒词出现两条消息"
const COOLDOWN_MS = 1500

let spotter = null
let stream = null
let flushTimer = null
let lastHitAt = 0

// 2026-08-08 fix: 喂数缓冲——sherpa streaming 解码要求每次解码前累积足够帧
// (chunk-16-left-64 模型, 0.5s≈8000 样本为安全量)。声探页按 worklet quantum
// (128 样本)小块投递,直接逐块 decode 会触发 features.cc GetFrames 越界崩溃。
const FEED_CHUNK_SAMPLES = 8000 // 0.5s @16kHz
let pcmBuf = []
let pcmBufLen = 0

// 打包模式: app.asar 内不携带 node_modules,sherpa 原生模块由 electron-builder
// extraResources 拷入 resources/node_modules(与后端 node.exe 运行时一致),
// asar 内 require 解析不到,需按绝对路径回退加载。dev 模式直接从 gui/node_modules 解析。
function loadSherpa() {
  try {
    return require('sherpa-onnx-node')
  } catch (err) {
    if (process.resourcesPath) {
      return require(path.join(process.resourcesPath, 'node_modules', 'sherpa-onnx-node'))
    }
    throw err
  }
}

function createSpotter(modelDir, keywordsFile) {
  const { KeywordSpotter } = loadSherpa()
  const config = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(modelDir, 'encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx'),
        decoder: path.join(modelDir, 'decoder-epoch-13-avg-2-chunk-16-left-64.onnx'),
        joiner: path.join(modelDir, 'joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx'),
      },
      tokens: path.join(modelDir, 'tokens.txt'),
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
    keywordsFile,
    maxActivePaths: 4,
    keywordsScore: KEYWORDS_SCORE,
    keywordsThreshold: KEYWORDS_THRESHOLD,
  }
  const kws = new KeywordSpotter(config)
  // 2026-08-08 fix: sherpa-onnx-node 1.13.x API 是流式的——
  // 喂数必须走 createStream() 返回的 OnlineStream, spotter 本体无 acceptWaveform。
  stream = kws.createStream()
  return kws
}

function handleInit(modelDir, keywordsFile) {
  try {
    spotter = createSpotter(modelDir, keywordsFile)
    // 2026-08-08 fix: 尾段冲刷定时器——最后不足 0.5s 的残余 PCM 也要喂给解码器,
    // 否则句尾 0.4s 的唤醒词(如"…小螃蟹"收尾)永远检不到
    if (flushTimer) clearInterval(flushTimer)
    flushTimer = setInterval(() => {
      if (pcmBufLen > 0) feedAndDecode()
    }, 1000)
    if (flushTimer.unref) flushTimer.unref()
    process.parentPort.postMessage({ type: 'ready' })
  } catch (err) {
    console.error('[kws] 初始化失败:', err?.message || err)
    process.parentPort.postMessage({ type: 'error', error: err?.message || String(err) })
  }
}

let pcmTotal = 0
let lastDiag = 0
// 2026-08-07 fix: getResult 空结果诊断计数——sherpa 内部状态异常时 isReady 可能
// 恒 true 而 getResult 恒 null,旧实现 continue 会死循环卡死事件循环(审查报告 P2)
let nullResultCount = 0

// 2026-08-15: 空闲心跳——liveness 与 PCM 吞吐脱钩。旧实现 diag 只在 handlePcm
// 内发送: 麦克风被 ASR 会话占用/probe 重建窗口期间无 PCM 流入 → 心跳停 →
// 主进程 watchdog 误判假死 → 杀子进程 → 3 次配额耗尽 → 唤醒永久禁用。
// 事件循环能跑 = 进程活着; 原生解码卡死时本定时器同样不触发, 仍会被判死重启。
setInterval(() => {
  const now = Date.now()
  if (now - lastDiag > 5000) {
    try {
      process.parentPort.postMessage({ type: 'diag', bytes: pcmTotal, idle: true })
    } catch { /* best-effort */ }
    lastDiag = now
    pcmTotal = 0
  }
}, 5000).unref?.()

function handlePcm(b64) {
  if (!spotter || !b64) return
  try {
    // 2026-08-03: base64 传输解码（主进程 transfer 崩溃 + 克隆丢失的稳妥方案）
    const buf = Buffer.from(b64, 'base64')
    pcmTotal += buf.byteLength
    const now = Date.now()
    if (now - lastDiag > 5000) {
      // 2026-08-03: 心跳回执（子进程 console 在 Windows utilityProcess 不转发，
      // 用 parentPort 回执到主进程——与 ready 同通道，一定可达）
      try { process.parentPort.postMessage({ type: 'diag', bytes: pcmTotal }) } catch { /* best-effort */ }
      lastDiag = now
      pcmTotal = 0
    }
    const samples = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
    // 2026-08-08 fix: 累积 0.5s 再解码(stream API)——直接逐块喂会抛
    // "acceptWaveform is not a function" 且小块 decode 会越界崩溃,两者叠加
    // 导致唤醒词从未被真正解码(心跳正常但零命中,静默失效)
    pcmBuf.push(samples)
    pcmBufLen += samples.length
    if (pcmBufLen >= FEED_CHUNK_SAMPLES) feedAndDecode()
  } catch (err) {
    console.error('[kws] PCM 处理失败:', err?.message || err)
  }
}

// 累积满一块 → 喂入流并解码
function feedAndDecode() {
  if (!stream || pcmBufLen === 0) return
  const merged = new Float32Array(pcmBufLen)
  let o = 0
  for (const c of pcmBuf) { merged.set(c, o); o += c.length }
  pcmBuf = []
  pcmBufLen = 0
  stream.acceptWaveform({ samples: merged, sampleRate: 16000 })
  spotter.decode(stream)
  while (spotter.isReady(stream)) {
    const result = spotter.getResult(stream)
    if (!result || !result.keyword) {
      // 2026-08-07 fix: 空结果改 break——isReady 仍 true 而 getResult 无产出说明
      // 内部状态异常,继续轮询只会空转;退出循环等下一块 PCM 再处理,并计数告警
      // (告警节流: 首现 + 每 100 次打一次,避免异常态下每块 PCM 刷日志)
      nullResultCount++
      if (nullResultCount === 1 || nullResultCount % 100 === 0) {
        console.warn(`[kws] getResult 空结果(${nullResultCount} 次),退出处理循环防死锁`)
      }
      break
    }
    const now2 = Date.now()
    // 2026-08-07 fix: COOLDOWN 分支改 break——冷却期内继续轮询无意义
    // (命中时间不会变),退出循环由下一块 PCM 重新进入,避免自旋
    if (now2 - lastHitAt < COOLDOWN_MS) break
    lastHitAt = now2
    nullResultCount = 0
    console.log('[kws] 命中唤醒词:', result.keyword)
    process.parentPort.postMessage({ type: 'hit', keyword: result.keyword })
    // 命中后重置流内部状态,防止同一关键词在剩余音频上重复触发
    try { spotter.reset(stream) } catch (err) { console.error('[kws] reset 失败:', err?.message || err) }
  }
}

process.parentPort.on('message', (e) => {
  const msg = e.data
  if (!msg) return
  if (msg.type === 'init') {
    handleInit(msg.modelDir, msg.keywordsFile)
  } else if (msg.type === 'reload') {
    try {
      spotter = null
      spotter = createSpotter(msg.modelDir, msg.keywordsFile)
      process.parentPort.postMessage({ type: 'ready' })
    } catch (err) {
      console.error('[kws] 热加载失败:', err?.message || err)
      process.parentPort.postMessage({ type: 'error', error: err?.message || String(err) })
    }
  } else if (msg.type === 'pcm') {
    handlePcm(msg.b64)
  }
})
