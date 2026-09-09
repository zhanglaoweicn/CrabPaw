// meetings.js — 会议记录 API（2026-08-18）
//
// 会议卡片的后端端点（替代旧前端 localStorage 方案）：
//   POST   /api/meetings                     → 新建会议（录制开始）
//   GET    /api/meetings                     → 历史列表（倒序）
//   GET    /api/meetings/:id                 → 全量（含转写 segments）
//   POST   /api/meetings/:id/segments        → 追加转写（录制 flush, bookmarks 透传）
//   POST   /api/meetings/:id/insights        → 实时提取（P2: silent AI + 严格 JSON + 静默降级）
//   POST   /api/meetings/:id/summarize       → 静默总结（ctx.ai.chat silent）→ 落库 + 广播
//   DELETE /api/meetings/:id                 → 删除
//
// 统一响应 { success, data | error }。总结走 silent 内部任务（不计用户对话历史、
// 预算 internal 分类），60s 超时兜底。

const { readJsonBody, sendJson } = require('../http-utils');
const store = require('../../core/meeting-store');
const meetingEvents = require('../../core/meeting-events');

const SUMMARY_TIMEOUT_MS = 60 * 1000;

/** 总结提示词：两段式（摘要 + 核心要点）。旧版 UI 的三段式含完整转写回显，
 *  转写已在卡片内展示，不再让模型回显浪费 token；parseSummaryReply 仍兼容
 *  模型自行附加「## 📝 完整转写」节。 */
function buildSummaryPrompt(text, insights) {
  return `请对以下会议转写内容进行摘要整理，输出格式要求：

## 📋 会议摘要
（3-5句话概括会议核心内容）

## 🔑 核心要点
- 要点1
- 要点2
...

转写内容：
---
${text}

---
${insights && (insights.todos?.length || insights.decisions?.length || insights.points?.length) ? `
## 🧭 录制中实时提取（参考）
以下为录制过程中实时提取的中间产物，供总结参考（可能不完整，以转写原文为准）：
${insights.todos?.length ? `- 待办: ${insights.todos.join('；')}\n` : ''}${insights.decisions?.length ? `- 决策: ${insights.decisions.join('；')}\n` : ''}${insights.points?.length ? `- 要点: ${insights.points.join('；')}\n` : ''}
` : ''}
要求：摘要简洁有力，核心要点不超过8条。`;
}

/** 实时提取提示词（P2）: 严格 JSON 输出, 供前端右栏与总结参考 */
function buildInsightsPrompt(text) {
  return `你是会议实时摘要助手。从以下会议转写片段中提取三类信息，输出严格 JSON（不要任何其他文字、不要代码块标记）：
{"todos":["待办事项，含负责人则带上"],"decisions":["已做出的决定"],"points":["值得记的要点/结论"]}

规则：只提取转写中明确说到的内容；没有的类别输出空数组；每条不超过 40 字。

转写片段：
---
${text}
---`;
}

/** 解析 AI 提取回复 → 归一 {todos,decisions,points}; 无法解析返回 null（调用方静默降级） */
function parseInsightsReply(reply) {
  const text = String(reply || '');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  const norm = v => (Array.isArray(v) ? v.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim()).slice(0, 10) : []);
  const out = { todos: norm(obj.todos), decisions: norm(obj.decisions), points: norm(obj.points) };
  if (!out.todos.length && !out.decisions.length && !out.points.length) return null;
  return out;
}

