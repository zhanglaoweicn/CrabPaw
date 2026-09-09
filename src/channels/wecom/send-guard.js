/**
 * send-guard.js — 企微发送服务 chatId 授权集（发布 S-2b 安全）。
 * 允许集合 = user.wecomUserId（DATA_DIR/config/user.json）+ wecom.defaultChatId /
 * wecom.defaultUserId（DATA_DIR/config.json）。未配置任何值 → 空集合
 * （fail-closed：所有发送被拒，与既有 token 鉴权「无 token 一律拒绝」同姿态）。
 *
 * 边界（发布注册）：本设计只允许配置的默认用户 + 本人；如需发给任意客户，
 * 需先写入配置（后续轮）。
 */
const fs = require('fs');
const path = require('path');

function loadAllowedChatIds(dataDir) {
  const allowed = new Set();
  try {
    const userPath = path.join(dataDir, 'config', 'user.json');
    if (fs.existsSync(userPath)) {
      const userConfig = JSON.parse(fs.readFileSync(userPath, 'utf-8'));
      if (userConfig.wecomUserId) allowed.add(String(userConfig.wecomUserId));
    }
  } catch (e) {
    console.warn('[wecom/send-guard] 读取用户配置失败:', e.message);
  }
  try {
    const appPath = path.join(dataDir, 'config.json');
    if (fs.existsSync(appPath)) {
      const appConfig = JSON.parse(fs.readFileSync(appPath, 'utf-8'));
      const wecom = appConfig.wecom || {};
      if (wecom.defaultChatId) allowed.add(String(wecom.defaultChatId));
      if (wecom.defaultUserId) allowed.add(String(wecom.defaultUserId));
    }
  } catch (e) {
    console.warn('[wecom/send-guard] 读取应用配置失败:', e.message);
  }
  return allowed;
}

function isAllowedChatId(chatId, allowed) {
  if (chatId === null || chatId === undefined || chatId === '') return false;
  if (!allowed || typeof allowed.has !== 'function') return false;
  return allowed.has(String(chatId));
}

// ── 群聊白名单（2026-09-06）──
// 群 chatId 不在用户配置里（默认只有本人），群里回复一律 403。群聊授权走
// "机器人被 @ 才放行"：服务端 group-router 批准某群交互时调用 approveGroupChat
// 落盘，桥侧按时间窗口放行——服务端(主进程)与桥(子进程)不同进程，只能靠文件共享。

const GROUPS_FILE = 'wecom-allowed-groups.json';
const GROUP_APPROVAL_WINDOW_MS = 10 * 60 * 1000; // 被 @ 后 10 分钟内可回复

function _groupsPath(dataDir) {
  return path.join(dataDir, 'config', GROUPS_FILE);
}

/** 服务端：记录一次 router 批准的群交互 */
function approveGroupChat(dataDir, chatId) {
  if (!chatId) return;
  try {
    const p = _groupsPath(dataDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    let groups = {};
    if (fs.existsSync(p)) groups = JSON.parse(fs.readFileSync(p, 'utf-8'));
    groups[String(chatId)] = Date.now();
    fs.writeFileSync(p, JSON.stringify(groups, null, 2));
  } catch (e) {
    console.warn('[wecom/send-guard] 群白名单写入失败:', e.message);
  }
}

/** 桥侧：读取时间窗口内被批准的群（与 loadAllowedChatIds 并集使用） */
function loadApprovedGroupChats(dataDir) {
  const allowed = new Set();
  try {
    const p = _groupsPath(dataDir);
    if (!fs.existsSync(p)) return allowed;
    const groups = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const now = Date.now();
    for (const [chatId, ts] of Object.entries(groups)) {
      if (now - ts < GROUP_APPROVAL_WINDOW_MS) allowed.add(String(chatId));
    }
  } catch (e) {
    console.warn('[wecom/send-guard] 群白名单读取失败:', e.message);
  }
  return allowed;
}

module.exports = { loadAllowedChatIds, isAllowedChatId, approveGroupChat, loadApprovedGroupChats, GROUP_APPROVAL_WINDOW_MS };
