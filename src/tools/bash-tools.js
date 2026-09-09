const { spawn } = require('child_process');
const { registry } = require('./registry');
const { getSandboxManager } = require('../core/security/sandbox');
const { getApprovalSystem } = require('../core/security/index');

const BASH_TIMEOUT = 120000;
const DANGEROUS_COMMANDS = [
  'rm -rf /',
  'rm -rf ~',
  'rm -rf *',
  ':(){:|:&};:',
  'mkfs',
  'dd if=',
  '> /dev/sda',
  'chmod -R 777 /',
  'chown -R',
  'wget',
  'curl -X POST',
  'nc -l',
  'ssh-keygen',
  'passwod',
  'su -',
  'sudo su'
];

const DANGEROUS_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)(\/|~|\*|\$\{?HOME\}?)/i,
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)(\/|~|\*|\$\{?HOME\}?)/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  />\s*\/dev\/[sh]d/i,
  /\bchmod\s+-R\s+777\s+\//i,
  /\bchown\s+-R\s+/i,
  /\bsudo\s+(su|i|bash|sh|zsh)\b/i,
  /\bsu\s+[-]\s*$/i,
  /\bnc\s+-l\b/i,
  /\bssh-keygen\b/i,
  /\bpasswd\b/i,
  /\bbase64\s+.*\|\s*(sh|bash|powershell)/i,
  /\beval\s+/i,
  /\bexec\s+/i,
  /\bformat\s+[a-zA-Z]:/i,
  /\bdel\s+\/[a-zA-Z]/i,
  /\bshutdown\s+(?:\/|-[a-z])/i,
  /\breboot\b/i,
  /\bhalt\b/i,
  /:\(\)\s*\{[^}]*\}[\s;]*:/i,
];

const confirmedPatterns = new Map();

/**
 * 读取用户终端输入（用于 CLI 授权交互）
 * 支持回车确认和超时自动拒绝
 * @param {number} timeoutMs - 超时毫秒数
 * @returns {Promise<string>}
 */
function readUserInput(timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('User input timeout'));
    }, timeoutMs);

    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      if (buf.includes('\n') || buf.includes('\r')) {
        cleanup();
        resolve(buf.replace(/[\r\n]+$/, '').replace(/\r/g, ''));
      }
    };

    const cleanup = () => {
      clearTimeout(timeout);
      try { process.stdin.removeListener('data', onData); } catch { console.warn('[bash-tools.js] failed to remove stdin listener during cleanup'); }
      try { process.stdin.pause(); } catch { console.warn('[bash-tools.js] failed to pause stdin during cleanup'); }
    };

    try {
      process.stdin.setEncoding('utf-8');
      process.stdin.on('data', onData);
      process.stdin.resume();
    } catch (err) { cleanup(); reject(err); }
  });
}

function addConfirmedPattern(pattern) {
  // S-1c 安全: 白名单按「规范化后完整命令串」存储——与 isCommandConfirmed 全等口径一致。
  confirmedPatterns.set(normalizeCommand(pattern.trim()).toLowerCase(), Date.now());
  console.log('✓ 命令白名单:', pattern);
}

function isCommandConfirmed(command) {
  // S-1c 安全(2026-08-28): 子串匹配删除, 改规范化后全等——
  // 此前 'wttr.in' 白名单使任何含该子串的命令(curl http://wttr.in/$(cat ../config))
  // 跳过全部检查+审批直执行。精确语义: 仅同一规范化命令串放行, TTL 24h 保留。
  const cmd = normalizeCommand(command).toLowerCase();
  const now = Date.now();
  const TTL = 24 * 60 * 60 * 1000;
  for (const [pattern, timestamp] of confirmedPatterns) {
    if (now - timestamp > TTL) {
      confirmedPatterns.delete(pattern);
      continue;
    }
    if (cmd === pattern) return true;
  }
  return false;
}

