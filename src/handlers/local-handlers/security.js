// security.js — 从 src/cli/request-handler.js 机械抽取（Task 6，零行为变化）。
// 方法体逐字迁移；相对 require 路径按新模块位置平移；LOCAL_HANDLERS 交叉引用改为模块内直调。

const fs = require('fs');
const path = require('path');
const { readJsonBody, sendJson } = require('../http-utils');
const { getDataDir } = require('./_shared');

async function handleIdentity(req, res, _ctx) {
  const identityPath = path.join(getDataDir(), 'workspace', 'IDENTITY.md');
  try {
    if (req.method === 'GET') {
      const content = fs.existsSync(identityPath) ? fs.readFileSync(identityPath, 'utf-8') : '';
      return sendJson(res, 200, { success: true, data: { content }, content });
    }
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const content = typeof body.content === 'string' ? body.content : '';
      fs.mkdirSync(path.dirname(identityPath), { recursive: true });
      fs.writeFileSync(identityPath, content, 'utf-8');
      return sendJson(res, 200, { success: true, data: { content }, content });
    }
    return sendJson(res, 405, { success: false, message: 'Method Not Allowed' });
  } catch (e) {
    return sendJson(res, 500, { success: false, message: e.message });
  }
}

async function handleSecurityStatus(req, res, ctx) {
  try {
    const security = ctx.security;
    return sendJson(res, 200, {
      success: true,
      data: {
        level: security?.config?.level || 'unknown',
        stats: security?.getStats ? security.getStats() : {},
      },
    });
  } catch (e) {
    return sendJson(res, 500, { success: false, message: e.message });
  }
}

async function handleSecurityConfig(req, res, ctx) {
  try {
    const security = ctx.security;
    if (req.method === 'GET') {
      // 2026-08-28 发布项: remoteInstall 存 appConfig.security（SecuritySystem 不承载），
      // 回显时合并，GUI 安全页复选框可往返。
      return sendJson(res, 200, { success: true, data: {
        ...(security?.config || {}),
        remoteInstall: (ctx.appConfig?.security?.remoteInstall) || { enabled: false },
      } });
    }

    const body = await readJsonBody(req);
    if (!security) return sendJson(res, 400, { success: false, message: 'Security system unavailable' });

    const { SECURITY_LEVELS } = require('../../core/security');
    const LEVEL_MAP = { low: 'disabled', medium: 'standard', high: 'strict' };
    const backendLevel = LEVEL_MAP[body.level] || body.level;
    if (!Object.values(SECURITY_LEVELS).includes(backendLevel)) {
      return sendJson(res, 400, { success: false, message: 'Invalid security level: ' + backendLevel });
    }

    security.setLevel(backendLevel, { authorized: true, reason: 'gui-security-config' });
    if (body.approval && security.approval) {
      security.approval.config.enabled = body.approval.enabled !== false;
      if (body.approval.mode) security.approval.config.mode = body.approval.mode;
      security.config.approval.enabled = security.approval.config.enabled;
      security.config.approval.mode = security.approval.config.mode;
    }
    if (body.userWhitelist && security.userWhitelist) {
      security.userWhitelist.config.enabled = body.userWhitelist.enabled !== false;
      security.userWhitelist.config.allowAll = !!body.userWhitelist.allowAll;
      if (Array.isArray(body.userWhitelist.users)) security.userWhitelist.config.users = body.userWhitelist.users;
      if (Array.isArray(body.userWhitelist.adminUsers)) security.userWhitelist.config.adminUsers = body.userWhitelist.adminUsers;
      security.config.userWhitelist = { ...security.config.userWhitelist, ...security.userWhitelist.config };
      security.userWhitelist.save?.();
    }

    // 2026-08-28 发布项: 远程技能安装开关（默认关闭）——持久化到 appConfig.security
    if (body.remoteInstall && typeof body.remoteInstall === 'object') {
      ctx.appConfig.security = {
        ...(ctx.appConfig.security || {}),
        remoteInstall: { enabled: !!body.remoteInstall.enabled },
      };
    }

    ctx.appConfig.security = {
      ...(ctx.appConfig.security || {}),
      level: backendLevel,
      approval: security.config.approval,
      userWhitelist: security.config.userWhitelist,
    };
    ctx.config?.saveConfig?.(ctx.appConfig);
    return sendJson(res, 200, { success: true, data: security.config });
  } catch (e) {
    return sendJson(res, 500, { success: false, message: e.message });
  }
}

