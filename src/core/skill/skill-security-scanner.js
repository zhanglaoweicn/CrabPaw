/**
 * Skill Security Scanner - 技能安全扫描器
 * 
 * 功能：
 * - 检测潜在安全风险
 * - 识别危险命令和操作
 * - 扫描敏感信息泄露
 * - 评估技能风险等级
 * - 提供修复建议
 */

const fs = require('fs');
const path = require('path');

const RISK_LEVELS = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  INFO: 'info',
};

const TRUST_SOURCES = {
  BUILTIN: 'builtin',
  TRUSTED_HUB: 'trusted_hub',
  COMMUNITY: 'community',
  AGENT_CREATED: 'agent_created',
};

const INSTALL_POLICY = {
  [TRUST_SOURCES.BUILTIN]:       { safe: 'allow', caution: 'allow', dangerous: 'allow' },
  [TRUST_SOURCES.TRUSTED_HUB]:   { safe: 'allow', caution: 'allow', dangerous: 'block' },
  [TRUST_SOURCES.COMMUNITY]:     { safe: 'allow', caution: 'block', dangerous: 'block' },
  [TRUST_SOURCES.AGENT_CREATED]: { safe: 'allow', caution: 'allow', dangerous: 'ask' },
};

const VERDICT_MAP = {
  [RISK_LEVELS.INFO]: 'safe',
  [RISK_LEVELS.LOW]: 'safe',
  [RISK_LEVELS.MEDIUM]: 'caution',
  [RISK_LEVELS.HIGH]: 'dangerous',
  [RISK_LEVELS.CRITICAL]: 'dangerous',
};

