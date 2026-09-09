/**
 * Clipboard Tools — 系统剪贴板读写工具
 *
 * 用于桌面端快速复制/粘贴内容到系统剪贴板。
 * 读：从剪贴板获取文本
 * 写：将文本写入剪贴板
 */

const { spawn } = require('child_process');
const { registry } = require('./registry');

function _execCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, timeout: 5000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `Exit code ${code}`));
    });
  });
}

async function _getClipboard() {
  try {
    const result = await _execCommand('powershell', [
      '-NoProfile', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetText()',
    ]);
    return result || '';
  } catch {
    // Fallback: try Windows clip.exe
    try {
      const result = await _execCommand('powershell', ['-NoProfile', '-Command', 'Get-Clipboard']);
      return result || '';
    } catch {
      return '';
    }
  }
}

async function _setClipboard(text) {
  // Escape for PowerShell
  const escaped = text.replace(/'/g, "''");
  await _execCommand('powershell', [
    '-NoProfile', '-Command',
    `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetText('${escaped}')`,
  ]);
}

// eslint-disable-next-line no-unused-vars -- 读剪贴板无需会话上下文，保留签名以匹配 registry handler 契约
async function handleClipboardRead(_params, context) {
  try {
    const text = await _getClipboard();
    return {
      success: true,
      text,
      length: text.length,
      hasContent: text.length > 0,
    };
  } catch (e) {
    return { success: false, error: `读取剪贴板失败: ${e.message}` };
  }
}

async function handleClipboardWrite(params, _context) {
  const { text } = params;
  if (text === undefined || text === null) {
    return { success: false, error: '缺少 text 参数' };
  }

  try {
    const str = String(text);
    await _setClipboard(str);
    return { success: true, length: str.length };
  } catch (e) {
    return { success: false, error: `写入剪贴板失败: ${e.message}` };
  }
}

registry.register({
  name: 'ClipboardRead',
  toolset: 'desktop',
  category: 'interaction',
  description: '读取系统剪贴板文本内容。适用于用户复制了内容后想让你处理、或者需要获取桌面应用中的选中文本。',
  schema: {
    type: 'object',
    properties: {},
  },
  handler: handleClipboardRead,
  timeout: 10000,
  isReadOnly: true,
});

registry.register({
  name: 'ClipboardWrite',
  toolset: 'desktop',
  category: 'interaction',
  description: '将文本写入系统剪贴板。适用于：让用户粘贴你生成的内容、准备分享的文本、将代码复制到 IDE。',
  whenNotToUse: [
    // P2 修复(2026-09-06): 补风险声明——剪贴板可被提示注入利用(诱导用户粘贴恶意脚本/钓鱼链接)
    '不要写入非用户请求来源的脚本、命令或链接(剪贴板钓鱼风险)',
    '用户没有要求"复制"某内容时',
  ],
  schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '要写入剪贴板的文本内容' },
    },
    required: ['text'],
  },
  handler: handleClipboardWrite,
  timeout: 10000,
  // P2 修复(2026-09-06): 此前默认 low 风险零标记。标记 medium 进审计分级与契约,
  // 不设 high——"复制生成内容到 IDE"是高频合法流程, 不应逐次弹审批
  riskLevel: 'medium',
});

module.exports = { handleClipboardRead, handleClipboardWrite };
