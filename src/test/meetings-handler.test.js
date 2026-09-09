/**
 * meetings-handler.test.js — 会议记录 API（2026-08-18；P2 实时智能层 2026-09-02）
 * mock meeting-store / meeting-events / ctx.ai，锁定端点行为：
 * 新建/追加（bookmarks 透传）/列表/全量/总结（silent 调用 + 解析落库 + 广播
 * + insights 参考节）/insights 实时提取（静默降级不落坏快照）/删除 + 错误路径。
 */
const { EventEmitter } = require('events');

const mockLive = {}; // meetingId → meeting（store 与 events 共享的迷你磁盘态）
jest.mock('../core/meeting-store', () => ({
  createMeeting: jest.fn(({ title } = {}) => {
    const m = { id: 'mtg_t_' + (Object.keys(mockLive).length + 1), title: title || '会议', date: new Date().toISOString(), duration: 0, segments: [], status: 'recording' };
    mockLive[m.id] = m;
    return m;
  }),
  appendSegments: jest.fn((id, segments, opts = {}) => {
    const m = mockLive[id];
    if (!m) return null;
    if (Array.isArray(segments)) m.segments.push(...segments);
    if (opts.duration) m.duration = opts.duration;
    if (opts.bookmarks) m.bookmarks = opts.bookmarks;
    return m;
  }),
  listMeetings: jest.fn(() => Object.values(mockLive).map(x => ({ id: x.id, title: x.title, status: x.status, segmentCount: x.segments.length, hasSummary: !!x.summary }))),
  getMeeting: jest.fn((id) => mockLive[id] || null),
  updateSummary: jest.fn((id, { summary, keyPoints }) => {
    const m = mockLive[id];
    if (!m) return null;
    m.summary = summary; m.keyPoints = keyPoints; m.status = 'done';
    return m;
  }),
  setInsights: jest.fn((id, insights) => { const m = mockLive[id]; if (!m) return null; m.insights = insights; return m; }),
  setMeetingStatus: jest.fn(() => null),
  deleteMeeting: jest.fn((id) => { const existed = !!mockLive[id]; delete mockLive[id]; return existed; }),
  sanitizeTranscript: jest.fn((segments) => (segments || []).map(s => s.text).join('\n')),
  parseSummaryReply: jest.fn((reply) => {
    const text = String(reply || '');
    const m = text.match(/## 📋 会议摘要\n([\s\S]*?)\n\n## 🔑 核心要点\n([\s\S]*)$/);
    if (!m) return { summary: '', keyPoints: [] };
    return { summary: m[1], keyPoints: m[2].split('\n').map(l => l.replace(/^- /, '')).filter(Boolean) };
  }),
}));

jest.mock('../core/meeting-events', () => ({
  updateMeetingSurface: jest.fn(),
  completeMeeting: jest.fn((id, { summary, keyPoints }) => {
    const m = mockLive[id];
    m.summary = summary; m.keyPoints = keyPoints; m.status = 'done';
    return m;
  }),
  failMeeting: jest.fn(),
}));

const { handleMeetingsRoute, buildSummaryPrompt } = require('../handlers/local-handlers/meetings');

function makeReq(method, body) {
  const r = new EventEmitter();
  r.method = method;
  if (body !== undefined) {
    setImmediate(() => {
      r.emit('data', Buffer.from(JSON.stringify(body)));
      r.emit('end');
    });
  }
  return r;
}

function makeRes() {
  return { writeHead: jest.fn(), end: jest.fn(), headersSent: false, writableEnded: false };
}

function ctxFor(pathname, ai) {
  return {
    url: new URL(`http://localhost:38767${pathname}`),
    appConfig: { test: true },
    skills: [],
    userId: 'test-user',
    ai,
  };
}

function jsonOf(res) {
  return JSON.parse(res.end.mock.calls[0][1] || res.end.mock.calls[0][0]);
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(mockLive)) delete mockLive[k];
});

describe('POST /api/meetings', () => {
  test('新建会议返回会议对象（recording 态）', async () => {
    const res = makeRes();
    await handleMeetingsRoute(makeReq('POST', { title: '周会' }), res, ctxFor('/api/meetings'));
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.anything());
    const body = jsonOf(res);
    expect(body.success).toBe(true);
    expect(body.data.id).toMatch(/^mtg_/);
    expect(body.data.title).toBe('周会');
    expect(body.data.status).toBe('recording');
  });
});

