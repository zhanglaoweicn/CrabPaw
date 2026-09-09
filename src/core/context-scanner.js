const CONTEXT_THREAT_PATTERNS = [
  // ── 提示注入 ──
  { pattern: /ignore\s+(previous|all|above|prior)\s+instructions/i, id: 'prompt_injection' },
  { pattern: /do\s+not\s+tell\s+the\s+user/i, id: 'deception_hide' },
  { pattern: /system\s+prompt\s+override/i, id: 'sys_prompt_override' },
  { pattern: /disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, id: 'disregard_rules' },
  { pattern: /act\s+as\s+(if|though)\s+you\s+(have\s+no|don'?t\s+have)\s+(restrictions|limits|rules)/i, id: 'bypass_restrictions' },
  { pattern: /you\s+are\s+now\s+(jailbroken|unrestricted|uncensored)/i, id: 'jailbreak_attempt' },
  { pattern: /forget\s+(all\s+)?(previous|your)\s+(instructions|rules|training)/i, id: 'forget_instructions' },
  { pattern: /pretend\s+(you\s+are|to\s+be)\s+(?!a\s+(user|human|person)\s+who)/i, id: 'role_hijack' },
  { pattern: /output\s+(your|the|my)\s+(system|initial|original)\s+(prompt|instructions?|message)/i, id: 'prompt_extraction' },
  { pattern: /reveal\s+(your|the)\s+(system|hidden|secret)\s+(prompt|instructions?|rules)/i, id: 'prompt_extraction_v2' },
  { pattern: /\[INST\]|<<SYS>>|<\|im_start\|>system/i, id: 'model_tag_injection' },
  // ── HTML/代码注入 ──
  { pattern: /<!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->/i, id: 'html_comment_injection' },
  { pattern: /<\s*div\s+style\s*=\s*["'][\s\S]*?display\s*:\s*none/i, id: 'hidden_div' },
  { pattern: /translate\s+.*\s+into\s+.*\s+and\s+(execute|run|eval)/i, id: 'translate_execute' },
  { pattern: /base64[_-]?decode|atob\s*\(|Buffer\.from\s*\([^)]*,\s*['"]base64['"]\)/i, id: 'obfuscated_payload' },
  { pattern: /eval\s*\(|Function\s*\(|new\s+Function\s*\(/i, id: 'code_exec_injection' },
  { pattern: /import\s+os|require\s*\(\s*['"]child_process/i, id: 'system_access_attempt' },
  // ── 数据外泄 ──
  { pattern: /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, id: 'exfil_curl' },
  { pattern: /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass)/i, id: 'read_secrets' },
  { pattern: /send\s+(this|the)\s+(file|data|result|output)\s+to\s+\S+\.\S+/i, id: 'exfil_data' },
  { pattern: /upload\s+.*\.(env|pem|key|secret|credentials)/i, id: 'exfil_secrets' },
  // ── 破坏性命令 ──
  { pattern: /rm\s+-rf|del\s+\/[sq]|format\s+[a-z]:/i, id: 'destructive_command' },
  { pattern: /shutdown\s+(-r|-h|-s|now)|\/f\s*\/r\s*\/t|init\s+[06]/i, id: 'system_shutdown' },
  { pattern: /wipe\s+(all|everything|disk|drive|data)/i, id: 'data_wipe' },
  // ── C2/Brainworm 持久化 ──
  { pattern: /(c2|command\s*&?\s*control|brainworm|backdoor|persistence)\s+(server|channel|endpoint|mechanism)/i, id: 'c2_persistence' },
  { pattern: /install\s+(persistence|backdoor|cron\s*job|launchd|systemd\s*service|startup\s*script)/i, id: 'install_persistence' },
  { pattern: /(establish|create|spawn)\s+(reverse\s*shell|bind\s*shell|remote\s*access)/i, id: 'remote_access_shell' },
  { pattern: /(exfiltrate|steal|dump|extract)\s+(credentials|passwords|hashes|sessions?|cookies)/i, id: 'credential_theft' },
  // ── 反取证/痕迹清理 ──
  { pattern: /(clear|delete|wipe|remove)\s+(history|logs?|traces?|fingerprints?|evidence)/i, id: 'anti_forensics' },
  { pattern: /unset\s+(HISTFILE|HISTSIZE|HISTFILESIZE)|set\s+\+o\s+history/i, id: 'disable_history' },
  { pattern: /(overwrite|shred|secure.?delete)\s+(logs?|files?|data)/i, id: 'secure_delete_logs' },
  // ── 环境变量/配置擦除 ──
  { pattern: /(export|set|unset)\s+(PATH|HOME|USER|SHELL|LANG|LC_)/i, id: 'env_poisoning' },
  { pattern: /(overwrite|replace|modify)\s+(\.bashrc|\.zshrc|\.profile|\.bash_profile)/i, id: 'profile_poisoning' },
  { pattern: /(chmod\s+[0-7]*7|chown\s+root|sudo\s+chmod)/i, id: 'permission_escalation' },
];

const INVISIBLE_CHARS = new Set([
  '\u200b', '\u200c', '\u200d', '\u2060', '\ufeff',
  '\u202a', '\u202b', '\u202c', '\u202d', '\u202e',
  '\u2061', '\u2062', '\u2063', '\u2064',
  '\u2066', '\u2067', '\u2068', '\u2069',
  '\u200e', '\u200f',
  '\u034f', '\u061c', '\u180e',
  '\u00ad', '\u206a', '\u206b', '\u206c', '\u206d', '\u206e', '\u206f',
]);

function scanContextContent(content, filename = '') {
  if (!content || typeof content !== 'string') {
    return { safe: true, content, findings: [] };
  }

  const findings = [];

  for (const char of content) {
    if (INVISIBLE_CHARS.has(char)) {
      findings.push(`invisible_unicode_U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
      break;
    }
  }

  for (const { pattern, id } of CONTEXT_THREAT_PATTERNS) {
    if (!pattern.test(content)) continue;
    // 2026-08-06: 文档类扫描(code_exec_injection)排除否定语境——
    // AGENTS.md/CLAUDE.md 写"禁止 new Function()/eval()"是安全规则声明，不是攻击。
    // 若匹配位置前有"禁止/不要/no/never/避免/不使用"等否定词，跳过该命中。
    if (id === 'code_exec_injection') {
      const m = content.match(pattern);
      if (m && m.index !== undefined) {
        const before = content.slice(Math.max(0, m.index - 20), m.index).toLowerCase();
        if (/(禁止|不要|不可|避免|请勿|no\s|never|not\s|don'?t|不使用|no\s+use|rather than)/.test(before)) {
          continue;
        }
      }
    }
    findings.push(id);
  }

  if (findings.length > 0) {
    const blockedContent = `[BLOCKED: ${filename || 'content'} contained potential prompt injection (${findings.join(', ')}). Content not loaded.]`;
    console.warn(`⚠️ 上下文文件安全扫描拦截: ${filename || 'unknown'} — ${findings.join(', ')}`);
    return { safe: false, content: blockedContent, findings };
  }

  return { safe: true, content, findings: [] };
}

function sanitizeContextContent(content, filename = '') {
  const result = scanContextContent(content, filename);
  return result.content;
}

function scanAndStripInvisible(content) {
  if (!content || typeof content !== 'string') return content;
  let result = '';
  let stripped = 0;
  for (const char of content) {
    if (INVISIBLE_CHARS.has(char)) {
      stripped++;
    } else {
      result += char;
    }
  }
  if (stripped > 0) {
    console.log(`🧹 已移除 ${stripped} 个不可见字符`);
  }
  return result;
}

function checkPromptInjection(message) {
  if (!message || typeof message !== 'string') return { injected: false, score: 0, findings: [] };

  // 先剥离不可见字符，再检查模式匹配
  // PDF 等文件提取的内容常包含零宽字符，这是正常的，不应直接判定为注入
  const cleanedMessage = scanAndStripInvisible(message);

  const findings = [];
  let score = 0;

  for (const { pattern, id } of CONTEXT_THREAT_PATTERNS) {
    if (pattern.test(cleanedMessage)) {
      findings.push(id);
      score += 1;
    }
  }

  // 不可见字符检测：仅当比例异常高时才计分
  const invisibleCount = [...message].filter(c => INVISIBLE_CHARS.has(c)).length;
  const totalChars = [...message].length;
  const invisibleRatio = totalChars > 0 ? invisibleCount / totalChars : 0;
  if (invisibleCount > 0 && invisibleRatio > 0.1) {
    // 超过 10% 的字符是不可见字符，才视为可疑
    findings.push(`invisible_unicode_${invisibleCount}_chars`);
    score += invisibleCount > 3 ? 2 : 1;
  }

  return {
    injected: score >= 2,
    score,
    findings,
  };
}

module.exports = {
  scanContextContent,
  sanitizeContextContent,
  scanAndStripInvisible,
  checkPromptInjection,
  CONTEXT_THREAT_PATTERNS,
  INVISIBLE_CHARS,
};
