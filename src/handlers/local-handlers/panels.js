'use strict';
// 管理舱面板禁用开关 API（2026-08-27 已知限制#1 收口配套）。
const { sendJson } = require('../http-utils');

/**
 * POST body 校验（抽纯函数供单测——readJsonBody 需 req 流，测试不便构造）。
 * @returns {{ok: true, key: string, enabled: boolean} | {ok: false, error: string}}
 */
function validatePanelStatePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body 缺失' };
  }
  if (typeof body.key !== 'string' || !body.key.trim()) {
    return { ok: false, error: 'key 必须为非空字符串' };
  }
  if (typeof body.enabled !== 'boolean') {
    return { ok: false, error: 'enabled 必须为布尔' };
  }
  return { ok: true, key: body.key, enabled: body.enabled };
}

async function handlePanelStateGet(req, res, _ctx) {
  try {
    const { getPanelStates } = require('../../core/panels/panel-registry');
    sendJson(res, 200, { success: true, data: { panels: getPanelStates() } });
  } catch (e) {
    console.error('[panels] 状态读取失败:', e.message);
    sendJson(res, 500, { success: false, error: e.message });
  }
}

async function handlePanelStateSet(req, res, ctx) {
  try {
    const { readJsonBody } = require('../http-utils');
    const body = await readJsonBody(req);
    const v = validatePanelStatePayload(body);
    if (!v.ok) return sendJson(res, 400, { success: false, error: v.error });
    const { setPanelEnabled } = require('../../core/panels/panel-registry');
    const { refreshPanelStateMaps } = require('../../core/panel-state');
    const r = setPanelEnabled(v.key, v.enabled);
    if (!r.ok) return sendJson(res, 400, { success: false, error: r.error });
    refreshPanelStateMaps(); // 重建 panel-state 读面——即时生效
    sendJson(res, 200, { success: true, data: { key: v.key, enabled: v.enabled } });
  } catch (e) {
    // 非法 JSON（空 body 亦归此类）属客户端错误 → 400；其余内部错误 → 500
    console.error('[panels] 状态写入失败:', e.message);
    sendJson(res, e && e.code === 'INVALID_JSON' ? 400 : 500, { success: false, error: e.message });
  }
}

module.exports = { handlePanelStateGet, handlePanelStateSet, validatePanelStatePayload };
