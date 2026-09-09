/**
 * tool-router-meeting.test.js — 会议记录意图路由（2026-08-18）
 *
 * 现象：语音/文本「开始记录」→ 无纪要卡片。根因（触发链断点）：
 * 「开始」命中 task 意图 → panel 工具集被裁 → meeting_mode 对 LLM 不可见。
 * 修复：meeting_record 意图（'记录'等关键词 + 开始/结束/停止·记录 pairs 复合词）。
 * 本测试锁定路由归属 + 工具集裁剪结果 + 不误伤场景。
 */
// 2026-09-01 R1: handler 级断言需捕获广播——mock sse-broadcast（路由测试本身不广播，
// 不受影响）。顺带消掉真实广播的 console 噪音。
jest.mock('../core/sse-broadcast', () => ({ broadcastEvent: jest.fn() }));
const { selectToolsForContext } = require('../core/ai/tool-router');

async function route(message) {
  return selectToolsForContext({ message, channel: 'cli', toolSystem: null });
}

describe('meeting_record 意图路由', () => {
  test('开始记录 → meeting_record, panel 工具集在列', async () => {
    const r = await route('开始记录');
    expect(r.intent).toBe('meeting_record');
    expect(r.toolsets).toContain('panel');
    expect(r.toolsets).toContain('interaction');
  });

  test('记录一下 → meeting_record', async () => {
    expect((await route('记录一下')).intent).toBe('meeting_record');
  });

  test('开始录音 → meeting_record', async () => {
    expect((await route('开始录音')).intent).toBe('meeting_record');
  });

  test('停止记录 → meeting_record（pairs 停止·记录 双命中压过 task）', async () => {
    expect((await route('停止记录')).intent).toBe('meeting_record');
  });

  test('结束记录 → meeting_record', async () => {
    expect((await route('结束记录')).intent).toBe('meeting_record');
  });

  test('打开会议记录 → meeting_record（压过 open_app 裸打开）', async () => {
    expect((await route('打开会议记录')).intent).toBe('meeting_record');
  });

  test('会议记录 → meeting_record（记录+会议记录 双命中, 压过 schedule 的会议）', async () => {
    expect((await route('会议记录')).intent).toBe('meeting_record');
  });

  test('帮我记录一下这个知识点 → meeting_record（memory/skills 可选兜底）', async () => {
    const r = await route('帮我记录一下这个知识点');
    expect(r.intent).toBe('meeting_record');
    expect(r.toolsets).toContain('memory');
  });

  test('开始做饭 → 不落 meeting_record（task 正常接管, 不误伤）', async () => {
    expect((await route('开始做饭')).intent).toBe('task');
  });

  test('播放铁血丹心 → music 不受影响', async () => {
    expect((await route('播放铁血丹心')).intent).toBe('music');
  });

  test('设置会议提醒 → schedule（会议+提醒 双命中, 既有行为; 不落 meeting_record）', async () => {
    const r = await route('设置会议提醒');
    expect(r.intent).toBe('schedule');
    expect(r.intent).not.toBe('meeting_record');
  });
});

// 2026-09-01 R1: meeting_mode 契约含 history 动作——「查看历史被 LLM 用 show 回应
// → 新建空会议」的空壳制造机（20 空壳文件根因），契约枚举必须放行 history。
describe('meeting_mode 契约 history 动作（R1）', () => {
  test('meeting_mode 契约含 history 动作（R1: 查看历史禁止 show 回应）', () => {
    const { TOOL_CONTRACTS } = require('../core/tool-contract');
    const contract = TOOL_CONTRACTS.MeetingMode;
    expect(contract.schema.properties.action.enum).toContain('history');
    expect(contract.whenNotToUse.length).toBeGreaterThan(0);
    expect(contract.whenNotToUse.join('\n')).toContain('history');
  });
});

// 2026-09-01 R1: handler 级端到端——action=history 全链路。brief 原插入位在分支内引用
// reason 而其 const 声明位于分支之后（TDZ ReferenceError 实测复现），实现已上提声明；
// 本测试同时锁定「绝不建会」的 R1 核心语义（契约/单测两层之外的第三层防线）。
describe('meeting_mode handler history 动作（R1 端到端）', () => {
  test('action=history → 广播 meeting:history, 不建会不落盘', async () => {
    const { registry } = require('../tools/registry');
    require('../tools/panel-tools');
    const { broadcastEvent } = require('../core/sse-broadcast');
    const { getMeetingStatus } = require('../core/meeting-events');
    const store = require('../core/meeting-store');
    const createSpy = jest.spyOn(store, 'createMeeting');
    broadcastEvent.mockClear();

    const r = await registry.execute('meeting_mode', { action: 'history', reason: '查看历史纪要' });

    // handler 正常返回（TDZ 修复前此处为 success:false + "Cannot access 'reason' ..."）
    expect(r.success).toBe(true);
    expect(r.data.message).toBe('已打开历史纪要列表');
    // 前端开历史列表信号 + legacy meeting_mode 事件
    expect(broadcastEvent).toHaveBeenCalledWith('meeting:history', {});
    expect(broadcastEvent).toHaveBeenCalledWith('meeting_mode', { action: 'history', active: false, reason: '查看历史纪要' });
    // R1 核心: 绝不新建会议（磁盘零建会 + 内存无当前会议）
    expect(createSpy).not.toHaveBeenCalled();
    expect(getMeetingStatus().meetingId).toBeNull();
  });
});