describe('POST /api/meetings/:id/segments', () => {
  test('追加转写返回 segmentCount/duration 并刷新 surface', async () => {
    const created = await (async () => {
      const res = makeRes();
      await handleMeetingsRoute(makeReq('POST', { title: 'T' }), res, ctxFor('/api/meetings'));
      return jsonOf(res).data;
    })();
    const res = makeRes();
    await handleMeetingsRoute(
      makeReq('POST', { segments: [{ text: '你好' }, { text: '记录中' }], duration: 30 }),
      res, ctxFor(`/api/meetings/${created.id}/segments`)
    );
    const body = jsonOf(res);
    expect(body.success).toBe(true);
    expect(body.data.segmentCount).toBe(2);
    expect(body.data.duration).toBe(30);
    const { updateMeetingSurface } = require('../core/meeting-events');
    expect(updateMeetingSurface).toHaveBeenCalled();
  });

  test('会议不存在返回 404', async () => {
    const res = makeRes();
    await handleMeetingsRoute(makeReq('POST', { segments: [] }), res, ctxFor('/api/meetings/mtg_none/segments'));
    expect(res.writeHead).toHaveBeenCalledWith(404, expect.anything());
  });
});

describe('POST /api/meetings/:id/summarize', () => {
  async function createWithSegments() {
    const res = makeRes();
    await handleMeetingsRoute(makeReq('POST', { title: 'T' }), res, ctxFor('/api/meetings'));
    const { data } = jsonOf(res);
    const res2 = makeRes();
    await handleMeetingsRoute(
      makeReq('POST', { segments: [{ text: '讨论了新方案' }, { text: '下周三上线' }], duration: 60 }),
      res2, ctxFor(`/api/meetings/${data.id}/segments`)
    );
    return data.id;
  }

  test('总结成功：silent 调用 ai.chat + 解析落库 + 广播 completeMeeting', async () => {
    const id = await createWithSegments();
    const aiChat = jest.fn(async () =>
      '## 📋 会议摘要\n确定了新方案，下周三上线。\n\n## 🔑 核心要点\n- 新方案\n- 周三上线'
    );
    const res = makeRes();
    await handleMeetingsRoute(makeReq('POST', {}), res, ctxFor(`/api/meetings/${id}/summarize`, { chat: aiChat }));
    expect(aiChat).toHaveBeenCalledTimes(1);
    expect(aiChat.mock.calls[0][0]).toEqual({ test: true }); // appConfig
    expect(aiChat.mock.calls[0][3]).toContain('## 📋 会议摘要'); // prompt 两段式
    expect(aiChat.mock.calls[0][4]).toEqual(expect.objectContaining({ silent: true })); // silent 内部任务
    const body = jsonOf(res);
    expect(body.success).toBe(true);
    expect(body.data.summary).toContain('新方案');
    expect(body.data.keyPoints).toEqual(['新方案', '周三上线']);
    const { completeMeeting } = require('../core/meeting-events');
    expect(completeMeeting).toHaveBeenCalledWith(id, { summary: expect.stringContaining('新方案'), keyPoints: expect.any(Array) });
  });

  test('转写为空返回 400 不调 AI', async () => {
    const res = makeRes();
    await handleMeetingsRoute(makeReq('POST', { title: '空' }), res, ctxFor('/api/meetings'));
    const { data } = jsonOf(res);
    const aiChat = jest.fn();
    const res2 = makeRes();
    await handleMeetingsRoute(makeReq('POST', {}), res2, ctxFor(`/api/meetings/${data.id}/summarize`, { chat: aiChat }));
    expect(res2.writeHead).toHaveBeenCalledWith(400, expect.anything());
    expect(aiChat).not.toHaveBeenCalled();
  });

  test('会议不存在返回 404', async () => {
    const res = makeRes();
    await handleMeetingsRoute(makeReq('POST', {}), res, ctxFor('/api/meetings/mtg_none/summarize', { chat: jest.fn() }));
    expect(res.writeHead).toHaveBeenCalledWith(404, expect.anything());
  });

  test('ctx.ai 缺失 → failMeeting 广播 + 502', async () => {
    const id = await createWithSegments();
    const res = makeRes();
    await handleMeetingsRoute(makeReq('POST', {}), res, ctxFor(`/api/meetings/${id}/summarize`, null));
    expect(res.writeHead).toHaveBeenCalledWith(502, expect.anything());
    const { failMeeting } = require('../core/meeting-events');
    expect(failMeeting).toHaveBeenCalledWith(id, expect.any(String));
  });

  test('AI 回复无法解析 → failMeeting + 502', async () => {
    const id = await createWithSegments();
    const res = makeRes();
    await handleMeetingsRoute(makeReq('POST', {}), res, ctxFor(`/api/meetings/${id}/summarize`, { chat: jest.fn(async () => '无法理解的内容') }));
    expect(res.writeHead).toHaveBeenCalledWith(502, expect.anything());
    const { failMeeting } = require('../core/meeting-events');
    expect(failMeeting).toHaveBeenCalled();
  });

  // 超时路径由 Promise.race + SUMMARY_TIMEOUT_MS(60s) 结构保证；
  // 模块常量不可注入，真实等待 60s 不现实——错误路径（AI 缺失/无法解析）已覆盖 failMeeting 分支。
});

