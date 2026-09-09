/**
 * PromptInjectionDetector - 提示注入检测
 * 
 * 检测用户输入中的恶意指令
 * 防止 Agent 被诱导执行危险操作
 */

const crypto = require('crypto');
const { getThreatPatternLoader } = require('./threat-pattern-loader');

const SEVERITY = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
};

const VERDICT = {
  ALLOW: 'allow',
  REVIEW: 'review',
  BLOCK: 'block'
};

const LEETSPEAK_MAP = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a',
  '5': 's', '7': 't', '8': 'b', '9': 'g',
  '@': 'a', '$': 's', '!': 'i', '|': 'l',
};

function normalizeInput(input) {
  let s = input;

  s = s.replace(/[\u200B-\u200D\uFEFF\u00AD\u2060\u180E]/g, '');

  s = s.replace(/[\u200E-\u200F\u202A-\u202E]/g, '');

  s = s.replace(/\\u[0-9a-fA-F]{4}/gi, (m) => {
    try { return String.fromCharCode(parseInt(m.slice(2), 16)); } catch { return m; }
  });
  s = s.replace(/\\x[0-9a-fA-F]{2}/gi, (m) => {
    try { return String.fromCharCode(parseInt(m.slice(2), 16)); } catch { return m; }
  });
  s = s.replace(/&#x?[0-9a-fA-F]+;/gi, (m) => {
    try {
      const code = m.replace(/^&#x?/, '').replace(/;$/, '');
      return String.fromCharCode(parseInt(code, 16));
    } catch { return m; }
  });

  s = s.replace(/\s+/g, ' ');

  let leet = '';
  for (const ch of s) {
    const lower = ch.toLowerCase();
    leet += LEETSPEAK_MAP[lower] || ch;
  }
  s = leet;

  return s;
}

function detectCompactStrings(input, minLen = 30, maxSpaces = 3) {
  const words = input.split(/\s+/);
  const compact = words.filter(w => w.length >= minLen && (w.match(/\s/g) || []).length <= maxSpaces);
  return compact.length;
}

function heuristicScore(findings, normalizedFindings, input) {
  let score = 0;

  const categories = new Set();
  for (const f of findings) categories.add(f.category);
  for (const f of normalizedFindings) categories.add(f.category);

  if (categories.has('role_override') || categories.has('chinese_role_override')) score += 3;
  if (categories.has('instruction_injection') || categories.has('chinese_instruction_injection')) score += 3;
  if (categories.has('output_manipulation')) score += 2;
  if (categories.has('data_exfiltration') || categories.has('chinese_data_exfiltration')) score += 2;
  if (categories.has('command_injection')) score += 3;
  if (categories.has('social_engineering') || categories.has('chinese_social_engineering')) score += 1;
  if (categories.has('encoding_evasion')) score += 2;
  if (categories.has('delimiter_injection')) score += 2;

  const hasOverride = categories.has('role_override') || categories.has('chinese_role_override');
  const hasExfil = categories.has('data_exfiltration') || categories.has('chinese_data_exfiltration');
  const hasInject = categories.has('instruction_injection') || categories.has('chinese_instruction_injection');
  if (hasOverride && hasExfil) score += 3;
  if (hasOverride && hasInject) score += 2;

  const compactCount = detectCompactStrings(input);
  if (compactCount > 0) score += 1;

  return score;
}

function scoreToVerdict(score) {
  if (score >= 6) return VERDICT.BLOCK;
  if (score >= 3) return VERDICT.REVIEW;
  return VERDICT.ALLOW;
}

