/**
 * Voice Pipeline — 语音管线组件（保留子集）
 *
 * 2026-08-01 精简：VoicePipeline 主类与 EventSemantics/SessionManager/VoiceTranscript
 * 从未被任何代码实例化（voice-cloud-ws.js 只使用 BoundedBacklog 与 NoSpeechWatchdog，
 * 其余逻辑由前端 useVoiceSession 的 applyTranscript 三层语义镜像实现）。
 * 本文件仅保留被生产路径消费的两个组件。
 */

// ─── 默认配置 ────────────────────────────────────────────────

const DEFAULT_CONFIG = Object.freeze({
  sampleRate: 16000,
  chunkSize: 2048,
  silenceThreshold: 0.05,
  maxRecordingDuration: 300000,
  maxReconnectAttempts: 3,
  noSpeechTimeoutMs: 30000,
  backlogMaxSize: 100,
  reconnectDelayMs: 1000,
});

// ─── BoundedBacklog ──────────────────────────────────────────

class BoundedBacklog {
  /**
   * 固定大小的 PCM 音频数据有界缓冲区 + 阈值双级背压（2026-08-12,移植 LiveKit 流控思想）
   * - 缓冲满时新数据丢弃并触发溢出回调（保留）
   * - 占用 ≥ highRatio 触发 'high'，回落 ≤ lowRatio 触发 'ok'（迟滞,防抖动）
   * @param {number} [maxSize=100] 最大缓存块数
   * @param {{highRatio?: number, lowRatio?: number}} [opts]
   */
  constructor(maxSize = DEFAULT_CONFIG.backlogMaxSize, opts = {}) {
    this._maxSize = maxSize;
    this._chunks = [];
    this._overflowed = false;
    this._onOverflow = null;
    this._onLevelChange = null;
    this._highRatio = opts.highRatio ?? 0.6;
    this._lowRatio = opts.lowRatio ?? 0.2;
    this._level = 'ok';
  }

  /**
   * 推入一个 PCM 音频块
   * @param {Buffer} chunk PCM 音频数据
   * @returns {boolean} true 表示入队成功，false 表示缓冲区已满
   */
  push(chunk) {
    if (this._chunks.length >= this._maxSize) {
      if (!this._overflowed) {
        this._overflowed = true;
        if (typeof this._onOverflow === 'function') {
          try { this._onOverflow(this._chunks.length); } catch (e) { console.warn('[voice-pipeline] 回调异常:', e); }
        }
      }
      return false;
    }
    this._chunks.push(chunk);
    this._updateLevel();
    return true;
  }

  /**
   * 排空缓冲区，返回所有缓存的音频块并清空
   * @returns {Buffer[]}
   */
  drain() {
    const drained = this._chunks.slice();
    this._chunks.length = 0;
    this._overflowed = false;
    this._updateLevel();
    return drained;
  }

  /** 当前缓存块数 */
  size() { return this._chunks.length; }

  /** 当前背压级别 'ok' | 'high' */
  level() { return this._level; }

  /** 清空缓冲区 */
  clear() {
    this._chunks.length = 0;
    this._overflowed = false;
    this._updateLevel();
  }

  /**
   * 设置溢出回调 — 当缓冲区首次溢出时触发
   * @param {(currentSize: number) => void} cb
   */
  onOverflow(cb) {
    this._onOverflow = (typeof cb === 'function') ? cb : null;
  }

  /**
   * 设置背压级别变化回调（迟滞）:
   * - ok → high 当 ratio ≥ highRatio
   * - high → ok 当 ratio ≤ lowRatio
   * @param {(level: 'ok'|'high', queued: number, queuedMs: number) => void} cb
   */
  onLevelChange(cb) {
    this._onLevelChange = (typeof cb === 'function') ? cb : null;
  }

  _updateLevel() {
    const ratio = this._chunks.length / this._maxSize;
    let next = this._level;
    if (this._level !== 'high' && ratio >= this._highRatio) next = 'high';
    else if (this._level === 'high' && ratio <= this._lowRatio) next = 'ok';
    if (next !== this._level) {
      this._level = next;
      if (typeof this._onLevelChange === 'function') {
        try {
          this._onLevelChange(this._level, this._chunks.length, Math.round(this._chunks.length * 128));
        } catch (e) { console.warn('[voice-pipeline] 回调异常:', e); }
      }
    }
  }
}

/**
 * 计算 Int16 PCM Buffer 的 RMS（Int16 域,满幅 ≈32768）
 * @param {Buffer} pcmData
 * @returns {number}
 */
function computeRms(pcmData) {
  if (!pcmData || pcmData.length < 2) return 0;
  let sum = 0, samples = 0;
  for (let i = 0; i + 1 < pcmData.length && samples < 500; i += 2, samples++) {
    const s = pcmData.readInt16LE(i);
    sum += s * s;
  }
  return samples > 0 ? Math.sqrt(sum / samples) : 0;
}

// ─── NoSpeechWatchdog ────────────────────────────────────────

/**
 * STT 转录活动监控看门狗。
 * 在指定超时时间内未收到任何转录事件时触发超时信号，
 * 用于检测空麦克风或 ASR 卡死等异常情况。
 */
class NoSpeechWatchdog {
  /**
   * @param {number} [timeoutMs=30000] 超时时间（毫秒）
   */
  constructor(timeoutMs = DEFAULT_CONFIG.noSpeechTimeoutMs) {
    this._timeoutMs = timeoutMs;
    this._timer = null;
    this._triggered = false;
    this._active = false;
    this._lastFeedTs = 0;
    this._onTimeout = null;
  }

  /**
   * 开始监控。调用后立即重置计时器。
   * @param {() => void} [onTimeout] 超时回调
   */
  watch(onTimeout) {
    this._active = true;
    this._triggered = false;
    this._lastFeedTs = 0;
    if (typeof onTimeout === 'function') {
      this._onTimeout = onTimeout;
    }
    this._resetTimer();
  }

  /**
   * 喂食一个转录事件 — 重置计时器
   * @param {object} [event] STT 事件对象（可选，用于记录时间戳）
   */
  feed() {
    if (!this._active || this._triggered) return;
    this._lastFeedTs = Date.now();
    this._resetTimer();
  }

  /**
   * 检查看门狗是否已被触发（即是否已超时）
   * @returns {boolean}
   */
  triggered() {
    return this._triggered;
  }

  /**
   * 停止监控并清理计时器
   */
  stop() {
    this._active = false;
    this._clearTimer();
    this._onTimeout = null;
  }

  _resetTimer() {
    this._clearTimer();
    this._timer = setTimeout(() => {
      if (!this._active || this._triggered) return;
      this._triggered = true;
      this._active = false;
      try {
        if (typeof this._onTimeout === 'function') {
          this._onTimeout();
        }
      } catch (_) { console.warn('NoSpeechWatchdog 超时回调执行失败:', _) }
    }, this._timeoutMs);
  }

  _clearTimer() {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
}

module.exports = {
  BoundedBacklog,
  NoSpeechWatchdog,
  computeRms,
};
