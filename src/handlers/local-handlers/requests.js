// requests.js — 从 src/cli/request-handler.js 机械抽取（Task 6，零行为变化）。
// 方法体逐字迁移；相对 require 路径按新模块位置平移；LOCAL_HANDLERS 交叉引用改为模块内直调。

const { readJsonBody, sendJson } = require('../http-utils');

async function handleRequestCancel(req, res, _ctx) {
  try {
    let body = {};
    try { body = await readJsonBody(req); } catch (e) { console.warn('[request-cancel] body 解析失败:', e?.message || e); }
    const userId = body.userId || 'default';
    const runId = body.runId || null;

    const { globalRequestInterrupt } = require('../../core/request-interrupt');
    const { getRunStore } = require('../../core/run-store');

    // B3(Runtime差距分析): run 级取消——停止按钮/调用方携带 runId 时先置位
    // cancelRequested 再 abort,保证断连清理与终态分类(cancelled vs interrupted)
    // 看到一致的取消意图; 未带 runId 回退 userId 粒度(兼容旧调用方)。
    const runStore = getRunStore();
    let targetRecord = null;
    if (runId) {
      targetRecord = runStore.requestCancel(runId);
      if (!targetRecord) {
        return sendJson(res, 200, { success: false, message: 'No active run with this runId' });
      }
    } else {
      targetRecord = runStore.getActiveRunByUser(userId);
      if (targetRecord) runStore.requestCancel(targetRecord.runId);
    }

    const aborted = globalRequestInterrupt.abort(targetRecord ? targetRecord.userId : userId);

    return sendJson(res, 200, {
      success: aborted || !!targetRecord,
      runId: targetRecord ? targetRecord.runId : null,
      message: aborted ? 'Request aborted' : (targetRecord ? 'Run cancel requested (no in-flight LLM stream)' : 'No active request to cancel'),
    });
  } catch (e) {
    return sendJson(res, 500, { success: false, message: e.message });
  }
}

async function handleRequestStatus(req, res, _ctx) {
  try {
    const { globalRequestInterrupt } = require('../../core/request-interrupt');
    return sendJson(res, 200, {
      activeRequests: globalRequestInterrupt.getActiveRequests(),
      activeCount: globalRequestInterrupt.getActiveCount(),
    });
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
}

module.exports = {
  handleRequestCancel,
  handleRequestStatus,
};
