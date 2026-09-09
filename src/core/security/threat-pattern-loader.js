/**
 * ThreatPatternLoader - 威胁模式热加载器
 *
 * 从 JSON 配置文件加载威胁模式，支持：
 * - 启动时加载
 * - 文件变更时自动热更新（fs.watch）
 * - 回退到内置硬编码模式
 */

const fs = require('fs');
const path = require('path');

const THREAT_PATTERNS_DIR = path.join(__dirname, 'threat-patterns');

class ThreatPatternLoader {
  constructor() {
    this._cache = new Map(); // configName → { patterns, mtime }
    this._watchers = new Map(); // configName → fs.FSWatcher
    this._listeners = new Map(); // configName → Set<callback>
  }

  /**
   * 加载威胁模式（带缓存和热更新）
   * @param {string} configName - 配置文件名（不含路径）
   * @param {object} fallbackPatterns - 回退的内置模式
   * @returns {object} 解析后的模式对象
   */
  load(configName, fallbackPatterns = null) {
    const configPath = path.join(THREAT_PATTERNS_DIR, configName);

    try {
      if (!fs.existsSync(configPath)) {
        console.warn(`[ThreatPatternLoader] 配置文件不存在: ${configName}，使用内置模式`);
        return fallbackPatterns;
      }

      const stat = fs.statSync(configPath);
      const cached = this._cache.get(configName);

      // 缓存有效
      if (cached && cached.mtime === stat.mtimeMs) {
        return cached.patterns;
      }

      const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const patterns = this._compilePatterns(data);

      this._cache.set(configName, {
        patterns,
        mtime: stat.mtimeMs,
      });

      // 启动文件监听（仅首次）
      if (!this._watchers.has(configName)) {
        this._startWatching(configName);
      }

      console.log(`[ThreatPatternLoader] 已加载: ${configName} (v${data.version || 'unknown'})`);
      return patterns;
    } catch (e) {
      console.error(`[ThreatPatternLoader] 加载失败: ${configName}, ${e.message}`);
      return fallbackPatterns;
    }
  }

  /**
   * 编译 JSON 模式为可用的正则表达式对象
   */
  _compilePatterns(data) {
    const compiled = {};

    // 编译 bash 威胁模式
    if (data.blockedPatterns) {
      compiled.blockedPatterns = data.blockedPatterns.map(p => ({
        pattern: new RegExp(p.pattern, 'm'),
        reason: p.reason,
        severity: p.severity,
      }));
    }

    if (data.warnPatterns) {
      compiled.warnPatterns = data.warnPatterns.map(p => ({
        pattern: new RegExp(p.pattern, 'm'),
        reason: p.reason,
        severity: p.severity,
      }));
    }

    // 编译注入检测模式
    if (data.injectionPatterns) {
      compiled.injectionPatterns = data.injectionPatterns.map(group => ({
        category: group.category,
        severity: group.severity,
        patterns: group.patterns.map(p => ({
          regex: new RegExp(p.regex, 'gi'),
          description: p.description,
        })),
      }));
    }

    if (data.contextPatterns) {
      compiled.contextPatterns = data.contextPatterns.map(group => ({
        context: group.context,
        patterns: group.patterns.map(p => new RegExp(p, 'gi')),
      }));
    }

    compiled._meta = {
      version: data.version,
      updatedAt: data.updatedAt,
      description: data.description,
    };

    return compiled;
  }

  /**
   * 启动文件监听，实现热更新
   */
  _startWatching(configName) {
    const configPath = path.join(THREAT_PATTERNS_DIR, configName);

    try {
      let debounceTimer = null;
      const watcher = fs.watch(configPath, { persistent: false }, (eventType) => {
        if (eventType === 'change') {
          // 防抖：300ms 内只处理一次变更
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            // 清除缓存，下次 load 时重新读取
            this._cache.delete(configName);
            console.log(`[ThreatPatternLoader] 检测到变更: ${configName}，缓存已清除`);

            // 通知监听器
            const listeners = this._listeners.get(configName);
            if (listeners) {
              for (const cb of listeners) {
                try { cb(configName); } catch (e) { console.warn('[threat-pattern-loader] listener callback error:', e.message); }
              }
            }
          }, 300);
        }
      });

      this._watchers.set(configName, watcher);
    } catch (e) { console.warn('[threat-pattern-loader] file watcher setup failed, continuing:', e.message); }
  }

  /**
   * 注册模式变更回调
   */
  onPatternChange(configName, callback) {
    if (!this._listeners.has(configName)) {
      this._listeners.set(configName, new Set());
    }
    this._listeners.get(configName).add(callback);
  }

  /**
   * 停止所有监听
   */
  destroy() {
    for (const watcher of this._watchers.values()) {
      watcher.close();
    }
    this._watchers.clear();
    this._cache.clear();
    this._listeners.clear();
  }
}

// 单例
const _instance = new ThreatPatternLoader();

module.exports = {
  ThreatPatternLoader,
  getThreatPatternLoader: () => _instance,
  THREAT_PATTERNS_DIR,
};
