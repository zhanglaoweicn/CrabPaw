/**
 * 结构化日志桥接模块
 *
 * 将全局 console.log/warn/error/info/debug 重定向到 Logger，
 * 实现零改动渐进式迁移。
 *
 * 用法：
 *   // 在应用入口最早位置调用
 *   require('./console-bridge').install();
 *
 * 迁移完成后，各模块可直接用 getLogger('module') 获取子日志器。
 */

const { getLogger } = require('./logger');

const _originals = {
  log: console.log,
  warn: console.warn,
  error: console.error,
  info: console.info,
  debug: console.debug,
};

let _installed = false;
let _reentrant = false; // 重入保护，防止 Logger → console → Logger 死循环

// 映射表：console 方法 → Logger 方法
const METHOD_MAP = {
  log: 'info',
  warn: 'warn',
  error: 'error',
  info: 'info',
  debug: 'debug',
};

/**
 * 安装全局 console 桥接
 * @param {object} options
 * @param {string} [options.prefix] - 日志前缀，默认 'App'
 * @param {boolean} [options.keepOriginal] - 是否同时输出到原始 console，默认 true
 * @param {string[]} [options.excludePatterns] - 排除匹配的消息模式（正则字符串）
 */
function install(options = {}) {
  if (_installed) return;

  const {
    prefix = 'App',
    keepOriginal = true,
    excludePatterns = [],
  } = options;

  const logger = getLogger(prefix);
  const excludeRegexes = excludePatterns.map(p => new RegExp(p));

  function _shouldExclude(args) {
    if (excludeRegexes.length === 0) return false;
    const msg = args.map(a => typeof a === 'string' ? a : '').join(' ');
    return excludeRegexes.some(re => re.test(msg));
  }

  function _makeBridge(method) {
    const loggerMethod = METHOD_MAP[method];
    return function (...args) {
      // 重入保护：Logger 内部调用 console 时直接走原始路径
      if (_reentrant) {
        try { _originals[method].apply(console, args); } catch (_) {
          /* 静默忽略 EPIPE 等写入错误 */
          console.warn('[console-bridge.js] 空 catch 补日志:', _ && _.message);
        }

        return;
      }

      // 排除特定模式（如进度条、交互式提示等）
      if (_shouldExclude(args)) {
          try { _originals[method].apply(console, args); } catch (_) {
            /* 静默忽略写入错误 */
            console.warn('[console-bridge.js] 空 catch 补日志:', _ && _.message);
          }

        return;
      }

      // 提取结构化元数据
      const { message, meta } = _parseArgs(args);

      // 写入结构化日志（设置重入标记防止死循环）
      _reentrant = true;
      try {
        logger[loggerMethod](message, meta);
      } finally {
        _reentrant = false;
      }

      // 可选：同时输出到原始 console（保持终端可见性）
      if (keepOriginal) {
        try { _originals[method].apply(console, args); } catch (_) {
          /* 静默忽略 EPIPE 等写入错误 */
          console.warn('[console-bridge.js] 空 catch 补日志:', _ && _.message);
        }

      }
    };
  }

  // 替换全局 console 方法
  for (const method of Object.keys(METHOD_MAP)) {
    console[method] = _makeBridge(method);
  }

  _installed = true;
}

/**
 * 卸载桥接，恢复原始 console
 */
function uninstall() {
  if (!_installed) return;

  for (const method of Object.keys(_originals)) {
    console[method] = _originals[method];
  }

  _installed = false;
}

/**
 * 解析 console 参数为 message + meta
 *
 * 约定：
 *   - 纯字符串参数 → message
 *   - 最后一个 object 参数 → meta
 *   - Error 对象 → meta.error
 */
function _parseArgs(args) {
  if (args.length === 0) return { message: '', meta: {} };

  // 检查最后一个参数是否为普通对象（作为 meta）
  const last = args[args.length - 1];
  if (args.length > 1 && last && typeof last === 'object' && !Array.isArray(last) && !(last instanceof Error)) {
    const messageParts = args.slice(0, -1);
    return {
      message: messageParts.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '),
      meta: last,
    };
  }

  // 检查是否包含 Error 对象
  const errorArg = args.find(a => a instanceof Error);
  const messageParts = args.map(a => {
    if (a instanceof Error) return a.message;
    if (typeof a === 'string') return a;
    return JSON.stringify(a);
  });

  return {
    message: messageParts.join(' '),
    meta: errorArg ? { error: errorArg.message, stack: errorArg.stack } : {},
  };
}

/**
 * 检查桥接是否已安装
 */
function isInstalled() {
  return _installed;
}

module.exports = {
  install,
  uninstall,
  isInstalled,
};
