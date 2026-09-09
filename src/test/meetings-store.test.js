/**
 * meetings-store.test.js — 会议记录磁盘持久化（2026-08-18）
 * 注入临时 baseDir，锁定 index + 全量文件 CRUD、segments 上限、状态机、
 * parseSummaryReply 宽松正则家族（迁移自旧 MeetingsPanel handleSummarize）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createMeeting,
  appendSegments,
  listMeetings,
  getMeeting,
  updateSummary,
  setMeetingStatus,
  deleteMeeting,
  sanitizeTranscript,
  parseSummaryReply,
  gcStaleRecordings,
  setInsights,
  MAX_SEGMENTS,
} = require('../core/meeting-store');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meetings-test-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* 清理临时目录 */ }
});

function seg(text, time = 1000) {
  return { text, time };
}

describe('meeting-store CRUD', () => {
  test('createMeeting 落 index + 全量文件，列表倒序（新在前）', () => {
    const a = createMeeting({ title: '会议A', baseDir: tmpDir });
    const b = createMeeting({ title: '会议B', baseDir: tmpDir });
    const list = listMeetings(tmpDir);
    expect(list[0].id).toBe(b.id);
    expect(list[1].id).toBe(a.id);
    expect(list[0].title).toBe('会议B');
    expect(list[0].status).toBe('recording');
    expect(list[0].hasSummary).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'meetings', `${a.id}.json`))).toBe(true);
  });

  test('createMeeting 缺 title 用默认「会议 日期 时:分」', () => {
    const m = createMeeting({ baseDir: tmpDir });
    expect(m.title).toMatch(/^会议 \d+/);
  });

  test('appendSegments 追加转写 + 索引刷新 segmentCount/duration', () => {
    const m = createMeeting({ title: 'T', baseDir: tmpDir });
    appendSegments(m.id, [seg('你好'), seg('我在记录')], { duration: 45, baseDir: tmpDir });
    const full = getMeeting(m.id, tmpDir);
    expect(full.segments).toHaveLength(2);
    expect(full.duration).toBe(45);
    expect(listMeetings(tmpDir)[0].segmentCount).toBe(2);
  });

  test('appendSegments 幂等追加（多次 flush 不丢）且 duration 取最大', () => {
    const m = createMeeting({ title: 'T', baseDir: tmpDir });
    appendSegments(m.id, [seg('一'), seg('二')], { duration: 10, baseDir: tmpDir });
    appendSegments(m.id, [seg('三')], { duration: 30, baseDir: tmpDir });
    appendSegments(m.id, [seg('四')], { duration: 20, baseDir: tmpDir });
    const full = getMeeting(m.id, tmpDir);
    expect(full.segments.map(s => s.text)).toEqual(['一', '二', '三', '四']);
    expect(full.duration).toBe(30);
  });

  test('segments 上限 MAX_SEGMENTS 截尾保留最新', () => {
    const m = createMeeting({ title: 'T', baseDir: tmpDir });
    const many = [];
    for (let i = 0; i < MAX_SEGMENTS + 50; i++) many.push(seg(`第${i}段`));
    appendSegments(m.id, many, { baseDir: tmpDir });
    const full = getMeeting(m.id, tmpDir);
    expect(full.segments).toHaveLength(MAX_SEGMENTS);
    expect(full.segments[0].text).toBe(`第${50}段`);
  });

  test('空/纯空白 segment 被过滤', () => {
    const m = createMeeting({ title: 'T', baseDir: tmpDir });
    appendSegments(m.id, [seg(''), seg('  '), seg('有效')], { baseDir: tmpDir });
    expect(getMeeting(m.id, tmpDir).segments).toHaveLength(1);
  });

  test('updateSummary 落 done + 索引 hasSummary', () => {
    const m = createMeeting({ title: 'T', baseDir: tmpDir });
    appendSegments(m.id, [seg('内容')], { baseDir: tmpDir });
    const updated = updateSummary(m.id, { summary: '摘要', keyPoints: ['要点1'], baseDir: tmpDir });
    expect(updated.status).toBe('done');
    expect(getMeeting(m.id, tmpDir).summary).toBe('摘要');
    const entry = listMeetings(tmpDir)[0];
    expect(entry.hasSummary).toBe(true);
    expect(entry.status).toBe('done');
  });

  test('setMeetingStatus 状态迁移（summarizing/error）', () => {
    const m = createMeeting({ title: 'T', baseDir: tmpDir });
    setMeetingStatus(m.id, 'summarizing', tmpDir);
    expect(listMeetings(tmpDir)[0].status).toBe('summarizing');
    setMeetingStatus(m.id, 'error', tmpDir);
    expect(listMeetings(tmpDir)[0].status).toBe('error');
  });

  test('deleteMeeting 移除索引与全量文件', () => {
    const m = createMeeting({ title: 'T', baseDir: tmpDir });
    const file = path.join(tmpDir, 'meetings', `${m.id}.json`);
    expect(fs.existsSync(file)).toBe(true);
    expect(deleteMeeting(m.id, tmpDir)).toBe(true);
    expect(listMeetings(tmpDir)).toHaveLength(0);
    expect(fs.existsSync(file)).toBe(false);
    expect(deleteMeeting('mtg_nonexist', tmpDir)).toBe(false);
  });

  test('getMeeting 不存在返回 null', () => {
    expect(getMeeting('mtg_nonexist', tmpDir)).toBeNull();
  });
});

