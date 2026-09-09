const { EventEmitter } = require('events');
const { Readable } = require('stream');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadConfig, DATA_DIR } = require('../config');
const { redactText } = require('../secret-redactor');
const { stripEmojis, sanitizeTextForSpeech } = require('../text-utils');

// 2026-08-04: edge 403/超时熔断——中国大陆访问 speech.platform.bing.com 常被墙(403/超时)。
// 每次合成先试 edge 会白白占用首句时间(用户感知"文本先出,语音等半天")。
// edge 失败后熔断 10 分钟:期间 provider 链直接跳过 edge 走兜底(如 doubao/sapi)。
// 2026-08-05 fix: 熔断持久化——edge 被墙是长期网络事实(非偶发)，10 分钟太短，
// 每次重启/熔断过期后都要再白等一次 edge 超时(实测单请求 25.8s 全耗在 edge)。
// 失败 1 次 → 熔断 1 小时并落盘，重启后仍跳过 edge 直走兜底。
let edgeBlockedUntil = 0;
const EDGE_BLOCK_MS = 60 * 60 * 1000;
const EDGE_BLOCK_FILE = path.join(DATA_DIR, 'tts-edge-blocked.json');
function markEdgeBlocked() {
  edgeBlockedUntil = Date.now() + EDGE_BLOCK_MS;
  try { fs.writeFileSync(EDGE_BLOCK_FILE, JSON.stringify({ until: edgeBlockedUntil }), 'utf8'); } catch (e) { console.warn('[tts] 熔断持久化失败:', e.message); }
}
function isEdgeBlocked() { return Date.now() < edgeBlockedUntil; }
function restoreEdgeBlock() {
  try {
    if (fs.existsSync(EDGE_BLOCK_FILE)) {
      const raw = JSON.parse(fs.readFileSync(EDGE_BLOCK_FILE, 'utf8'));
      if (raw && raw.until && raw.until > Date.now()) edgeBlockedUntil = raw.until;
    }
  } catch (e) {
    /* 熔断文件损坏时忽略 */
    console.warn('[index.js] 空 catch 补日志:', e && e.message);
  }

}
restoreEdgeBlock();

/**
 * chunkText — 长文本按句分块（I-3 T4）
 * 边界优先级：句末标点 → 逗号/顿号 → 硬切 maxLength；绝不丢字。
 */
function chunkText(text, { maxLength = 300 } = {}) {
  const s = String(text || "");
  if (s.length <= maxLength) return [s];
  const chunks = [];
  let cur = "";
  const push = () => { if (cur.trim()) { chunks.push(cur); cur = ""; } };
  // 按句末标点分
  const sentences = s.split(/(?<=[。！？；\n])/);
  for (const sent of sentences) {
    if ((cur + sent).length <= maxLength) { cur += sent; continue; }
    push();
    if (sent.length <= maxLength) { cur = sent; continue; }
    // 单句超长：按逗号再切
    const parts = sent.split(/(?<=[，、])/);
    for (const part of parts) {
      if ((cur + part).length <= maxLength) { cur += part; continue; }
      push();
      if (part.length <= maxLength) { cur = part; continue; }
      // 硬切
      for (let i = 0; i < part.length; i += maxLength) {
        push();
        cur = part.slice(i, i + maxLength);
      }
      push();
    }
  }
  push();
  return chunks;
}

function extractSpeechContent(text, options) {
  // 兼容旧调用 extractSpeechContent(text, number)
  let maxLength = 2000;
  if (typeof options === "number") { maxLength = options; }
  else if (options && typeof options.maxLength === "number") { maxLength = options.maxLength; }
  const cleaned = sanitizeTextForSpeech(text);
  if (!cleaned) return "";
  if (cleaned.length <= maxLength) return cleaned;
  // 用 chunkText 分块，保留顺序
  const chunks = chunkText(cleaned, { maxLength });
  // 取前 N 段，拼接尾注
  const tail = "…（完整内容已显示在屏幕上）";
  let result = "";
  for (const c of chunks) {
    if ((result + c + tail).length > maxLength) break;
    result += c;
  }
  if (!result) {
    // 单 chunk 都超 maxLength：截取前 maxLength-tail.length 加尾注
    const cutoff = maxLength - tail.length;
    if (cutoff > 0) result = cleaned.substring(0, cutoff);
    else result = cleaned.substring(0, maxLength);
  }
  return result + tail;
}

// ===== TTS Providers =====

const TTS_PROVIDERS = {
 sapi: {
 name: 'Windows SAPI TTS (Local)',
 url: 'sapi', model: 'windows-sapi',
 voices: ['Microsoft Huihui Desktop', 'Microsoft Zira Desktop'],
 maxTextLength: 10000, defaultVoice: 'Microsoft Huihui Desktop'
 },
 edge: {
 name: 'Edge TTS (Free)',
 url: 'edge-tts', model: 'edge-tts',
 voices: ['zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural', 'en-US-JennyNeural', 'ja-JP-NanamiNeural'],
 maxTextLength: 10000, defaultVoice: 'zh-CN-XiaoxiaoNeural'
 },
 openai: {
 name: 'OpenAI TTS',
 url: 'https://api.openai.com/v1/audio/speech', model: 'tts-1',
 voices: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
 maxTextLength: 4096, defaultVoice: 'alloy'
 },
 qwen: {
 name: 'Qwen TTS',
 url: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text2audio/generation', model: 'sambert-zhichu-v1',
 voices: ['zhichu', 'zhitian', 'zhiyan', 'zhimi'],
 maxTextLength: 5000, defaultVoice: 'zhichu'
 },
 local: {
 name: 'Local TTS',
 url: 'http://localhost:5000/api/tts', model: 'local-tts',
 voices: ['default'], maxTextLength: 10000, defaultVoice: 'default'
 },
  doubao: {
  name: '豆包 TTS（火山引擎·seed-tts-2.0）',
  url: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
  model: 'seed-tts-2.0',
  voices: [
    'zh_female_xiaohe_uranus_bigtts',         // 晓鹤 女声
    'zh_female_shuangkuaisisi_uranus_bigtts',  // 爽快斯斯 女声
    'zh_female_wanwanxiaohe_uranus_bigtts',    // 婉婉晓鹤 女声
    'zh_female_xiaomei_uranus_bigtts',          // 小美 女声
    'zh_female_qingxin_uranus_bigtts',          // 清新 女声
    'zh_female_tianmeixiaoyuan_uranus_bigtts',  // 甜美校园 女声
    'zh_male_m191_uranus_bigtts',               // M191 男声
    'zh_male_xiaoma_uranus_bigtts',             // 小马 男声
    'zh_male_jijie_uranus_bigtts',              // 季节 男声
    'zh_male_chentong_uranus_bigtts',           // 晨通 男声
  ],
 maxTextLength: 5000,
 defaultVoice: 'zh_female_xiaohe_uranus_bigtts',
 requiresKey: true,
 },
  volcano: {
  name: '火山引擎 TTS（基础版）',
  url: 'https://openspeech.bytedance.com/api/v1/tts',
  model: 'volcano-tts',
  voices: [
    'BV001_streaming',   // 通用女声
    'BV002_streaming',   // 通用男声
    'BV003_streaming',   // 温柔女声
    'BV004_streaming',   // 成熟男声
    'BV005_streaming',   // 沉稳男声
    'BV006_streaming',   // 可爱女声
    'BV007_streaming',   // 成熟女声
    'zh_female_qingxin', // 清新 女声
  ],
 maxTextLength: 5000,
 defaultVoice: 'BV001_streaming',
 requiresKey: true,
   },
   // V9 fix: 注册 Piper 本地 TTS 提供商
   piper: {
   name: 'Piper TTS (Local)',
   url: 'piper', model: 'piper-tts',
   voices: ['default'],
   maxTextLength: 5000,
   defaultVoice: 'default',
   requiresKey: false,
   },
  };

const DEFAULT_OUTPUT_DIR = path.join(DATA_DIR, 'tts-output');

// ===== TextToSpeechEngine =====

class TextToSpeechEngine extends EventEmitter {
 constructor(config = {}) {
 super();
 this.config = config.config || loadConfig();
 this._providerOrder = this._buildProviderOrder();
 // 2026-08-14: 记录 order 指纹，供每次合成前惰性校验（配置/熔断态变化时重建）
 this._providerOrderSig = this._providerOrderSignature();
 this._outputDir = config.outputDir || DEFAULT_OUTPUT_DIR;
 this._stats = { totalRequests: 0, successfulRequests: 0, failedRequests: 0, totalCharsSynthesized: 0, totalAudioSeconds: 0 };
 this._localTtsAvailable = false;
 // 2026-08-01: voice 覆盖互斥锁（并发 synthesize 保护单例 config.voice）
 this._voiceLock = Promise.resolve();
 this._checkLocalTtsHealth();
 }

 /**
  * 获取 voice 覆盖段互斥锁（FIFO promise 链）。
  * @returns {Promise<() => void>} resolve 为释放函数（闭包持有，避免被后续 acquire 覆盖）
  */
 _acquireVoiceLock() {
   const prev = this._voiceLock;
   let release;
   this._voiceLock = new Promise(resolve => { release = resolve; });
   return prev.then(() => release);
 }