describe('GET /api/meetings 与 DELETE', () => {
  test('列表返回全部会议（倒序由 store 保证）', async () => {
    const { createMeeting } = require('../core/meeting-store');
    createMeeting({ title: 'A' });
    createMeeting({ title: 'B' });
    const res = makeRes();
    await handleMeetingsRoute(makeReq('GET'), res, ctxFor('/api/meetings'));
    const body = jsonOf(res);
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(2);
  });

  test('全量返回含 segments', async () => {
    const { createMeeting, appendSegments } = require('../core/meeting-store');
    const m = createMeeting({ title: 'T' });
    appendSegments(m.id, [{ text: 'x' }]);
    const res = makeRes();
    await handleMeetingsRoute(makeReq('GET'), res, ctxFor(`/api/meetings/${m.id}`));
    const body = jsonOf(res);
    expect(body.data.segments).toHaveLength(1);
  });

  test('全量不存在返回 404', async () => {
    const res = makeRes();
    await handleMeetingsRoute(makeReq('GET'), res, ctxFor('/api/meetings/mtg_none'));
    expect(res.writeHead).toHaveBeenCalledWith(404, expect.anything());
  });

  test('删除成功返回 200；不存在返回 404', async () => {
    const { createMeeting } = require('../core/meeting-store');
    const m = createMeeting({ title: 'T' });
    const res = makeRes();
    await handleMeetingsRoute(makeReq('DELETE'), res, ctxFor(`/api/meetings/${m.id}`));
    expect(jsonOf(res).success).toBe(true);
    const res2 = makeRes();
    await handleMeetingsRoute(makeReq('DELETE'), res2, ctxFor('/api/meetings/mtg_none'));
    expect(res2.writeHead).toHaveBeenCalledWith(404, expect.anything());
  });

  test('未知路径返回 404', async () => {
    const res = makeRes();
    await handleMeetingsRoute(makeReq('GET'), res, ctxFor('/api/meetings-unknown'));
    expect(res.writeHead).toHaveBeenCalledWith(404, expect.anything());
  });
});

describe('buildSummaryPrompt', () => {
  test('两段式提示词含摘要/核心要点与转写正文', () => {
    const p = buildSummaryPrompt('转写正文');
    expect(p).toContain('## 📋 会议摘要');
    expect(p).toContain('## 🔑 核心要点');
    expect(p).toContain('转写正文');
    expect(p).not.toContain('完整转写'); // 不回显转写（卡片内已展示）
  });
});