function normalizeCommand(command) {
  return command
    .replace(/['"]/g, '')
    .replace(/\$HOME/g, '~')
    .replace(/\$\{HOME\}/g, '~')
    .replace(/\\./g, m => m.charAt(1));
}

function isDangerousCommand(command) {
  const cmd = command.toLowerCase();
  if (DANGEROUS_COMMANDS.some(dangerous => cmd.includes(dangerous.toLowerCase()))) {
    return true;
  }
  const normalized = normalizeCommand(command).toLowerCase();
  if (DANGEROUS_COMMANDS.some(dangerous => normalized.includes(dangerous.toLowerCase()))) {
    return true;
  }
  if (DANGEROUS_PATTERNS.some(pattern => pattern.test(command))) {
    return true;
  }
  return false;
}

// ─── 2026-09-07: 只读命令免审批 ───
// GUI(非 TTY) 后端的审批队列没有终端入口，30s 必超时拒绝（实测"分析上传表格"
// 两轮都死在 dir 核对命令上，白白烧掉工具深度预算）。查看类命令对完成分析任务是
// 必需动作且无副作用，判定从保守：命令必须整体满足①非危险命令②无输出重定向
// ③每一段（按 | ; && & 切分）首词都是查看类原语，才免审批直执行。
const READONLY_VIEW_TOKEN_RE = /^\s*(dir|ls|ll|la|pwd|cat|type|head|tail|echo|which|where|whoami|hostname|stat|file|wc|findstr|grep|tree|more|uniq|cut|nl|diff|cmp|cksum)(\.exe)?(\s|$)/i;

function isReadonlySafeCommand(command) {
  if (!command || typeof command !== 'string') return false;
  if (isDangerousCommand(command)) return false;
  // 摘除 fd 复制(2>&1 / 1>&2)后，任何输出重定向(> / >>)都视为有写副作用
  const cleaned = command.replace(/2>&1|1>&2/g, ' ');
  if (/>{1,2}\s*[^\s&|]/.test(cleaned)) return false;
  const segments = cleaned.split(/\||&&|\|\||;|&/);
  return segments.every(seg => {
    const t = seg.trim();
    if (!t) return true; // 链接符两侧空隙
    return READONLY_VIEW_TOKEN_RE.test(t);
  });
}

async function handleBash(params, context) {
  const { command, blocking = true, timeout = BASH_TIMEOUT, cwd } = params;
  
  const sandbox = getSandboxManager();
  // 2026-08-13 P1-7: approve-with-edits——最终执行命令(审批可能编辑),默认原命令
  let finalCommand = command;
  
  // Layer 0: 白名单检查 —— 之前授权过的命令直接跳过安全检查
  if (isCommandConfirmed(command)) {
    // 已确认，跳过检查
  } else {
    // Layer 1: 危险命令检查
    const dangerous = isDangerousCommand(command);

    // Layer 2: 沙箱策略检查
    const sandboxCheck = sandbox.validateExecute(command);
    const blocked = dangerous || !sandboxCheck.allowed;

    // 2026-09-07: 只读命令免审批直执行——GUI(非 TTY) 审批队列无确认入口，
    // 30s 必超时拒绝。判定见 isReadonlySafeCommand（非危险 + 无写重定向 +
    // 全部命令段为查看类原语）。
    if (blocked && isReadonlySafeCommand(command)) {
      console.log(`📖 [Bash] 只读命令免审批直执行: ${command.slice(0, 100)}`);
    } else if (blocked) {
      const reasons = [];
      if (dangerous) reasons.push('危险命令模式');
      if (!sandboxCheck.allowed) reasons.push(`沙箱拦截: ${sandboxCheck.reason}`);

      const approval = getApprovalSystem();

      // 通过 ApprovalSystem 发起审批请求（同时通过 SSE 推送到 GUI 前端）
      const approvalRequest = await approval.request(command, {
        ...context,
        message: `此操作被安全规则拦截，原因：${reasons.join('；')}\n命令内容：\`${command}\`\n是否授权执行？（授权仅对本次操作有效，不会永久放行）`,
        source: 'bash-tools',
      });

      // 无 requestId 说明是自动审批结果（auto_approved / auto_denied / off 模式）
      if (!approvalRequest.requestId) {
        if (approvalRequest.status === 'auto_approved' || approvalRequest.status === 'approved') {
          console.log('\u2705 安全系统自动放行:', approvalRequest.reason);
        } else {
          throw new Error(`安全系统自动拒绝: ${approvalRequest.reason}`);
        }
      } else {
        // ── 审批决策双通道消费（发布 P1-2 根因修复）──────────────────────────────
        // - 终端 TTY（CLI）：保留交互式输入流程（现行为不变）；
        // - 非 TTY（GUI 启动的后端）：改走 ApprovalSystem 事件通道——GUI 经
        //   ApprovalHost → POST /api/security/approval（或 AG-UI resume）→ approval.respond
        //   → 'responded' 事件 → waitForApproval 决议。
        // 旧实现非 TTY 也读终端 stdin：GUI 后端 stdin 恒无输入 → 100% 30s 超时 →
        // 「审批超时」被误记为工具失败（skill-usage.json 实测 Bash 53/53 全失败、
        // 命令从未执行）——且超时 catch 会 respond(false) 覆盖 GUI 已做出的批准。
        const reasonsStr = reasons.join('；');
        const cmdPreview = command.slice(0, 100);
        const useTty = !!(process.stdin && process.stdin.isTTY);

        try {
          let approved = false;
          let resp = null;
          if (useTty) {
            const boxLines = [
              '',
              '╔══════════════════════════════════════════════╗',
              '║      U0001f512 操作被安全规则拦截                          ║',
              '╠══════════════════════════════════════════════╣',
              '║  内容: ' + cmdPreview + '  ║',
              '║  原因: ' + reasonsStr + '  ║',
              '╠══════════════════════════════════════════════╣',
              '║  请输入“授权”或“可以”确认执行此操作                ║',
              '║  输入其他内容或等待 30 秒将自动拒绝                ║',
              '╚══════════════════════════════════════════════╝',
              '> ',
            ].join('\n');
            process.stdout.write(boxLines);

            const userInput = await readUserInput(30000);
            const trimmed = (userInput || '').trim().toLowerCase();
            const approveKeywords = ['授权', '可以'];
            approved = approveKeywords.some(kw => trimmed === kw);
            resp = await approval.respond(approvalRequest.requestId, approved, 'once');
          } else {
            console.log(`🔒 [Bash] 命令已进入审批队列，等待前端确认: ${cmdPreview}`);
            const decision = await approval.waitForApproval(approvalRequest.requestId, 30000);
            approved = !!(decision && decision.approved);
            resp = decision ? { command: decision.command || null } : null;
          }

          // 2026-08-13 P1-7: approve-with-edits 防御性消费——GUI 审批可能携带编辑后的命令;
          // 编辑后的命令需重检(与 exec-approval 同规则, fail closed)
          if (approved && resp && resp.command && resp.command !== command) {
            finalCommand = resp.command;
            const reDangerous = isDangerousCommand(finalCommand);
            const reSandbox = sandbox.validateExecute(finalCommand);
            if (reDangerous || !reSandbox.allowed) {
              throw new Error(`编辑后的命令未通过安全检查: ${reSandbox.reason || '危险命令模式'}`);
            }
          }

          if (approved) {
            console.log(`✅ 用户已授权命令: ${finalCommand.slice(0, 120)}`);
            // 授权仅对本次操作有效，不加永久白名单
          } else {
            console.log(`❌ 用户拒绝执行: ${command.slice(0, 120)}`);
            throw new Error(`用户拒绝执行: ${command}`);
          }
        } catch (err) {
          if (err.message.includes('timeout') || err.message.includes('User input') || err.message.includes('审批超时')) {
            // 仅终端路径需要 respond(false) 收尾；waitForApproval 超时时审批系统自身已 auto_deny
            if (useTty) {
              await approval.respond(approvalRequest.requestId, false, 'once').catch(e => console.debug('[bash] Approval respond failed:', e?.message));
            }
            throw new Error('⏱️ 审批超时或无终端输入，已自动拒绝');
          }
          throw err;
        }
      }
    }
  }
  
  if (cwd) {
    const readCheck = sandbox.validateRead(cwd);
    if (!readCheck.allowed) {
      throw new Error(`Sandbox blocked read access to working directory: ${readCheck.reason}`);
    }
    const writeCheck = sandbox.validateWrite(cwd);
    if (!writeCheck.allowed) {
      throw new Error(`Sandbox blocked write access to working directory: ${writeCheck.reason}`);
    }
  }
  
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
  const shellArgs = process.platform === 'win32' ? ['-Command', finalCommand || command] : ['-c', finalCommand || command];
  
  const proc = spawn(shell, shellArgs, {
    cwd: cwd || process.cwd(),
    env: { ...process.env, PAGER: 'cat' },
    stdio: ['ignore', 'pipe', 'pipe'],
    // 2026-08-22 实机修复: windowsHide——GUI 模式下无此选项每次执行弹 CMD 窗口
    windowsHide: true
  });
  
  // 非阻塞模式：立即返回进程信息
  if (!blocking) {
    // eslint-disable-next-line no-unused-vars
    let stdout = '';
    // eslint-disable-next-line no-unused-vars
    let stderr = '';
    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    
    // 设置超时保护，防止进程泄漏
    const timeoutId = setTimeout(() => {
      proc.kill();
    }, timeout);
    
    proc.on('close', () => { clearTimeout(timeoutId); });
    
    return {
      pid: proc.pid,
      status: 'running',
      command,
      message: `进程已启动 (PID: ${proc.pid})，非阻塞模式不等待结果`
    };
  }
  
  // 阻塞模式：等待完成
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timeoutId;
    
    timeoutId = setTimeout(() => {
      proc.kill();
      reject(new Error(`命令执行超时 (${timeout}ms)`));
    }, timeout);
    
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    proc.on('close', (code) => {
      clearTimeout(timeoutId);
      resolve({
        stdout: stdout.slice(-10000),
        stderr: stderr.slice(-5000),
        exitCode: code,
        success: code === 0
      });
    });
    
    proc.on('error', (error) => {
      clearTimeout(timeoutId);
      reject(error);
    });
  });
}

registry.register({
  name: 'Bash',
  toolset: 'system',
  category: 'execution',
  description: '执行命令行命令',
  schema: {
    description: '在 shell 中执行命令',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        blocking: { type: 'boolean', description: '是否阻塞等待完成' },
        timeout: { type: 'integer', description: '超时时间 (ms)' },
        cwd: { type: 'string', description: '工作目录' }
      },
      required: ['command']
    }
  },
  handler: handleBash,
  checkFn: (params) => params.command && typeof params.command === 'string',
  timeout: 120000,
  isDangerous: true,
  selfApproval: true,
  isReadOnly: false
});

console.log('🔧 系统工具集已注册:', registry.getByToolset('system').map(t => t.name).join(', '));

module.exports = {
  handleBash,
  addConfirmedPattern,
  isCommandConfirmed,
  isDangerousCommand
};
