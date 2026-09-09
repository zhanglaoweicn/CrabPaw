const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const TRAJECTORY_DIR = path.join(DATA_DIR, 'trajectories');

// 大小上限轮转（Eval 隔离轮 Task 4）：追加型 jsonl mtime 恒新，按 mtime 的 30 天清理
// 永远删不到它（trajectory_samples.jsonl 曾涨到 710MB）。超过上限即归档轮转。
const ROTATED_SUFFIX_RE = /\.jsonl\.rotated-\d{8}-\d{6}-\d{3}$/;
const DEFAULT_ROTATE_MAX_BYTES =
  Number(process.env.CRABPAW_TRAJECTORY_ROTATE_MAX_BYTES) || 256 * 1024 * 1024;

/** 轮转归档名时间戳：YYYYMMDD-HHMMSS-SSS（本地时间，Windows 文件名安全） */
function _rotationTimestamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
  );
}

class TrajectorySaver {
  constructor() {
    this._ensureDir();
  }

  _ensureDir() {
    if (!fs.existsSync(TRAJECTORY_DIR)) {
      fs.mkdirSync(TRAJECTORY_DIR, { recursive: true });
    }
  }

  
  // ── Real-time streaming writes (not just tail-save) ──
  
  /** Start a new trajectory session with real-time streaming */
  // eslint-disable-next-line no-unused-vars
  startSession(sessionId, metadata = {}) {
    this._ensureDir();
    const fname = "stream_" + (sessionId || Date.now()) + ".jsonl";
    const filePath = path.join(TRAJECTORY_DIR, fname);
    this._activeStreams = this._activeStreams || {};
    this._activeStreams[sessionId || "default"] = { filePath, fname, turnCount: 0, toolCallCount: 0, startedAt: Date.now() };
    console.log('[trajectory] Session started: ' + fname);
  }
  
  /** Record a single LLM message in real-time */
  recordLLMMessage(sessionId, role, content, toolCalls = []) {
    const active = (this._activeStreams || {})[sessionId || "default"];
    if (!active) return;
    const entry = { type: "llm", role, content: content?.slice(0, 4000), tool_calls_count: toolCalls.length, ts: Date.now() };
    try {
      fs.appendFileSync(path.join(TRAJECTORY_DIR, active.fname), JSON.stringify(entry) + "\n", "utf-8");
    } catch (e) { console.warn("[trajectory] Stream write failed:", e.message); }
  }
  
  /** Record a tool call event in real-time */
  recordToolCall(sessionId, toolName, params, result, elapsed) {
    const active = (this._activeStreams || {})[sessionId || "default"];
    if (!active) return;
    active.toolCallCount++;
    const entry = {
      type: "tool",
      tool: toolName,
      params_keys: Object.keys(params || {}),
      success: result?.success !== false,
      elapsed,
      ts: Date.now(),
    };
    try {
      fs.appendFileSync(path.join(TRAJECTORY_DIR, active.fname), JSON.stringify(entry) + "\n", "utf-8");
    } catch (e) { console.warn("[trajectory] Tool stream write failed:", e.message); }
  }
  
  /** Record a system event in real-time */
  recordEvent(sessionId, event) {
    const active = (this._activeStreams || {})[sessionId || "default"];
    if (!active) return;
    const entry = { type: "event", ...event, ts: Date.now() };
    try {
      fs.appendFileSync(path.join(TRAJECTORY_DIR, active.fname), JSON.stringify(entry) + "\n", "utf-8");
    } catch (e) { console.warn("[trajectory] Event stream write failed:", e.message); }
  }
  