describe('POST /api/meetings/:id/insights（P2 实时智能层）', () => {
  const aiJson = (obj) => jest.fn(async () => '```json\n' + JSON.stringify(obj) + '\n```');

  beforeEach(() => {
    // 外层 beforeEach 每例清空 mockLive → 此处种子一个会议供 /:id/insights 定位
    require('../core/meeting-store').createMeeting({ title: 'T' });
  });

  test('静默 AI 提取成功 → 归一落库 setInsights + 返回', async () => {
    const res = makeRes();
    const meeting = JSON.parse(JSON.stringify(mockLive.mtg_1 || Object.values(mockLive)[0]));
    await handleMeetingsRoute(makeReq('POST', { transcript: '会上说要发周报，决定用方案A' }), res, ctxFor(`/api/meetings/${meeting.id}/insights`, { chat: aiJson({ todos: ['发周报'], decisions: ['用方案A'], points: ['x', 42, 'y'] }) }));
    const out = jsonOf(res);
    expect(out.success).toBe(true);
    expect(out.data.todos).toEqual(['发周报']);
    expect(out.data.points).toEqual(['x', 'y']);
    const { setInsights } = require('../core/meeting-store');
    expect(setInsights).toHaveBeenCalledWith(meeting.id, expect.objectContaining({ todos: ['发周报'] }));
  });

  test('AI 回复无法解析 → 200 空数组 + 不落库（静默降级）', async () => {
    const res = makeRes();
    const meeting = Object.values(mockLive)[0];
    const { setInsights } = require('../core/meeting-store');
    await handleMeetingsRoute(makeReq('POST', { transcript: '内容' }), res, ctxFor(`/api/meetings/${meeting.id}/insights`, { chat: jest.fn(async () => '不是 JSON') }));
    const out = jsonOf(res);
    expect(out.success).toBe(true);
    expect(out.data).toEqual({ todos: [], decisions: [], points: [] });
    expect(setInsights).not.toHaveBeenCalled();
  });

  test('空 transcript 短路: 不调 AI 返回空数组', async () => {
    const res = makeRes();
    const meeting = Object.values(mockLive)[0];
    const chat = jest.fn();
    await handleMeetingsRoute(makeReq('POST', { transcript: '   ' }), res, ctxFor(`/api/meetings/${meeting.id}/insights`, { chat }));
    expect(chat).not.toHaveBeenCalled();
    expect(jsonOf(res).data.todos).toEqual([]);
  });

  test('未知会议 404', async () => {
    const res = makeRes();
    await handleMeetingsRoute(makeReq('POST', { transcript: 'x' }), res, ctxFor('/api/meetings/mtg_none/insights', { chat: jest.fn() }));
    expect(jsonOf(res).success).toBe(false); // sendJson 单参 end → jsonOf 兜底取 calls[0][0]
  });
});

describe('segments bookmarks 透传 + summarize 参考节（P2）', () => {
  beforeEach(() => {
    // 同上：种子一个会议供 /:id/segments 定位
    require('../core/meeting-store').createMeeting({ title: 'T' });
  });

  test('segments POST 把 bookmarks 透传 appendSegments', async () => {
    const res = makeRes();
    const meeting = Object.values(mockLive)[0];
    await handleMeetingsRoute(makeReq('POST', { segments: [{ text: 'a', time: 0 }], bookmarks: [{ time: 3, at: 9 }] }), res, ctxFor(`/api/meetings/${meeting.id}/segments`));
    const { appendSegments } = require('../core/meeting-store');
    expect(appendSegments).toHaveBeenCalledWith(meeting.id, expect.anything(), expect.objectContaining({ bookmarks: [{ time: 3, at: 9 }] }));
  });

  test('buildSummaryPrompt 带 insights 时附参考节', () => {
    const prompt = buildSummaryPrompt('转写', { todos: ['发周报'], decisions: [], points: ['要点1'] });
    expect(prompt).toContain('录制中实时提取');
    expect(prompt).toContain('发周报');
    expect(buildSummaryPrompt('转写', null)).not.toContain('录制中实时提取');
  });
});

describe('scheduleId 关联（S3.3 日程×纪要打通）', () => {
  test('POST /api/meetings 透传 scheduleId 到 store', async () => {
    const res = makeRes();
    await handleMeetingsRoute(makeReq('POST', { title: '评审', scheduleId: 'evt_9' }), res, ctxFor('/api/meetings'));
    const { createMeeting } = require('../core/meeting-store');
    expect(createMeeting).toHaveBeenCalledWith(expect.objectContaining({ scheduleId: 'evt_9' }));
  });

  test('GET /api/meetings?scheduleId= 内存过滤', async () => {
    const { listMeetings } = require('../core/meeting-store');
    listMeetings.mockReturnValueOnce([
      { id: 'mtg_1', title: '有关联', scheduleId: 'evt_1', status: 'done', hasSummary: true },
      { id: 'mtg_2', title: '无关联', scheduleId: null, status: 'done', hasSummary: true },
    ]);
    const res = makeRes();
    await handleMeetingsRoute(makeReq('GET'), res, ctxFor('/api/meetings?scheduleId=evt_1'));
    const body = jsonOf(res);
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('mtg_1');
  });
});