 async _checkLocalTtsHealth() {
   try {
     const resp = await fetch(TTS_PROVIDERS.local.url, { method: 'HEAD', signal: AbortSignal.timeout(2000) });
     this._localTtsAvailable = resp.ok;
   } catch {
     this._localTtsAvailable = false;
   }
 }

  _buildProviderOrder() {
    const order = [];
    const voiceConfig = this.config.voice || {};
    const ttsConfig = this.config.tts || {};
    let primary = voiceConfig.ttsProvider || ttsConfig.provider || 'edge';
    if (primary === 'edge-tts') primary = 'edge';

    // 2026-08-07: 动态排序——已配置 Key 的云端提供商优先，edge 后置避免国内 6s 白等
    const cloudProviders = ['doubao', 'volcano', 'openai', 'qwen'];
    const hasAnyCloudKey = cloudProviders.some(p => this._hasValidKey(p));

    if (hasAnyCloudKey) {
      // 已配置 Key 的云端提供商（按优先级顺序：doubao→volcano→openai→qwen）
      for (const p of cloudProviders) {
        if (this._hasValidKey(p)) order.push(p);
      }
      // sapi → edge → local（edge 后置，其已有 1 小时熔断兜底）
      if (!order.includes('sapi')) order.push('sapi');
      if (!isEdgeBlocked() && !order.includes('edge')) order.push('edge');
      if (this._localTtsAvailable && !order.includes('local')) order.push('local');
      console.log('TTS provider order:', order);
      return order;
    }

    // 没有任何云端 Key 配置——保持现状顺序不变（兜底行为一致）
    // 2026-08-05 fix: edge 被墙(熔断中)且有 doubao key 时，直接以 doubao 为主——
    // 国内直连秒回，避免每次先白等 edge 超时(6s)。被墙是长期事实，熔断 1 小时不
    // 应反复拖慢首句。piper 本地模型同理：无云端 key 时优先本地而非 edge。
    if (primary === 'edge' && isEdgeBlocked() && this._hasValidKey('doubao')) {
      primary = 'doubao';
    }
    if (primary !== 'edge') { order.push(primary); }
    for (const p of Object.keys(TTS_PROVIDERS)) {
      // V15 fix: local 不再硬编码跳过，由 _hasValidKey 动态检测
      // 2026-08-04: sapi 不在循环内 push——放最后兜底(Windows 本地音质一般,
      // 仅在 edge/云端全部失败时兜底,避免抢默认)
      if (p === 'sapi') continue;
      // 2026-08-01: edge 放末尾兜底——primary 已指定时（如 doubao），
      // 其余 provider 按定义顺序尝试，edge 作为最后 fallback（此前紧跟在 primary 后，
      // 免费且总是就绪，会抢在用户配置的 volcano/openai 之前）
      // 2026-08-04: edge 熔断——403/超时后 10 分钟内跳过(被墙时不再每次先试白等)
      if (p === 'edge' && (primary !== 'edge' || isEdgeBlocked())) continue;
      if (!order.includes(p)) order.push(p);
      }
    if (primary !== 'edge' && !order.includes('edge')) order.push('edge');
    // 2026-08-04: edge 熔断时移除(链尾也不放,直接走兜底)
    if (isEdgeBlocked() && order.includes('edge')) order.splice(order.indexOf('edge'), 1);
    // 2026-08-04: sapi(Windows 内置 System.Speech)解锁为最终兜底——edge 403(被墙)
    // 且无其他 provider key 时语音不至于 'All TTS providers failed' 完全瘫痪
    if (!order.includes('sapi')) order.push('sapi');
    console.log('TTS provider order:', order);
    return order;
  }

  /**
   * provider 顺序惰性重建（2026-08-14 fix）：
   * 旧实现只在构造函数里 build 一次 order——edge 运行中被熔断后旧 order 仍把
   * edge 排前（每句白等 ~6s 超时），新增 doubao key 后也不会把 doubao 提前。
   * 每次合成开始前用「配置/熔断态指纹」校验，变了才重建（读取 config 开销极小）。
   */
  _providerOrderSignature() {
    const voice = this.config.voice || {};
    const tts = this.config.tts || {};
    let primary = voice.ttsProvider || tts.provider || 'edge';
    if (primary === 'edge-tts') primary = 'edge';
    const cloudKeys = ['doubao', 'volcano', 'openai', 'qwen']
      .map(p => p + ':' + (this._hasValidKey(p) ? 1 : 0)).join(',');
    return [primary, cloudKeys, isEdgeBlocked() ? 1 : 0, this._localTtsAvailable ? 1 : 0].join('|');
  }

  _refreshProviderOrder() {
    const sig = this._providerOrderSignature();
    if (sig === this._providerOrderSig) return;
    this._providerOrderSig = sig;
    this._providerOrder = this._buildProviderOrder();
  }

 _getProviderConfig(providerName) {
 const providers = this.config.models?.providers || {};
 const fromModels = providers[providerName];
 if (fromModels && fromModels.apiKey) return fromModels;
 // Fallback: check voice config for openai/qwen keys set via Settings page
 const voice = this.config.voice || {};
 if (providerName === 'openai' && voice.openaiApiKey) return { apiKey: voice.openaiApiKey };
 if (providerName === 'qwen' && voice.qwenApiKey) return { apiKey: voice.qwenApiKey };
 return fromModels || null;
 }

 _hasValidKey(providerName) {
   // 2026-08-04: sapi(Windows 内置)始终可用——此前硬编码 false 禁用了本地兜底
   if (providerName === 'sapi') return true;
   // V15 fix: local TTS 动态检测可用性（缓存 5 分钟）
   if (providerName === 'local') {
     return this._localTtsAvailable;
   }
   if (providerName === 'edge' || providerName === 'edge-tts') return true;
   // V9 fix: Piper 不需要 API Key，检测二进制是否可用
   if (providerName === 'piper') {
     try {
       const { spawnSync } = require('child_process');
       const cfg = this.config.voice || {};
       const piperPath = cfg.piperPath || 'piper';
       const probe = spawnSync(piperPath, ['--help'], { stdio: 'ignore', timeout: 3000, windowsHide: true });
       return !probe.error && probe.status === 0;
     } catch (e) {
       console.warn('[TTS] Piper probe failed:', e.message || e);
       return false;
     }
   }
 if (providerName === 'doubao') {
 const voice = this.config.voice || {};
 const models = this.config.models || {};
 const key = voice.doubaoKey || (models.providers && models.providers.doubao && models.providers.doubao.apiKey) || '';
 return key.length > 0 && !key.includes('***');
 }
 if (providerName === 'volcano') {
 const voice = this.config.voice || {};
 return !!(voice.volcanoAppId && voice.volcanoToken) && !String(voice.volcanoToken).includes('***');
 }
 const cfg = this._getProviderConfig(providerName);
 return cfg && cfg.apiKey && cfg.apiKey.trim() !== '' && !cfg.apiKey.includes('***');
 }