async function handleMeetingsRoute(req, res, ctx) {
  const pathname = ctx.url.pathname;
  try {
    // POST /api/meetings —— 新建会议（录制开始）
    if (req.method === 'POST' && /^\/api\/meetings$/.test(pathname)) {
      const body = await readJsonBody(req);
      const meeting = store.createMeeting({ title: body && body.title, scheduleId: body && body.scheduleId });
      return sendJson(res, 200, { success: true, data: meeting });
    }

    // POST /api/meetings/:id/segments —— 追加转写（录制 flush）
    let m = pathname.match(/^\/api\/meetings\/([^/]+)\/segments$/);
    if (req.method === 'POST' && m) {
      const body = await readJsonBody(req);
      const meeting = store.appendSegments(m[1], body && body.segments, {
        duration: body && body.duration,
        bookmarks: body && body.bookmarks,
      });
      if (!meeting) return sendJson(res, 404, { success: false, error: '会议不存在' });
      meetingEvents.updateMeetingSurface(); // 快照刷新（segmentCount/duration）
      return sendJson(res, 200, {
        success: true,
        data: { id: meeting.id, segmentCount: meeting.segments.length, duration: meeting.duration },
      });
    }

    // POST /api/meetings/:id/insights —— 实时提取（P2）: silent AI + 严格 JSON + 静默降级
    m = pathname.match(/^\/api\/meetings\/([^/]+)\/insights$/);
    if (req.method === 'POST' && m) {
      const meetingId = m[1];
      const meeting = store.getMeeting(meetingId);
      if (!meeting) return sendJson(res, 404, { success: false, error: '会议不存在' });
      const body = await readJsonBody(req);
      const text = String((body && body.transcript) || '').trim().slice(0, 8000);
      const empty = { todos: [], decisions: [], points: [] };
      if (!text) return sendJson(res, 200, { success: true, data: empty });
      if (ctx.ai && typeof ctx.ai.chat === 'function') {
        const userId = (ctx && ctx.userId) || 'default';
        let timer;
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('提取超时(20s)')), 20 * 1000); });
        let reply = '';
        try {
          reply = await Promise.race([ctx.ai.chat(ctx.appConfig, ctx.skills, userId, buildInsightsPrompt(text), { silent: true }), timeout]);
        } catch (e) {
          console.warn('[meetings] insights 提取失败(静默降级):', e.message);
        } finally {
          clearTimeout(timer);
        }
        const parsed = parseInsightsReply(reply);
        if (parsed) {
          try { store.setInsights(meetingId, parsed); } catch (e) { console.warn('[meetings] insights 落库失败:', e.message); }
          return sendJson(res, 200, { success: true, data: parsed });
        }
        return sendJson(res, 200, { success: true, data: empty });
      }
      return sendJson(res, 200, { success: true, data: empty });
    }

    // POST /api/meetings/:id/summarize —— 静默总结 + 落库 + 广播
    m = pathname.match(/^\/api\/meetings\/([^/]+)\/summarize$/);
    if (req.method === 'POST' && m) {
      const meetingId = m[1];
      const meeting = store.getMeeting(meetingId);
      if (!meeting) return sendJson(res, 404, { success: false, error: '会议不存在' });
      const text = store.sanitizeTranscript(meeting.segments);
      if (!text) return sendJson(res, 400, { success: false, error: '转写内容为空，无法总结' });
      const insights = meeting.insights || null;

      let reply = '';
      if (ctx.ai && typeof ctx.ai.chat === 'function') {
        const userId = (ctx && ctx.userId) || 'default';
        let timer;
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('总结超时(60s)')), SUMMARY_TIMEOUT_MS);
        });
        const chatPromise = ctx.ai.chat(ctx.appConfig, ctx.skills, userId, buildSummaryPrompt(text, insights), {
          silent: true, // 内部任务：不进对话历史、预算 internal 分类
        });
        try {
          reply = await Promise.race([chatPromise, timeout]);
        } finally {
          clearTimeout(timer);
        }
      }
      if (!reply) {
        // ctx.ai 不可用（降级/测试）或空回复 → 错误态，不落 done
        meetingEvents.failMeeting(meetingId, 'AI 未返回有效回复');
        return sendJson(res, 502, { success: false, error: '总结失败：AI 未返回有效回复' });
      }
      const { summary, keyPoints } = store.parseSummaryReply(reply);
      if (!summary && keyPoints.length === 0) {
        meetingEvents.failMeeting(meetingId, 'AI 回复无法解析');
        return sendJson(res, 502, { success: false, error: '总结失败：AI 回复无法解析' });
      }
      const updated = meetingEvents.completeMeeting(meetingId, { summary, keyPoints });
      return sendJson(res, 200, {
        success: true,
        data: { id: updated.id, summary, keyPoints },
      });
    }

    // DELETE /api/meetings/:id
    m = pathname.match(/^\/api\/meetings\/([^/]+)$/);
    if (req.method === 'DELETE' && m) {
      const removed = store.deleteMeeting(m[1]);
      return sendJson(res, removed ? 200 : 404, {
        success: removed,
        error: removed ? undefined : '会议不存在',
      });
    }

    // GET /api/meetings —— 历史列表
    if (req.method === 'GET' && /^\/api\/meetings$/.test(pathname)) {
      // S3.3: ?scheduleId= 内存过滤（日程卡纪要 chip 查询）
      const sid = ctx.url.searchParams.get('scheduleId');
      let list = store.listMeetings();
      if (sid) list = list.filter(x => x.scheduleId === sid);
      return sendJson(res, 200, { success: true, data: list });
    }

    // GET /api/meetings/:id —— 全量
    m = pathname.match(/^\/api\/meetings\/([^/]+)$/);
    if (req.method === 'GET' && m) {
      const meeting = store.getMeeting(m[1]);
      if (!meeting) return sendJson(res, 404, { success: false, error: '会议不存在' });
      return sendJson(res, 200, { success: true, data: meeting });
    }

    return sendJson(res, 404, { success: false, error: 'Meetings API Not Found' });
  } catch (e) {
    console.error('[meetings] API 错误:', e.message);
    return sendJson(res, 500, { success: false, error: `会议 API 错误: ${e.message}` });
  }
}

module.exports = { handleMeetingsRoute, buildSummaryPrompt, buildInsightsPrompt, parseInsightsReply };
