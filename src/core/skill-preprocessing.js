const { spawnSync } = require('child_process');


const TEMPLATE_VAR_RE = /\$\{(CRABPAW_SKILL_DIR|CRABPAW_SESSION_ID|CRABPAW_DATA_DIR|CRABPAW_PLATFORM)\}/g;

const INLINE_SHELL_RE = /!`([^`\n]+)`/g;

const INLINE_SHELL_MAX_OUTPUT = 4000;
const INLINE_SHELL_TIMEOUT = 10;
const INLINE_SHELL_DANGEROUS = /[;&|`$\x00<>]/; // eslint-disable-line no-control-regex

function sanitizeShellCommand(command) {
  if (typeof command !== 'string') return null;
  let sanitized = command.replace(/\x00/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n'); // eslint-disable-line no-control-regex
  sanitized = sanitized.split('\n')[0];
  sanitized = sanitized.trim();
  if (!sanitized) return null;
  if (INLINE_SHELL_DANGEROUS.test(sanitized)) return null;
  if (/^(rm|del|rd|rmdir|format|mkfs|dd|shutdown|reboot|chmod|xargs)\b/i.test(sanitized)) {
    return null;
  }
  return sanitized;
}

function substituteTemplateVars(content, { skillDir, sessionId, dataDir, platform }) {
  if (!content) return content;
  return content.replace(TEMPLATE_VAR_RE, (match, token) => {
    switch (token) {
      case 'CRABPAW_SKILL_DIR':
        return skillDir || match;
      case 'CRABPAW_SESSION_ID':
        return sessionId || match;
      case 'CRABPAW_DATA_DIR':
        return dataDir || match;
      case 'CRABPAW_PLATFORM':
        return platform || match;
      default:
        return match;
    }
  });
}

function runInlineShell(command, cwd, timeout) {
  timeout = Math.max(1, timeout || INLINE_SHELL_TIMEOUT);
  const safeCwd = cwd || process.cwd();
  const sanitized = sanitizeShellCommand(command);
  if (!sanitized) {
    return '[inline-shell blocked: command contains dangerous characters or is disallowed]';
  }
  try {
    const result = spawnSync(sanitized, {
      cwd: safeCwd,
      timeout: timeout * 1000,
      encoding: 'utf-8',
      maxBuffer: INLINE_SHELL_MAX_OUTPUT * 2,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (result.error) {
      const msg = (result.error.message || '').substring(0, 200);
      return `[inline-shell error: ${msg}]`;
    }
    if (result.status !== 0) {
      const stderr = (result.stderr || '').trim();
      const msg = stderr ? stderr.substring(0, 200) : `exit code ${result.status}`;
      return `[inline-shell error: ${msg}]`;
    }
    if (result.signal) {
      return `[inline-shell error: killed by signal ${result.signal}]`;
    }
    return (result.stdout || '').trim().substring(0, INLINE_SHELL_MAX_OUTPUT);
  } catch (err) {
    if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return '[inline-shell error: output exceeded max buffer]';
    }
    if (err.killed || err.code === 'ETIMEDOUT') {
      return `[inline-shell timeout after ${timeout}s: ${sanitized}]`;
    }
    const msg = (err.message || '').substring(0, 200);
    return `[inline-shell error: ${msg}]`;
  }
}

function expandInlineShell(content, { cwd, timeout, enabled }) {
  if (!content || enabled === false) return content;
  return content.replace(INLINE_SHELL_RE, (match, command) => {
    return runInlineShell(command, cwd, timeout);
  });
}

function preprocessSkillContent(content, options) {
  options = options || {};
  let result = content;
  result = substituteTemplateVars(result, {
    skillDir: options.skillDir,
    sessionId: options.sessionId,
    dataDir: options.dataDir,
    platform: options.platform,
  });
  result = expandInlineShell(result, {
    cwd: options.skillDir,
    timeout: options.shellTimeout,
    enabled: options.shellEnabled,
  });
  return result;
}

function extractSkillDescription(content) {
  if (!content) return '';
  const lines = content.split('\n');
  const descLines = [];
  let inFrontmatter = false;
  let frontmatterCount = 0;
  for (const line of lines) {
    if (line.trim() === '---') {
      frontmatterCount++;
      if (frontmatterCount === 2) {
        inFrontmatter = false;
        continue;
      }
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) continue;
    if (line.startsWith('# ')) {
      if (descLines.length === 0) {
        continue;
      }
      break;
    }
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('<!--')) {
      descLines.push(trimmed);
      if (descLines.length >= 3) break;
    }
  }
  return descLines.join(' ').substring(0, 200);
}

module.exports = {
  substituteTemplateVars,
  runInlineShell,
  expandInlineShell,
  preprocessSkillContent,
  extractSkillDescription,
  TEMPLATE_VAR_RE,
  INLINE_SHELL_RE,
  INLINE_SHELL_MAX_OUTPUT,
  INLINE_SHELL_TIMEOUT,
};
