const fs = require('fs');
const path = require('path');
const { SKILLS_DIR, GLOBAL_SKILLS_DIR } = require('./config');

const RELOAD_DEBOUNCE_MS = 500;

class SkillHotReloader {
  constructor(options = {}) {
    this.skillsDir = options.skillsDir || SKILLS_DIR;
    this.globalSkillsDir = options.globalSkillsDir || GLOBAL_SKILLS_DIR;
    this.watchers = [];
    this.reloadCallbacks = [];
    this._coalesceTimer = null;
    this.enabled = options.enabled !== false;
    this.lastReloadTime = 0;
  }

  start() {
    if (!this.enabled) {
      console.log('⏸️ 技能热重载已禁用');
      return;
    }

    console.log('🔄 启动技能热重载监控...');

    this._watchDirectory(this.skillsDir, 'builtin');
    this._watchDirectory(this.globalSkillsDir, 'global');

    console.log('✅ 技能热重载监控已启动');
  }

  stop() {
    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch (e) {

        // Ignore close errors

        console.warn('[skill-hot-reload.js] 空 catch 补日志:', e && e.message);
      }

    }
    this.watchers = [];
    console.log('⏹️ 技能热重载监控已停止');
  }

  _watchDirectory(dir, source) {
    if (!fs.existsSync(dir)) {
      return;
    }

    const watcher = fs.watch(dir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;

      if (filename.includes('node_modules') ||
          filename.includes('.git') ||
          filename.includes('.drafts') ||
          /(^|[\\/])\./.test(filename) ||
          filename.toLowerCase().includes('testdraft') ||
          !filename.endsWith('.md') && !filename.endsWith('.json') && !filename.endsWith('.js')) {
        return;
      }

      this._scheduleReload(filename, source);
    });

    watcher.on('error', (err) => {
      console.error(`❌ 技能目录监控错误 [${source}]:`, err.message);
    });

    this.watchers.push(watcher);
  }

  _scheduleReload(filename, source) {
    // 2026-08-18: 合并防抖——窗口内多次变更(如 SKILL.md+executor.js 连续写入)只触发一次
    // reload。此前按 (source,filename) 各自起定时器 + lastReloadTime 跳过:
    // 窗口内的第二次事件被丢弃而不重新排队,后写入的文件可能不被加载。
    if (this._coalesceTimer) {
      clearTimeout(this._coalesceTimer);
    }
    this._coalesceTimer = setTimeout(() => {
      this._coalesceTimer = null;
      this._triggerReload(filename, source);
    }, RELOAD_DEBOUNCE_MS);
  }

  _triggerReload(filename, source) {
    this.lastReloadTime = Date.now();

    const skillName = this._extractSkillName(filename);
    console.log(`🔄 检测到技能变更: ${skillName} (${source})`);

    for (const callback of this.reloadCallbacks) {
      try {
        callback({
          type: 'reload',
          skillName,
          source,
          filename,
          timestamp: new Date().toISOString()
        });
      } catch (e) {
        console.error('❌ 热重载回调执行失败:', e.message);
      }
    }
  }

  _extractSkillName(filename) {
    const parts = filename.split(path.sep);
    if (parts.length >= 1) {
      return parts[0];
    }
    return filename;
  }

  onReload(callback) {
    if (typeof callback === 'function') {
      this.reloadCallbacks.push(callback);
    }
    return () => {
      const index = this.reloadCallbacks.indexOf(callback);
      if (index >= 0) {
        this.reloadCallbacks.splice(index, 1);
      }
    };
  }

  forceReload(skillName) {
    console.log(`🔄 强制重载技能: ${skillName}`);
    
    for (const callback of this.reloadCallbacks) {
      try {
        callback({
          type: 'force_reload',
          skillName,
          source: 'manual',
          timestamp: new Date().toISOString()
        });
      } catch (e) {
        console.error('❌ 强制重载回调执行失败:', e.message);
      }
    }
  }

  reloadAll() {
    console.log('🔄 重载所有技能...');
    
    for (const callback of this.reloadCallbacks) {
      try {
        callback({
          type: 'reload_all',
          source: 'manual',
          timestamp: new Date().toISOString()
        });
      } catch (e) {
        console.error('❌ 全量重载回调执行失败:', e.message);
      }
    }
  }

  getStatus() {
    return {
      enabled: this.enabled,
      watching: this.watchers.length > 0,
      watcherCount: this.watchers.length,
      callbackCount: this.reloadCallbacks.length,
      lastReloadTime: this.lastReloadTime ? new Date(this.lastReloadTime).toISOString() : null
    };
  }
}

let _instance = null;

function getHotReloader(options) {
  if (!_instance) {
    _instance = new SkillHotReloader(options);
  }
  return _instance;
}

module.exports = {
  SkillHotReloader,
  getHotReloader
};