 async synthesize(text, options = {}) {
   this._stats.totalRequests++;
   if (!text || typeof text !== 'string' || text.trim().length === 0) {
   this._stats.failedRequests++;
   return { success: false, error: 'Empty text', filePath: null };
   }
   const isRefined = options._refined === true;
   let sanitizedText = isRefined ? stripEmojis(text).replace(/\s+/g, ' ').trim() : extractSpeechContent(text, 5000);
   if (!sanitizedText || sanitizedText.trim().length === 0) {
   return { success: false, error: 'Text empty after sanitization', filePath: null };
   }
   console.log('TTS: orig', text.length, 'clean', sanitizedText.length);
   // 2026-08-01: voice 覆盖段互斥——单例 config.voice 临时覆盖在并发 synthesize
   // 下互相污染（A 覆盖 → B 基于被覆盖值保存 → B restore 泄漏 A 的覆盖）。
   // 覆盖段（含 provider 循环）串行化；provider 实现读 this.config.voice 取覆盖值。
   const releaseVoiceLock = await this._acquireVoiceLock();
   try {
     // 2026-08-14: 合成前惰性校验 provider 顺序（edge 熔断/新 Key 配置变化时重建）
     this._refreshProviderOrder();
     // V1 fix: 支持请求级 voiceOverride — 临时合并到 config.voice 而不修改原始单例
     // T2 fix: 使用浅拷贝保存原始值，防止引用赋值导致 restore 无法恢复
     const savedVoice = { ...this.config.voice };
     if (options.voiceOverride && typeof options.voiceOverride === 'object') {
       this.config.voice = { ...savedVoice, ...options.voiceOverride };
     }
     // 支持请求级 provider 指定 — 临时覆盖 _providerOrder
     const savedProviderOrder = [...this._providerOrder];
     if (options.provider) {
       const primary = options.provider === 'edge-tts' ? 'edge' : options.provider;
       this._providerOrder = [primary, ...this._providerOrder.filter(p => p !== primary)];
     }
   try {
   for (const providerName of this._providerOrder) {
 const providerInfo = TTS_PROVIDERS[providerName];
 if (!providerInfo || !this._hasValidKey(providerName)) continue;
 if (sanitizedText.length > providerInfo.maxTextLength) continue;
 // 2026-08-14: edge 熔断进程内即时生效——旧 order 是构造时快照,熔断后仍会先试 edge
 // 白等 ~6s。熔断期间跳过 edge 走兜底,其余 provider 仍按顺序尝试。
 if (providerName === 'edge' && isEdgeBlocked()) continue;
 try {
   // 音色映射：fallback 到不同 provider 时，使用该 provider 的 defaultVoice，
   // 而非将上一个 provider 的音色名（如 Edge 的 zh-CN-XiaoxiaoNeural）传给当前 provider
   const mappedOptions = { ...options };
   if (!providerInfo.voices.includes(mappedOptions.voice || '')) {
     mappedOptions.voice = providerInfo.defaultVoice;
   }
   const result = await this._callProvider(providerName, providerInfo, sanitizedText, mappedOptions);
 if (result.success) {
 this._stats.successfulRequests++;
 this._stats.totalCharsSynthesized += sanitizedText.length;
 if (result.duration) this._stats.totalAudioSeconds += result.duration;
 this.emit('speech_synthesized', { provider: providerName, textLength: sanitizedText.length, duration: result.duration, voice: options.voice || providerInfo.defaultVoice, timestamp: Date.now() });
 return result;
 }
 } catch (error) {
  const normalized = normalizeTTSError(error, providerName)
  console.warn('TTS', providerName, 'failed:', normalized.message, `(code=${normalized.code}, retryable=${normalized.retryable})`)
  this.emit('provider_error', { provider: providerName, error: normalized.message, code: normalized.code, retryable: normalized.retryable, timestamp: Date.now() });
  // 2026-08-04: edge 403/超时 → 熔断 10 分钟(被墙时不再每次先试白等)
  if (providerName === 'edge' && /403|timeout|超时/i.test(normalized.message || '')) markEdgeBlocked();
 }
   }
   this._stats.failedRequests++;
   return { success: false, error: 'All TTS providers failed', filePath: null, provider: 'none' };
   } finally {
     // V1 fix: 恢复原始 config.voice 和 _providerOrder，防止请求级覆盖泄漏
     this.config.voice = savedVoice;
     this._providerOrder = savedProviderOrder;
   }
   } finally {
     // 2026-08-01: 释放 voice 覆盖互斥锁（与 synthesize 开头 _acquireVoiceLock 配对）
     releaseVoiceLock();
   }
  }

 async _callProvider(providerName, providerInfo, text, options) {
 switch (providerName) {
 case 'sapi': return this._callSAPI(providerInfo, text, options);
 case 'edge': case 'edge-tts': return this._callEdgeTTS(providerInfo, text, options);
 case 'qwen': return this._callQwen(providerName, providerInfo, text, options);
 case 'local': return this._callLocalTTS(providerInfo, text, options);
 case 'doubao': return this._callDoubao(providerInfo, text, options);
 case 'volcano': return this._callVolcano(providerInfo, text, options);
 // V9 fix: Piper 本地 TTS 支持
 case 'piper': return this._callPiper(providerInfo, text, options);
 default: return this._callOpenAICompatible(providerName, providerInfo, text, options);
 }
 }

 // ===== SAPI =====
 async _callSAPI(providerInfo, text, options) {
 const { spawn } = require('child_process');
 const voice = options.voice || providerInfo.defaultVoice;
 const speedValue = options.speed || 1.0;
 const filePath = this._generateOutputPath(options, 'wav');
 const tmpTextFile = filePath + '.txt';
 fs.writeFileSync(tmpTextFile, text, 'utf8');
 const psScript = [
 'Add-Type -AssemblyName System.Speech',
 '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
 '$s.Rate = ' + Math.round((speedValue - 1) * 10),
 "try { $s.SelectVoice('" + voice + "') } catch { Write-Warning 'TTS voice not found; using default'; }",
 "$s.SetOutputToWaveFile('" + filePath + "')",
 "$s.Speak([System.IO.File]::ReadAllText('" + tmpTextFile + "'))",
 '$s.Dispose()'
 ].join('; ');
 return new Promise((resolve, reject) => {
 const proc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
 let stderr = '';
 proc.stderr.on('data', chunk => stderr += chunk);
 proc.on('close', (code) => {
 try { fs.unlinkSync(tmpTextFile); } catch (e) { console.warn('[tts] failed to clean up temp file on close:', e.message); }
 if (code === 0 && fs.existsSync(filePath)) {
 const stat = fs.statSync(filePath);
 resolve({ success: true, filePath, format: 'wav', duration: stat.size / 176400, voice, speed: speedValue, provider: 'sapi', model: 'windows-sapi', sizeBytes: stat.size });
 } else { reject(new Error('SAPI failed')); }
 });
 proc.on('error', (err) => { try { fs.unlinkSync(tmpTextFile); } catch (e2) { console.warn('[tts] failed to clean up temp file on error:', e2.message); } reject(err); });
 setTimeout(() => { try { proc.kill(); } catch (e) { console.warn('[tts] failed to kill proc on timeout:', e.message); } try { fs.unlinkSync(tmpTextFile); } catch (e2) { console.warn('[tts] failed to clean up temp file on timeout:', e2.message); } reject(new Error('SAPI timeout')); }, 30000);
 });
 }

 // ===== Edge TTS (Node.js WebSocket) =====
 _generateSecMSGEC() {
 const TRUSTED = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
 let ticks = BigInt(Math.floor(Date.now() / 1000));
 ticks += 11644473600n;
 ticks -= ticks % 300n;
 ticks *= 10000000n;
 return crypto.createHash('sha256').update(ticks.toString() + TRUSTED).digest('hex').toUpperCase();
 }

 _generateMUID() { return crypto.randomBytes(16).toString('hex').toUpperCase(); }

 _edgeDateString() { return new Date().toUTCString().replace('GMT', 'GMT+0000 (Coordinated Universal Time)'); }

 _edgeVoiceName(short) {
 const m = short.match(/^([a-z]{2,})-([A-Z]{2,})-(.+)$/);
 return m ? 'Microsoft Server Speech Text to Speech Voice (' + m[1] + '-' + m[2] + ', ' + m[3] + ')' : short;
 }

 async _callEdgeTTS(providerInfo, text, options) {
 const WebSocket = require('ws');
 const voice = options.voice || providerInfo.defaultVoice;
 const speedValue = options.speed || 1.0;
 const ratePercent = Math.round((speedValue - 1) * 100);
 const rate = ratePercent >= 0 ? '+' + ratePercent + '%' : ratePercent + '%';
 const filePath = this._generateOutputPath(options, 'mp3');
 const secMSGEC = this._generateSecMSGEC();
 const muid = this._generateMUID();
 const connId = crypto.randomUUID();
 const WSS_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1' +
 '?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=' + connId +
 '&Sec-MS-GEC=' + secMSGEC + '&Sec-MS-GEC-Version=1-143.0.3650.75';
 const CRLF = String.fromCharCode(13, 10);
 console.log('Edge TTS:', { voice: voice.substring(0, 30), rate, len: text.length });
 return new Promise((resolve, reject) => {
 const ws = new WebSocket(WSS_URL, {
 // 2026-08-05 fix: 握手 8s→4s、总超时 20s→6s——被墙环境下 edge 连接黑洞，
 // 缩短白等时间(实测单请求 25.8s 中 edge 独占 20s)
 handshakeTimeout: 4000,
 headers: {
 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
 'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
 'Pragma': 'no-cache', 'Cache-Control': 'no-cache',
 'Sec-WebSocket-Version': '13',
 'Cookie': 'muid=' + muid + ';',
 }
 });
 // Edge TTS 403 快速失败
 ws.on('unexpected-response', (req, res) => {
   clearTimeout(timeout);
   reject(new Error('Edge TTS: server returned ' + res.statusCode));
 });
 const audioChunks = [];
 const timeout = setTimeout(() => { try { ws.close(); } catch (e2) { console.warn('[tts] ws close on timeout failed:', e2.message); } reject(new Error('Edge TTS timeout')); }, 6000);
 ws.on('open', () => { 
 const ts = this._edgeDateString();
 ws.send('X-Timestamp:' + ts + CRLF + 'Content-Type:application/json; charset=utf-8' + CRLF + 'Path:speech.config' + CRLF + CRLF +
 JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'true' }, outputFormat: 'audio-24khz-48kbitrate-mono-mp3' } } } }));
 const longVoice = this._edgeVoiceName(voice);
 const escapedText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
 const ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
 "<voice name='" + longVoice + "'><prosody pitch='+0Hz' rate='" + rate + "' volume='+0%'>" + escapedText + "</prosody></voice></speak>";
 ws.send('X-RequestId:' + crypto.randomUUID().replace(/-/g, '') + CRLF + 'Content-Type:application/ssml+xml' + CRLF + 'X-Timestamp:' + ts + 'Z' + CRLF + 'Path:ssml' + CRLF + CRLF + ssml);
 });
 // eslint-disable-next-line no-unused-vars -- msgCount 未使用
 var msgCount=0;
 ws.on('message', (data, isBinary) => {
 if (isBinary && data.length >= 2) {
 var offset = 0;
 while (offset + 2 <= data.length) {
 var hdrLen = (data[offset] << 8) | data[offset + 1];
 offset += 2;
 if (offset + hdrLen > data.length) break;
 var hdr = data.toString('utf8', offset, offset + hdrLen);
 offset += hdrLen;
 if (offset + 2 > data.length) break;
 var contentLen = (data[offset] << 8) | data[offset + 1];
 offset += 2;
 if (offset + contentLen > data.length) break;
 if (hdr.indexOf('audio') >= 0 || hdr.indexOf('audio/mpeg') >= 0) {
 audioChunks.push(data.slice(offset, offset + contentLen));
 }
 offset += contentLen;
 }
 } else if (!isBinary) {
 var str = Buffer.isBuffer(data) ? data.toString('utf8') : data;
 var idx2 = str.indexOf('\r\n\r\n');
 if (idx2 >= 0) {
 try {
 var obj = JSON.parse(str.substring(idx2 + 4));
 if (obj.audio && obj.audio.data) {
 audioChunks.push(Buffer.from(obj.audio.data, 'base64'));
 }
 } catch (e) { console.warn('[tts] failed to parse audio data:', e.message); }
 }
 }
 });