describe('sanitizeTranscript', () => {
  test('拼接非空转写并截断 8000 字', () => {
    const long = '长'.repeat(9000);
    const out = sanitizeTranscript([seg(' 甲 '), seg(''), seg(long)]);
    expect(out.startsWith('甲\n')).toBe(true);
    expect(out.length).toBe(8000); // '甲\n'(2) + 长文本截断至 8000 字符切片
  });
});

describe('parseSummaryReply 宽松正则家族', () => {
  test('标准 ## 标题解析摘要 + 核心要点', () => {
    const { summary, keyPoints } = parseSummaryReply(
      '## 📋 会议摘要\n今天讨论了下周计划。\n\n## 🔑 核心要点\n- 准备材料\n- 周四评审\n\n## 📝 完整转写\n原样内容'
    );
    expect(summary).toContain('今天讨论了');
    expect(keyPoints).toEqual(['准备材料', '周四评审']);
  });

  test('无 emoji 纯文本标题（## 会议摘要 / ## 核心要点）', () => {
    const { summary, keyPoints } = parseSummaryReply(
      '## 会议摘要\n两句话概括。\n## 核心要点\n1. 第一点\n2. 第二点'
    );
    expect(summary).toBe('两句话概括。');
    expect(keyPoints).toEqual(['第一点', '第二点']);
  });

  test('** 加粗标题形态', () => {
    const { summary } = parseSummaryReply('**会议摘要**：加粗标题下的内容。\n**核心要点**：\n- A');
    expect(summary).toBe('加粗标题下的内容。');
  });

  test('无标题时降级：回复前 500 字为摘要', () => {
    const { summary, keyPoints } = parseSummaryReply('这就是没有标题的回复内容，足够长会被截断。'.repeat(50));
    expect(summary.length).toBe(500);
    expect(keyPoints).toEqual([]);
  });

  test('无核心要点节时降级：提取 - • 数字行', () => {
    const { summary, keyPoints } = parseSummaryReply(
      '## 会议摘要\n内容\n- 行一\n• 行二\n2. 行三\n普通文本行\n- 行四'
    );
    expect(keyPoints).toEqual(['行一', '行二', '行三', '行四']);
  });

  test('要点行清洗：-、•、*、数字 前缀全部剥离', () => {
    const { keyPoints } = parseSummaryReply('## 核心要点\n- 带横杠\n• 带圆点\n* 带星号\n3. 带数字\n  缩进的要点');
    expect(keyPoints).toEqual(['带横杠', '带圆点', '带星号', '带数字', '缩进的要点']);
  });

  test('要点超过 10 条截断（fallback 路径 slice(0,10)）', () => {
    const lines = Array.from({ length: 15 }, (_, i) => `- 要点${i + 1}`).join('\n');
    const { keyPoints } = parseSummaryReply(`## 会议摘要\nx\n${lines}`);
    expect(keyPoints).toHaveLength(10);
  });

  test('空回复返回空摘要空要点', () => {
    expect(parseSummaryReply('')).toEqual({ summary: '', keyPoints: [] });
    expect(parseSummaryReply(null)).toEqual({ summary: '', keyPoints: [] });
  });
});