  /** End session and finalize trajectory */
  endSession(sessionId, summary = {}) {
    const key = sessionId || "default";
    const active = (this._activeStreams || {})[key];
    if (!active) return;
    const entry = {
      type: "session_end",
      turnCount: active.turnCount,
      toolCallCount: active.toolCallCount,
      duration: Date.now() - active.startedAt,
      ...summary,
      ts: Date.now(),
    };
    try {
      fs.appendFileSync(path.join(TRAJECTORY_DIR, active.fname), JSON.stringify(entry) + "\n", "utf-8");
    } catch (e) { console.warn("[trajectory] End write failed:", e.message); }
    delete (this._activeStreams || {})[key];
    console.log('[trajectory] Session ended: ' + active.fname);
  }
  save(trajectory, model, completed = true, filename = null) {
    this._ensureDir();

    const entry = {
      conversations: trajectory,
      timestamp: new Date().toISOString(),
      model,
      completed,
      turnCount: trajectory.filter(m => m.role === 'user').length,
      toolCallCount: trajectory.filter(m => m.role === 'assistant' && m.tool_calls?.length > 0).length,
    };

    const fname = filename || (completed ? 'trajectory_samples.jsonl' : 'failed_trajectories.jsonl');
    const filePath = path.join(TRAJECTORY_DIR, fname);

    try {
      const line = JSON.stringify(entry, null, 0) + '\n';
      fs.appendFileSync(filePath, line, 'utf-8');
      console.log(`📊 会话轨迹已保- ? ${fname} (${entry.turnCount} - ? ${entry.toolCallCount} 次工具调用?`);
      return true;
    } catch (e) {
      console.warn('保存会话轨迹失败:', e.message);
      return false;
    }
  }

  list(limit = 20) {
    this._ensureDir();
    const results = [];

    try {
      // 轮转归档不进列表（仅待 30 天清理，非活跃数据）
      const files = fs.readdirSync(TRAJECTORY_DIR)
        .filter(f => f.endsWith('.jsonl') && !ROTATED_SUFFIX_RE.test(f));
      for (const f of files) {
        try {
          const stat = fs.statSync(path.join(TRAJECTORY_DIR, f));
          results.push({
            filename: f,
            size: stat.size,
            modified: stat.mtime.toISOString(),
          });
        } catch { console.warn('[trajectory] silent catch, error swallowed'); }
      }
    } catch { console.warn('[trajectory] silent catch, error swallowed'); }

    return results.sort((a, b) => new Date(b.modified) - new Date(a.modified)).slice(0, limit);
  }