ws.on('close', (_code) => {
 clearTimeout(timeout);
 if (audioChunks.length > 0) {
 const buffer = Buffer.concat(audioChunks);
 try {
 fs.writeFileSync(filePath, buffer);
 const stat = fs.statSync(filePath);
 console.log('Edge TTS done:', stat.size, 'bytes');
 resolve({ success: true, filePath, format: 'mp3', duration: this._estimateDuration(stat.size, 'mp3', buffer), voice, speed: speedValue, provider: 'edge', model: 'edge-tts', sizeBytes: stat.size });
 } catch (writeErr) { reject(writeErr); }
 } else { reject(new Error('Edge TTS: no audio received')); }
 });
 ws.on('error', (err) => { console.error('[Edge TTS] WS error:', err.message); clearTimeout(timeout); reject(new Error('Edge TTS: ' + err.message)); });
 });
 }

 // ===== OpenAI-compatible =====
 async _callOpenAICompatible(providerName, providerInfo, text, options) {
 const providerConfig = this._getProviderConfig(providerName);
 if (!providerConfig) return { success: false, error: 'No config for ' + providerName, filePath: null };
 const baseUrl = providerConfig.baseUrl || providerConfig.base_url || 'https://api.openai.com/v1';
 const apiKey = providerConfig.apiKey;
 const url = baseUrl.replace(/\/$/, '') + '/audio/speech';
 const voice = options.voice || providerInfo.defaultVoice;
 const speed = Math.max(0.25, Math.min(4.0, options.speed || 1.0));
 const body = { model: options.model || providerInfo.model, input: text, voice, speed, response_format: 'mp3' };
 const resp = await fetch(url, { method: 'POST', headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: options.signal || AbortSignal.timeout(30000) });
 // eslint-disable-next-line no-unused-vars -- errText 未使用，resp.text() 需消费响应体
 if (!resp.ok) { const errText = await resp.text().catch(() => ''); throw new Error('TTS API ' + resp.status); }
 const arrayBuffer = await resp.arrayBuffer();
 const buffer = Buffer.from(arrayBuffer);
 const filePath = await this._saveAudio(buffer, options, 'mp3');
 const duration = this._estimateDuration(buffer.length, 'mp3', buffer);
 return { success: true, filePath, format: 'mp3', duration, voice, speed, provider: providerName, model: body.model, sizeBytes: buffer.length };
 }

 // ===== Qwen =====
 async _callQwen(providerName, providerInfo, text, options) {
 const providerConfig = this._getProviderConfig(providerName);
 if (!providerConfig) return { success: false, error: 'No config for qwen', filePath: null };
 const apiKey = providerConfig.apiKey;
 const baseUrl = providerConfig.baseUrl || providerConfig.base_url || providerInfo.url;
 const voice = options.voice || providerInfo.defaultVoice;
 const body = { model: options.model || providerInfo.model, input: { text }, parameters: { voice, format: 'mp3', rate: options.speed || 1.0, pitch: 0 } };
 const resp = await fetch(baseUrl, { method: 'POST', headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: options.signal || AbortSignal.timeout(30000) });
 // eslint-disable-next-line no-unused-vars -- errText 未使用，resp.text() 需消费响应体
 if (!resp.ok) { const errText = await resp.text().catch(() => ''); throw new Error('Qwen TTS ' + resp.status); }
 const data = await resp.json();
 if (data.output?.audio) {
 const buffer = Buffer.from(data.output.audio, 'base64');
 const filePath = await this._saveAudio(buffer, options, 'mp3');
 return { success: true, filePath, format: 'mp3', duration: data.output.duration || this._estimateDuration(buffer.length, 'mp3', buffer), voice, provider: providerName, model: providerInfo.model, sizeBytes: buffer.length };
 }
 throw new Error('Qwen TTS unexpected response');
 }

 // ===== Local =====
 async _callLocalTTS(providerInfo, text, options) {
 const voice = options.voice || providerInfo.defaultVoice;
 const body = { text, voice, speed: options.speed || 1.0, format: 'mp3' };
 const resp = await fetch(providerInfo.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: options.signal || AbortSignal.timeout(30000) });
 if (!resp.ok) throw new Error('Local TTS ' + resp.status);
 const arrayBuffer = await resp.arrayBuffer();
 const buffer = Buffer.from(arrayBuffer);
 const filePath = await this._saveAudio(buffer, options, 'mp3');
 return { success: true, filePath, format: 'mp3', duration: this._estimateDuration(buffer.length, 'mp3', buffer), voice, speed: options.speed || 1.0, provider: 'local', model: 'local-tts', sizeBytes: buffer.length };
 }

 // ===== Doubao =====

 /**
 * 根据音色自动选择 Resource-Id：
 * *_uranus_bigtts → seed-tts-2.0（2.0 音色）
 * *_moon_bigtts / BV*_streaming → seed-tts-1.0（旧版音色）
 */
 _resolveDoubaoResourceId(voiceId) {
 const voice = this.config.voice || {};
 if (voice.doubaoResourceId) return voice.doubaoResourceId;
 if (/_moon_bigtts$/.test(voiceId) || /^BV\d+(_24k)?_streaming$/.test(voiceId)) {
 return 'seed-tts-1.0';
 }
 return 'seed-tts-2.0';
 }

 /**
 * 解码豆包 SSE chunked 响应（data: <base64> 行格式）
 * 返回完整的音频 Buffer
 */
 async _decodeDoubaoResponse(resp, context) {
 const contentType = resp.headers.get('content-type') || '';

 // 直接返回 audio/mpeg 流
 if (contentType.includes('audio/')) {
 return Buffer.from(await resp.arrayBuffer());
 }

 // SSE 格式：逐行解析 data: <base64>
 const text = await resp.text();
 const chunks = [];
 const lines = text.split(/\r?\n/);
 for (const rawLine of lines) {
 const line = rawLine.trim().replace(/^data:\s*/, '');
 if (!line || line === '[DONE]') continue;
 if (!line.startsWith('{')) {
 // 非 JSON 行跳过（可能是纯 base64 或其他格式）
 if (line.length > 20) {
 try { chunks.push(Buffer.from(line, 'base64')); } catch (e) { console.warn('[TTS] failed to decode base64 chunk in doubao response:', e.message); }
   }
   continue;
   }
   try {
   const data = JSON.parse(line);
   const code = Number(data.code ?? data.status_code ?? 0);
   if (code > 0 && code !== 20000000) {
   const msg = data.message || data.status_text || '未知错误';
   throw new Error(`豆包 TTS 流错误 (${code}): ${msg}. 当前音色: ${context.speaker}, 资源: ${context.resourceId}`);
   }
   if (data.data) {
   chunks.push(Buffer.from(data.data, 'base64'));
   }
   } catch (e) {
   if (e.message && e.message.indexOf('豆包 TTS') === 0) throw e;
   // 非 JSON 行的解析错误跳过
   console.warn('[TTS] failed to parse doubao SSE line:', e.message);
   }
 }

 if (chunks.length === 0) {
   // 2026-08-05: 失败时转储原始响应便于定位（服务器收到与本地复现不一致的响应）
   console.warn('[TTS] doubao 响应无音频数据——原文 head: ' + text.slice(0, 300).replace(/\n/g, '\\n'));
   throw new Error('豆包 TTS: 响应中无音频数据');
 }
 return Buffer.concat(chunks);
 }

 async _callDoubao(providerInfo, text, options) {
 const voiceCfg = this.config.voice || {};
 const models = this.config.models || {};
 const doubaoCfg = (models.providers && models.providers.doubao) || {};
 const apiKey = voiceCfg.doubaoKey || doubaoCfg.apiKey;
 const accessKey = voiceCfg.doubaoAccessKey;
 const appId = voiceCfg.doubaoAppId;
 const voiceId = options.voice || providerInfo.defaultVoice;
 const resourceId = this._resolveDoubaoResourceId(voiceId);

 if (!apiKey && !accessKey) throw new Error('豆包 TTS: 缺少 API Key/Access Key，请在设置中填写豆包语音凭证');

 const headers = {
 'X-Api-Resource-Id': resourceId,
 'X-Api-Request-Id': 'blm_' + Date.now() + '_' + Math.random().toString(16).slice(2),
 'Content-Type': 'application/json',
 };
 if (appId) headers['X-Api-App-Id'] = appId;
 if (accessKey) headers['X-Api-Access-Key'] = accessKey;
 if (apiKey) headers['X-Api-Key'] = apiKey;

 const reqParams = {
 text,
 speaker: voiceId,
 audio_params: { format: 'mp3', sample_rate: 24000 },
 };

 // 语速：speech_rate 范围 -50~100（0=正常，100=2倍速，-50=0.5倍速）
 const speechRate = options.speechRate ?? voiceCfg.doubaoSpeechRate;
 const rate = Number(speechRate);
 if (Number.isFinite(rate) && rate !== 0) {
 reqParams.audio_params.speech_rate = Math.max(-50, Math.min(100, Math.round(rate)));
 }

 // 情感风格：通过 additions.context_texts 注入自然语言风格描述
 const style = options.style || voiceCfg.doubaoStyle;
 const styleText = (style || '').trim();
 if (styleText) {
 reqParams.additions = JSON.stringify({ context_texts: [styleText], model_type: 4 });
 }

 const body = JSON.stringify({
 user: { uid: 'crabpaw' },
 req_params: reqParams,
 });

 // 2026-08-05 fix(根因): 改用 Node https 模块请求——undici fetch 与火山 WAF 不兼容，
 // 应用进程 fetch 静默收到 200+data:null（无音频块）→"响应中无音频数据"。
 // 实测同参数 https 模块返回完整 MP3。与 _streamDoubao(2026-08-03 已修)对齐。
 let respStatus = 0;
 let respHeaders = {};
 let respBody = null;
 for (let attempt = 0; attempt < 3; attempt++) {
   try {
     const r = await this._doubaoHttpsRequest(providerInfo.url, headers, body);
     respStatus = r.status; respHeaders = r.headers; respBody = r.body;
     if (respStatus !== 200) {
       throw new Error('豆包 TTS ' + respStatus + ': ' + respBody.slice(0, 300).toString('utf8'));
     }
     break;
   } catch (e) {
     console.warn('[TTS] doubao 请求失败 (attempt ' + (attempt + 1) + '): ' + (e.message || e));
     if (attempt >= 2) throw e;
     await new Promise(r => setTimeout(r, 500));
   }
 }
 if (respStatus !== 200) {
   throw new Error('豆包 TTS ' + respStatus + ': ' + String(respBody || '').slice(0, 300));
 }
 // 诊断日志——留痕(speaker/resourceId/status)，避免下次盲查
 if (!this._lastDoubaoDiag || Date.now() - this._lastDoubaoDiag > 30000) {
   this._lastDoubaoDiag = Date.now();
   console.log(`[TTS] doubao 请求: resourceId=${resourceId} speaker=${voiceId} status=${respStatus} ct=${(respHeaders['content-type'] || '').toString().slice(0, 40)}`);
 }

 // 用 https 模块的 Buffer 直接解码（对齐 _streamDoubao 的 SSE 解析）
 const buffer = await this._decodeDoubaoBuffer(respBody, { speaker: voiceId, resourceId });
 const filePath = await this._saveAudio(buffer, options, 'mp3');
 return {
 success: true, filePath, format: 'mp3',
 duration: this._estimateDuration(buffer.length, 'mp3', buffer),
 voice: voiceId, provider: 'doubao', model: resourceId,
 sizeBytes: buffer.length,
 };
 }

 // ===== Volcano =====
 async _callVolcano(providerInfo, text, options) {
 const voiceCfg = this.config.voice || {};
 const appId = voiceCfg.volcanoAppId;
 const token = voiceCfg.volcanoToken;
 const voiceId = options.voice || providerInfo.defaultVoice;
 if (!appId || !token) throw new Error('火山引擎 TTS: 缺少 AppId 或 Token');

 const body = JSON.stringify({
 app: { appid: appId, token, cluster: 'volcano_tts' },
 user: { uid: 'crabpaw' },
 audio: { voice_type: voiceId, encoding: 'mp3', speed_ratio: 1.0, volume_ratio: 1.0, pitch_ratio: 1.0 },
 request: { reqid: 'crab_' + Date.now(), text, text_type: 'plain', operation: 'query', with_frontend: 1, frontend_type: 'unitTson' },
 });

 const resp = await fetch(providerInfo.url, {
 method: 'POST',
 headers: { 'Authorization': 'Bearer ' + appId + ';' + token, 'Content-Type': 'application/json' },
 body,
 signal: AbortSignal.timeout(30000),
 });
 if (!resp.ok) throw new Error('火山引擎 TTS ' + resp.status);
 const json = await resp.json();
 if (!json.data) throw new Error('火山引擎 TTS 响应中无音频数据');
 const buffer = Buffer.from(json.data, 'base64');
 const filePath = await this._saveAudio(buffer, options, 'mp3');
 return { success: true, filePath, format: 'mp3', duration: this._estimateDuration(buffer.length, 'mp3', buffer), voice: voiceId, provider: 'volcano', model: 'volcano-tts', sizeBytes: buffer.length };
 }

 // ===== Helpers =====
 async _saveAudio(buffer, options, format) {
 const outputDir = options.outputPath ? path.dirname(options.outputPath) : this._outputDir;
 if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
 const filePath = options.outputPath || this._generateOutputPath(options, format);
 fs.writeFileSync(filePath, buffer);
 return filePath;
 }

 _generateOutputPath(options, format) {
 if (!fs.existsSync(this._outputDir)) fs.mkdirSync(this._outputDir, { recursive: true });
 // 2026-08-15 S7c(审计 P1): 惰性 TTL 清理——tts-output 此前只增不减无限膨胀。
 // 每次生成时概率触发(1/32), 清理 2 小时前的 tts_* 文件; 失败静默不影响合成。
 this._sweepStaleOutputsLazy();
 const hash = crypto.createHash('sha256').update(Date.now() + '_' + Math.random()).digest('hex').slice(0, 8);
 return path.join(this._outputDir, 'tts_' + hash + '.' + format);
 }

 /** 惰性清理 2 小时前的 tts_* 输出(1/32 概率触发, 摊薄 I/O 开销) */
 _sweepStaleOutputsLazy() {
 if (!this._lastSweepTs) this._lastSweepTs = 0;
 if (Date.now() - this._lastSweepTs < 30000) return; // 最多每 30s 尝试一次
 this._lastSweepTs = Date.now();
 if (Math.random() > 1 / 32) return;
 try {
 const cutoff = Date.now() - 2 * 3600 * 1000;
 const files = fs.readdirSync(this._outputDir).filter(f => f.startsWith('tts_'));
 let removed = 0;
 for (const f of files) {
 const full = path.join(this._outputDir, f);
 try {
 const st = fs.statSync(full);
 if (st.mtimeMs < cutoff) { fs.unlinkSync(full); removed++; }
 } catch (e) { /* 单文件失败跳过 */ }
 }
 if (removed > 0) console.log(`[tts] 清理过期输出: ${removed} 个文件 (tts-output)`);
 } catch (e) {
 console.warn('[tts] 输出目录清理失败(不阻塞合成):', e.message);
 }
 }

 /**
  * 估算音频时长(秒)。
  * 2026-08-08 fix: 旧实现 size/128000 把 bit/s 当 byte/s(少乘 8),且 doubao 等
  * 供应商输出低码率 VBR MP3(实测 ~54kbps),size 估算与真实时长差 20 倍
  * (15021B 文件报 0.117s,实际 ~2.2s)——误导排查与诊断。MP3 改为真实帧解析。
  */
 _estimateDuration(fileSizeBytes, format, buffer) {
   if (format === 'mp3') {
     const buf = buffer || null;
     if (buf && buf.length > 4) return this._measureMp3Duration(buf);
     return fileSizeBytes / 16000; // 无 buffer 时的粗略退化(64kbps)
   }
   const bitrateMap = { wav: 1411200, ogg: 112000, flac: 800000 };
   return fileSizeBytes / (bitrateMap[format] || 128000);
 }

 /**
  * 解析 MP3 帧头统计真实时长(兼容 CBR/VBR): 逐帧读取同步字,按帧长公式前进,
  * 累加每帧时长。支持 MPEG1/MPEG2/MPEG2.5 Layer III。
  */
 _measureMp3Duration(buffer) {
   try {
     let pos = 0;
     let seconds = 0;
     const bitrateTable1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
     const sampleRateTable1 = [44100, 48000, 32000, 0];
     // MPEG2/2.5 Layer3 码率表(kbps)——doubao(FFmpeg)输出即 MPEG2 Layer III
     const bitrateTable2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
     const sampleRateTable2 = [22050, 24000, 16000, 0];
     const sampleRateTable25 = [11025, 12000, 8000, 0];
     while (pos + 4 <= buffer.length) {
       if (buffer[pos] === 0xFF && (buffer[pos + 1] & 0xE0) === 0xE0) {
         const versionBits = (buffer[pos + 1] >> 3) & 0x03;
         const layerBits = (buffer[pos + 1] >> 1) & 0x03;
         const bitrateIdx = (buffer[pos + 2] >> 4) & 0x0F;
         const sampleRateIdx = (buffer[pos + 2] >> 2) & 0x03;
         const padding = (buffer[pos + 2] >> 1) & 0x01;
         if (layerBits === 1 && bitrateIdx > 0 && bitrateIdx < 15 && sampleRateIdx < 3) {
           let bitrate, sampleRate, samplesPerFrame;
           if (versionBits === 3) {
             bitrate = bitrateTable1[bitrateIdx] * 1000;
             sampleRate = sampleRateTable1[sampleRateIdx];
             samplesPerFrame = 1152;
           } else if (versionBits === 2) {
             bitrate = bitrateTable2[bitrateIdx] * 1000;
             sampleRate = sampleRateTable2[sampleRateIdx];
             samplesPerFrame = 576;
           } else if (versionBits === 0) {
             bitrate = bitrateTable2[bitrateIdx] * 1000;
             sampleRate = sampleRateTable25[sampleRateIdx];
             samplesPerFrame = 576;
           } else { pos++; continue; }
           const frameLen = Math.floor((144 * bitrate) / sampleRate) + padding;
           if (frameLen > 0 && frameLen <= 1441) {
             seconds += samplesPerFrame / sampleRate;
             pos += frameLen;
             continue;
           }
         }
       }
       pos++;
     }
     if (seconds > 0) return Number(seconds.toFixed(4));
     return buffer.length / 16000;
   } catch {
     return buffer.length / 16000;
   }
 }

 getStats() { return { ...this._stats }; }
 getProviders() {
 return Object.entries(TTS_PROVIDERS).map(([id, info]) => ({ id, name: info.name, available: id === 'sapi' || id === 'edge' || id === 'local' || this._hasValidKey(id), voices: info.voices, defaultVoice: info.defaultVoice }));
 }

 // ── 流式合成 ──

 /**
 * 流式合成语音 — 返回 Node.js Readable stream
 * 边合成边推送音频块，无需等待完整文件生成
 */
 async synthesizeStream(text, options = {}) {
   if (!text || typeof text !== 'string' || text.trim().length === 0) {
   throw new Error('TTS: Empty text');
   }
   const sanitizedText = sanitizeTextForSpeech(text);
     if (!sanitizedText) throw new Error('TTS: Text empty after sanitization');

     // V1 fix: 支持请求级 voiceOverride — 临时合并到 config.voice 而不修改原始单例
     // T2 fix: 使用浅拷贝保存原始值，防止引用赋值导致 restore 无法恢复
     // 2026-08-01: 覆盖段加互斥锁（与 synthesize 一致，防并发污染单例 config.voice）
     const releaseVoiceLock = await this._acquireVoiceLock();
     // 2026-08-14: 合成前惰性校验 provider 顺序（edge 熔断/新 Key 配置变化时重建）
     this._refreshProviderOrder();
     const savedVoice = { ...this.config.voice };
     if (options.voiceOverride && typeof options.voiceOverride === 'object') {
       this.config.voice = { ...savedVoice, ...options.voiceOverride };
     }
     // 支持请求级 provider 指定 — 临时覆盖 _providerOrder
     const savedProviderOrder = [...this._providerOrder];
     if (options.provider) {
       const primary = options.provider === 'edge-tts' ? 'edge' : options.provider;
       this._providerOrder = [primary, ...this._providerOrder.filter(p => p !== primary)];
     }

   // 将音频数据即时推送到外部 stream（流式输出），首个 chunk 到达即推送
   const outerStream = new Readable({ read() {} });
   let committed = false;
   const failedProviders = [];  // 追踪失败的 provider 和原因

 try {
 for (const providerName of this._providerOrder) {
 const providerInfo = TTS_PROVIDERS[providerName];
 if (!providerInfo || !this._hasValidKey(providerName)) continue;
 if (sanitizedText.length > providerInfo.maxTextLength) continue;
 // 2026-08-14: edge 熔断进程内即时生效（与 synthesize 同步跳过,避免流式首句白等）
 if (providerName === 'edge' && isEdgeBlocked()) continue;
 try {
   // 音色映射：fallback 到不同 provider 时，使用该 provider 的 defaultVoice
   const mappedOptions = { ...options };
   if (!providerInfo.voices.includes(mappedOptions.voice || '')) {
     mappedOptions.voice = providerInfo.defaultVoice;
   }
   // 为每个 provider 创建独立的内部 stream，避免 destroy 级联
   const innerStream = new Readable({ read() {} });
   let streamEnded = false;
   // V17 fix: 先绑定事件监听器，再启动流，避免数据丢失竞态
   innerStream.on('data', (chunk) => {
     if (!committed) {
       committed = true;
       this._stats.successfulRequests++;
       this._stats.totalCharsSynthesized += sanitizedText.length;
     }
     outerStream.push(chunk);
   });
   innerStream.on('end', () => {
     streamEnded = true;
     if (committed) {
       outerStream.push(null);
     }
   });
   innerStream.on('error', (err) => {
     if (committed) {
       outerStream.destroy(new Error(`${providerName} failed mid-stream: ${err.message}`));
     }
   });

   // eslint-disable-next-line no-unused-vars -- result 未使用，Promise 内流式逻辑仍需执行
   const result = await new Promise((resolve) => {
     // 超时保护：15s 内无首帧则放弃该 provider
     const timeout = setTimeout(() => { innerStream.destroy(); resolve(false); }, 15000);

   this._streamFromProvider(providerName, providerInfo, sanitizedText, mappedOptions, innerStream)
     .then(r => { clearTimeout(timeout); resolve(r); })
     .catch(_e => { clearTimeout(timeout); resolve(false); });
 });

 if (committed) {
   // 已从该 provider 收到首个 chunk，等待流结束
   if (!streamEnded) {
     await new Promise(resolve => innerStream.on('end', resolve));
   }
   return outerStream;
 }

 console.warn('[TTS Stream]', providerName, 'returned no audio, trying next provider');
 failedProviders.push({ provider: providerName, error: 'no audio' });
 } catch (e) {
 console.warn('[TTS Stream]', providerName, 'failed:', redactText(e.message));
 failedProviders.push({ provider: providerName, error: e.message });
 // 2026-08-04: edge 403/超时 → 熔断 10 分钟(被墙时不再每次先试)
 if (providerName === 'edge' && /403|timeout|超时/i.test(e?.message || '')) markEdgeBlocked();
 }
 }
 } catch (e) {
   console.error('[TTS Stream] unexpected error:', e.message);
   } finally {
     // V1 fix: 恢复原始 config.voice 和 _providerOrder
     this.config.voice = savedVoice;
     this._providerOrder = savedProviderOrder;
     // 2026-08-01: 释放互斥锁
     releaseVoiceLock();
   }

 // 所有 provider 均失败
 const hint = failedProviders.some(p => p.error && p.error.includes('403'))
   ? 'Edge TTS 服务已被微软封禁(403)，请在设置中配置其他 TTS 提供商（如豆包/火山引擎）的 API Key'
   : 'All TTS providers failed for streaming';
 console.error('[TTS Stream] Error:', hint);
 outerStream.destroy(new Error(hint));

 return outerStream;
   }

 // V9 fix: Piper 本地 TTS 调用
  async _callPiper(providerInfo, text, _options) {
   const { spawn } = require('child_process');
   const voiceCfg = this.config.voice || {};
   const piperPath = voiceCfg.piperPath || 'piper';
   const modelPath = voiceCfg.piperModel || 'default';
   const outputDir = this._outputDir;
   if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
   const outputPath = path.join(outputDir, `piper_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.wav`);

   return new Promise((resolve, reject) => {
     let settled = false;
     const finish = (fn, value) => {
       if (settled) return;
       settled = true;
       fn(value);
     };
     const piperProc = spawn(piperPath, ['--model', modelPath, '--output_file', outputPath], {
       stdio: ['pipe', 'ignore', 'pipe'],
       windowsHide: true,
     });
     let stderr = '';
     piperProc.stderr.on('data', chunk => { stderr += chunk.toString(); });
     piperProc.on('error', (error) => {
       console.warn('[TTS Piper] 启动失败:', error.message);
       finish(reject, error);
     });
     piperProc.on('close', (code) => {
       if (code !== 0) {
         const err = new Error(`Piper TTS exit code ${code}: ${stderr.trim() || 'unknown error'}`);
         console.warn('[TTS Piper] 合成失败:', err.message);
         finish(reject, err);
         return;
       }
       if (!fs.existsSync(outputPath)) {
         finish(reject, new Error('Piper TTS: output file not created'));
         return;
       }
       finish(resolve, {
         success: true,
         filePath: outputPath,
         format: 'wav',
         provider: 'piper',
         model: modelPath,
       });
     });
     piperProc.stdin.write(text);
     piperProc.stdin.end();
   });
  }

 async _streamFromProvider(providerName, providerInfo, text, options, stream) {
 const voice = options.voice || providerInfo.defaultVoice;
 const speed = Math.max(0.25, Math.min(4.0, options.speed || 1.0));

 switch (providerName) {
 case 'edge': case 'edge-tts':
 return this._streamEdgeTTS(providerInfo, text, voice, speed, stream);
case 'openai':
 return this._streamOpenAICompatible(providerName, providerInfo, text, voice, speed, options, stream);
 case 'doubao':
 return this._streamDoubao(providerInfo, text, options, stream);
 default:
 // 非流式 Provider 降级：完整缓冲后推送
 return this._streamNonStreamingAsStream(providerName, providerInfo, text, options, stream);
 }
 }

 async _streamEdgeTTS(providerInfo, text, voice, speed, stream) {
 const WebSocket = require('ws');
 const ratePercent = Math.round((speed - 1) * 100);
 const rate = ratePercent >= 0 ? '+' + ratePercent + '%' : ratePercent + '%';
 const secMSGEC = this._generateSecMSGEC();
 const connId = crypto.randomUUID();
 const WSS_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
 + '?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=' + connId
 + '&Sec-MS-GEC=' + secMSGEC + '&Sec-MS-GEC-Version=1-143.0.3650.75';
 const CRLF = String.fromCharCode(13, 10);

 return new Promise((resolve, reject) => {
 const ws = new WebSocket(WSS_URL, {
 handshakeTimeout: 8000,
 headers: {
 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
 'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
 'Pragma': 'no-cache', 'Cache-Control': 'no-cache',
 'Sec-WebSocket-Version': '13',
 'Cookie': 'muid=' + this._generateMUID() + ';',
 }
 });
 // Edge TTS 403 快速失败：微软封禁时 WS 握手直接返回 403
 // 需要监听 unexpected-response 事件，否则会卡到 handshakeTimeout (8s) 才失败
 ws.on('unexpected-response', (req, res) => {
   clearTimeout(timeout);
   const status = res.statusCode;
   console.warn(`[Edge TTS] Server returned ${status}, service may be blocked`);
   reject(new Error(`Edge TTS: server returned ${status}`));
 });
 let audioFound = false;
 const timeout = setTimeout(() => { try { ws.close(); } catch (e) { console.warn('[TTS] failed to close ws on stream timeout:', e.message); } reject(new Error('Edge TTS stream timeout')); }, 20000);

 ws.on('open', () => {
 const ts = new Date().toUTCString().replace('GMT', 'GMT+0000 (Coordinated Universal Time)');
 ws.send('X-Timestamp:' + ts + CRLF + 'Content-Type:application/json; charset=utf-8' + CRLF + 'Path:speech.config' + CRLF + CRLF +
 JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'true' }, outputFormat: 'audio-24khz-48kbitrate-mono-mp3' } } } }));
 const longVoice = this._edgeVoiceName(voice);
 const escapedText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
 const ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>"
 + "<voice name='" + longVoice + "'><prosody pitch='+0Hz' rate='" + rate + "' volume='+0%'>" + escapedText + "</prosody></voice></speak>";
 ws.send('X-RequestId:' + crypto.randomUUID().replace(/-/g, '') + CRLF + 'Content-Type:application/ssml+xml' + CRLF + 'X-Timestamp:' + ts + 'Z' + CRLF + 'Path:ssml' + CRLF + CRLF + ssml);
 });

 ws.on('message', (data, isBinary) => {
 if (isBinary && data.length >= 2) {
 let offset = 0;
 while (offset + 2 <= data.length) {
 const hdrLen = (data[offset] << 8) | data[offset + 1];
 offset += 2;
 if (offset + hdrLen > data.length) break;
 const hdr = data.toString('utf8', offset, offset + hdrLen);
 offset += hdrLen;
 if (offset + 2 > data.length) break;
 const contentLen = (data[offset] << 8) | data[offset + 1];
 offset += 2;
 if (offset + contentLen > data.length) break;
 if (hdr.indexOf('audio') >= 0 || hdr.indexOf('audio/mpeg') >= 0) {
 audioFound = true;
 stream.push(data.slice(offset, offset + contentLen));
 }
 offset += contentLen;
 }
 } else if (!isBinary) {
 const str = Buffer.isBuffer(data) ? data.toString('utf8') : data;
 const idx2 = str.indexOf('\r\n\r\n');
 if (idx2 >= 0) {
 try {
 const obj = JSON.parse(str.substring(idx2 + 4));
 if (obj.audio && obj.audio.data) {
 audioFound = true;
 stream.push(Buffer.from(obj.audio.data, 'base64'));
 }
 } catch (e) { console.warn('[TTS] failed to parse Edge TTS stream message:', e.message); }
   }
   }
   });

 ws.on('close', () => {
 clearTimeout(timeout);
 if (audioFound) { stream.push(null); resolve(true); }
 else { stream.destroy(new Error('Edge TTS: no audio received')); reject(new Error('Edge TTS: no audio received')); }
 });
 ws.on('error', (err) => { clearTimeout(timeout); stream.destroy(err); reject(err); });
 });
 }

 /**
 * 解码豆包 https 响应 Buffer（SSE JSON 多行格式），带 3 次重试。
 * 2026-08-05: 由 _decodeDoubaoResponse(fetch 版) 拆出，供 https 模块路径复用。
 * 火山对瞬时限流/并发静默返回 code:0+data:null（无音频），短暂等待后重试——
 * 实测独立进程同参数成功，属间歇性限流。
 * @returns {Promise<Buffer>}
 */
 async _decodeDoubaoBuffer(respBody, context) {
   const text = Buffer.isBuffer(respBody) ? respBody.toString('utf8') : String(respBody || '');
   for (let attempt = 0; attempt < 3; attempt++) {
     const chunks = [];
     const lines = text.split(/\r?\n/);
     for (const rawLine of lines) {
       const line = rawLine.trim().replace(/^data:\s*/, '');
       if (!line || line === '[DONE]') continue;
       if (!line.startsWith('{')) {
         if (line.length > 20) {
           try { chunks.push(Buffer.from(line, 'base64')); } catch (e) { console.warn('[TTS] failed to decode base64 chunk in doubao response:', e.message); }
         }
         continue;
       }
       try {
         const data = JSON.parse(line);
         const code = Number(data.code ?? data.status_code ?? 0);
         if (code > 0 && code !== 20000000) {
           const msg = data.message || data.status_text || '未知错误';
           throw new Error(`豆包 TTS 流错误 (${code}): ${msg}. 当前音色: ${context.speaker}, 资源: ${context.resourceId}`);
         }
         if (data.data) {
           chunks.push(Buffer.from(data.data, 'base64'));
         }
       } catch (e) {
         if (e.message && e.message.indexOf('豆包 TTS') === 0) throw e;
         console.warn('[TTS] failed to parse doubao SSE line:', e.message);
       }
     }
     if (chunks.length === 0) {
       console.warn('[TTS] doubao 响应无音频数据 (attempt ' + (attempt + 1) + '), raw head: ' + text.slice(0, 200).replace(/\n/g, '\\n'));
       if (attempt < 2) {
         await new Promise(r => setTimeout(r, 800));
         continue;
       }
       throw new Error('豆包 TTS: 响应中无音频数据（重试后仍为空）');
     }
     return Buffer.concat(chunks);
   }
   throw new Error('豆包 TTS: 响应中无音频数据');
 }

 /**
 * 豆包 TTS 请求（Node https 模块，2026-08-03 修复）
 * undici fetch 与火山 WAF 不兼容（静默返回 200+data:null），https 模块实测正常。
 * @returns {Promise<{status: number, headers: object, body: Buffer}>}
 */
 _doubaoHttpsRequest(url, headers, body) {
   return new Promise((resolve, reject) => {
     const https = require('https');
     // 2026-08-05: 诊断——打印完整请求体与响应摘要，定位"应用进程空响应"差异
     if (!this._lastDoubaoReqDiag || Date.now() - this._lastDoubaoReqDiag > 30000) {
       this._lastDoubaoReqDiag = Date.now();
       console.log('[TTS] doubao req diag: url=' + url + ' headers=' + JSON.stringify(headers) + ' body=' + body.slice(0, 300));
     }
     const req = https.request(url, {
       method: 'POST',
       headers: { ...headers, 'Content-Length': Buffer.byteLength(body), 'Connection': 'close' },
       timeout: 30000,
     }, (res) => {
       const chunks = [];
       res.on('data', (c) => chunks.push(c));
       res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
     });
     req.on('error', (e) => reject(new Error('豆包 TTS 网络错误: ' + (e.message || e))));
     req.on('timeout', () => { req.destroy(new Error('豆包 TTS 请求超时')); });
     req.write(body);
     req.end();
   });
 }

 /**
 * 豆包流式 TTS — 使用 HTTP chunked SSE 响应
 * 对齐 streamDoubao + decodeDoubaoStream 模式
 */
 async _streamDoubao(providerInfo, text, options, stream, attempt = 0) {
 const voiceCfg = this.config.voice || {};
 const models = this.config.models || {};
 const doubaoCfg = (models.providers && models.providers.doubao) || {};
 const apiKey = voiceCfg.doubaoKey || doubaoCfg.apiKey;
 const accessKey = voiceCfg.doubaoAccessKey;
 const appId = voiceCfg.doubaoAppId;
 const voiceId = options.voice || providerInfo.defaultVoice;
 const resourceId = this._resolveDoubaoResourceId(voiceId);

 if (!apiKey && !accessKey) throw new Error('豆包 TTS: 缺少 API Key/Access Key');

 const headers = {
 'X-Api-Resource-Id': resourceId,
 'X-Api-Request-Id': 'blm_' + Date.now() + '_' + Math.random().toString(16).slice(2),
 'Content-Type': 'application/json',
 };
 if (appId) headers['X-Api-App-Id'] = appId;
 if (accessKey) headers['X-Api-Access-Key'] = accessKey;
 if (apiKey) headers['X-Api-Key'] = apiKey;

 const reqParams = {
 text,
 speaker: voiceId,
 audio_params: { format: 'mp3', sample_rate: 24000 },
 };

 const speechRate = options.speechRate ?? voiceCfg.doubaoSpeechRate;
 const rate = Number(speechRate);
 if (Number.isFinite(rate) && rate !== 0) {
 reqParams.audio_params.speech_rate = Math.max(-50, Math.min(100, Math.round(rate)));
 }

 // 情感风格：通过 additions.context_texts 注入自然语言风格描述
 const style = options.style || voiceCfg.doubaoStyle;
 const styleText = (style || '').trim();
 if (styleText) {
 reqParams.additions = JSON.stringify({ context_texts: [styleText], model_type: 4 });
 }

 // 2026-08-03 修复: 改用 Node https 模块请求（undici fetch 与火山 WAF 不兼容——
 // 应用进程 fetch 收到 200+data:null 静默空音频，https 模块同参数返回正常 MP3）。
 // 'Connection: close' 避免 keep-alive 连接复用（排除连接池因素）。
 const { status: respStatus, headers: respHeaders, body: respBody } = await this._doubaoHttpsRequest(
   providerInfo.url,
   headers,
   JSON.stringify({ user: { uid: 'crabpaw' }, req_params: reqParams }),
 );

 if (respStatus !== 200) {
   const errText = respBody.slice(0, 300).toString('utf8');
   throw new Error('豆包 TTS ' + respStatus + ': ' + errText);
 }

 const contentType = (respHeaders['content-type'] || '').toString();

 // 直接 audio/mpeg 流 — pipe to output
 if (contentType.includes('audio/')) {
   stream.push(respBody);
   stream.push(null);
   return true;
 }

 // SSE chunked 格式: data: <base64 JSON>
 const text2 = respBody.toString('utf8');
 const chunks = [];
 const lines = text2.split(/\r?\n/);
 for (const rawLine of lines) {
 const line = rawLine.trim().replace(/^data:\s*/, '');
 if (!line || line === '[DONE]') continue;
 if (!line.startsWith('{')) {
 if (line.length > 20) {
 try { chunks.push(Buffer.from(line, 'base64')); } catch (e) { console.warn('[TTS] failed to decode base64 chunk in doubao stream:', e.message); }
 }
 continue;
 }
 try {
 const data = JSON.parse(line);
 const code = Number(data.code ?? data.status_code ?? 0);
 if (code > 0 && code !== 20000000) {
 throw new Error('豆包 TTS 流错误 (' + code + '): ' + (data.message || '未知'));
 }
 if (data.data) { chunks.push(Buffer.from(data.data, 'base64')); }
 } catch (e) {
 if (e.message && e.message.indexOf('豆包 TTS') === 0) throw e;
 }
 }

 if (chunks.length === 0) {
   // 2026-08-03 修复: 火山对瞬时限流/并发静默返回 code:0 + data:null（无音频），
   // 不抛错而是短暂等待后重试（最多 3 次）——实测独立进程同参数成功，间歇性限流
   console.warn('[Doubao TTS] 响应中无音频数据 (attempt %d), raw=%s', attempt, String(text2).slice(0, 120));
   if (attempt < 2) {
     await new Promise(r => setTimeout(r, 800));
     return this._streamDoubao(providerInfo, text, options, stream, attempt + 1);
   }
   throw new Error('豆包 TTS: 响应中无音频数据（重试后仍为空）');
 }
 for (const chunk of chunks) stream.push(chunk);
 stream.push(null);
 return true;
 }

 async _streamOpenAICompatible(providerName, providerInfo, text, voice, speed, options, stream) {
 const providerConfig = this._getProviderConfig(providerName);
 if (!providerConfig) throw new Error('No config for ' + providerName);
 const baseUrl = providerConfig.baseUrl || providerConfig.base_url || 'https://api.openai.com/v1';
 const apiKey = providerConfig.apiKey;
 const url = baseUrl.replace(/\/$/, '') + '/audio/speech';
 const body = { model: options?.model || providerInfo.model, input: text, voice, speed, response_format: 'mp3' };
 const resp = await fetch(url, {
 method: 'POST',
 headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
 body: JSON.stringify(body),
 signal: AbortSignal.timeout(30000),
 });
 if (!resp.ok) throw new Error('TTS API ' + resp.status);
 if (resp.body) {
 const reader = resp.body.getReader();
 const pump = async () => {
 try {
 // eslint-disable-next-line no-constant-condition
 while (true) {
 const { done, value } = await reader.read();
 if (done) { stream.push(null); break; }
 stream.push(Buffer.from(value));
 }
 } catch (e) { stream.destroy(e); }
 };
 pump();
 return true;
 }
 const arrayBuffer = await resp.arrayBuffer();
 stream.push(Buffer.from(arrayBuffer));
 stream.push(null);
 return true;
 }

 async _streamNonStreamingAsStream(providerName, providerInfo, text, options, stream) {
 const result = await this._callProvider(providerName, providerInfo, text, options);
 if (result.success && result.filePath) {
 const audioBuffer = fs.readFileSync(result.filePath);
 stream.push(audioBuffer);
 stream.push(null);
 // V18 fix: 只删除临时目录中的文件，保留 TTS 输出目录中的缓存文件
   const isTmpFile = result.filePath.includes(require('os').tmpdir());
   if (isTmpFile) { try { fs.unlinkSync(result.filePath); } catch (e) { console.warn('[TTS] failed to delete temp file:', e.message); } }
 return true;
 }
 throw new Error(result.error || providerName + ' TTS failed');
 }
}

