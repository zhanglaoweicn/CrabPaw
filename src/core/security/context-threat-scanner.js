const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const CONTEXT_FILE_NAMES = [
  'AGENTS.md', 'SOUL.md', 'PERSONA.md', 'SYSTEM.md',
  'CONTEXT.md', 'INSTRUCTIONS.md', 'PROMPT.md',
  'agents.md', 'soul.md', 'persona.md', 'system.md',
  'context.md', 'instructions.md', 'prompt.md',
];

const THREAT_PATTERNS = [
  {
    id: 'role_override',
    severity: 'critical',
    patterns: [
      /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/gi,
      /disregard\s+(all\s+)?(previous|above)\s+(instructions?|prompts?)/gi,
      /forget\s+(all\s+)?(previous|above|your)\s+(instructions?|prompts?|training)/gi,
      /you\s+are\s+now\s+(a|an)\s+\w+/gi,
      /忽略(之前|以上|上面|前面|所有)?(的)?(指令|提示|规则|设定)/g,
      /忘记(之前|以上|你的)?(的)?(指令|提示|训练|设定)/g,
      /你现在是(一个|一名)?/g,
    ],
  },
  {
    id: 'system_tag_injection',
    severity: 'critical',
    patterns: [
      /\[system\]/gi,
      /\[instruction\]/gi,
      /\[admin\]/gi,
      /\[developer\]/gi,
      /【系统】/g,
      /【指令】/g,
      /【管理员】/g,
    ],
  },
  {
    id: 'tool_access_escalation',
    severity: 'high',
    patterns: [
      /you\s+now\s+have\s+access\s+to/gi,
      /grant\s+(yourself|me)\s+(full|admin|root)\s+(access|permissions?)/gi,
      /bypass\s+(all\s+)?(security|safety|restrictions?|guardrails?)/gi,
      /绕过(所有)?(安全|限制|护栏)/g,
      /获取(完整|管理员|root)(权限|访问)/g,
    ],
  },
  {
    id: 'data_exfiltration',
    severity: 'high',
    patterns: [
      /reveal\s+(your|the)\s+(system\s+)?prompt/gi,
      /show\s+(me\s+)?(your|the)\s+(system\s+)?prompt/gi,
      /dump\s+(your|the)\s+(memory|context|prompt)/gi,
      /显示(你的|系统)(提示|指令|设定)/g,
      /导出(所有)?(数据|记忆|知识)/g,
    ],
  },
  {
    id: 'command_execution',
    severity: 'critical',
    patterns: [
      /execute\s+(the\s+)?following\s+command/gi,
      /run\s+(the\s+)?following\s+(code|script|command)/gi,
      /执行以下(命令|代码|脚本)/g,
      /运行以下(命令|代码|脚本)/g,
    ],
  },
  {
    id: 'delimiter_injection',
    severity: 'high',
    patterns: [
      /---+\s*system\s*---+/gi,
      /===+\s*instruction\s*===+/gi,
      /\*\*\*+\s*new\s+prompt\s*\*\*\*+/gi,
    ],
  },
  {
    id: 'cron_injection',
    severity: 'critical',
    patterns: [
      /schedule\s+(a\s+)?(new\s+)?(cron|job|task)/gi,
      /添加(定时|cron|计划)任务/g,
      /创建(定时|cron|计划)任务/g,
    ],
  },
];

const BLOCKED_REPLACEMENT = '[BLOCKED]';

class ContextFileThreatScanner extends EventEmitter {
  constructor(config = {}) {
    super();
    this._strictMode = config.strictMode !== false;
    this._blockOnCritical = config.blockOnCritical !== false;
    this._blockOnHigh = config.blockOnHigh || false;
    this._scanDirs = config.scanDirs || [];
    this._stats = {
      filesScanned: 0,
      threatsFound: 0,
      threatsBlocked: 0,
      filesCleaned: 0,
    };
  }

  scanContent(content, source = 'unknown') {
    if (!content || typeof content !== 'string') {
      return { safe: true, threats: [], sanitized: content };
    }

    const threats = [];
    const seen = new Set();

    for (const group of THREAT_PATTERNS) {
      for (const pattern of group.patterns) {
        pattern.lastIndex = 0;
        let match;
        try {
          while ((match = pattern.exec(content)) !== null) {
            const key = `${group.id}:${match.index}`;
            if (seen.has(key)) continue;
            seen.add(key);

            threats.push({
              id: group.id,
              severity: group.severity,
              matched: match[0],
              index: match.index,
              source,
            });
          }
        } catch (e) {

          // regex error, skip

          console.warn('[context-threat-scanner.js] 空 catch 补日志:', e && e.message);
        }

      }
    }

    this._stats.threatsFound += threats.length;

    const hasCritical = threats.some(t => t.severity === 'critical');
    const hasHigh = threats.some(t => t.severity === 'high');
    const shouldBlock =
      (this._blockOnCritical && hasCritical) ||
      (this._blockOnHigh && hasHigh) ||
      (this._strictMode && threats.length > 0);

    if (shouldBlock) {
      this._stats.threatsBlocked += threats.length;
    }

    const sanitized = shouldBlock
      ? this._sanitizeContent(content, threats)
      : content;

    if (shouldBlock && sanitized !== content) {
      this._stats.filesCleaned++;
    }

    const result = {
      safe: !shouldBlock,
      blocked: shouldBlock,
      threats,
      threatCount: threats.length,
      hasCritical,
      hasHigh,
      sanitized,
      source,
      scannedAt: Date.now(),
    };

    if (shouldBlock) {
      this.emit('threat:blocked', result);
    }

    return result;
  }

  _sanitizeContent(content, threats) {
    let sanitized = content;
    const sorted = [...threats].sort((a, b) => b.index - a.index);

    for (const threat of sorted) {
      sanitized =
        sanitized.substring(0, threat.index) +
        BLOCKED_REPLACEMENT +
        sanitized.substring(threat.index + threat.matched.length);
    }

    return sanitized;
  }

  scanFile(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      this._stats.filesScanned++;
      const result = this.scanContent(content, filePath);

      if (result.blocked && result.sanitized !== content) {
        this.emit('file:cleaned', { filePath, threatCount: result.threatCount });
      }

      return result;
    } catch (e) {
      return {
        safe: true,
        threats: [],
        sanitized: null,
        error: e.message,
        source: filePath,
      };
    }
  }

  scanDirectory(dirPath) {
    const results = [];

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
          const subResults = this.scanDirectory(fullPath);
          results.push(...subResults);
        } else if (CONTEXT_FILE_NAMES.includes(entry.name)) {
          const result = this.scanFile(fullPath);
          results.push(result);
        }
      }
    } catch (e) {

      // directory read error, skip

      console.warn('[context-threat-scanner.js] 空 catch 补日志:', e && e.message);
    }


    return results;
  }

  scanWorkspace(baseDir) {
    const allResults = [];
    const dirsToScan = [baseDir, ...this._scanDirs];

    for (const dir of dirsToScan) {
      if (!fs.existsSync(dir)) continue;
      const results = this.scanDirectory(dir);
      allResults.push(...results);
    }

    return allResults;
  }

  getStats() {
    return { ...this._stats };
  }
}

module.exports = { ContextFileThreatScanner, THREAT_PATTERNS, CONTEXT_FILE_NAMES, BLOCKED_REPLACEMENT };
