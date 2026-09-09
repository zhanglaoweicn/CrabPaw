const { sendJson } = require('./http-utils');
const { getAuditLogs, getAuditStats, clearAuditLogs, logMessageFeedback } = require('../core/audit-log');

async function handleAuditLogs(req, res, ctx) {
  const url = new URL(req.url, `http://localhost:${ctx.PORT}`);

  const options = {
    limit: parseInt(url.searchParams.get('limit') || '100', 10),
    event: url.searchParams.get('event') || undefined,
    userId: url.searchParams.get('userId') || undefined,
    startDate: url.searchParams.get('startDate') || undefined,
    endDate: url.searchParams.get('endDate') || undefined
  };

  try {
    const logs = getAuditLogs(options);
    sendJson(res, 200, { success: true, data: logs });
  } catch (error) {
    console.error('获取审计日志失败:', error);
    sendJson(res, 500, { success: false, error: error.message });
  }
}

async function handleAuditStats(req, res, _ctx) {
  try {
    const stats = getAuditStats();
    sendJson(res, 200, { success: true, data: stats });
  } catch (error) {
    console.error('获取审计统计失败:', error);
    sendJson(res, 500, { success: false, error: error.message });
  }
}

async function handleAuditClear(req, res, _ctx) {
  try {
    clearAuditLogs();
    sendJson(res, 200, { success: true, message: '审计日志已清除' });
  } catch (error) {
    console.error('清除审计日志失败:', error);
    sendJson(res, 500, { success: false, error: error.message });
  }
}

/**
 * 消息级点赞/点踩落库(P0-3, ag-ui MetaEvent 借鉴)
 * POST /api/chat/message-feedback  body: { conversationId, messageTs, rating: 'up'|'down', text? }
 * 定位键 = conversationId + messageTs(消息无服务端持久化 id,以双键定位)。
 */
async function handleMessageFeedback(req, res, _ctx) {
  try {
    const body = await new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
        if (raw.length > 64 * 1024) { reject(new Error('body too large')); req.destroy(); }
      });
      req.on('end', () => {
        try { resolve(JSON.parse(raw || '{}')); } catch (e) { reject(new Error('invalid JSON')); }
      });
      req.on('error', reject);
    });

    const { conversationId, messageTs, rating, text } = body;
    if (typeof conversationId !== 'string' || !conversationId) {
      return sendJson(res, 400, { success: false, error: 'Missing conversationId' });
    }
    if (typeof messageTs !== 'number' || Number.isNaN(messageTs)) {
      return sendJson(res, 400, { success: false, error: 'Missing messageTs' });
    }
    if (rating !== 'up' && rating !== 'down') {
      return sendJson(res, 400, { success: false, error: "rating must be 'up' or 'down'" });
    }

    const entry = logMessageFeedback('voice_shell_user', {
      conversationId,
      messageTs,
      rating,
      text: typeof text === 'string' ? text : '',
    });
    return sendJson(res, 200, { success: true, data: { id: entry?.id, rating } });
  } catch (error) {
    console.error('消息反馈落库失败:', error);
    sendJson(res, 500, { success: false, error: error.message });
  }
}

module.exports = {
  handleAuditLogs,
  handleAuditStats,
  handleAuditClear,
  handleMessageFeedback
};