// 2026-08-13 P2-4: 最近运行终态快照(恢复横幅数据源)——GET /api/runs/active?userId=
async function handleRunsActive(req, res, ctx) {
  try {
    const { getRunStore } = require('../../core/run-store');
    const url = new URL(req.url, 'http://localhost');
    const userId = url.searchParams.get('userId') || 'default';
    const run = getRunStore().load(userId);
    return sendJson(res, 200, { success: true, run: run || null });
  } catch (e) {
    console.warn('[request] runs/active 读取失败:', e?.message || e);
    return sendJson(res, 200, { success: true, run: null });
  }
}

async function handleSecurityApproval(req, res, ctx) {
  try {
    const security = ctx.security;
    if (req.method === 'GET') {
      // 2026-08-14 审计 G3: 可选按会话过滤(conversationId/userId 查询参数);
      // 缺省不过滤保持旧行为(单会话兼容)。无归属信息的请求不隐藏(无法归因)。
      const q = ctx.query || {};
      const filterOwner = q.conversationId || q.userId || null;
      let pending = security?.approval?.getPendingRequests ? security.approval.getPendingRequests() : [];
      if (filterOwner) {
        pending = pending.filter((r) => {
          const owner = r.conversationId
            || (r.context && (r.context.conversationId || r.context.sessionId || r.context.userId));
          return !owner || String(owner) === String(filterOwner);
        });
      }
      return sendJson(res, 200, {
        success: true,
        pending,
        stats: security?.approval?.getStats ? security.approval.getStats() : {},
      });
    }

    const body = await readJsonBody(req);
    if (!security?.approval) return sendJson(res, 400, { success: false, message: 'Approval system unavailable' });
    if (!body.requestId) return sendJson(res, 400, { success: false, message: 'Missing requestId' });
    // 2026-08-14 审计 G3: 归属字段透传(仅新增可选,后端 respond 做一致性校验)
    const respondOptions = {
      ...(body.editedCommand ? { editedCommand: body.editedCommand } : {}),
      ...(body.conversationId ? { conversationId: body.conversationId } : {}),
      ...(body.userId ? { userId: body.userId } : {}),
    };
    const result = await security.approval.respond(body.requestId, body.response, body.scope || 'once', respondOptions);
    return sendJson(res, 200, { success: !!result.success, ...result });
  } catch (e) {
    return sendJson(res, 500, { success: false, message: e.message });
  }
}

async function handleSecurityWhitelist(req, res, ctx) {
  try {
    const security = ctx.security;
    if (!security?.userWhitelist) return sendJson(res, 400, { success: false, message: 'Whitelist system unavailable' });

    if (req.method === 'GET') {
      const data = security.userWhitelist.getUsers();
      return sendJson(res, 200, { success: true, data, ...data });
    }

    const body = await readJsonBody(req);
    if (body.action === 'add' && body.userId) {
      security.userWhitelist.addUser(body.userId, body.platform || 'lark');
    } else if (body.action === 'remove' && body.userId) {
      security.userWhitelist.removeUser(body.userId, body.platform || 'lark');
    } else if (body.action === 'add-admin' && body.userId) {
      security.userWhitelist.addAdminUser(body.userId, body.platform || 'lark');
    } else if (body.action === 'remove-admin' && body.userId) {
      security.userWhitelist.removeAdminUser(body.userId, body.platform || 'lark');
    } else if (typeof body.allowAll === 'boolean') {
      security.userWhitelist.setAllowAll(body.allowAll);
    } else if (Array.isArray(body.users)) {
      security.userWhitelist.config.users = body.users;
      if (Array.isArray(body.adminUsers)) security.userWhitelist.config.adminUsers = body.adminUsers;
      security.userWhitelist.config.allowAll = !!body.allowAll;
      security.userWhitelist.save?.();
    } else {
      return sendJson(res, 400, { success: false, message: 'No supported whitelist action provided' });
    }

    const data = security.userWhitelist.getUsers();
    return sendJson(res, 200, { success: true, data, ...data });
  } catch (e) {
    return sendJson(res, 500, { success: false, message: e.message });
  }
}

module.exports = {
  handleIdentity,
  handleSecurityStatus,
  handleSecurityConfig,
  handleRunsActive,
  handleSecurityApproval,
  handleSecurityWhitelist,
};
