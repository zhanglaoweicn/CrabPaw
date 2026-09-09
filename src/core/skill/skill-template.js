/**
 * Skill Template - Skill template variable and inline shell expansion
 *
 * Provides dynamic capabilities for SKILL.md:
 *   1. Template variable substitution: ${CRABPAW_SKILL_DIR}, ${CRABPAW_SESSION_ID}, etc.
 *   2. Inline Shell execution: !`command` replaced with command output at load time
 *   3. Platform filtering: frontmatter platforms field auto-skips incompatible skills
 *
 * Reference: Hermes-Agent agent/skill_preprocessing.py design.
 */



const { execFileSync } = require('child_process');

// Template variable regex: ${CRABPAW_VAR_NAME}
const TEMPLATE_VAR_RE = /\$\{(CRABPAW_SKILL_DIR|CRABPAW_SESSION_ID|CRABPAW_USER_HOME|CRABPAW_CWD)\}/g;

// Inline Shell regex: !`command`
const INLINE_SHELL_RE = /!`([^`\n]+)`/g;

// Max inline shell output
const MAX_INLINE_SHELL_OUTPUT = 4000;

// Commands that are explicitly denied in inline shell
const BLOCKED_INLINE_COMMANDS = [
  /\brm\s+-rf/i,
  /\bdel\s+\/[sfq]/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bformat\s/i,
  /\bwget\s.*\|\s*(?:bash|sh|python)/i,
  /\bcurl\s.*\|\s*(?:bash|sh|python)/i,
  /\beval\s*\(/i,
  /\bexec\s*\(/i,
  /\bchild_process/i,
  /\brequire\s*\(/i,
];

function validateInlineCommand(command) {
  if (!command || !command.trim()) return { safe: false, reason: 'empty command' };
  for (const pattern of BLOCKED_INLINE_COMMANDS) {
    if (pattern.test(command)) {
      return { safe: false, reason: 'blocked pattern: ' + pattern.source };
    }
  }
  return { safe: true };
}

function substituteTemplateVars(content, context) {
  if (!context) context = {};
  return content.replace(TEMPLATE_VAR_RE, (match, varName) => {
    switch (varName) {
      case 'CRABPAW_SKILL_DIR': return context.skillDir || '';
      case 'CRABPAW_SESSION_ID': return context.sessionId || '';
      case 'CRABPAW_USER_HOME': return context.userHome || process.env.HOME || process.env.USERPROFILE || '';
      case 'CRABPAW_CWD': return context.cwd || process.cwd();
      default: return match;
    }
  });
}

/**
 * Execute an inline shell command safely using execFileSync.
 * Command is passed as an argument to the shell, preventing injection
 * via shell metacharacters (though the shell still interprets it).
 * Additional validation via BLOCKED_INLINE_COMMANDS prevents dangerous operations.
 */
function runInlineShell(command, cwd, timeout) {
  if (!timeout) timeout = 10;
  if (!command || !command.trim()) return '';

  // Validate against blocked patterns
  const validation = validateInlineCommand(command);
  if (!validation.safe) {
    return '[inline-shell] Blocked: ' + validation.reason;
  }

  try {
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'powershell.exe' : (process.env.SHELL || '/bin/bash');
    const args = isWindows
      ? ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', command]
      : ['-c', command];

    const result = execFileSync(shell, args, {
      cwd: cwd || process.cwd(),
      timeout: Math.max(1, timeout) * 1000,
      encoding: 'utf-8',
      maxBuffer: 1024 * 10,
      windowsHide: true
    });
    return (result || '').trim().substring(0, MAX_INLINE_SHELL_OUTPUT);
  } catch (e) {
    return '[inline-shell] Error: ' + (e.message || 'unknown').substring(0, 100);
  }
}

function substituteInlineShell(content, context) {
  if (!content) return content;
  const cwd = (context && context.skillDir) ? context.skillDir : process.cwd();
  return content.replace(INLINE_SHELL_RE, (match, command) => {
    return runInlineShell(command.trim(), cwd);
  });
}

function processTemplate(content, context) {
  if (!content) return content;
  content = substituteTemplateVars(content, context);
  content = substituteInlineShell(content, context);
  return content;
}

module.exports = {
  substituteTemplateVars,
  substituteInlineShell,
  processTemplate,
  runInlineShell,
  validateInlineCommand,
  TEMPLATE_VAR_RE,
  INLINE_SHELL_RE
};