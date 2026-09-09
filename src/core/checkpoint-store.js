/**
 * CheckpointStore -- 长任务断点持久化
 *
 * 7x24 一体机面对 Windows Update 强制重启：进行中的工作流/后台任务必须有断点。
 * 原子写（tmp + rename）+ 损坏降级（loadCheckpoint 返回 null 不抛）。
 */

const fs = require('fs');
const path = require('path');

class CheckpointStore {
  constructor({ dir }) {
    this._dir = dir;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { console.error('[checkpoint] 目录创建失败:', e.message || e); }
  }

  _file(key) {
    const safe = String(key).replace(/[^\w一-鿿-]/g, '_');
    return path.join(this._dir, `${safe}.json`);
  }

  saveCheckpoint(key, data) {
    try {
      const file = this._file(key);
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
      fs.renameSync(tmp, file); // 原子替换
      return true;
    } catch (e) {
      console.error('[checkpoint] 保存失败:', e.message || e);
      return false;
    }
  }

  loadCheckpoint(key) {
    try {
      const file = this._file(key);
      if (!fs.existsSync(file)) return null;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      return raw && typeof raw === 'object' ? raw : null;
    } catch (e) {
      console.warn('[checkpoint] 读取失败（降级 null）:', e.message || e);
      return null;
    }
  }

  deleteCheckpoint(key) {
    try {
      const file = this._file(key);
      if (!fs.existsSync(file)) return false;
      fs.unlinkSync(file);
      return true;
    } catch (e) {
      console.error('[checkpoint] 删除失败:', e.message || e);
      return false;
    }
  }

  listCheckpoints(prefix = '') {
    try {
      if (!fs.existsSync(this._dir)) return [];
      return fs.readdirSync(this._dir)
        .filter((f) => f.endsWith('.json') && !f.endsWith('.tmp.json'))
        .map((f) => f.slice(0, -5))
        .filter((k) => k.startsWith(prefix));
    } catch (e) {
      console.error('[checkpoint] 列表失败:', e.message || e);
      return [];
    }
  }
}

module.exports = { CheckpointStore };
