const { spawn } = require('child_process');

const { registry } = require('./registry');
const { buildRegistryParameters } = require('../core/desktop/schema');
// eslint-disable-next-line no-unused-vars
const { logDesktopControl, logSecurityBlock, RISK_LEVELS } = require('../core/audit-log');
const { getApprovalSystem } = require('../core/security/index');

const DESKTOP_TIMEOUT = 30000;

// 2026-09-06: 移除 'wechat'——微信桌面监控能力已全量退役(见 docs/retrospective/
// 2026-08-18-deep-retrospective.md)，不再允许 agent 拉起微信桌面端。
const ALLOWED_APPS = new Set([
  'chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi',
  'notepad', 'notepad++', 'code', 'codium', 'sublime_text', 'atom',
  'explorer', 'calc', 'calculator', 'mspaint', 'wordpad', 'snippingtool',
  'dingtalk', 'feishu', 'qq', 'tim', 'telegram', 'discord',
  'winword', 'excel', 'powerpnt', 'outlook', 'onenote',
  'control', 'taskmgr', 'wt',
  'steam', 'spotify', 'vlc', 'potplayer',
  'terminal', 'iterm', 'safari', 'mail', 'calendar', 'notes',
  'textedit', 'preview', 'activitymonitor', 'systempreferences',
]);

const UWP_APP_MAP = {
  'calc': 'shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App',
  'calculator': 'shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App',
};

const ALLOWED_BROWSERS = new Set([
  'chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'safari',
]);

const ALLOWED_URL_SCHEMES = new Set(['http', 'https']);

const BLOCKED_PATH_PATTERNS = [
  /^[A-Za-z]:\\(Windows|Program Files|Program Files \(x86\)|ProgramData)[\\/]?/i,
  /^\/(etc|usr|var|boot|sys|proc|root)[/]/,
  /^\/(etc|usr|var|boot|sys|proc|root)\/?$/,
  /\.\.(\\|\/)/,
];