let _instance = null;
function getTextToSpeechEngine(config) {
 if (!_instance) _instance = new TextToSpeechEngine(config);
 return _instance;
}

const TTS_ERROR_CODES = {
  NETWORK: 'network_error',
  TIMEOUT: 'timeout_error',
  AUTH: 'auth_error',
  RATE_LIMIT: 'rate_limit',
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
  INVALID_INPUT: 'invalid_input',
  UNKNOWN: 'unknown_error',
}

function normalizeTTSError(error, providerName) {
  const msg = error?.message || String(error)
  const status = error?.status || error?.statusCode || 0

  if (msg.includes('timeout') || msg.includes('timed out')) {
    return { code: TTS_ERROR_CODES.TIMEOUT, message: `${providerName} TTS 超时`, retryable: true }
  }
  if (msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
    return { code: TTS_ERROR_CODES.NETWORK, message: `${providerName} 网络连接失败`, retryable: true }
  }
  if (status === 401 || status === 403 || msg.includes('auth') || msg.includes('API key')) {
    return { code: TTS_ERROR_CODES.AUTH, message: `${providerName} 认证失败，请检查 API Key`, retryable: false }
  }
  if (status === 429 || msg.includes('rate limit') || msg.includes('too many')) {
    return { code: TTS_ERROR_CODES.RATE_LIMIT, message: `${providerName} 请求过于频繁`, retryable: true }
  }
  if (status === 503 || status === 502 || msg.includes('unavailable')) {
    return { code: TTS_ERROR_CODES.PROVIDER_UNAVAILABLE, message: `${providerName} 服务暂时不可用`, retryable: true }
  }
  return { code: TTS_ERROR_CODES.UNKNOWN, message: `语音合成失败: ${msg}`, retryable: false }
}

module.exports = { TextToSpeechEngine, getTextToSpeechEngine, TTS_PROVIDERS, normalizeTTSError, TTS_ERROR_CODES, chunkText, extractSpeechContent };
