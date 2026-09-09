/**
 * DangerousPatterns - 危险命令模式检测
 * 
 * 检测 Shell 命令、SQL 语句、文件操作中的危险模式
 */

const SEVERITY_LEVELS = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low'
};

const DANGEROUS_PATTERNS = [
  {
    category: 'recursive_delete',
    severity: SEVERITY_LEVELS.CRITICAL,
    patterns: [
      { regex: /rm\s+(-[rf]+\s+|--)\/\s*/gi, description: '删除根目录' },
      { regex: /rm\s+(-[rf]+\s+|--)~\s*/gi, description: '删除用户目录' },
      { regex: /rm\s+(-[rf]+\s+|--recursive).*\*/gi, description: '递归删除通配符' },
      { regex: /rm\s+-[rf]+\s+\/(etc|usr|var|home|root)/gi, description: '删除系统目录' },
      { regex: /rd\s+\/[sq]\s+[a-z]:\\/gi, description: 'Windows 强制删除目录' },
      { regex: /del\s+\/[sq]\s+/gi, description: 'Windows 强制删除文件' }
    ]
  },
  
  {
    category: 'disk_operations',
    severity: SEVERITY_LEVELS.CRITICAL,
    patterns: [
      { regex: /mkfs\.[a-z]+\s+/gi, description: '格式化文件系统' },
      { regex: /dd\s+if=.*of=\/dev\//gi, description: '磁盘镜像写入' },
      { regex: /dd\s+.*of=\/dev\/[sh]d/gi, description: '写入块设备' },
      { regex: /format\s+[a-z]:/gi, description: '格式化驱动器' }
    ]
  },
  
  {
    category: 'permission_change',
    severity: SEVERITY_LEVELS.HIGH,
    patterns: [
      { regex: /chmod\s+(-R\s+)?[0-7]*777/gi, description: '设置完全开放权限' },
      { regex: /chmod\s+.*o\+w/gi, description: '添加其他用户写权限' },
      { regex: /chmod\s+.*a\+w/gi, description: '添加所有用户写权限' },
      { regex: /chown\s+(-R\s+)?root\s+/gi, description: '更改所有者为 root' },
      { regex: /icacls\s+.*\/grant\s+everyone/gi, description: 'Windows 授予所有人权限' }
    ]
  },
  
  {
    category: 'system_config',
    severity: SEVERITY_LEVELS.HIGH,
    patterns: [
      { regex: />\s*\/etc\//gi, description: '覆盖系统配置文件' },
      { regex: />\s*~\/\.ssh\//gi, description: '覆盖 SSH 配置' },
      { regex: /tee\s+.*\/etc\//gi, description: '写入系统配置' },
      { regex: /sed\s+(-i|--in-place).*\/etc\//gi, description: '修改系统配置' },
      { regex: /systemctl\s+(stop|disable|mask)\s+/gi, description: '停止/禁用系统服务' },
      { regex: /reg\s+add\s+/gi, description: '修改 Windows 注册表' }
    ]
  },
  
  {
    category: 'sql_dangerous',
    severity: SEVERITY_LEVELS.HIGH,
    patterns: [
      { regex: /DROP\s+(TABLE|DATABASE|SCHEMA)/gi, description: 'SQL DROP 语句' },
      { regex: /TRUNCATE\s+TABLE/gi, description: 'SQL TRUNCATE 语句' },
      { regex: /DELETE\s+FROM/gi, description: 'SQL DELETE 语句' },
      { regex: /GRANT\s+ALL/gi, description: 'SQL 授予所有权限' }
    ]
  },
  
  {
    category: 'remote_execution',
    severity: SEVERITY_LEVELS.HIGH,
    patterns: [
      { regex: /curl\s+.*\|\s*(bash|sh|zsh)/gi, description: '远程脚本执行' },
      { regex: /wget\s+.*\|\s*(bash|sh|zsh)/gi, description: '远程脚本执行' },
      { regex: /bash\s+<\s*\(curl/gi, description: '进程替换执行远程脚本' },
      { regex: /sh\s+<\s*\(wget/gi, description: '进程替换执行远程脚本' },
      { regex: /curl\s+.*>\s*\/dev\/null.*\|/gi, description: '隐藏输出的管道执行' }
    ]
  },
  
  {
    category: 'process_kill',
    severity: SEVERITY_LEVELS.MEDIUM,
    patterns: [
      { regex: /kill\s+-9\s+-1/gi, description: '杀死所有进程' },
      { regex: /kill\s+-9\s+1/gi, description: '杀死 init 进程' },
      { regex: /pkill\s+-9/gi, description: '强制杀死进程组' },
      { regex: /killall\s+-9/gi, description: '强制杀死所有同名进程' },
      { regex: /taskkill\s+\/f\s+\/im/gi, description: 'Windows 强制结束进程' }
    ]
  },
  
  {
    category: 'shell_execution',
    severity: SEVERITY_LEVELS.MEDIUM,
    patterns: [
      { regex: /bash\s+-c\s+/gi, description: '通过 -c 执行命令' },
      { regex: /sh\s+-c\s+/gi, description: '通过 -c 执行命令' },
      { regex: /zsh\s+-c\s+/gi, description: '通过 -c 执行命令' },
      { regex: /python\s+-c\s+/gi, description: 'Python 单行执行' },
      { regex: /perl\s+-e\s+/gi, description: 'Perl 单行执行' },
      { regex: /ruby\s+-e\s+/gi, description: 'Ruby 单行执行' },
      { regex: /node\s+-e\s+/gi, description: 'Node.js 单行执行' }
    ]
  },
  
  {
    category: 'network_dangerous',
    severity: SEVERITY_LEVELS.MEDIUM,
    patterns: [
      { regex: /nc\s+.*-e\s+/gi, description: 'Netcat 反向 Shell' },
      { regex: /\/dev\/tcp\//gi, description: 'Bash 网络重定向' },
      { regex: /socat\s+.*exec:/gi, description: 'Socat 执行命令' }
    ]
  },
  
  {
    category: 'fork_bomb',
    severity: SEVERITY_LEVELS.CRITICAL,
    patterns: [
      { regex: /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/g, description: 'Fork 炸弹' },
      { regex: /\.\/\.\./g, description: '可疑的路径遍历' }
    ]
  },
  
  {
    category: 'data_exfiltration',
    severity: SEVERITY_LEVELS.HIGH,
    patterns: [
      { regex: /curl\s+.*\$(API_KEY|TOKEN|SECRET|PASSWORD)/gi, description: '泄露环境变量' },
      { regex: /wget\s+.*\$(API_KEY|TOKEN|SECRET|PASSWORD)/gi, description: '泄露环境变量' },
      { regex: /cat\s+.*\.env/gi, description: '读取环境变量文件' },
      { regex: /cat\s+.*id_rsa/gi, description: '读取 SSH 私钥' },
      { regex: /cat\s+.*\.pem/gi, description: '读取证书文件' },
      { regex: /type\s+.*\.env/gi, description: 'Windows 读取环境变量文件' }
    ]
  },
  
  {
    category: 'xargs_dangerous',
    severity: SEVERITY_LEVELS.MEDIUM,
    patterns: [
      { regex: /xargs\s+rm/gi, description: 'xargs 配合 rm' },
      { regex: /find\s+.*-exec\s+rm/gi, description: 'find 执行 rm' },
      { regex: /find\s+.*-delete/gi, description: 'find 删除文件' }
    ]
  }
];

class DangerousPatterns {
  constructor() {
    this.patterns = DANGEROUS_PATTERNS;
  }

  check(command) {
    const matches = [];
    let maxSeverity = 'low';
    
    for (const category of this.patterns) {
      for (const pattern of category.patterns) {
        const found = command.match(pattern.regex);
        if (found) {
          matches.push({
            category: category.category,
            severity: category.severity,
            description: pattern.description,
            match: found[0],
            pattern: pattern.regex.source
          });
          
          if (this._severityValue(category.severity) > this._severityValue(maxSeverity)) {
            maxSeverity = category.severity;
          }
        }
      }
    }
    
    return {
      hasMatches: matches.length > 0,
      matches,
      maxSeverity,
      summary: this._generateSummary(matches)
    };
  }

  _severityValue(severity) {
    const values = {
      [SEVERITY_LEVELS.CRITICAL]: 4,
      [SEVERITY_LEVELS.HIGH]: 3,
      [SEVERITY_LEVELS.MEDIUM]: 2,
      [SEVERITY_LEVELS.LOW]: 1
    };
    return values[severity] || 0;
  }

  _generateSummary(matches) {
    if (matches.length === 0) {
      return '未检测到危险模式';
    }
    
    const critical = matches.filter(m => m.severity === SEVERITY_LEVELS.CRITICAL);
    const high = matches.filter(m => m.severity === SEVERITY_LEVELS.HIGH);
    const medium = matches.filter(m => m.severity === SEVERITY_LEVELS.MEDIUM);
    
    const parts = [];
    if (critical.length > 0) parts.push(`严重 ${critical.length}`);
    if (high.length > 0) parts.push(`高危 ${high.length}`);
    if (medium.length > 0) parts.push(`中危 ${medium.length}`);
    
    return `检测到 ${matches.length} 个危险模式 (${parts.join(', ')})`;
  }

  addPattern(category, severity, pattern, description) {
    let cat = this.patterns.find(c => c.category === category);
    if (!cat) {
      cat = { category, severity, patterns: [] };
      this.patterns.push(cat);
    }
    cat.patterns.push({ regex: pattern, description });
  }

  getCategories() {
    return this.patterns.map(p => ({
      category: p.category,
      severity: p.severity,
      patternCount: p.patterns.length
    }));
  }
}

module.exports = DangerousPatterns;
