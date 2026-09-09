const { EventEmitter } = require('events');

const CRON_INJECTION_PATTERNS = [
  {
    category: 'role_override',
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
    category: 'system_tag_injection',
    severity: 'critical',
    patterns: [
      /\[system\]/gi,
      /\[instruction\]/gi,
      /\[admin\]/gi,
      /\[developer\]/gi,
      /【系统】/g,
      /【指令】/g,
      /【管理员】/g,
      /【开发者】/g,
      /<\|.*\|>/g,
    ],
  },
  {
    category: 'command_execution',
    severity: 'critical',
    patterns: [
      /execute\s+(the\s+)?following\s+command/gi,
      /run\s+(the\s+)?following\s+(code|script|command)/gi,
      /执行以下(命令|代码|脚本)/g,
      /运行以下(命令|代码|脚本)/g,
      /eval\s*\(/gi,
    ],
  },
  {
    category: 'data_exfiltration',
    severity: 'high',
    patterns: [
      /reveal\s+(your|the)\s+(system\s+)?prompt/gi,
      /show\s+(me\s+)?(your|the)\s+(system\s+)?prompt/gi,
      /dump\s+(your|the)\s+(memory|context|prompt)/gi,
      /export\s+(all\s+)?(your|the)\s+(data|memory|knowledge)/gi,
      /显示(你的|系统)(提示|指令|设定)/g,
      /导出(所有)?(数据|记忆|知识)/g,
    ],
  },
  {
    category: 'cron_self_propagation',
    severity: 'critical',
    patterns: [
      /schedule\s+(a\s+)?(new\s+)?(cron|job|task)/gi,
      /create\s+(a\s+)?(new\s+)?cron\s+job/gi,
      /添加(定时|cron|计划)任务/g,
      /创建(定时|cron|计划)任务/g,
      /cronjob/gi,
    ],
  },
  {
    category: 'messaging_access',
    severity: 'high',
    patterns: [
      /send\s+(a\s+)?message\s+to/gi,
      /发送消息给/g,
      /notify\s+(all\s+)?users?/gi,
      /通知(所有)?用户/g,
    ],
  },
  {
    category: 'delimiter_injection',
    severity: 'high',
    patterns: [
      /---+\s*system\s*---+/gi,
      /===+\s*instruction\s*===+/gi,
      /\*\*\*+\s*new\s+prompt\s*\*\*\*+/gi,
      /###\s*(system|instruction|admin)/gi,
    ],
  },
];

class CronPromptInjectionScanner extends EventEmitter {
  constructor(config = {}) {
    super();
    this._strictMode = config.strictMode !== false;
    this._maxFindings = config.maxFindings || 50;
    this._stats = {
      totalScans: 0,
      cleanScans: 0,
      blockedScans: 0,
      findingsByCategory: {},
    };
  }

  scan(assembledPrompt, context = {}) {
    this._stats.totalScans++;

    if (!assembledPrompt || typeof assembledPrompt !== 'string') {
      return { safe: true, findings: [], blocked: false };
    }

    const findings = [];
    const seen = new Set();

    for (const group of CRON_INJECTION_PATTERNS) {
      for (const pattern of group.patterns) {
        pattern.lastIndex = 0;
        let match;
        try {
          while ((match = pattern.exec(assembledPrompt)) !== null) {
            const key = `${group.category}:${match.index}`;
            if (seen.has(key)) continue;
            seen.add(key);

            findings.push({
              category: group.category,
              severity: group.severity,
              matched: match[0],
              index: match.index,
              context: assembledPrompt.substring(
                Math.max(0, match.index - 30),
                Math.min(assembledPrompt.length, match.index + match[0].length + 30)
              ),
            });

            if (findings.length >= this._maxFindings) break;
          }
        } catch (e) {

          // regex error, skip

          console.warn('[cron-injection-scanner.js] 空 catch 补日志:', e && e.message);
        }

        if (findings.length >= this._maxFindings) break;
      }
      if (findings.length >= this._maxFindings) break;
    }

    const hasCritical = findings.some(f => f.severity === 'critical');
    const hasHigh = findings.some(f => f.severity === 'high');
    const blocked = this._strictMode
      ? findings.length > 0
      : hasCritical;

    if (blocked) {
      this._stats.blockedScans++;
    } else {
      this._stats.cleanScans++;
    }

    for (const f of findings) {
      this._stats.findingsByCategory[f.category] =
        (this._stats.findingsByCategory[f.category] || 0) + 1;
    }

    const result = {
      safe: !blocked,
      blocked,
      findings,
      findingCount: findings.length,
      hasCritical,
      hasHigh,
      jobId: context.jobId || null,
      jobName: context.jobName || null,
      scannedAt: Date.now(),
    };

    if (blocked) {
      this.emit('blocked', result);
    }

    return result;
  }

  scanSkillContent(skillContent, skillName) {
    return this.scan(skillContent, { source: 'skill', skillName });
  }

  getStats() {
    return { ...this._stats };
  }
}

class CronPromptInjectionBlocked extends Error {
  constructor(scanResult) {
    const categories = [...new Set(scanResult.findings.map(f => f.category))];
    super(
      `Cron prompt injection blocked: ${scanResult.findingCount} finding(s) in category(ies) ${categories.join(', ')}`
    );
    this.name = 'CronPromptInjectionBlocked';
    this.scanResult = scanResult;
  }
}

module.exports = { CronPromptInjectionScanner, CronPromptInjectionBlocked, CRON_INJECTION_PATTERNS };