describe('gcStaleRecordings（R4 僵尸录制态）', () => {
  test('recording/summarizing → interrupted; done/error 不动', () => {
    const a = createMeeting({ title: 'A', baseDir: tmpDir });
    const b = createMeeting({ title: 'B', baseDir: tmpDir });
    const c = createMeeting({ title: 'C', baseDir: tmpDir });
    setMeetingStatus(b.id, 'summarizing', tmpDir);
    setMeetingStatus(c.id, 'done', tmpDir);
    const n = gcStaleRecordings(tmpDir);
    expect(n).toBe(2);
    expect(getMeeting(a.id, tmpDir).status).toBe('interrupted');
    expect(getMeeting(b.id, tmpDir).status).toBe('interrupted');
    expect(getMeeting(c.id, tmpDir).status).toBe('done');
  });

  test('空索引安全返回 0', () => {
    const empty = path.join(tmpDir, 'empty-gc-' + Date.now());
    fs.mkdirSync(empty, { recursive: true });
    expect(gcStaleRecordings(empty)).toBe(0);
  });
});

describe('bookmarks 落库 + insights 快照（P2）', () => {
  test('appendSegments 传 bookmarks 时替换 meeting.bookmarks（合法条目过滤）', () => {
    const m = createMeeting({ title: 'B', baseDir: tmpDir });
    appendSegments(m.id, [{ text: '第一句', time: 0 }], {
      bookmarks: [{ time: 12, at: 1000 }, { time: 'bad' }, null, { at: 99 }],
      baseDir: tmpDir,
    });
    const full = getMeeting(m.id, tmpDir);
    expect(full.bookmarks).toEqual([{ time: 12, at: 1000 }]);
    // 二次不带 bookmarks → 保留
    appendSegments(m.id, [{ text: '第二句', time: 5 }], { baseDir: tmpDir });
    expect(getMeeting(m.id, tmpDir).bookmarks).toEqual([{ time: 12, at: 1000 }]);
  });

  test('setInsights 覆盖写快照; 缺失 id 返回 null', () => {
    const m = createMeeting({ title: 'I', baseDir: tmpDir });
    const r = setInsights(m.id, { todos: ['发周报'], decisions: ['用方案A'], points: ['OPC 人群'] }, tmpDir);
    expect(r.insights).toEqual({ todos: ['发周报'], decisions: ['用方案A'], points: ['OPC 人群'] });
    expect(getMeeting(m.id, tmpDir).insights.todos).toEqual(['发周报']);
    // 非法输入归一: 非数组字段→空数组, 非字符串条目过滤
    setInsights(m.id, { todos: 'x', decisions: [1, 'ok'], points: null }, tmpDir);
    expect(getMeeting(m.id, tmpDir).insights).toEqual({ todos: [], decisions: ['ok'], points: [] });
    expect(setInsights('mtg_none', { todos: [] })).toBeNull();
  });
});

describe('scheduleId 关联（S3.3 日程×纪要打通）', () => {
  test('createMeeting 存 scheduleId，listMeetings 带出', () => {
    const m = createMeeting({ title: '产品评审', scheduleId: 'evt_123', baseDir: tmpDir });
    expect(m.scheduleId).toBe('evt_123');
    const inList = listMeetings(tmpDir).find(x => x.id === m.id);
    expect(inList.scheduleId).toBe('evt_123');
    const full = getMeeting(m.id, tmpDir);
    expect(full.scheduleId).toBe('evt_123');
  });

  test('无 scheduleId → null（透传字段，不破坏既有记录）', () => {
    const m = createMeeting({ title: '临时会', baseDir: tmpDir });
    const inList = listMeetings(tmpDir).find(x => x.id === m.id);
    expect(inList.scheduleId).toBeNull();
  });
});