const BLOCKED_TITLE_PATTERNS = [
  /[;&|`$<>]/,
  /\$\(/,
];

const DANGEROUS_PS_PATTERNS = [
  /Remove-Item/i,
  /Stop-Process/i,
  /Set-ExecutionPolicy/i,
  /Invoke-Expression/i,
  /New-Object\s+System\.Net/i,
  /Start-Process.*-Verb\s+RunAs/i,
  /\[System\.Reflection\.Assembly\]/i,
  /Invoke-WebRequest.*-OutFile/i,
  /net\s+(user|localgroup|share)/i,
  /reg\s+(add|delete|import)/i,
  /schtasks\s+\/(create|delete|change)/i,
  /wmic\s+/i,
];

const DANGEROUS_SHELL_PATTERNS = [
  /rm\s+-rf/i,
  /curl.*\|\s*(bash|sh)/i,
  /wget.*\|\s*(bash|sh)/i,
  />\s*\/dev\//i,
  /chmod\s+777/i,
  /mkfs/i,
  /dd\s+if=/i,
];

const AUDIT_LOG = [];
const MAX_AUDIT_LOG = 5000;

function auditLog(action, params, result) {
  AUDIT_LOG.push({
    ts: Date.now(),
    action,
    params: _truncateParams(params),
    success: result.success,
    risk: result._risk || 'low',
  });
  if (AUDIT_LOG.length > MAX_AUDIT_LOG) AUDIT_LOG.shift();

  try {
    logDesktopControl('system', action, _truncateParams(params), result);
  } catch (e) { console.warn('[desktop-tools] audit log failed:', e.message); }
}

function auditSecurityBlock(action, params, reason) {
  try {
    logSecurityBlock('system', 'DesktopControl', reason, { action, params: _truncateParams(params) });
  } catch (e) { console.warn('[desktop-tools] audit log failed:', e.message); }
}

function _truncateParams(params) {
  const s = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string' && v.length > 100) {
      s[k] = v.substring(0, 100) + '...';
    } else {
      s[k] = v;
    }
  }
  return s;
}

function classifyError(error) {
  const msg = (error?.message || String(error)).toLowerCase();
  if (msg.includes('timeout') || msg.includes('超时')) return { type: 'timeout', retryable: true, hint: '操作超时，可尝试简化操作或增加超时时间' };
  if (msg.includes('enoent') || msg.includes('not found') || msg.includes('找不到')) return { type: 'not_found', retryable: false, hint: '目标不存在，请检查名称或路径' };
  if (msg.includes('eacces') || msg.includes('permission') || msg.includes('权限')) return { type: 'permission', retryable: false, hint: '权限不足，请检查访问权限' };
  if (msg.includes('network') || msg.includes('enet') || msg.includes('网络')) return { type: 'network', retryable: true, hint: '网络问题，可稍后重试' };
  if (msg.includes('安全策略') || msg.includes('blocked')) return { type: 'security', retryable: false, hint: '操作被安全策略拦截' };
  return { type: 'unknown', retryable: false, hint: '操作失败，请检查参数后重试' };
}

function sanitizeShellArg(str) {
  if (typeof str !== 'string') return '';
  let s = str;
  // 移除命令注入相关字符，但保留反斜杠（Windows路径需要）
  s = s.replace(/[`]/g, '');
  s = s.replace(/\$\(/g, '');
  s = s.replace(/\$\{/g, '');
  s = s.replace(/;/g, '');
  s = s.replace(/\|/g, '');
  s = s.replace(/&/g, '');
  s = s.replace(/>/g, '');
  s = s.replace(/</g, '');
  s = s.replace(/\n/g, ' ');
  s = s.replace(/\r/g, '');
  return s.trim();
}

function sanitizePath(filePath) {
  if (typeof filePath !== 'string') return '';
  let s = filePath.replace(/\0/g, '');
  for (const pat of BLOCKED_PATH_PATTERNS) {
    if (pat.test(s)) return '';
  }
  return s.trim();
}

function sanitizeUrl(url) {
  if (typeof url !== 'string') return '';
  if (url.includes('\0') || url.includes('%00')) return '';
  try {
    const parsed = new URL(url);
    if (!ALLOWED_URL_SCHEMES.has(parsed.protocol.replace(':', ''))) return '';
    return url.trim();
  } catch {
    return '';
  }
}

function validateApp(app) {
  if (!app || typeof app !== 'string') return false;
  const lower = app.toLowerCase().replace(/\.exe$/i, '');
  return ALLOWED_APPS.has(lower);
}

function validateBrowser(browser) {
  if (!browser) return true;
  const lower = browser.toLowerCase().replace(/\.exe$/i, '');
  return ALLOWED_BROWSERS.has(lower);
}

function validateTitle(title) {
  if (!title || typeof title !== 'string') return false;
  for (const pat of BLOCKED_TITLE_PATTERNS) {
    if (pat.test(title)) return false;
  }
  return true;
}

function validateKey(key) {
  if (!key || typeof key !== 'string') return false;
  const allowedKeys = new Set([
    'enter', 'return', 'tab', 'escape', 'esc', 'backspace', 'delete',
    'space', 'up', 'down', 'left', 'right', 'home', 'end',
    'pageup', 'pagedown', 'insert',
    'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
    'ctrl', 'alt', 'shift', 'win', 'cmd',
    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
    'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  ]);
  return allowedKeys.has(key.toLowerCase());
}

function validateModifiers(modifiers) {
  if (!Array.isArray(modifiers)) return true;
  const allowed = new Set(['ctrl', 'alt', 'shift', 'win', 'cmd']);
  return modifiers.every(m => allowed.has(m.toLowerCase()));
}

function validateClipboardAction(action) {
  return ['copy', 'paste', 'set', 'get'].includes(action);
}

function validateRegion(region) {
  if (!region || typeof region !== 'string') return true;
  return /^\d+,\d+,\d+,\d+$/.test(region);
}

function checkCommandSafety(command) {
  const platform = detectPlatform();
  const patterns = platform === 'win32' ? DANGEROUS_PS_PATTERNS : DANGEROUS_SHELL_PATTERNS;
  for (const pat of patterns) {
    if (pat.test(command)) return false;
  }
  return true;
}

function detectPlatform() {
  return process.platform;
}

async function executeCommand(command, timeout = DESKTOP_TIMEOUT) {
  // Layer 0: 安全检查 + 授权审批
  if (!checkCommandSafety(command)) {
    // 尝试授权审批系统
    try {
      const approval = getApprovalSystem();
      const approvalRequest = await approval.request(command, {
        message: '此操作被安全规则拦截。\n命令内容：' + command.slice(0, 200) + '\n是否授权执行？（授权仅对本次操作有效，不会永久放行）',
        source: 'desktop-tools',
      });
      
      if (approvalRequest.requestId) {
        // 等待用户 GUI 审批
        const result = await approval.waitForApproval(approvalRequest.requestId, 30000);
        if (result.approved) {
          console.log('[桌面控制] 用户已授权命令:', command.slice(0, 120));
        } else {
          auditSecurityBlock('execute_command', { command: command.slice(0, 100) }, '用户拒绝授权');
          return { stdout: '', stderr: '操作被用户拒绝授权', exitCode: 1, success: false };
        }
      } else if (approvalRequest.status === 'auto_approved' || approvalRequest.status === 'approved') {
        console.log('[桌面控制] 安全系统自动放行:', approvalRequest.reason);
      } else {
        auditSecurityBlock('execute_command', { command: command.slice(0, 100) }, '安全系统自动拒绝: ' + (approvalRequest.reason || ''));
        return { stdout: '', stderr: '操作被安全系统自动拒绝: ' + (approvalRequest.reason || ''), exitCode: 1, success: false };
      }
    } catch (e) {
      auditSecurityBlock('execute_command', { command: command.slice(0, 100) }, '检测到危险命令模式，审批系统不可用: ' + (e.message || ''));
      return { stdout: '', stderr: '操作被安全策略拦截：检测到危险命令模式', exitCode: 1, success: false };
    }
  }

  return _executeWithRetry(command, timeout);
}

async function _executeWithRetry(command, timeout, maxRetries = 1) {
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await _executeOnce(command, timeout);
      if (result.success || result.exitCode !== null) {
        return result;
      }
      lastError = new Error(`进程异常退出，exitCode=${result.exitCode}`);
    } catch (error) {
      lastError = error;
      if (error.message && error.message.includes('超时')) {
        break;
      }
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }

  return {
    stdout: '',
    stderr: lastError?.message || '未知错误',
    exitCode: -1,
    success: false,
  };
}

function _executeOnce(command, timeout) {
  return new Promise((resolve, reject) => {
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
    const shellArgs = process.platform === 'win32' ? ['-Command', command] : ['-c', command];

    const proc = spawn(shell, shellArgs, {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      // 2026-08-22 实机修复: windowsHide——GUI 模式防 CMD 弹窗（同 safe-exec）
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let timeoutId;

    timeoutId = setTimeout(() => {
      proc.kill();
      reject(new Error(`桌面操作超时 (${timeout}ms)`));
    }, timeout);

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timeoutId);
      resolve({
        stdout: stdout.slice(-5000),
        stderr: stderr.slice(-3000),
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

async function openApplication(params) {
  const { app, arguments: appArgs = '' } = params;

  if (!validateApp(app)) {
    const result = { success: false, action: 'open_application', app, message: `应用不在允许列表中: ${app}。允许的应用: ${[...ALLOWED_APPS].slice(0, 20).join(', ')}...`, _risk: 'blocked' };
    auditLog('open_application', params, result);
    auditSecurityBlock('open_application', params, `应用不在允许列表: ${app}`);
    return result;
  }

  const platform = detectPlatform();
  const safeApp = sanitizeShellArg(app);
  let command;

  if (platform === 'win32') {
    if (UWP_APP_MAP[safeApp.toLowerCase()]) {
      const uwpPath = UWP_APP_MAP[safeApp.toLowerCase()];
      command = `[System.Diagnostics.Process]::Start('explorer.exe', '${uwpPath}')`;
    } else if (appArgs) {
      const safeArgs = sanitizeShellArg(appArgs);
      command = `Start-Process "${safeApp}" -ArgumentList "${safeArgs}"`;
    } else {
      command = `Start-Process "${safeApp}"`;
    }
  } else if (platform === 'darwin') {
    if (appArgs) {
      const safeArgs = sanitizeShellArg(appArgs);
      command = `open -a "${safeApp}" --args ${safeArgs}`;
    } else {
      command = `open -a "${safeApp}"`;
    }
  } else {
    if (appArgs) {
      const safeArgs = sanitizeShellArg(appArgs);
      command = `${safeApp} ${safeArgs} &`;
    } else {
      command = `${safeApp} &`;
    }
  }

  try {
    const result = await executeCommand(command);
    const ret = {
      success: result.success,
      action: 'open_application',
      app,
      message: result.success ? `已启动应用: ${app}` : `启动应用失败: ${result.stderr || '未知错误'}`,
      exitCode: result.exitCode
    };
    auditLog('open_application', params, ret);
    return ret;
  } catch (e) {
    const ret = { success: false, action: 'open_application', app, message: `启动应用异常: ${e.message}` };
    auditLog('open_application', params, ret);
    return ret;
  }
}

async function openUrl(params) {
  const { url, browser } = params;
  const safeUrl = sanitizeUrl(url);

  if (!safeUrl) {
    const result = { success: false, action: 'open_url', url, message: 'URL格式无效或使用了不允许的协议(仅允许http/https)', _risk: 'blocked' };
    auditLog('open_url', params, result);
    return result;
  }

  if (browser && !validateBrowser(browser)) {
    const result = { success: false, action: 'open_url', url, message: `浏览器不在允许列表中: ${browser}`, _risk: 'blocked' };
    auditLog('open_url', params, result);
    return result;
  }

  const platform = detectPlatform();
  let command;

  if (platform === 'win32') {
    command = browser
      ? `Start-Process "${sanitizeShellArg(browser)}" "${safeUrl}"`
      : `Start-Process "${safeUrl}"`;
  } else if (platform === 'darwin') {
    command = browser
      ? `open -a "${sanitizeShellArg(browser)}" "${safeUrl}"`
      : `open "${safeUrl}"`;
  } else {
    command = browser
      ? `${sanitizeShellArg(browser)} "${safeUrl}" &`
      : `xdg-open "${safeUrl}" &`;
  }

  try {
    const result = await executeCommand(command);
    const ret = {
      success: result.success,
      action: 'open_url',
      url: safeUrl,
      message: result.success ? `已打开URL: ${safeUrl}` : `打开URL失败: ${result.stderr || '未知错误'}`,
      exitCode: result.exitCode
    };
    auditLog('open_url', params, ret);
    return ret;
  } catch (e) {
    const ret = { success: false, action: 'open_url', url: safeUrl, message: `打开URL异常: ${e.message}` };
    auditLog('open_url', params, ret);
    return ret;
  }
}

async function openFolder(params) {
  const { path: folderPath } = params;
  const safePath = sanitizePath(folderPath);

  if (!safePath) {
    const result = { success: false, action: 'open_folder', path: folderPath, message: '路径无效或包含安全限制的目录', _risk: 'blocked' };
    auditLog('open_folder', params, result);
    return result;
  }

  const platform = detectPlatform();
  let command;

  if (platform === 'win32') {
    command = `explorer "${safePath}"`;
  } else if (platform === 'darwin') {
    command = `open "${safePath}"`;
  } else {
    command = `xdg-open "${safePath}"`;
  }

  try {
    const result = await executeCommand(command);
    const ret = {
      success: result.success,
      action: 'open_folder',
      path: safePath,
      message: result.success ? `已打开文件夹: ${safePath}` : `打开文件夹失败: ${result.stderr || '未知错误'}`,
      exitCode: result.exitCode
    };
    auditLog('open_folder', params, ret);
    return ret;
  } catch (e) {
    const ret = { success: false, action: 'open_folder', path: safePath, message: `打开文件夹异常: ${e.message}` };
    auditLog('open_folder', params, ret);
    return ret;
  }
}

async function searchWeb(params) {
  const { query, engine = 'bing' } = params;
  const engineUrls = {
    bing: 'https://www.bing.com/search?q=',
    baidu: 'https://www.baidu.com/s?wd=',
    google: 'https://www.google.com/search?q=',
    sogou: 'https://www.sogou.com/web?query=',
    toutiao: 'https://so.toutiao.com/search?keyword=',
    '360': 'https://www.so.com/s?q='
  };
  const baseUrl = engineUrls[engine] || engineUrls.bing;
  const safeQuery = sanitizeShellArg(query);
  const url = baseUrl + encodeURIComponent(safeQuery);

  return openUrl({ url });
}

async function listRunningApps() {
  const platform = detectPlatform();
  let command;

  if (platform === 'win32') {
    command = 'Get-Process | Where-Object { $_.MainWindowTitle -ne "" } | Select-Object ProcessName, Id, MainWindowTitle | ConvertTo-Json';
  } else if (platform === 'darwin') {
    command = 'osascript -e \'tell application "System Events" to get name of every process whose background only is false\'';
  } else {
    command = 'wmctrl -l';
  }

  try {
    const result = await executeCommand(command);
    const ret = {
      success: result.success,
      action: 'list_running_apps',
      apps: result.stdout.trim(),
      message: result.success ? '获取运行中的应用列表成功' : `获取应用列表失败: ${result.stderr || '未知错误'}`
    };
    auditLog('list_running_apps', {}, ret);
    return ret;
  } catch (e) {
    const ret = { success: false, action: 'list_running_apps', message: `获取应用列表异常: ${e.message}` };
    auditLog('list_running_apps', {}, ret);
    return ret;
  }
}

async function activateWindow(params) {
  const { title } = params;

  if (!validateTitle(title)) {
    const result = { success: false, action: 'activate_window', title, message: '窗口标题包含不允许的特殊字符', _risk: 'blocked' };
    auditLog('activate_window', params, result);
    auditSecurityBlock('activate_window', params, '窗口标题包含不允许的特殊字符');
    return result;
  }

  const platform = detectPlatform();
  const safeTitle = sanitizeShellArg(title);
  let command;

  if (platform === 'win32') {
    command = `Add-Type -TypeDefinition "using System;using System.Runtime.InteropServices;public class Win{[DllImport(\\"user32.dll\\")]public static extern bool SetForegroundWindow(IntPtr hWnd);}" -PassThru | Out-Null; $w = Get-Process | Where-Object { $_.MainWindowTitle -like "*${safeTitle}*" } | Select-Object -First 1; if ($w) { [Win]::SetForegroundWindow($w.MainWindowHandle) }`;
  } else if (platform === 'darwin') {
    command = `osascript -e 'tell application "${safeTitle}" to activate'`;
  } else {
    command = `wmctrl -a "${safeTitle}"`;
  }

  try {
    const result = await executeCommand(command);
    const ret = {
      success: result.success,
      action: 'activate_window',
      title,
      message: result.success ? `已激活窗口: ${title}` : `激活窗口失败: ${result.stderr || '未知错误'}`
    };
    auditLog('activate_window', params, ret);
    return ret;
  } catch (e) {
    const ret = { success: false, action: 'activate_window', title, message: `激活窗口异常: ${e.message}` };
    auditLog('activate_window', params, ret);
    return ret;
  }
}

async function screenshot(params) {
  const { path: savePath, region } = params;

  if (!validateRegion(region)) {
    const result = { success: false, action: 'screenshot', message: '截图区域格式无效，应为: x,y,width,height', _risk: 'blocked' };
    auditLog('screenshot', params, result);
    return result;
  }

  const platform = detectPlatform();
  let command;

  if (platform === 'win32') {
    const targetPath = savePath ? sanitizePath(savePath) : `${process.env.TEMP || '/tmp'}/crabpaw_screenshot_${Date.now()}.png`;
    if (savePath && !targetPath) {
      const result = { success: false, action: 'screenshot', message: '截图保存路径无效', _risk: 'blocked' };
      auditLog('screenshot', params, result);
      return result;
    }
    command = `Add-Type -AssemblyName System.Windows.Forms; $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size); $bmp.Save("${targetPath}"); $g.Dispose(); $bmp.Dispose(); Write-Output "${targetPath}"`;
  } else if (platform === 'darwin') {
    const targetPath = savePath ? sanitizePath(savePath) : `/tmp/crabpaw_screenshot_${Date.now()}.png`;
    command = `screencapture -x "${targetPath}" && echo "${targetPath}"`;
  } else {
    const targetPath = savePath ? sanitizePath(savePath) : `/tmp/crabpaw_screenshot_${Date.now()}.png`;
    command = `import -window root "${targetPath}" && echo "${targetPath}"`;
  }

  try {
    const result = await executeCommand(command, 15000);
    const ret = {
      success: result.success,
      action: 'screenshot',
      path: result.stdout.trim(),
      message: result.success ? `截图已保存: ${result.stdout.trim()}` : `截图失败: ${result.stderr || '未知错误'}`
    };
    auditLog('screenshot', params, ret);
    return ret;
  } catch (e) {
    const ret = { success: false, action: 'screenshot', message: `截图异常: ${e.message}` };
    auditLog('screenshot', params, ret);
    return ret;
  }
}

async function typeText(params) {
  const { text, delay = 50 } = params;

  if (!text || typeof text !== 'string') {
    const result = { success: false, action: 'type_text', message: 'text参数不能为空', _risk: 'blocked' };
    auditLog('type_text', params, result);
    return result;
  }

  if (text.length > 5000) {
    const result = { success: false, action: 'type_text', message: '输入文本过长(最大5000字符)', _risk: 'blocked' };
    auditLog('type_text', params, result);
    return result;
  }

  const platform = detectPlatform();
  let command;

  if (platform === 'win32') {
    // 安全转义：SendKeys特殊字符 + PowerShell特殊字符
    // 单引号在PowerShell单引号字符串中用 '' 转义
    // SendKeys: + ^ % ~ { } ( ) 需要用 {} 包裹
    // PowerShell: ` $ 在单引号字符串中不需要转义，但为了安全还是处理
    const escapedText = text
      .replace(/'/g, "''")  // PowerShell单引号转义
      .replace(/\n/g, '{ENTER}');  // SendKeys换行
    command = `Add-Type -AssemblyName System.Windows.Forms; Start-Sleep -Milliseconds 300; [System.Windows.Forms.SendKeys]::SendWait('${escapedText}')`;
  } else if (platform === 'darwin') {
    const escapedText = text.replace(/"/g, '\\"').replace(/\\/g, '\\\\');
    command = `osascript -e 'tell application "System Events" to keystroke "${escapedText}"'`;
  } else {
    const escapedText = text.replace(/"/g, '\\"');
    command = `xdotool type --delay ${delay} "${escapedText}"`;
  }

  try {
    const result = await executeCommand(command, 10000);
    const ret = {
      success: result.success,
      action: 'type_text',
      text: text.substring(0, 50) + (text.length > 50 ? '...' : ''),
      message: result.success ? `已输入文本: ${text.substring(0, 30)}...` : `输入文本失败: ${result.stderr || '未知错误'}`
    };
    auditLog('type_text', params, ret);
    return ret;
  } catch (e) {
    const ret = { success: false, action: 'type_text', message: `输入文本异常: ${e.message}` };
    auditLog('type_text', params, ret);
    return ret;
  }
}

// macOS 物理键码（osascript `key code` 只接受数字，此前传 'Enter' 等名字是非法 AppleScript）
const MAC_KEY_CODES = {
  enter: 36, return: 36, tab: 48, escape: 53, esc: 53,
  backspace: 51, delete: 51, space: 49,
  up: 126, down: 125, left: 123, right: 124,
  home: 115, end: 119, pageup: 116, pagedown: 121,
};
// osascript 修饰键名
const MAC_MODIFIERS = {
  ctrl: 'control down', control: 'control down',
  alt: 'option down', shift: 'shift down',
  win: 'command down', meta: 'command down', cmd: 'command down',
};
// registry 允许 Control/Alt/Shift/Meta 形态，内部统一为 ctrl/alt/shift/win
function _normalizeModifiers(modifiers) {
  const norm = { control: 'ctrl', ctrl: 'ctrl', alt: 'alt', shift: 'shift', meta: 'win', win: 'win', cmd: 'win' };
  return (modifiers || []).map(m => norm[String(m).toLowerCase()] || String(m).toLowerCase());
}

async function pressKey(params) {
  const { key, modifiers = [] } = params;

  if (!validateKey(key)) {
    const result = { success: false, action: 'press_key', key, message: `按键不在允许列表中: ${key}`, _risk: 'blocked' };
    auditLog('press_key', params, result);
    auditSecurityBlock('press_key', params, `按键不在允许列表: ${key}`);
    return result;
  }

  if (!validateModifiers(modifiers)) {
    const result = { success: false, action: 'press_key', key, message: '修饰键不在允许列表中', _risk: 'blocked' };
    auditLog('press_key', params, result);
    auditSecurityBlock('press_key', params, '修饰键不在允许列表');
    return result;
  }

  const platform = detectPlatform();
  // 修饰键规范化后的完整组合, 如 'ctrl+shift+s' / 'enter' / 'ctrl'
  const mods = _normalizeModifiers(modifiers);
  const combo = [...mods, String(key).toLowerCase()].join('+');

  try {
    if (platform === 'win32') {
      // P1 修复(2026-09-06): 修饰键组合此前生成 '{Ctrlc}' 这类非法 SendKeys 语法
      // (花括号是转义符, 会打字面文本而非按组合键)。统一走 ComputerUse 后端
      // composeSendKeys 生成正确语法(^+c / {ENTER}), 同时接上后端 emit('action') 事件。
      const backend = await _getComputerBackend();
      if (!backend) {
        const ret = { success: false, action: 'press_key', key, modifiers, message: 'ComputerUse后端不可用' };
        auditLog('press_key', params, ret);
        return ret;
      }
      await backend.key(combo);
      const ret = { success: true, action: 'press_key', key, modifiers, message: `已按键: ${combo}` };
      auditLog('press_key', params, ret);
      return ret;
    }

    let command;
    if (platform === 'darwin') {
      const modParts = mods.map(m => MAC_MODIFIERS[m]).filter(Boolean).join(', ');
      const usingClause = modParts ? ` using {${modParts}}` : '';
      const keyCode = MAC_KEY_CODES[key.toLowerCase()];
      if (keyCode !== undefined) {
        command = `osascript -e 'tell application "System Events" to key code ${keyCode}${usingClause}'`;
      } else {
        // 字符键（c/v/1 等白名单单字符）走 keystroke
        command = `osascript -e 'tell application "System Events" to keystroke "${key.toLowerCase()}"${usingClause}'`;
      }
    } else {
      // Linux xdotool: keysym 名组合（ctrl+c），win → super
      const xdoMods = mods.map(m => (m === 'win' ? 'super' : m));
      command = `xdotool key ${[...xdoMods, key.toLowerCase()].join('+')}`;
    }

    const result = await executeCommand(command, 5000);
    const ret = {
      success: result.success,
      action: 'press_key',
      key,
      modifiers,
      message: result.success ? `已按键: ${combo}` : `按键失败: ${result.stderr || '未知错误'}`
    };
    auditLog('press_key', params, ret);
    return ret;
  } catch (e) {
    const ret = { success: false, action: 'press_key', key, modifiers, message: `按键异常: ${e.message}` };
    auditLog('press_key', params, ret);
    return ret;
  }
}

async function clipboardAction(params) {
  const { clipboard_action, text } = params;

  if (!validateClipboardAction(clipboard_action)) {
    const result = { success: false, action: 'clipboard', message: `未知剪贴板操作: ${clipboard_action}`, _risk: 'blocked' };
    auditLog('clipboard', params, result);
    return result;
  }

  const platform = detectPlatform();
  let command;

  if (clipboard_action === 'copy') {
    if (platform === 'win32') {
      command = `Add-Type -AssemblyName System.Windows.Forms; Start-Sleep -Milliseconds 100; [System.Windows.Forms.SendKeys]::SendWait('^c'); Start-Sleep -Milliseconds 300; [System.Windows.Forms.Clipboard]::GetText()`;
    } else if (platform === 'darwin') {
      command = `osascript -e 'tell application "System Events" to keystroke "c" using command down' && pbpaste`;
    } else {
      command = `xdotool key ctrl+c && sleep 0.3 && xclip -selection clipboard -o`;
    }
  } else if (clipboard_action === 'paste') {
    if (platform === 'win32') {
      command = `Add-Type -AssemblyName System.Windows.Forms; Start-Sleep -Milliseconds 100; [System.Windows.Forms.SendKeys]::SendWait('^v')`;
    } else if (platform === 'darwin') {
      command = `osascript -e 'tell application "System Events" to keystroke "v" using command down'`;
    } else {
      command = `xdotool key ctrl+v`;
    }
  } else if (clipboard_action === 'set') {
    if (!text) {
      const result = { success: false, action: 'clipboard', message: 'set操作需要text参数', _risk: 'blocked' };
      auditLog('clipboard', params, result);
      return result;
    }
    if (text.length > 50000) {
      const result = { success: false, action: 'clipboard', message: '剪贴板内容过长(最大50000字符)', _risk: 'blocked' };
      auditLog('clipboard', params, result);
      return result;
    }
    if (platform === 'win32') {
      const escapedText = text.replace(/'/g, "''").replace(/\n/g, '`n').replace(/\r/g, '');
      command = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetText('${escapedText}')`;
    } else if (platform === 'darwin') {
      const escapedText = text.replace(/'/g, "'\\''");
      command = `echo -n '${escapedText}' | pbcopy`;
    } else {
      const escapedText = text.replace(/'/g, "'\\''");
      command = `echo -n '${escapedText}' | xclip -selection clipboard`;
    }
  } else if (clipboard_action === 'get') {
    if (platform === 'win32') {
      command = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetText()`;
    } else if (platform === 'darwin') {
      command = `pbpaste`;
    } else {
      command = `xclip -selection clipboard -o`;
    }
  }

  try {
    const result = await executeCommand(command, 5000);
    const ret = {
      success: result.success,
      action: 'clipboard',
      clipboard_action,
      content: (clipboard_action === 'copy' || clipboard_action === 'get') ? result.stdout.trim() : undefined,
      message: result.success ? `剪贴板操作(${clipboard_action})成功` : `剪贴板操作失败: ${result.stderr || '未知错误'}`
    };
    auditLog('clipboard', params, ret);
    return ret;
  } catch (e) {
    const ret = { success: false, action: 'clipboard', message: `剪贴板操作异常: ${e.message}` };
    auditLog('clipboard', params, ret);
    return ret;
  }
}

async function closeWindow(params) {
  const { title } = params;

  if (!validateTitle(title)) {
    const result = { success: false, action: 'close_window', title, message: '窗口标题包含不允许的特殊字符', _risk: 'blocked' };
    auditLog('close_window', params, result);
    auditSecurityBlock('close_window', params, '窗口标题包含不允许的特殊字符');
    return result;
  }

  const platform = detectPlatform();
  const safeTitle = sanitizeShellArg(title);
  let command;

  if (platform === 'win32') {
    command = `Add-Type -TypeDefinition "using System;using System.Runtime.InteropServices;public class Win{[DllImport(\\"user32.dll\\")]public static extern bool PostMessage(IntPtr hWnd,uint Msg,IntPtr wParam,IntPtr lParam);}" -PassThru | Out-Null; $w = Get-Process | Where-Object { $_.MainWindowTitle -like "*${safeTitle}*" } | Select-Object -First 1; if ($w) { [Win]::PostMessage($w.MainWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }`;
  } else if (platform === 'darwin') {
    command = `osascript -e 'tell application "${safeTitle}" to quit'`;
  } else {
    command = `wmctrl -c "${safeTitle}"`;
  }

  try {
    const result = await executeCommand(command);
    const ret = {
      success: result.success,
      action: 'close_window',
      title,
      message: result.success ? `已关闭窗口: ${title}` : `关闭窗口失败: ${result.stderr || '未知错误'}`
    };
    auditLog('close_window', params, ret);
    return ret;
  } catch (e) {
    const ret = { success: false, action: 'close_window', title, message: `关闭窗口异常: ${e.message}` };
    auditLog('close_window', params, ret);
    return ret;
  }
}

async function getSystemInfo() {
  const platform = detectPlatform();
  let command;

  if (platform === 'win32') {
    command = `Get-ComputerInfo | Select-Object CsName, WindowsVersion, OsArchitecture, CsTotalPhysicalMemory, OsFreePhysicalMemory | ConvertTo-Json`;
  } else if (platform === 'darwin') {
    command = `system_profiler SPHardwareDataType SPSoftwareDataType 2>/dev/null | head -30`;
  } else {
    command = `uname -a && free -h && df -h / | tail -1`;
  }

  try {
    const result = await executeCommand(command, 10000);
    const ret = {
      success: result.success,
      action: 'system_info',
      info: result.stdout.trim(),
      message: result.success ? '获取系统信息成功' : `获取系统信息失败: ${result.stderr || '未知错误'}`
    };
    auditLog('system_info', {}, ret);
    return ret;
  } catch (e) {
    const ret = { success: false, action: 'system_info', message: `获取系统信息异常: ${e.message}` };
    auditLog('system_info', {}, ret);
    return ret;
  }
}

async function handleDesktopControl(params) {
  const { action } = params;

  switch (action) {
    case 'open_application':
      return openApplication(params);
    case 'open_url':
      return openUrl(params);
    case 'open_folder':
      return openFolder(params);
    case 'search_web':
      return searchWeb(params);
    case 'list_running_apps':
      return listRunningApps();
    case 'activate_window':
      return activateWindow(params);
    case 'screenshot':
      return screenshot(params);
    case 'type_text':
      return typeText(params);
    case 'press_key':
      return pressKey(params);
    case 'clipboard':
      return clipboardAction(params);
    case 'close_window':
      return closeWindow(params);
    case 'system_info':
      return getSystemInfo();
    case 'mouse_click':
      return mouseClick(params);
    case 'mouse_move':
      return mouseMove(params);
    case 'scroll':
      return scrollAction(params);
    case 'drag':
      return dragAction(params);
    case 'screen_capture':
      return screenCapture(params);
    case 'list_windows':
      return listWindows();
    case 'resize_window':
      return resizeWindow(params);
    case 'maximize_window':
      return maximizeWindow();
    case 'minimize_window':
      return minimizeWindow();
    case 'restore_window':
      return restoreWindow();
    case 'move_window':
      return moveWindow(params);
    case 'list_processes':
      return listProcesses(params);
    case 'kill_process':
      return killProcess(params);
    case 'start_process':
      return startProcess(params);
    case 'send_notification':
      return sendNotification(params);
    case 'get_display_info':
      return getDisplayInfo();
    case 'lock_screen':
      return lockScreen();
    case 'sleep_system':
      return sleepSystem();
    case 'volume_control':
      return volumeControl(params);
    default:
      return { success: false, error: `未知的桌面操作: ${action}` };
  }
}

function _validateCoordinate(x, y) {
  const nx = Number(x);
  const ny = Number(y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null;
  if (nx < 0 || ny < 0 || nx > 7680 || ny > 4320) return null;
  return { x: Math.round(nx), y: Math.round(ny) };
}

async function _getComputerBackend() {
  try {
    const { getComputerUseBackend } = require('../core/computer-use');
    const backend = getComputerUseBackend();
    if (!backend._initialized) {
      await backend.initialize();
      backend._initialized = true;
    }
    return backend;
  } catch (e) {
    return null;
  }
}

async function mouseClick(params) {
  const { x, y, button = 'left' } = params;
  const coord = _validateCoordinate(x, y);
  if (!coord) {
    const result = { success: false, action: 'mouse_click', message: '坐标无效，x/y必须为0-7680/0-4320范围内的数字', _risk: 'low' };
    auditLog('mouse_click', params, result);
    return result;
  }
  if (!['left', 'right'].includes(button)) {
    const result = { success: false, action: 'mouse_click', message: 'button仅支持left或right', _risk: 'low' };
    auditLog('mouse_click', params, result);
    return result;
  }

  try {
    const backend = await _getComputerBackend();
    if (!backend) {
      const result = { success: false, action: 'mouse_click', message: 'ComputerUse后端不可用', _risk: 'low' };
      auditLog('mouse_click', params, result);
      return result;
    }
    await backend.click({ x: coord.x, y: coord.y, button });
    const result = { success: true, action: 'mouse_click', x: coord.x, y: coord.y, button, _risk: 'medium' };
    auditLog('mouse_click', params, result);
    return result;
  } catch (e) {
    const result = { success: false, action: 'mouse_click', message: `鼠标点击失败: ${e.message}`, _risk: 'low' };
    auditLog('mouse_click', params, result);
    return result;
  }
}

async function mouseMove(params) {
  const { x, y } = params;
  const coord = _validateCoordinate(x, y);
  if (!coord) {
    const result = { success: false, action: 'mouse_move', message: '坐标无效', _risk: 'low' };
    auditLog('mouse_move', params, result);
    return result;
  }

  try {
    const platform = detectPlatform();
    if (platform === 'win32') {
      // P2 修复(2026-09-06): 统一走 ComputerUse 后端(接 emit('action') 事件流, 与 mouse_click 一致),
      // 此前绕过后端直接拼 PowerShell 少了事件且多起一个进程
      const backend = await _getComputerBackend();
      if (!backend) {
        const result = { success: false, action: 'mouse_move', message: 'ComputerUse后端不可用', _risk: 'low' };
        auditLog('mouse_move', params, result);
        return result;
      }
      await backend.move(coord.x, coord.y);
    } else {
      await executeCommand(`xdotool mousemove ${coord.x} ${coord.y}`);
    }
    const result = { success: true, action: 'mouse_move', x: coord.x, y: coord.y, _risk: 'low' };
    auditLog('mouse_move', params, result);
    return result;
  } catch (e) {
    const result = { success: false, action: 'mouse_move', message: `鼠标移动失败: ${e.message}`, _risk: 'low' };
    auditLog('mouse_move', params, result);
    return result;
  }
}

async function scrollAction(params) {
  const { direction = 'down', amount = 3, x, y } = params;
  if (!['up', 'down'].includes(direction)) {
    const result = { success: false, action: 'scroll', message: 'direction仅支持up或down', _risk: 'low' };
    auditLog('scroll', params, result);
    return result;
  }
  const scrollAmount = Math.min(Math.max(Number(amount) || 3, 1), 20);

  try {
    const backend = await _getComputerBackend();
    if (!backend) {
      const result = { success: false, action: 'scroll', message: 'ComputerUse后端不可用', _risk: 'low' };
      auditLog('scroll', params, result);
      return result;
    }
    await backend.scroll({ direction, amount: scrollAmount, x: x || 0, y: y || 0 });
    const result = { success: true, action: 'scroll', direction, amount: scrollAmount, _risk: 'low' };
    auditLog('scroll', params, result);
    return result;
  } catch (e) {
    const result = { success: false, action: 'scroll', message: `滚动失败: ${e.message}`, _risk: 'low' };
    auditLog('scroll', params, result);
    return result;
  }
}

async function dragAction(params) {
  const { fromX, fromY, toX, toY } = params;
  const from = _validateCoordinate(fromX, fromY);
  const to = _validateCoordinate(toX, toY);
  if (!from || !to) {
    const result = { success: false, action: 'drag', message: '坐标无效，需要fromX/fromY/toX/toY', _risk: 'low' };
    auditLog('drag', params, result);
    return result;
  }

  try {
    const backend = await _getComputerBackend();
    if (!backend) {
      const result = { success: false, action: 'drag', message: 'ComputerUse后端不可用', _risk: 'low' };
      auditLog('drag', params, result);
      return result;
    }
    await backend.drag({ fromX: from.x, fromY: from.y, toX: to.x, toY: to.y });
    const result = { success: true, action: 'drag', fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, _risk: 'medium' };
    auditLog('drag', params, result);
    return result;
  } catch (e) {
    const result = { success: false, action: 'drag', message: `拖拽失败: ${e.message}`, _risk: 'low' };
    auditLog('drag', params, result);
    return result;
  }
}

async function screenCapture(params) {
  const { mode = 'som' } = params;
  if (!['som', 'ax', 'screenshot'].includes(mode)) {
    const result = { success: false, action: 'screen_capture', message: 'mode仅支持som/ax/screenshot', _risk: 'low' };
    auditLog('screen_capture', params, result);
    return result;
  }

  try {
    const backend = await _getComputerBackend();
    if (!backend) {
      const result = { success: false, action: 'screen_capture', message: 'ComputerUse后端不可用', _risk: 'low' };
      auditLog('screen_capture', params, result);
      return result;
    }
    const capture = await backend.capture(mode);
    const result = {
      success: true,
      action: 'screen_capture',
      mode,
      width: capture.width,
      height: capture.height,
      elements: capture.elements ? capture.elements.slice(0, 100) : undefined,
      axTree: capture.axTree ? capture.axTree.slice(0, 5000) : undefined,
      hasScreenshot: !!capture.screenshot,
      _risk: 'low',
    };
    auditLog('screen_capture', params, result);
    return result;
  } catch (e) {
    const result = { success: false, action: 'screen_capture', message: `屏幕捕获失败: ${e.message}`, _risk: 'low' };
    auditLog('screen_capture', params, result);
    return result;
  }
}


async function listWindows() {
  const platform = detectPlatform();
  let command;
  if (platform === 'win32') {
    command = `Get-Process | Where-Object { $_.MainWindowTitle -ne "" } | Select-Object Id, ProcessName, MainWindowTitle, @{N="Handle";E={$_.MainWindowHandle.ToInt64()}} | ConvertTo-Json -Compress`;
  } else if (platform === 'darwin') {
    command = `osascript -e 'tell application "System Events" to get {name, id} of every window of every process whose visible is true' `;
  } else {
    command = 'wmctrl -lG';
  }
  try {
    const result = await executeCommand(command, 10000);
    const ret = {
      success: result.success,
      action: 'list_windows',
      windows: result.stdout.trim(),
      message: result.success ? '获取窗口列表成功' : `获取窗口列表失败: ${result.stderr || '未知错误'}`
    };
    auditLog('list_windows', {}, ret);
    return ret;
  } catch (e) {
    const ret = { success: false, action: 'list_windows', message: `获取窗口列表异常: ${e.message}` };
    auditLog('list_windows', {}, ret);
    return ret;
  }
}

async function resizeWindow(params) {
  const { width, height } = params;
  if (!width || !height || !Number.isFinite(Number(width)) || !Number.isFinite(Number(height)) ||
      Number(width) < 100 || Number(height) < 100 || Number(width) > 7680 || Number(height) > 4320) {
    const ret = { success: false, action: 'resize_window', message: '窗口尺寸无效(100-7680x100-4320)', _risk: 'low' };
    auditLog('resize_window', params, ret);
    return ret;
  }
  const platform = detectPlatform();
  let command;
  if (platform === 'win32') {
    command = `Add-Type -TypeDefinition "using System;using System.Runtime.InteropServices;public class Win32{[DllImport(\\"user32.dll\\")]public static extern IntPtr GetForegroundWindow();[DllImport(\\"user32.dll\\")]public static extern bool SetWindowPos(IntPtr hWnd,IntPtr hAfter,int x,int y,int cx,int cy,uint flags);}" -PassThru | Out-Null; $h = [Win32]::GetForegroundWindow(); [Win32]::SetWindowPos($h, 0, 0, 0, ${width}, ${height}, 0x0002)`;
  } else if (platform === 'darwin') {
    command = `osascript -e 'tell application "System Events" to set size of front window of (first process whose frontmost is true) to {${width}, ${height}}'`;
  } else {
    command = `wmctrl -r :ACTIVE: -e 0,-1,-1,${width},${height}`;
  }
  try {
    const result = await executeCommand(command, 5000);
    const ret = {
      success: result.success,
      action: 'resize_window',
      width: Number(width), height: Number(height),
      message: result.success ? `窗口已调整至 ${width}x${height}` : `调整窗口失败: ${result.stderr || '未知错误'}`
    };
    auditLog('resize_window', params, ret);
    return ret;
  } catch (e) {
    const ret = { success: false, action: 'resize_window', message: `调整窗口异常: ${e.message}` };
    auditLog('resize_window', params, ret);
    return ret;
  }
}

async function maximizeWindow() {
  const platform = detectPlatform();
  let command;
  if (platform === 'win32') {
    command = `Add-Type -TypeDefinition "using System;using System.Runtime.InteropServices;public class Win32{[DllImport(\\"user32.dll\\")]public static extern IntPtr GetForegroundWindow();[DllImport(\\"user32.dll\\")]public static extern bool ShowWindow(IntPtr hWnd,int nCmdShow);}" -PassThru | Out-Null; $h = [Win32]::GetForegroundWindow(); [Win32]::ShowWindow($h, 3)`;
  } else if (platform === 'darwin') {
    command = `osascript -e 'tell application "System Events" to tell front window of (first process whose frontmost is true) to set zoomed to true'`;
  } else {
    command = 'wmctrl -r :ACTIVE: -b add,maximized_vert,maximized_horz';
  }
  try {
    const result = await executeCommand(command, 5000);
    const ret = {
      success: result.success,
      action: 'maximize_window',
      message: result.success ? '窗口已最大化' : `最大化窗口失败: ${result.stderr || '未知错误'}`
    };
    auditLog('maximize_window', {}, ret);
    return ret;
  } catch (e) {
    const ret = { success: false, action: 'maximize_window', message: `最大化窗口异常: ${e.message}` };
    auditLog('maximize_window', {}, ret);
    return ret;
  }
}

async function minimizeWindow() {
  const platform = detectPlatform();
  let command;
  if (platform === 'win32') {
    command = `Add-Type -TypeDefinition "using System;using System.Runtime.InteropServices;public class Win32{[DllImport(\\"user32.dll\\")]public static extern IntPtr GetForegroundWindow();[DllImport(\\"user32.dll\\")]public static extern bool ShowWindow(IntPtr hWnd,int nCmdShow);}" -PassThru | Out-Null; $h = [Win32]::GetForegroundWindow(); [Win32]::ShowWindow($h, 6)`;
  } else if (platform === 'darwin') {
    command = `osascript -e 'tell application "System Events" to set miniaturized of front window of (first process whose frontmost is true) to true'`;
  } else {
    command = 'xdotool windowminimize $(xdotool getactivewindow)';
  }
  try {
    const result = await executeCommand(command, 5000);
    const ret = {
      success: result.success,
      action: 'minimize_window',
      message: result.success ? '窗口已最小化' : `最小化窗口失败: ${result.stderr || '未知错误'}`
    };
    auditLog('minimize_window', {}, ret);
    return ret;
  } catch (e) {
    const ret = { success: false, action: 'minimize_window', message: `最小化窗口异常: ${e.message}` };
    auditLog('minimize_window', {}, ret);
    return ret;
  }
}

async function restoreWindow() {
  const platform = detectPlatform();
  let command;
  if (platform === 'win32') {
    command = `Add-Type -TypeDefinition "using System;using System.Runtime.InteropServices;public class Win32{[DllImport(\\"user32.dll\\")]public static extern IntPtr GetForegroundWindow();[DllImport(\\"user32.dll\\")]public static extern bool ShowWindow(IntPtr hWnd,int nCmdShow);}" -PassThru | Out-Null; $h = [Win32]::GetForegroundWindow(); [Win32]::ShowWindow($h, 1)`;
  } else if (platform === 'darwin') {
    command = `osascript -e 'tell application "System Events" to tell front window of (first process whose frontmost is true) to set zoomed to false'`;
  } else {
    command = 'wmctrl -r :ACTIVE: -b remove,maximized_vert,maximized_horz';
  }
  try {
    const result = await executeCommand(command, 5000);
    const ret = {
      success: result.success,
      action: 'restore_window',
      message: result.success ? '窗口已还原' : `还原窗口失败: ${result.stderr || '未知错误'}`
    };
    auditLog('restore_window', {}, ret);
    return ret;
  } catch (e) {
    const ret = { success: false, action: 'restore_window', message: `还原窗口异常: ${e.message}` };
    auditLog('restore_window', {}, ret);
    return ret;
  }
}

async function moveWindow(params) {
  const { x, y } = params;
  if (x === undefined || y === undefined || !Number.isFinite(Number(x)) || !Number.isFinite(Number(y)) ||
      Number(x) < -7680 || Number(y) < -4320 || Number(x) > 7680 || Number(y) > 4320) {
    const ret = { success: false, action: 'move_window', message: '坐标无效', _risk: 'low' };
    auditLog('move_window', params, ret);
    return ret;
  }
  const platform = detectPlatform();
  let command;
  if (platform === 'win32') {
    command = `Add-Type -TypeDefinition "using System;using System.Runtime.InteropServices;public class Win32{[DllImport(\\"user32.dll\\")]public static extern IntPtr GetForegroundWindow();[DllImport(\\"user32.dll\\")]public static extern bool SetWindowPos(IntPtr hWnd,IntPtr hAfter,int x,int y,int cx,int cy,uint flags);}" -PassThru | Out-Null; $h = [Win32]::GetForegroundWindow(); [Win32]::SetWindowPos($h, 0, ${x}, ${y}, 0, 0, 0x0001)`;
  } else if (platform === 'darwin') {
    command = `osascript -e 'tell application "System Events" to set position of front window of (first process whose frontmost is true) to {${x}, ${y}}'`;
  } else {
    command = `wmctrl -r :ACTIVE: -e 0,${x},${y},-1,-1`;
  }
  try {
    const result = await executeCommand(command, 5000);
    const ret = {
      success: result.success,
      action: 'move_window',
      x: Number(x), y: Number(y),
      message: result.success ? `窗口已移至 (${x}, ${y})` : `移动窗口失败: ${result.stderr || '未知错误'}`
    };
    auditLog('move_window', params, ret);
    return ret;
  } catch (e) {
    const ret = { success: false, action: 'move_window', message: `移动窗口异常: ${e.message}` };
    auditLog('move_window', params, ret);
    return ret;
  }
}

async function listProcesses(params) {
  const { filter: procFilter } = params || {};
  const platform = detectPlatform();
  let command;
  if (platform === 'win32') {
    if (procFilter) {
      const safeFilter = sanitizeShellArg(procFilter);
      command = `Get-Process -Name "*${safeFilter}*" -ErrorAction SilentlyContinue | Select-Object Id, ProcessName, CPU, WorkingSet64, StartTime | ConvertTo-Json -Compress`;
    } else {
      command = 'Get-Process | Select-Object Id, ProcessName, CPU, WorkingSet64, StartTime | Sort-Object CPU -Descending | Select-Object -First 50 | ConvertTo-Json -Compress';
    }
  } else if (platform === 'darwin') {
    if (procFilter) {
      const safeFilter = sanitizeShellArg(procFilter);
      command = `ps aux | grep -i "${safeFilter}" | grep -v grep`;
    } else {
      command = 'ps aux --sort=-%cpu | head -50';
    }
  } else {
    if (procFilter) {
      const safeFilter = sanitizeShellArg(procFilter);
      command = `ps aux | grep -i "${safeFilter}" | grep -v grep`;
    } else {
      command = 'ps aux --sort=-%cpu | head -50';
    }
  }
  try {
    const result = await executeCommand(command, 10000);
    const ret = {
      success: result.success,
      action: 'list_processes',
      processes: result.stdout.trim(),
      message: result.success ? '获取进程列表成功' : `获取进程列表失败: ${result.stderr || '未知错误'}`
    };
    auditLog('list_processes', params || {}, ret);
    return ret;
  } catch (e) {
    const ret = { success: false, action: 'list_processes', message: `获取进程列表异常: ${e.message}` };
    auditLog('list_processes', params || {}, ret);
    return ret;
  }
}

async function killProcess(params) {
  const { pid, name } = params;
  if ((!pid && !name) || (pid && !String(pid).match(/^\d+$/))) {
    const ret = { success: false, action: 'kill_process', message: '需要提供有效的 pid 或 name', _risk: 'blocked' };
    auditLog('kill_process', params, ret);
    return ret;
  }
  const platform = detectPlatform();
  let command;
  if (platform === 'win32') {
    if (pid) {
      command = `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`;
    } else {
      const safeName = sanitizeShellArg(name);
      command = `Stop-Process -Name "${safeName}" -Force -ErrorAction SilentlyContinue`;
    }
  } else {
    if (pid) {
      command = `kill -9 ${pid}`;
    } else {
      const safeName = sanitizeShellArg(name);
      command = `pkill -f "${safeName}"`;
    }
  }
  try {
    const result = await executeCommand(command, 10000);
    const ret = {
      success: result.success,
      action: 'kill_process',
      pid, name,
      message: result.success ? '进程已终止' : `终止进程失败: ${result.stderr || '未知错误'}`,
      _risk: 'high'
    };
    auditLog('kill_process', params, ret);
    return ret;
  } catch (e) {
    const ret = { success: false, action: 'kill_process', message: `终止进程异常: ${e.message}`, _risk: 'high' };
    auditLog('kill_process', params, ret);
    return ret;
  }
}

async function startProcess(params) {
  const { command: cmd, args = '', cwd } = params;
  if (!cmd || typeof cmd !== 'string') {
    const ret = { success: false, action: 'start_process', message: '需要提供有效的 command', _risk: 'blocked' };
    auditLog('start_process', params, ret);
    return ret;
  }
  if (!checkCommandSafety(cmd)) {
    const ret = { success: false, action: 'start_process', message: '命令包含危险模式，已被拦截', _risk: 'blocked' };
    auditLog('start_process', params, ret);
    auditSecurityBlock('start_process', params, '检测到危险命令模式');
    return ret;
  }
  const platform = detectPlatform();
  let command;
  if (platform === 'win32') {
    const safeCmd = sanitizeShellArg(cmd);
    const safeArgs = sanitizeShellArg(args || '');
    const safeCwd = cwd ? sanitizePath(cwd) : '';
    if (safeCwd) {
      command = `Start-Process -FilePath "${safeCmd}" -ArgumentList "${safeArgs}" -WorkingDirectory "${safeCwd}" -WindowStyle Normal`;
    } else {
      command = `Start-Process -FilePath "${safeCmd}" -ArgumentList "${safeArgs}" -WindowStyle Normal`;
    }
  } else if (platform === 'darwin') {
    const safeCmd = sanitizeShellArg(cmd);
    const safeArgs = sanitizeShellArg(args || '');
    command = `open -a "${safeCmd}" --args ${safeArgs}`;
  } else {
    const safeCmd = sanitizeShellArg(cmd);
    const safeArgs = sanitizeShellArg(args || '');
    command = `nohup ${safeCmd} ${safeArgs} &`;
  }
  try {
    const result = await executeCommand(command, 10000);
    const ret = {
      success: result.success,
      action: 'start_process',
      cmd,
      message: result.success ? `进程 ${cmd} 已启动` : `启动进程失败: ${result.stderr || '未知错误'}`,
      _risk: 'medium'
    };
    auditLog('start_process', params, ret);
    return ret;
  } catch (e) {
    const ret = { success: false, action: 'start_process', message: `启动进程异常: ${e.message}`, _risk: 'medium' };
    auditLog('start_process', params, ret);
    return ret;
  }
}

async function sendNotification(params) {
  const { title, message } = params;
  if (!title || !message || typeof title !== 'string' || typeof message !== 'string') {
    const ret = { success: false, action: 'send_notification', message: '需要提供有效的 title 和 message', _risk: 'low' };
    auditLog('send_notification', params, ret);
    return ret;
  }
  const safeTitle = sanitizeShellArg(title);
  const safeMessage = sanitizeShellArg(message);
  const platform = detectPlatform();
  let command;
  if (platform === 'win32') {
    command = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); $textNodes = $template.GetElementsByTagName("text"); $textNodes.Item(0).AppendChild($template.CreateTextNode("${safeTitle}")) | Out-Null; $textNodes.Item(1).AppendChild($template.CreateTextNode("${safeMessage}")) | Out-Null; $toast = New-Object Windows.UI.Notifications.ToastNotification($template); [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("CrabPaw").Show($toast)`;
  } else if (platform === 'darwin') {
    command = `osascript -e 'display notification "${safeMessage}" with title "${safeTitle}"'`;
  } else {
    command = `notify-send "${safeTitle}" "${safeMessage}"`;
  }
  try {
    const result = await executeCommand(command, 10000);
    const ret = {
      success: result.success,
      action: 'send_notification',
      title,
      message: result.success ? '通知已发送' : `发送通知失败: ${result.stderr || '未知错误'}`
    };
    auditLog('send_notification', params, ret);
    return ret;
  } catch (e) {
    const ret = { success: false, action: 'send_notification', message: `发送通知异常: ${e.message}` };
    auditLog('send_notification', params, ret);
    return ret;
  }
}

async function getDisplayInfo() {
  const platform = detectPlatform();
  let command;
  if (platform === 'win32') {
    command = 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { @{ DeviceName=$_.DeviceName; Bounds=@{X=$_.Bounds.X;Y=$_.Bounds.Y;Width=$_.Bounds.Width;Height=$_.Bounds.Height}; Primary=$_.Primary; BitsPerPixel=$_.BitsPerPixel } } | ConvertTo-Json -Compress';
  } else if (platform === 'darwin') {
    command = 'system_profiler SPDisplaysDataType -json 2>/dev/null || echo \'{"displays":[]}\'';
  } else {
    command = 'xrandr --query 2>/dev/null || echo ""';
  }
  try {
    const result = await executeCommand(command, 10000);
    const ret = {
      success: result.success,
      action: 'get_display_info',
      displays: result.stdout.trim(),
      message: result.success ? '获取显示信息成功' : `获取显示信息失败: ${result.stderr || '未知错误'}`
    };
    auditLog('get_display_info', {}, ret);
    return ret;
  } catch (e) {
    const ret = { success: false, action: 'get_display_info', message: `获取显示信息异常: ${e.message}` };
    auditLog('get_display_info', {}, ret);
    return ret;
  }
}

async function lockScreen() {
  const platform = detectPlatform();
  let command;
  if (platform === 'win32') {
    command = 'rundll32.exe user32.dll,LockWorkStation';
  } else if (platform === 'darwin') {
    command = 'pmset displaysleepnow; /System/Library/CoreServices/Menu\\ Extras/User.menu/Contents/Resources/CGSession -suspend';
  } else {
    command = 'xdg-screensaver lock || gnome-screensaver-command -l || loginctl lock-session';
  }
  try {
    const result = await executeCommand(command, 10000);
    const ret = {
      success: result.success,
      action: 'lock_screen',
      message: result.success ? '屏幕已锁定' : `锁定屏幕失败: ${result.stderr || '未知错误'}`,
      _risk: 'high'
    };
    auditLog('lock_screen', {}, ret);
    return ret;
  } catch (e) {
    const ret = { success: false, action: 'lock_screen', message: `锁定屏幕异常: ${e.message}`, _risk: 'high' };
    auditLog('lock_screen', {}, ret);
    return ret;
  }
}

async function sleepSystem() {
  const platform = detectPlatform();
  let command;
  if (platform === 'win32') {
    command = 'rundll32.exe powrprof.dll,SetSuspendState 0,1,0';
  } else if (platform === 'darwin') {
    command = 'pmset sleepnow';
  } else {
    command = 'systemctl suspend';
  }
  try {
    const result = await executeCommand(command, 10000);
    const ret = {
      success: result.success,
      action: 'sleep_system',
      message: result.success ? '系统正在进入休眠' : `系统休眠失败: ${result.stderr || '未知错误'}`,
      _risk: 'high'
    };
    auditLog('sleep_system', {}, ret);
    return ret;
  } catch (e) {
    const ret = { success: false, action: 'sleep_system', message: `系统休眠异常: ${e.message}`, _risk: 'high' };
    auditLog('sleep_system', {}, ret);
    return ret;
  }
}

async function volumeControl(params) {
  // P2 修复(2026-09-06): 此前读 params.action 做子动作, 但顶层 action 恒为
  // 'volume_control', 永远过不了白名单——该动作结构性不可达。改用专用 volume_action 参数。
  const { volume_action: volAction, level } = params;
  if (!volAction || !['mute', 'unmute', 'up', 'down'].includes(volAction)) {
    const ret = { success: false, action: 'volume_control', message: 'volume_action 仅支持 mute/unmute/up/down', _risk: 'low' };
    auditLog('volume_control', params, ret);
    return ret;
  }
  const platform = detectPlatform();
  let command;
  if (platform === 'win32') {
    if (volAction === 'mute') {
      command = '(New-Object -ComObject WScript.Shell).SendKeys([char]173)';
    } else if (volAction === 'unmute') {
      command = '(New-Object -ComObject WScript.Shell).SendKeys([char]173)';
    } else if (volAction === 'up') {
      const times = Math.min(level || 1, 20);
      command = `1..${times} | ForEach-Object { (New-Object -ComObject WScript.Shell).SendKeys([char]175); Start-Sleep -Milliseconds 100 }`;
    } else {
      const times = Math.min(level || 1, 20);
      command = `1..${times} | ForEach-Object { (New-Object -ComObject WScript.Shell).SendKeys([char]174); Start-Sleep -Milliseconds 100 }`;
    }
  } else if (platform === 'darwin') {
    if (volAction === 'mute') {
      command = 'osascript -e "set volume with output muted"';
    } else if (volAction === 'unmute') {
      command = 'osascript -e "set volume without output muted"';
    } else if (volAction === 'up') {
      const step = Math.min(level || 5, 20);
      command = `osascript -e "set volume output volume (output volume of (get volume settings) + ${step})"`;
    } else {
      const step = Math.min(level || 5, 20);
      command = `osascript -e "set volume output volume (output volume of (get volume settings) - ${step})"`;
    }
  } else {
    if (volAction === 'mute') {
      command = 'pactl set-sink-mute @DEFAULT_SINK@ 1';
    } else if (volAction === 'unmute') {
      command = 'pactl set-sink-mute @DEFAULT_SINK@ 0';
    } else if (volAction === 'up') {
      const step = Math.min(level || 5, 20);
      command = `pactl set-sink-volume @DEFAULT_SINK@ +${step}%`;
    } else {
      const step = Math.min(level || 5, 20);
      command = `pactl set-sink-volume @DEFAULT_SINK@ -${step}%`;
    }
  }
  try {
    const result = await executeCommand(command, 10000);
    const ret = {
      success: result.success,
      action: 'volume_control',
      volAction,
      level,
      message: result.success ? `音量控制 ${volAction} 成功` : `音量控制失败: ${result.stderr || '未知错误'}`
    };
    auditLog('volume_control', params, ret);
    return ret;
  } catch (e) {
    const ret = { success: false, action: 'volume_control', message: `音量控制异常: ${e.message}` };
    auditLog('volume_control', params, ret);
    return ret;
  }
}

function getAuditLog(filter = {}) {
  let logs = [...AUDIT_LOG];
  if (filter.action) logs = logs.filter(l => l.action === filter.action);
  if (filter.since) logs = logs.filter(l => l.ts >= filter.since);
  if (filter.risk) logs = logs.filter(l => l.risk === filter.risk);
  return logs;
}

function getSecurityStats() {
  const logs = AUDIT_LOG;
  const blocked = logs.filter(l => l.risk === 'blocked').length;
  const byAction = {};
  for (const l of logs) {
    byAction[l.action] = (byAction[l.action] || 0) + 1;
  }
  return {
    totalOperations: logs.length,
    blockedOperations: blocked,
    byAction,
  };
}

registry.register({
  name: 'DesktopControl',
  toolset: 'desktop',
  category: 'desktop_control',
  description: '桌面控制：打开应用、浏览器、文件夹，搜索网页，管理窗口，键盘输入，剪贴板操作，截图等',
  schema: {
    description: '控制电脑桌面：打开应用、浏览器、文件夹，搜索网页，查看运行中的应用，激活/关闭窗口，键盘输入，按键操作，剪贴板操作，截图，获取系统信息等。这是最直接的电脑控制方式，优先使用此工具而非通过Bash执行复杂命令。所有操作均经过安全审查。',
    parameters: buildRegistryParameters(),
  },
  handler: handleDesktopControl,
  checkFn: (params) => params.action && typeof params.action === 'string',
  timeout: 30000,
  isDangerous: true,
  selfApproval: true,
  // P1(2026-09-06): 工具整体 selfApproval 豁免避免 30 个 action 逐条弹窗,
  // 但以下高风险 action 仍由 registry 层强制人工审批(registry.js highRiskActions 闸)
  highRiskActions: ['kill_process', 'lock_screen', 'sleep_system', 'start_process'],
  isReadOnly: false
});

console.log('🖥️ 桌面控制工具集已注册(含安全审查):', registry.getByToolset('desktop').map(t => t.name).join(', '));

module.exports = {
  handleDesktopControl,
  openApplication,
  openUrl,
  openFolder,
  searchWeb,
  listRunningApps,
  activateWindow,
  screenshot,
  typeText,
  pressKey,
  clipboardAction,
  closeWindow,
  getSystemInfo,
  listWindows,
  resizeWindow,
  maximizeWindow,
  minimizeWindow,
  restoreWindow,
  moveWindow,
  listProcesses,
  killProcess,
  startProcess,
  sendNotification,
  getDisplayInfo,
  lockScreen,
  sleepSystem,
  volumeControl,
  getAuditLog,
  getSecurityStats,
  sanitizeShellArg,
  sanitizePath,
  sanitizeUrl,
  validateApp,
  validateKey,
  validateTitle,
  checkCommandSafety,
  classifyError,
  ALLOWED_APPS,
  ALLOWED_BROWSERS,
};