const RISK_PATTERNS = {
  command_injection: {
    level: RISK_LEVELS.CRITICAL,
    patterns: [
      { regex: /eval\s*\(/i, description: '使用eval可能导致代码注入' },
      { regex: /Function\s*\(/i, description: '动态函数创建可能不安全' },
      { regex: /exec\s*\(\s*['"`].*\$\{/i, description: '命令拼接可能导致注入' },
      { regex: /spawn\s*\(\s*['"`].*\$\{/i, description: 'spawn命令拼接可能不安全' },
    ],
  },
  
  file_destruction: {
    level: RISK_LEVELS.HIGH,
    patterns: [
      { regex: /rm\s+-rf\s+\//i, description: '危险：递归删除根目录' },
      { regex: /rm\s+-rf\s+~/i, description: '危险：递归删除用户目录' },
      { regex: /del\s+\/[sq]\s+/i, description: '危险：Windows强制删除' },
      { regex: /format\s+[a-z]:/i, description: '危险：格式化磁盘' },
      { regex: /shred\s+/i, description: '安全删除文件（不可恢复）' },
    ],
  },
  
  network_access: {
    level: RISK_LEVELS.MEDIUM,
    patterns: [
      { regex: /curl\s+.*\|\s*(bash|sh|zsh)/i, description: '远程脚本执行风险' },
      { regex: /wget\s+.*\|\s*(bash|sh|zsh)/i, description: '远程脚本执行风险' },
      { regex: /nc\s+.*-e/i, description: 'Netcat反向Shell' },
      { regex: /\/dev\/tcp\//i, description: 'Bash网络重定向' },
    ],
  },
  
  privilege_escalation: {
    level: RISK_LEVELS.CRITICAL,
    patterns: [
      { regex: /sudo\s+chmod\s+[0-7]*777/i, description: '危险权限设置' },
      { regex: /chmod\s+777/i, description: '开放所有权限' },
      { regex: /chown\s+.*:\s*\//i, description: '更改文件所有者' },
      { regex: /setuid/i, description: '设置setuid位' },
    ],
  },
  
  data_exfiltration: {
    level: RISK_LEVELS.HIGH,
    patterns: [
      { regex: /curl\s+.*\$\{.*KEY|TOKEN|SECRET|PASSWORD/i, description: '可能泄露敏感信息' },
      { regex: /wget\s+.*\$\{.*KEY|TOKEN|SECRET|PASSWORD/i, description: '可能泄露敏感信息' },
      { regex: /cat\s+.*\.env/i, description: '读取环境变量文件' },
      { regex: /cat\s+.*id_rsa/i, description: '读取SSH私钥' },
      { regex: /cat\s+.*\.pem/i, description: '读取证书文件' },
    ],
  },
  
  system_modification: {
    level: RISK_LEVELS.MEDIUM,
    patterns: [
      { regex: /\/etc\/passwd/i, description: '修改用户数据库' },
      { regex: /\/etc\/shadow/i, description: '修改密码数据库' },
      { regex: /\/etc\/sudoers/i, description: '修改sudo配置' },
      { regex: /reg\s+add/i, description: '修改Windows注册表' },
      { regex: /systemctl\s+(start|stop|enable|disable)/i, description: '控制系统服务' },
    ],
  },
  
  code_obfuscation: {
    level: RISK_LEVELS.MEDIUM,
    patterns: [
      { regex: /\\x[0-9a-f]{2}/i, description: '十六进制编码可能用于混淆' },
      { regex: /fromCharCode/i, description: '字符编码可能用于混淆' },
      { regex: /atob\s*\(/i, description: 'Base64解码可能隐藏恶意代码' },
      { regex: /btoa\s*\(/i, description: 'Base64编码' },
    ],
  },  
  // Imported skill specific patterns
  network_in_executor: {
    level: RISK_LEVELS.HIGH,
    patterns: [
      { regex: /\bfetch\s*\(/i, description: 'Executor code contains fetch network request' },
      { regex: /\baxios\b/i, description: 'Executor code uses axios HTTP client' },
      { regex: /\bhttp\.request\s*\(/i, description: 'Executor code uses http.request' },
      { regex: /\bhttps\.request\s*\(/i, description: 'Executor code uses https.request' },
      { regex: /\bWebSocket\b/i, description: 'Executor code creates WebSocket connections' },
      { regex: /\bnet\.connect\b/i, description: 'Executor code uses net.connect' },
    ],
  },

  filesystem_write: {
    level: RISK_LEVELS.HIGH,
    patterns: [
      { regex: /\bfs\.writeFile\b/i, description: 'Executor code writes files to disk' },
      { regex: /\bfs\.write\s*\(/i, description: 'Executor code writes to file descriptors' },
      { regex: /\bfs\.appendFile\b/i, description: 'Executor code appends to files' },
      { regex: /\bfs\.createWriteStream\b/i, description: 'Executor code creates write streams' },
      { regex: /\bfs\.rename\b/i, description: 'Executor code renames/moves files' },
      { regex: /\bfs\.unlink\b/i, description: 'Executor code deletes files' },
    ],
  },

  obfuscation_dynamic: {
    level: RISK_LEVELS.CRITICAL,
    patterns: [
      { regex: /\batob\s*\(.*\)\s*.*\bFunction\b/i, description: 'Obfuscated dynamic code execution (atob+Function)' },
      { regex: /\bbtoa\s*\(.*\)\s*.*\bFunction\b/i, description: 'Obfuscated dynamic code execution (btoa+Function)' },
      { regex: /setTimeout\s*\(\s*['"`][^'"`]*['"`]\s*\)/i, description: 'String-based setTimeout (possible eval)' },
      { regex: /setInterval\s*\(\s*['"`][^'"`]*['"`]\s*\)/i, description: 'String-based setInterval (possible eval)' },
      { regex: /\beval\s*\(.*atob/i, description: 'eval with base64 input (likely obfuscated)' },
      { regex: /\bchild_process\.exec\b/i, description: 'Executor code spawns child processes' },
      { regex: /\bchild_process\.spawn\b/i, description: 'Executor code spawns child processes' },
    ],
  },
  
  sensitive_data: {
    level: RISK_LEVELS.HIGH,
    patterns: [
      { regex: /password\s*[:=]\s*['"`][^'"`]+['"`]/i, description: '硬编码密码' },
      { regex: /api_key\s*[:=]\s*['"`][^'"`]+['"`]/i, description: '硬编码API密钥' },
      { regex: /secret\s*[:=]\s*['"`][^'"`]+['"`]/i, description: '硬编码密钥' },
      { regex: /token\s*[:=]\s*['"`][a-zA-Z0-9]{20,}['"`]/i, description: '硬编码令牌' },
    ],
  },
};

const INVISIBLE_CHARS = [
  '\u200b', '\u200c', '\u200d', '\u2060', '\ufeff',
  '\u202a', '\u202b', '\u202c', '\u202d', '\u202e',
];

class SkillSecurityScanner {
  constructor(config = {}) {
    this.config = {
      blockCritical: config.blockCritical !== false,
      blockHigh: config.blockHigh || false,
      warnMedium: config.warnMedium !== false,
      ...config,
    };
  }

  async scanContent(content) {
    const findings = [];
    
    for (const [category, config] of Object.entries(RISK_PATTERNS)) {
      for (const pattern of config.patterns) {
        const matches = content.match(pattern.regex);
        if (matches) {
          findings.push({
            category: category,
            level: config.level,
            description: pattern.description,
            match: matches[0],
            pattern: pattern.regex.source,
          });
        }
      }
    }
    
    for (const char of INVISIBLE_CHARS) {
      if (content.includes(char)) {
        findings.push({
          category: 'invisible_chars',
          level: RISK_LEVELS.HIGH,
          description: `检测到不可见字符 U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
          match: char,
          pattern: 'invisible_unicode',
        });
      }
    }
    
    const blocked = this._shouldBlock(findings);
    const critical = findings.some(f => f.level === RISK_LEVELS.CRITICAL);
    const hasRisks = findings.length > 0;
    
    return {
      findings,
      blocked,
      critical,
      hasRisks,
      riskLevel: this._calculateOverallRisk(findings),
      summary: this._generateSummary(findings),
    };
  }

  async scanSteps(steps) {
    const allFindings = [];
    
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const content = JSON.stringify(step);
      const result = await this.scanContent(content);
      
      if (result.findings.length > 0) {
        allFindings.push({
          stepIndex: i,
          stepSkill: step.skill,
          findings: result.findings,
        });
      }
    }
    
    const blocked = this._shouldBlock(allFindings.flatMap(f => f.findings));
    const critical = allFindings.some(f => f.findings.some(ff => ff.level === RISK_LEVELS.CRITICAL));
    
    return {
      findings: allFindings,
      blocked,
      critical,
      hasRisks: allFindings.length > 0,
      riskLevel: this._calculateOverallRisk(allFindings.flatMap(f => f.findings)),
    };
  }

  async scanSkill(skillDir) {
    const skillPath = path.join(skillDir, 'SKILL.md');
    
    if (!fs.existsSync(skillPath)) {
      return {
        findings: [],
        blocked: false,
        error: 'SKILL.md not found',
      };
    }
    
    const content = fs.readFileSync(skillPath, 'utf-8');
    const result = await this.scanContent(content);
    
    const scriptsDir = path.join(skillDir, 'scripts');
    if (fs.existsSync(scriptsDir)) {
      const scripts = fs.readdirSync(scriptsDir);
      for (const script of scripts) {
        const scriptPath = path.join(scriptsDir, script);
        if (fs.statSync(scriptPath).isFile()) {
          const scriptContent = fs.readFileSync(scriptPath, 'utf-8');
          const scriptResult = await this.scanContent(scriptContent);
          result.findings.push(...scriptResult.findings.map(f => ({
            ...f,
            file: `scripts/${script}`,
          })));
        }
      }
    }
    
    result.blocked = this._shouldBlock(result.findings);
    result.critical = result.findings.some(f => f.level === RISK_LEVELS.CRITICAL);
    
    return result;
  }

  /**
   * Scan imported skill with enhanced checks for network access, filesystem writes,
   * obfuscation patterns, and import isolation.
   * @param {string} skillDir
   * @returns {Promise<object>}
   */
  async scanImportedSkill(skillDir) {
    const result = await this.scanSkill(skillDir);

    const extraFindings = [];
    const scanFilesRecursive = (dir) => {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue;
          scanFilesRecursive(fullPath);
        } else if (/\.(js|mjs|ts|jsx|tsx)$/i.test(entry.name)) {
          try {
            const code = fs.readFileSync(fullPath, 'utf-8');
            for (const pattern of RISK_PATTERNS.network_in_executor.patterns) {
              if (pattern.regex.test(code)) {
                extraFindings.push({
                  level: RISK_PATTERNS.network_in_executor.level,
                  category: 'network_in_executor',
                  description: pattern.description,
                  match: code.match(pattern.regex)?.[0] || '',
                  file: path.relative(skillDir, fullPath),
                });
              }
            }
            for (const pattern of RISK_PATTERNS.filesystem_write.patterns) {
              if (pattern.regex.test(code)) {
                extraFindings.push({
                  level: RISK_PATTERNS.filesystem_write.level,
                  category: 'filesystem_write',
                  description: pattern.description,
                  match: code.match(pattern.regex)?.[0] || '',
                  file: path.relative(skillDir, fullPath),
                });
              }
            }
            for (const pattern of RISK_PATTERNS.obfuscation_dynamic.patterns) {
              if (pattern.regex.test(code)) {
                extraFindings.push({
                  level: RISK_PATTERNS.obfuscation_dynamic.level,
                  category: 'obfuscation_dynamic',
                  description: pattern.description,
                  match: code.match(pattern.regex)?.[0] || '',
                  file: path.relative(skillDir, fullPath),
                });
              }
            }
          } catch (e) { /* skip unreadable files */ }
        }
      }
    };

    scanFilesRecursive(skillDir);

    const seen = new Set();
    const uniqueExtraFindings = [];
    for (const f of extraFindings) {
      const key = `${f.category}:${f.file}`;
      if (!seen.has(key)) { seen.add(key); uniqueExtraFindings.push(f); }
    }

    result.findings = [...(result.findings || []), ...uniqueExtraFindings];
    result.blocked = this._shouldBlock(result.findings);
    result.critical = result.findings.some(f => f.level === RISK_LEVELS.CRITICAL);
    result.riskLevel = this._calculateOverallRisk(result.findings);
    result.summary = this._generateSummary(result.findings);
    result.imported = true;
    result.readOnly = true;
    result.isolationReport = {
      hasNetworkAccess: uniqueExtraFindings.some(f => f.category === 'network_in_executor'),
      hasFileWrite: uniqueExtraFindings.some(f => f.category === 'filesystem_write'),
      hasObfuscation: uniqueExtraFindings.some(f => f.category === 'obfuscation_dynamic'),
      blocked: result.blocked,
    };
    return result;
  }

  _shouldBlock(findings) {
    if (this.config.blockCritical && findings.some(f => f.level === RISK_LEVELS.CRITICAL)) {
      return true;
    }
    if (this.config.blockHigh && findings.some(f => f.level === RISK_LEVELS.HIGH)) {
      return true;
    }
    return false;
  }

  _calculateOverallRisk(findings) {
    if (findings.length === 0) return RISK_LEVELS.INFO;
    
    const levels = findings.map(f => f.level);
    
    if (levels.includes(RISK_LEVELS.CRITICAL)) return RISK_LEVELS.CRITICAL;
    if (levels.includes(RISK_LEVELS.HIGH)) return RISK_LEVELS.HIGH;
    if (levels.includes(RISK_LEVELS.MEDIUM)) return RISK_LEVELS.MEDIUM;
    if (levels.includes(RISK_LEVELS.LOW)) return RISK_LEVELS.LOW;
    
    return RISK_LEVELS.INFO;
  }

  _generateSummary(findings) {
    if (findings.length === 0) {
      return '未发现安全风险';
    }
    
    const counts = {};
    for (const level of Object.values(RISK_LEVELS)) {
      counts[level] = findings.filter(f => f.level === level).length;
    }
    
    const parts = [];
    for (const [level, count] of Object.entries(counts)) {
      if (count > 0) {
        parts.push(`${level}: ${count}`);
      }
    }
    
    return `发现 ${findings.length} 个风险 (${parts.join(', ')})`;
  }

  generateReport(scanResult) {
    const lines = [];
    
    lines.push('# 技能安全扫描报告');
    lines.push('');
    lines.push(`扫描时间: ${new Date().toISOString()}`);
    lines.push(`风险等级: ${scanResult.riskLevel}`);
    lines.push(`是否阻止: ${scanResult.blocked ? '是' : '否'}`);
    lines.push('');
    
    if (scanResult.findings.length === 0) {
      lines.push('✅ 未发现安全风险');
    } else {
      lines.push('## 发现的风险');
      lines.push('');
      
      const grouped = {};
      for (const finding of scanResult.findings) {
        if (!grouped[finding.level]) {
          grouped[finding.level] = [];
        }
        grouped[finding.level].push(finding);
      }
      
      for (const level of [RISK_LEVELS.CRITICAL, RISK_LEVELS.HIGH, RISK_LEVELS.MEDIUM, RISK_LEVELS.LOW]) {
        const items = grouped[level] || [];
        if (items.length === 0) continue;
        
        const emoji = this._getLevelEmoji(level);
        lines.push(`### ${emoji} ${level.toUpperCase()} (${items.length})`);
        lines.push('');
        
        for (const item of items) {
          lines.push(`- **${item.category}**: ${item.description}`);
          if (item.match) {
            lines.push(`  - 匹配: \`${item.match.slice(0, 50)}${item.match.length > 50 ? '...' : ''}\``);
          }
          if (item.file) {
            lines.push(`  - 文件: ${item.file}`);
          }
        }
        lines.push('');
      }
    }
    
    return lines.join('\n');
  }

  _getLevelEmoji(level) {
    const emojis = {
      [RISK_LEVELS.CRITICAL]: '🚨',
      [RISK_LEVELS.HIGH]: '⚠️',
      [RISK_LEVELS.MEDIUM]: '⚡',
      [RISK_LEVELS.LOW]: 'ℹ️',
      [RISK_LEVELS.INFO]: '✅',
    };
    return emojis[level] || '❓';
  }

  shouldAllowInstall(scanResult, source = TRUST_SOURCES.COMMUNITY) {
    const policy = INSTALL_POLICY[source];
    if (!policy) {
      return { allowed: false, reason: `Unknown source: ${source}` };
    }

    const findings = scanResult.findings || [];
    if (findings.length === 0) {
      return { allowed: true, reason: 'No findings', verdict: 'safe' };
    }

    const worstLevel = this._calculateOverallRisk(findings);
    const verdict = VERDICT_MAP[worstLevel] || 'caution';
    const action = policy[verdict];

    if (action === 'allow') {
      return { allowed: true, reason: `Policy allows ${verdict} from ${source}`, verdict };
    }
    if (action === 'ask') {
      return { allowed: false, reason: `Policy requires confirmation for ${verdict} from ${source}`, verdict, needsConfirmation: true };
    }
    return { allowed: false, reason: `Policy blocks ${verdict} from ${source}`, verdict };
  }

  formatInstallReport(scanResult, source) {
    const decision = this.shouldAllowInstall(scanResult, source);
    const lines = [];

    lines.push(`Source: ${source}`);
    lines.push(`Verdict: ${decision.verdict}`);
    lines.push(`Decision: ${decision.allowed ? 'ALLOWED' : (decision.needsConfirmation ? 'NEEDS CONFIRMATION' : 'BLOCKED')}`);
    if (decision.reason) lines.push(`Reason: ${decision.reason}`);
    lines.push('');
    lines.push(this.generateReport(scanResult));

    return lines.join('\n');
  }
}

module.exports = {
  SkillSecurityScanner,
  RISK_LEVELS,
  RISK_PATTERNS,
  TRUST_SOURCES,
  INSTALL_POLICY,
  VERDICT_MAP,
};