  read(filename, limit = 50) {
    const filePath = path.join(TRAJECTORY_DIR, filename);
    if (!fs.existsSync(filePath)) return [];

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return content.trim().split('\n').slice(-limit).map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
    } catch {
      return [];
    }
  }

  getStats() {
    this._ensureDir();
    let totalEntries = 0;
    let totalSize = 0;

    try {
      // 轮转归档不计入统计（getStats 逐文件全量读——归档可达数百 MB，必须跳过）
      const files = fs.readdirSync(TRAJECTORY_DIR)
        .filter(f => f.endsWith('.jsonl') && !ROTATED_SUFFIX_RE.test(f));
      for (const f of files) {
        try {
          const stat = fs.statSync(path.join(TRAJECTORY_DIR, f));
          totalSize += stat.size;
          const content = fs.readFileSync(path.join(TRAJECTORY_DIR, f), 'utf-8');
          totalEntries += content.trim().split('\n').filter(l => l.trim()).length;
        } catch { console.warn('[trajectory] silent catch, error swallowed'); }
      }
    } catch { console.warn('[trajectory] silent catch, error swallowed'); }

    return { totalEntries, totalSize, totalFiles: totalSize > 0 ? 1 : 0 };
  }

  /**
   * 大小上限轮转：超限的追加型 jsonl 归档为 `<原名>.jsonl.rotated-<时间戳>`，
   * 原文件重建为空（写入是 per-call appendFileSync，无常开句柄，续写无缝）。
   * 归档 mtime 置为归档时刻 → 30 天后随既有按 mtime 清理删除。
   */
  _rotateFile(f) {
    const src = path.join(TRAJECTORY_DIR, f);
    let ts = _rotationTimestamp();
    let dest = path.join(TRAJECTORY_DIR, `${f}.rotated-${ts}`);
    while (fs.existsSync(dest)) {
      // 同毫秒撞名：时间戳 +1ms 让步（保持归档名格式可被清理正则识别）
      ts = _rotationTimestamp(new Date(Date.now() + 1));
      dest = path.join(TRAJECTORY_DIR, `${f}.rotated-${ts}`);
    }

    try {
      fs.renameSync(src, dest);
    } catch (e) {
      // Windows 下 rename 打开中的文件会失败 → 兜底：复制归档 + 原文件原地截断
      console.warn('[trajectory] rename 轮转失败，降级 copy+truncate:', e.message);
      fs.copyFileSync(src, dest);
    }
    fs.writeFileSync(src, '');

    const now = new Date();
    fs.utimesSync(dest, now, now);

    console.log(`🔁 轨迹大文件已轮转: ${f} → ${path.basename(dest)}`);
    return dest;
  }

  /**
   * @param {number} [maxAgeDays=30] 按 mtime 保留天数（含轮转归档）
   * @param {object} [opts]
   * @param {number} [opts.maxSizeBytes] 单文件轮转上限（默认 256MB，可由
   *   CRABPAW_TRAJECTORY_ROTATE_MAX_BYTES 环境变量配置）
   * @returns {{ removed: number, rotated: number }}
   */
  cleanup(maxAgeDays = 30, { maxSizeBytes } = {}) {
    this._ensureDir();
    const limit =
      Number.isFinite(maxSizeBytes) && maxSizeBytes > 0
        ? maxSizeBytes
        : DEFAULT_ROTATE_MAX_BYTES;
    const now = Date.now();
    const maxAge = maxAgeDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    let rotated = 0;

    try {
      const files = fs
        .readdirSync(TRAJECTORY_DIR)
        .filter((f) => f.endsWith('.jsonl') || ROTATED_SUFFIX_RE.test(f));

      // 阶段 1: 超上限轮转（跳过轮转归档自身，避免二次轮转）
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        try {
          const stat = fs.statSync(path.join(TRAJECTORY_DIR, f));
          if (stat.size > limit) {
            this._rotateFile(f);
            rotated++;
          }
        } catch (e) { console.warn('[trajectory] rotate stat failed:', e.message); }
      }

      // 阶段 2: 按 mtime 删除过期文件（轮转归档同受管辖）
      for (const f of files) {
        try {
          const stat = fs.statSync(path.join(TRAJECTORY_DIR, f));
          if (now - stat.mtimeMs > maxAge) {
            fs.unlinkSync(path.join(TRAJECTORY_DIR, f));
            removed++;
          }
        } catch (e) { console.warn('[trajectory] cleanup stat failed:', e.message); }
      }
    } catch (e) { console.warn('[trajectory] cleanup readdir failed:', e.message); }

    if (removed > 0) {
      console.log(`🧹 已清理 ${removed} 个过期轨迹文件`);
    }
    if (rotated > 0) {
      console.log(`🔁 已轮转 ${rotated} 个超限轨迹文件 (上限 ${limit} bytes)`);
    }
    return { removed, rotated };
  }
}

const globalTrajectorySaver = new TrajectorySaver();

/**
 * 轨迹保留调度（死代码收口轮 Task 1）：cleanup(maxAgeDays) 此前定义后全仓零调用，
 * 审计 JSONL 无限增长。本函数将真实清理挂到周期定时器上，返回可停句柄。
 *
 * @param {object} [opts]
 * @param {number} [opts.intervalMs=86400000] 清理周期（默认 24h）
 * @param {number} [opts.maxAgeDays=30] 保留天数（透传 cleanup 本体，签名不变）
 * @param {Function} [opts._exec] 可选注入执行体（仅测试用；默认走真实清理）
 * @returns {{ stop: () => void }} 调度句柄
 */
function scheduleTrajectoryCleanup({ intervalMs = 24 * 60 * 60 * 1000, maxAgeDays = 30, _exec = null } = {}) {
  const exec = typeof _exec === 'function' ? _exec : () => globalTrajectorySaver.cleanup(maxAgeDays);
  let timer = setInterval(() => {
    try {
      exec();
    } catch (e) {
      console.warn('[trajectory] scheduled cleanup failed:', e && e.message);
    }
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

module.exports = { TrajectorySaver, globalTrajectorySaver, TRAJECTORY_DIR, scheduleTrajectoryCleanup };
