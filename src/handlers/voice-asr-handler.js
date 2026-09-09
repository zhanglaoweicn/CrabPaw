/**
 * Voice ASR Handler — 语音识别 HTTP 端点（自主实现）
 *
 * POST /api/voice/asr — 接收 PCM Int16 音频，返回识别文本
 *
 * 使用createCloudASRSession 统一工厂，
 * 支持 aliyun / tencent / xunfei / volcengine 四种 ASR 提供商，
 * 配置来自 voiceConfig 中的 provider 选择。
 */

const { createCloudASRSession } = require('../core/asr/cloud-asr');
const fs = require('fs');
const path = require('path');

// R7 fix: 配置文件缓存，避免每请求 readFileSync 阻塞事件循环
let _cachedConfig = null;
let _configMtime = 0;

/** 读取配置文件（带 mtime 缓存，仅在文件变更时重新读取） */
async function readConfig() {
  try {
    const { DATA_DIR } = require('../core/config');
    const configPath = path.join(DATA_DIR, 'config.json');
    const stat = await fs.promises.stat(configPath);
    if (_cachedConfig && stat.mtimeMs === _configMtime) {
      return _cachedConfig;
    }
    _configMtime = stat.mtimeMs;
    _cachedConfig = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
    return _cachedConfig;
  } catch (e) {
    console.warn('[ASR] 读取配置文件失败，使用空配置:', e.message);
    return { voice: {}, models: { providers: {} } };
  }
}

/** 处理 ASR 请求 */
async function handleVoiceASR(req, res, _appConfig) {
 if (req.method !== 'POST') {
 res.writeHead(405);
 res.end(JSON.stringify({ success: false, error: 'Method not allowed' }));
 return true;
 }

 try {
 const chunks = [];
 for await (const chunk of req) chunks.push(chunk);
 const pcmBuffer = Buffer.concat(chunks);
 if (pcmBuffer.length < 320) {
 res.writeHead(400);
 res.end(JSON.stringify({ success: false, error: '音频数据过短' }));
 return true;
 }

  const config = await readConfig();

 const voiceCfg = config.voice || {};
 const asrProvider = voiceCfg.asrProvider || 'volcengine';
 const lang = voiceCfg.lang || 'zh';

 // 构建 provider 配置（兼容字段名）
 const creds = { provider: asrProvider, lang,
 aliyunApiKey: voiceCfg.aliyunApiKey || '',
 tencentSecretId: voiceCfg.tencentSecretId || '',
 tencentSecretKey: voiceCfg.tencentSecretKey || '',
 tencentAppId: voiceCfg.tencentAppId || '',
 xunfeiAppId: voiceCfg.xunfeiAppId || '',
 xunfeiApiKey: voiceCfg.xunfeiApiKey || '',
 volcAsrApiKey: voiceCfg.volcAsrApiKey || voiceCfg.doubaoKey || config.models?.providers?.doubao?.apiKey || '',
 volcAsrAppKey: voiceCfg.volcAsrAppKey || '',
 volcAsrAccessKey: voiceCfg.volcAsrAccessKey || '',
 volcAsrResourceId: voiceCfg.volcAsrResourceId || '',
 };

 console.log('[ASR] provider=%s lang=%s pcmBytes=%d (%.1fs)', asrProvider, lang, pcmBuffer.length, pcmBuffer.length / 32000);
 const result = await runASRSession(creds, pcmBuffer);
 console.log('[ASR] result:', result ? `"${result.substring(0, 80)}"` : '(空)');
 if (result && result.trim()) {
 res.writeHead(200, { 'Content-Type': 'application/json' });
 res.end(JSON.stringify({ success: true, text: result }));
 } else {
 res.writeHead(200, { 'Content-Type': 'application/json' });
 res.end(JSON.stringify({ success: false, error: '未能识别到语音内容', text: '' }));
 }
 } catch (e) {
 res.writeHead(500, { 'Content-Type': 'application/json' });
 res.end(JSON.stringify({ success: false, error: e.message || 'ASR 处理异常' }));
 }
 return true;
}

/** 运行一次 ASR 会话 */
function runASRSession(creds, pcmBuffer) {
 return new Promise((resolve) => {
 // 用 Map 按段落 ID 去重 — 流式 ASR 会多次返回同一段落的增量更新
 const segMap = new Map();
 let session = null;
 let settled = false;

 const collectResult = () => {
  const segments = Array.from(segMap.entries())
  // R10 fix: 支持 seg_N 数字排序 和 UUID:index 格式排序
  .sort((a, b) => {
    const segMatchA = a[0].match(/^seg_(\d+)$/);
    const segMatchB = b[0].match(/^seg_(\d+)$/);
    if (segMatchA && segMatchB) return parseInt(segMatchA[1], 10) - parseInt(segMatchB[1], 10);
    const idxA = a[0].split(':')[1];
    const idxB = b[0].split(':')[1];
    if (idxA && idxB && !isNaN(idxA) && !isNaN(idxB)) return parseInt(idxA, 10) - parseInt(idxB, 10);
    return 0;
  });
 return segments.map(([, text]) => text).join('');
 };

 try {
 session = createCloudASRSession(creds,
 (text, isFinal, seg, speechFinal) => {
 if (text && text.trim()) {
 // 同一段落 ID 只保留最新文本（增量更新覆盖之前的部分结果）
 segMap.set(seg || 'default', text.trim());
 console.log('[ASR] 转录[%s] %s%s: "%s"', seg || '?', isFinal ? 'final' : 'interim', speechFinal ? '/speechFinal' : '', text.substring(0, 60));
 }
 },
 (err) => {
 console.warn('[ASR-ERR]', err);
 if (settled) return;
 settled = true;
 resolve(collectResult() || null);
 },
 () => {
 if (settled) return;
 settled = true;
 const result = collectResult();
 console.log('[ASR] 会话关闭，段数=%d 结果="%s"', segMap.size, result.substring(0, 80));
 resolve(result || null);
 },
 () => {}
 );
 } catch (e) {
 if (settled) return;
 settled = true;
 resolve(null);
 return;
 }

 if (!session) {
 if (settled) return;
 settled = true;
 resolve(null);
 return;
 }

 // 发送 PCM — WebSocket 未连接时会缓存到 pending，连接后自动发送
 const CHUNK_SIZE = 4096;
 let chunkCount = 0;
 for (let i = 0; i < pcmBuffer.length; i += CHUNK_SIZE) {
 session.sendAudio(pcmBuffer.slice(i, Math.min(i + CHUNK_SIZE, pcmBuffer.length)));
 chunkCount++;
 }
 // V2: 使用 flushSpeechFinal 确保最后一段被标记为 speechFinal（与 WS 模式一致）
 if (typeof session.flushSpeechFinal === 'function') {
 session.flushSpeechFinal();
 } else {
 session.flush();
 }
 console.log('[ASR] 已发送 %d 块 PCM (%d 字节)，等待识别...', chunkCount, pcmBuffer.length);

 // V25 fix: 移除 session 创建前的 15s 死代码超时，仅保留 flush 后的 12s 超时
 // 等待 ASR 返回结果（给足时间让 WS 连接 + 云端处理）
 setTimeout(() => {
 if (settled) return;
 settled = true;
 try { session.close(); } catch (e) { console.warn('[ASR] 超时关闭 session 失败:', e) }
 const result = collectResult();
 console.log('[ASR] 12s 后超时，段数=%d 结果="%s"', segMap.size, result.substring(0, 80));
 resolve(result || null);
 }, 12000);
 });
}

module.exports = { handleVoiceASR };
