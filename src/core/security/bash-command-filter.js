/**
 * Bash Command Security Filter - Bash 命令安全过滤
 *
 * 防止通过 Bash 工具执行危险命令：
 * - 阻止破坏性命令（rm -rf /, format, del /s 等）
 * - 阻止命令注入（curl | bash, wget | sh 等）
 * - 阻止权限提升（sudo, su, runas 等）
 * - 阻止敏感信息访问（cat /etc/passwd 等）
 * - 阻止网络后门（nc -l, python -m http.server 等）
 */


const { getThreatPatternLoader } = require('./threat-pattern-loader');

// 内置硬编码模式（作为 JSON 配置加载失败时的回退）
const BLOCKED_PATTERNS = [
  // 破坏性删除
  { pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?\/\s*$/m, reason: '禁止删除根目录', severity: 'critical' },
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\s*$/m, reason: '禁止删除根目录', severity: 'critical' },
  { pattern: /\brm\s+-rf\s+\/[a-zA-Z]/m, reason: '禁止递归强制删除系统目录', severity: 'critical' },
  { pattern: /\bdel\s+\/[sfq]\s+[Cc]:\\/im, reason: '禁止 Windows 强制删除', severity: 'critical' },
  { pattern: /\bformat\s+[a-zA-Z]:/im, reason: '禁止格式化磁盘', severity: 'critical' },
  { pattern: /\brd\s+\/[sfq]/im, reason: '禁止 Windows 递归删除目录', severity: 'critical' },
  { pattern: /\bRemove-Item\s+.*-Recurse.*-Force.*[Cc]:\\/im, reason: '禁止 PowerShell 递归强制删除', severity: 'critical' },

  // 命令注入（远程代码执行）
  { pattern: /\bcurl\s+.*\|\s*(bash|sh|zsh|fish)/m, reason: '禁止远程脚本执行（curl | bash）', severity: 'critical' },
  { pattern: /\bwget\s+.*\|\s*(bash|sh|zsh|fish)/m, reason: '禁止远程脚本执行（wget | bash）', severity: 'critical' },
  { pattern: /\bcurl\s+.*\|\s*python/m, reason: '禁止远程脚本执行（curl | python）', severity: 'critical' },
  { pattern: /\bwget\s+.*-O\s+.*\|\s*(bash|sh)/m, reason: '禁止远程脚本执行', severity: 'critical' },

  // 权限提升
  { pattern: /\bsudo\s+/m, reason: '禁止 sudo 权限提升', severity: 'high' },
  { pattern: /\bsu\s+/m, reason: '禁止 su 切换用户', severity: 'high' },
  { pattern: /\brunas\s+/im, reason: '禁止 Windows runas 提权', severity: 'high' },
  { pattern: /\bStart-Process\s+.*-Verb\s+RunAs/im, reason: '禁止 PowerShell 管理员提权', severity: 'high' },

  // 网络后门
  { pattern: /\bnc\s+.*-[lLe]/m, reason: '禁止 netcat 监听模式（可能创建后门）', severity: 'high' },
  { pattern: /\bncat\s+.*-[lLe]/m, reason: '禁止 ncat 监听模式', severity: 'high' },
  { pattern: /\bpython[23]?\s+-m\s+http\.server/m, reason: '禁止启动 HTTP 服务器', severity: 'medium' },
  { pattern: /\bpython[23]?\s+-m\s+SimpleHTTPServer/m, reason: '禁止启动 HTTP 服务器', severity: 'medium' },
  { pattern: /\bruby\s+-run\s+-e/m, reason: '禁止 Ruby HTTP 服务器', severity: 'medium' },
  { pattern: /\bphp\s+-S\s+/m, reason: '禁止 PHP 内置服务器', severity: 'medium' },

  // 敏感文件访问
  { pattern: /\/etc\/(passwd|shadow|sudoers)/m, reason: '禁止访问系统敏感文件', severity: 'high' },
  { pattern: /~\/\.ssh\//m, reason: '禁止访问 SSH 密钥目录', severity: 'high' },
  { pattern: /~\/\.gnupg\//m, reason: '禁止访问 GPG 密钥目录', severity: 'high' },
  { pattern: /\bcat\s+.*\/\.env\b/m, reason: '禁止读取 .env 文件', severity: 'medium' },

  // 系统服务操控
  { pattern: /\bsystemctl\s+(stop|disable|mask)\s+/m, reason: '禁止停止/禁用系统服务', severity: 'high' },
  { pattern: /\bservice\s+\w+\s+stop/m, reason: '禁止停止系统服务', severity: 'high' },
  { pattern: /\bnet\s+(stop|start)\s+/im, reason: '禁止操控 Windows 服务', severity: 'high' },
  { pattern: /\bshutdown\b/m, reason: '禁止关机命令', severity: 'critical' },
  { pattern: /\breboot\b/m, reason: '禁止重启命令', severity: 'critical' },

  // 内核模块
  { pattern: /\bmodprobe\b/m, reason: '禁止加载内核模块', severity: 'high' },
  { pattern: /\binsmod\b/m, reason: '禁止插入内核模块', severity: 'high' },
  { pattern: /\brmmod\b/m, reason: '禁止移除内核模块', severity: 'high' },

  // 磁盘操作
  { pattern: /\bdd\s+.*of=\/dev\//m, reason: '禁止直接写入块设备', severity: 'critical' },
  { pattern: /\bmkfs\./m, reason: '禁止格式化文件系统', severity: 'critical' },
  { pattern: /\bfdisk\b/m, reason: '禁止磁盘分区操作', severity: 'critical' },

  // 定时任务后门
  { pattern: /\bcrontab\s+/m, reason: '禁止修改 crontab（可能植入后门）', severity: 'medium' },
  { pattern: /\bschtasks\s+.*\/create/im, reason: '禁止创建 Windows 计划任务', severity: 'medium' },
];

// 需要警告但允许执行的命令模式
const WARN_PATTERNS = [
  { pattern: /\bgit\s+push\s+--force/m, reason: '强制推送可能覆盖远程提交', severity: 'medium' },
  { pattern: /\bgit\s+reset\s+--hard/m, reason: '硬重置会丢失未提交的更改', severity: 'medium' },
  { pattern: /\bgit\s+clean\s+-[fd]/m, reason: '清理会删除未跟踪的文件', severity: 'medium' },
  { pattern: /\bnpm\s+publish/m, reason: '发布到 npm 仓库', severity: 'medium' },
  { pattern: /\bdocker\s+(rm|rmi)\s+/m, reason: '删除 Docker 容器/镜像', severity: 'low' },
  { pattern: /\bkill\s+-9/m, reason: '强制终止进程', severity: 'low' },
];

class BashCommandFilter {
  constructor(config = {}) {
    this._config = {
      enabled: config.enabled !== false,
      blockLevel: config.blockLevel || 'critical',  // critical, high, medium, low
      ...config,
    };

    // 尝试从 JSON 配置热加载模式，失败则回退到内置硬编码
    this._loadPatterns();
  }

  /**
   * 加载威胁模式（支持热更新）
   */
  _loadPatterns() {
    const loader = getThreatPatternLoader();
    const compiled = loader.load('bash-threats.json', null);

    if (compiled && compiled.blockedPatterns) {
      this._blockedPatterns = compiled.blockedPatterns;
      this._warnPatterns = compiled.warnPatterns || WARN_PATTERNS;

      // 只注册一次热更新回调，避免重复注册导致无限循环
      if (!this._patternChangeListenerRegistered) {
        this._patternChangeListenerRegistered = true;
        loader.onPatternChange('bash-threats.json', () => {
          this._loadPatterns();
          console.log('[BashCommandFilter] 威胁模式已热更新');
        });
      }
    } else {
      // 回退到内置模式
      this._blockedPatterns = BLOCKED_PATTERNS;
      this._warnPatterns = WARN_PATTERNS;
    }
  }

  /**
   * 检查命令是否安全
   * @param {string} command - 要执行的命令
   * @returns {{ safe: boolean, blocked: boolean, warnings: string[], reason: string|null }}
   */
  check(command) {
    if (!this._config.enabled) {
      return { safe: true, blocked: false, warnings: [], reason: null };
    }

    if (!command || typeof command !== 'string') {
      return { safe: true, blocked: false, warnings: [], reason: null };
    }

    const warnings = [];
    let blocked = false;
    let blockReason = null;

    // 检查禁止模式
    for (const rule of this._blockedPatterns) {
      if (rule.pattern.test(command)) {
        if (this._shouldBlock(rule.severity)) {
          blocked = true;
          blockReason = rule.reason;
          break;
        } else {
          warnings.push(rule.reason);
        }
      }
    }

    // 检查警告模式
    if (!blocked) {
      for (const rule of this._warnPatterns) {
        if (rule.pattern.test(command)) {
          warnings.push(rule.reason);
        }
      }
    }

    return {
      safe: !blocked,
      blocked,
      warnings,
      reason: blockReason,
    };
  }

  _shouldBlock(severity) {
    const levels = { critical: 4, high: 3, medium: 2, low: 1 };
    const threshold = levels[this._config.blockLevel] || 4;
    const ruleLevel = levels[severity] || 0;
    return ruleLevel >= threshold;
  }

  /**
   * 过滤命令（移除危险部分或替换为安全替代）
   * 仅用于非关键场景，关键场景应直接拒绝
   */
  sanitize(command) {
    let sanitized = command;

    // 移除 sudo 前缀（降级执行）
    sanitized = sanitized.replace(/\bsudo\s+/g, '');

    return sanitized;
  }
}

// 单例
let _filter = null;

function getBashCommandFilter(config) {
  if (!_filter) {
    _filter = new BashCommandFilter(config);
  }
  return _filter;
}

module.exports = {
  BashCommandFilter,
  getBashCommandFilter,
  BLOCKED_PATTERNS,
  WARN_PATTERNS,
};