// 内置硬编码模式（作为 JSON 配置加载失败时的回退）
const INJECTION_PATTERNS = [
  {
    category: 'role_override',
    severity: SEVERITY.HIGH,
    patterns: [
      { regex: /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/gi, description: '忽略之前的指令' },
      { regex: /disregard\s+(all\s+)?(previous|above)\s+(instructions?|prompts?)/gi, description: '忽略之前的指令' },
      { regex: /forget\s+(all\s+)?(previous|above|your)\s+(instructions?|prompts?|training)/gi, description: '忘记之前的指令' },
      { regex: /you\s+are\s+now\s+(a|an)\s+\w+/gi, description: '角色覆盖尝试' },
      { regex: /act\s+as\s+(if\s+you\s+are|a|an)\s+\w+/gi, description: '角色扮演尝试' },
      { regex: /pretend\s+(to\s+be|that\s+you\s+are)/gi, description: '伪装尝试' },
      { regex: /simulate\s+(being|a|an)\s+\w+/gi, description: '模拟尝试' }
    ]
  },
  
  {
    category: 'instruction_injection',
    severity: SEVERITY.CRITICAL,
    patterns: [
      { regex: /\[system\]/gi, description: '系统标签注入' },
      { regex: /\[instruction\]/gi, description: '指令标签注入' },
      { regex: /\[admin\]/gi, description: '管理员标签注入' },
      { regex: /\[developer\]/gi, description: '开发者标签注入' },
      { regex: /<<<.*>>>/g, description: '特殊分隔符注入' },
      { regex: /\{\{.*\}\}/g, description: '模板注入' },
      { regex: /<\|.*\|>/g, description: '特殊标记注入' }
    ]
  },
  
  {
    category: 'output_manipulation',
    severity: SEVERITY.HIGH,
    patterns: [
      { regex: /print\s+["'].*["']/gi, description: '强制输出尝试' },
      { regex: /output\s+the\s+(following|text)/gi, description: '输出操纵' },
      { regex: /repeat\s+(after\s+me|the\s+following)/gi, description: '重复攻击' },
      { regex: /say\s+["'].*["']/gi, description: '强制说话' },
      { regex: /respond\s+with\s+only/gi, description: '限制响应' }
    ]
  },
  
  {
    category: 'data_exfiltration',
    severity: SEVERITY.HIGH,
    patterns: [
      { regex: /reveal\s+(your|the)\s+(system\s+)?prompt/gi, description: '提示泄露尝试' },
      { regex: /show\s+(me\s+)?(your|the)\s+(system\s+)?prompt/gi, description: '提示泄露尝试' },
      { regex: /what\s+(is|are)\s+(your|the)\s+(system\s+)?instructions?/gi, description: '指令探查' },
      { regex: /dump\s+(your|the)\s+(memory|context|prompt)/gi, description: '内存转储尝试' },
      { regex: /export\s+(all\s+)?(your|the)\s+(data|memory|knowledge)/gi, description: '数据导出尝试' }
    ]
  },
  
  {
    category: 'command_injection',
    severity: SEVERITY.CRITICAL,
    patterns: [
      { regex: /execute\s+(the\s+)?following\s+command/gi, description: '命令执行尝试' },
      { regex: /run\s+(the\s+)?following\s+(code|script|command)/gi, description: '代码执行尝试' },
      { regex: /eval\s*\(/gi, description: 'Eval 注入' },
      { regex: /exec\s*\(/gi, description: 'Exec 注入' },
      { regex: /`[^`]+`/g, description: '代码块注入' },
      { regex: /```[\s\S]*?```/g, description: '多行代码块' }
    ]
  },
  
  {
    category: 'social_engineering',
    severity: SEVERITY.MEDIUM,
    patterns: [
      { regex: /this\s+is\s+(a\s+)?test/gi, description: '测试借口' },
      { regex: /i\s+am\s+(your\s+)?(developer|admin|creator)/gi, description: '身份伪造' },
      { regex: /emergency\s+(mode|override)/gi, description: '紧急模式借口' },
      { regex: /debug\s+mode/gi, description: '调试模式借口' },
      { regex: /maintenance\s+mode/gi, description: '维护模式借口' }
    ]
  },
  
  {
    category: 'encoding_evasion',
    severity: SEVERITY.LOW,
    patterns: [
      { regex: /\\u[0-9a-f]{4}/gi, description: 'Unicode 编码' },
      { regex: /\\x[0-9a-f]{2}/gi, description: '十六进制编码' },
      { regex: /[a-zA-Z0-9+/]{40,}={0,2}/g, description: '可能的 Base64 编码' },
      { regex: /&#x?[0-9a-f]+;/gi, description: 'HTML 实体编码' }
    ]
  },
  
  {
    category: 'delimiter_injection',
    severity: SEVERITY.HIGH,
    patterns: [
      { regex: /---+\s*system\s*---+/gi, description: '系统分隔符注入' },
      { regex: /===+\s*instruction\s*===+/gi, description: '指令分隔符注入' },
      { regex: /\*\*\*+\s*new\s+prompt\s*\*\*\*+/gi, description: '新提示分隔符' },
      { regex: /###\s*(system|instruction|admin)/gi, description: 'Markdown 标题注入' }
    ]
  },
  {
    category: 'chinese_role_override',
    severity: SEVERITY.HIGH,
    patterns: [
      { regex: /忽略(之前|以上|上面|前面|所有)?(的)?(指令|提示|规则|设定)/g, description: '中文忽略指令' },
      { regex: /忘记(之前|以上|你的)?(的)?(指令|提示|训练|设定)/g, description: '中文忘记指令' },
      { regex: /你现在是(一个|一名)?/g, description: '中文角色覆盖' },
      { regex: /假装你是/g, description: '中文伪装尝试' },
      { regex: /扮演(一个|一名)?/g, description: '中文角色扮演' },
      { regex: /模拟(成为|一个|一名)?/g, description: '中文模拟尝试' }
    ]
  },
  {
    category: 'chinese_instruction_injection',
    severity: SEVERITY.CRITICAL,
    patterns: [
      { regex: /【系统】/g, description: '中文系统标签注入' },
      { regex: /【指令】/g, description: '中文指令标签注入' },
      { regex: /【管理员】/g, description: '中文管理员标签注入' },
      { regex: /【开发者】/g, description: '中文开发者标签注入' },
      { regex: /执行以下(命令|代码|脚本)/g, description: '中文命令执行' },
      { regex: /运行以下(命令|代码|脚本)/g, description: '中文代码执行' }
    ]
  },
  {
    category: 'chinese_data_exfiltration',
    severity: SEVERITY.HIGH,
    patterns: [
      { regex: /显示(你的|系统)(提示|指令|设定)/g, description: '中文提示泄露' },
      { regex: /泄露(你的|系统)(提示|指令)/g, description: '中文提示泄露' },
      { regex: /导出(所有)?(数据|记忆|知识)/g, description: '中文数据导出' },
      { regex: /转储(你的|系统)(内存|上下文)/g, description: '中文内存转储' }
    ]
  },
  {
    category: 'chinese_social_engineering',
    severity: SEVERITY.MEDIUM,
    patterns: [
      { regex: /我是(你的)?(开发者|管理员|创建者)/g, description: '中文身份伪造' },
      { regex: /紧急模式/g, description: '中文紧急模式' },
      { regex: /调试模式/g, description: '中文调试模式' },
      { regex: /维护模式/g, description: '中文维护模式' },
      { regex: /这是(一个)?测试/g, description: '中文测试借口' }
    ]
  }
];

const CONTEXT_PATTERNS = [
  {
    context: 'file_path',
    patterns: [
      /\.\.\//g,
      /\.\.\\/g,
      /~\//g,
      /\/etc\//g,
      /\/root\//g
    ]
  },
  {
    context: 'url',
    patterns: [
      /javascript:/gi,
      /data:/gi,
      /vbscript:/gi
    ]
  }
];

class PromptInjectionDetector {
  constructor(config = {}) {
    this.config = {
      enabled: config.enabled !== false,
      blockOnDetection: config.blockOnDetection !== false,
      warnLevel: config.warnLevel || 'medium',
      maxInputLength: config.maxInputLength || 50000,
      normalizeEnabled: config.normalizeEnabled !== false,
      heuristicEnabled: config.heuristicEnabled !== false,
      logHashes: config.logHashes || false,
      ...config
    };

    // 尝试从 JSON 配置热加载模式，失败则回退到内置硬编码
    this._loadPatterns();

    this._stats = {
      scans: 0,
      clean: 0,
      detected: 0,
      blocked: 0,
      reviewed: 0,
      normalizedCatches: 0
    };
  }

  /**
   * 加载威胁模式（支持热更新）
   */
  _loadPatterns() {
    const loader = getThreatPatternLoader();
    const compiled = loader.load('injection-threats.json', null);

    if (compiled && compiled.injectionPatterns) {
      this._injectionPatterns = compiled.injectionPatterns;
      this._contextPatterns = compiled.contextPatterns || CONTEXT_PATTERNS;

      // 只注册一次热更新回调，避免重复注册导致无限循环
      if (!this._patternChangeListenerRegistered) {
        this._patternChangeListenerRegistered = true;
        loader.onPatternChange('injection-threats.json', () => {
          this._loadPatterns();
          console.log('[PromptInjectionDetector] 威胁模式已热更新');
        });
      }
    } else {
      // 回退到内置模式
      this._injectionPatterns = INJECTION_PATTERNS;
      this._contextPatterns = CONTEXT_PATTERNS;
    }
  }

  // eslint-disable-next-line no-unused-vars
  detect(input, context = {}) {
    this._stats.scans++;
    
    if (!this.config.enabled) {
      this._stats.clean++;
      return { detected: false, verdict: VERDICT.ALLOW, reason: '提示注入检测未启用' };
    }
    
    if (input.length > this.config.maxInputLength) {
      this._stats.detected++;
      this._stats.blocked++;
      return {
        detected: true,
        verdict: VERDICT.BLOCK,
        blocked: true,
        severity: SEVERITY.MEDIUM,
        reason: `输入长度超过限制 (${input.length} > ${this.config.maxInputLength})`,
        findings: [{ category: 'length_exceeded', severity: SEVERITY.MEDIUM }]
      };
    }
    
    const findings = this._scanPatterns(input);
    let maxSeverity = 'low';
    for (const f of findings) {
      if (this._severityValue(f.severity) > this._severityValue(maxSeverity)) {
        maxSeverity = f.severity;
      }
    }

    let normalizedFindings = [];
    let normalizedInput = null;
    if (this.config.normalizeEnabled) {
      normalizedInput = normalizeInput(input);
      if (normalizedInput !== input) {
        normalizedFindings = this._scanPatterns(normalizedInput);
        for (const f of normalizedFindings) {
          f.fromNormalization = true;
          if (this._severityValue(f.severity) > this._severityValue(maxSeverity)) {
            maxSeverity = f.severity;
          }
        }
        if (normalizedFindings.length > 0) {
          this._stats.normalizedCatches++;
        }
      }
    }

    const allFindings = [...findings, ...normalizedFindings];

    if (allFindings.length === 0) {
      this._stats.clean++;
      return {
        detected: false,
        verdict: VERDICT.ALLOW,
        blocked: false,
        severity: 'none',
        findings: [],
        summary: '未检测到注入模式'
      };
    }

    this._stats.detected++;

    let verdict;
    if (this.config.heuristicEnabled) {
      const hScore = heuristicScore(findings, normalizedFindings, input);
      verdict = scoreToVerdict(hScore);
    } else {
      verdict = this._severityValue(maxSeverity) >= this._severityValue(this.config.warnLevel)
        ? VERDICT.BLOCK
        : VERDICT.REVIEW;
    }

    const blocked = verdict === VERDICT.BLOCK && this.config.blockOnDetection;
    if (blocked) this._stats.blocked++;
    if (verdict === VERDICT.REVIEW) this._stats.reviewed++;
    if (verdict === VERDICT.ALLOW && allFindings.length > 0) this._stats.reviewed++;

    const result = {
      detected: true,
      verdict,
      blocked,
      severity: maxSeverity,
      findings: allFindings,
      summary: this._generateSummary(allFindings),
      reason: `检测到 ${allFindings.length} 个潜在注入模式 (verdict: ${verdict})`
    };

    if (this.config.logHashes) {
      result.inputHash = crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
    }

    if (normalizedInput !== null && normalizedInput !== input) {
      result.normalized = true;
    }

    return result;
  }

  _scanPatterns(input) {
    const findings = [];
    for (const category of this._injectionPatterns) {
      for (const pattern of category.patterns) {
        const matches = input.match(pattern.regex);
        if (matches) {
          findings.push({
            category: category.category,
            severity: category.severity,
            description: pattern.description,
            match: matches[0].slice(0, 50),
            pattern: pattern.regex.source
          });
        }
      }
    }
    return findings;
  }

  _severityValue(severity) {
    const values = {
      [SEVERITY.CRITICAL]: 4,
      [SEVERITY.HIGH]: 3,
      [SEVERITY.MEDIUM]: 2,
      [SEVERITY.LOW]: 1,
      'none': 0
    };
    return values[severity] || 0;
  }

  _generateSummary(findings) {
    if (findings.length === 0) return '未检测到注入模式';
    
    const grouped = {};
    for (const f of findings) {
      if (!grouped[f.severity]) grouped[f.severity] = [];
      grouped[f.severity].push(f);
    }
    
    const parts = [];
    for (const level of [SEVERITY.CRITICAL, SEVERITY.HIGH, SEVERITY.MEDIUM, SEVERITY.LOW]) {
      if (grouped[level]) {
        parts.push(`${level}: ${grouped[level].length}`);
      }
    }
    
    return `检测到 ${findings.length} 个注入模式 (${parts.join(', ')})`;
  }

  getStats() {
    return { ...this._stats };
  }

  enable() {
    this.config.enabled = true;
  }

  disable() {
    this.config.enabled = false;
  }

  setBlockOnDetection(block) {
    this.config.blockOnDetection = block;
  }

  // ========== 安全拦截反馈闭环 ==========

  /**
   * 记录拦截反馈（误报/漏报）
   * @param {string} inputHash - 输入哈希
   * @param {string} feedback - 'false_positive'（误报）或 'false_negative'（漏报）
   * @param {object} details - 详情
   */
  recordFeedback(inputHash, feedback, details = {}) {
    if (!this._feedbackLog) this._feedbackLog = [];

    this._feedbackLog.push({
      inputHash,
      feedback,
      details,
      timestamp: Date.now(),
    });

    if (this._feedbackLog.length > 200) {
      this._feedbackLog = this._feedbackLog.slice(-100);
    }

    // 根据反馈调整检测灵敏度
    this._adaptFromFeedback();
  }

  /**
   * 根据反馈自动调整检测灵敏度
   * 误报多 → 放宽阈值（提高 warnLevel）
   * 漏报多 → 收紧阈值（降低 warnLevel）
   */
  _adaptFromFeedback() {
    if (!this._feedbackLog || this._feedbackLog.length < 5) return;

    const recent = this._feedbackLog.slice(-20);
    const falsePositives = recent.filter(f => f.feedback === 'false_positive').length;
    const falseNegatives = recent.filter(f => f.feedback === 'false_negative').length;

    const levels = ['low', 'medium', 'high', 'critical'];
    const currentIdx = levels.indexOf(this.config.warnLevel);

    if (falsePositives > falseNegatives * 2 && currentIdx < levels.length - 1) {
      // 误报过多，放宽阈值
      const newLevel = levels[currentIdx + 1];
      this.config.warnLevel = newLevel;
      console.log(`[PromptInjectionDetector] 反馈闭环: 误报偏多, warnLevel 调整为 ${newLevel}`);
    } else if (falseNegatives > falsePositives * 2 && currentIdx > 0) {
      // 漏报过多，收紧阈值
      const newLevel = levels[currentIdx - 1];
      this.config.warnLevel = newLevel;
      console.log(`[PromptInjectionDetector] 反馈闭环: 漏报偏多, warnLevel 调整为 ${newLevel}`);
    }
  }

  /**
   * 获取反馈统计
   */
  getFeedbackStats() {
    if (!this._feedbackLog) return { total: 0, falsePositives: 0, falseNegatives: 0 };

    return {
      total: this._feedbackLog.length,
      falsePositives: this._feedbackLog.filter(f => f.feedback === 'false_positive').length,
      falseNegatives: this._feedbackLog.filter(f => f.feedback === 'false_negative').length,
      currentWarnLevel: this.config.warnLevel,
    };
  }
}

module.exports = { PromptInjectionDetector, SEVERITY, VERDICT, normalizeInput, heuristicScore, scoreToVerdict };
