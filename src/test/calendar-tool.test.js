/**
 * calendar-tool 测试（2026-08-19 生成日程 BUG 修复轮）
 *
 * 背景：CreateCalendarEvent 契约是 LarkCreateCalendarEvent 的复制品(required
 * summary/start_time)，与 registry(title/datetime) 脱节 → 模型按 registry 传参恒被拒
 * → 3 次循环 → DSML 兜底（crabpaw.log 17:55:03/05/23 实锤）。
 * 修复：契约与 registry 对齐(required title + anyOf datetime|start_time 放行旧式别名)、
 * handler 兼容别名(summary/start_time)、parseEventTime 修 4 类 bug：
 *   ① 晚上 双 +12("晚上5点"→29:00) ② UTC 切片(凌晨取昨天日期)
 *   ③ ISO "2026-08-20 10:30" 不支持 ④ 十位中文数字("十五"→0)与"半"不支持
 */
jest.mock('../handlers/calendar-handler', () => ({
  addEvent: jest.fn(),
}));
jest.mock('../core/sse-broadcast', () => ({ broadcastEvent: jest.fn() }));
const mockUpsertSurface = jest.fn();
jest.mock('../core/scene/scene-store', () => ({
  getSceneStore: jest.fn(() => ({ upsertSurface: mockUpsertSurface })),
}));
jest.mock('../core/panel-state', () => ({ setPanelState: jest.fn() }));

const { addEvent } = require('../handlers/calendar-handler');
const { broadcastEvent } = require('../core/sse-broadcast');
const { getSceneStore } = require('../core/scene/scene-store');
const { parseEventTime, handleCreateEvent } = require('../tools/calendar-tool');
const { validateToolInput, registerIntoRegistry } = require('../core/tool-contract');
const { registry } = require('../tools/registry');

/** 本地日期 YYYY-MM-DD(与实现同构, 避免时区漂移断言) */
function fmtDate(d) {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}

describe('parseEventTime 自然语言时间解析', () => {
  test('晚上5点 → 17:00(原实现双 +12 得 29:00)', () => {
    const r = parseEventTime('晚上5点');
    expect(r.time).toBe('17:00');
    expect([fmtDate(new Date()), daysFromNow(1)]).toContain(r.date);
  });

  test('晚上4点半 → 16:30(半 支持, 原分钟解析为 0)', () => {
    const r = parseEventTime('晚上4点半');
    expect(r.time).toBe('16:30');
  });

  test('下午3点 → 15:00', () => {
    expect(parseEventTime('下午3点').time).toBe('15:00');
  });

  test('明天下午6点 → 明天 18:00', () => {
    expect(parseEventTime('明天下午6点')).toEqual({ date: daysFromNow(1), time: '18:00' });
  });

  test('明天十五点 → 明天 15:00(十位中文数字, 原单字符表解析为 0)', () => {
    expect(parseEventTime('明天十五点')).toEqual({ date: daysFromNow(1), time: '15:00' });
  });

  test('ISO "2026-08-20 10:30" → 固定日期时刻(原不支持 → null)', () => {
    expect(parseEventTime('2026-08-20 10:30')).toEqual({ date: '2026-08-20', time: '10:30' });
  });

  test('ISO 带 T 分隔 "2026-08-20T10:30" 同样支持', () => {
    expect(parseEventTime('2026-08-20T10:30')).toEqual({ date: '2026-08-20', time: '10:30' });
  });

  test('8月20日 14:00 支持', () => {
    const r = parseEventTime('8月20日 14:00');
    expect(r.time).toBe('14:00');
    expect(r.date.endsWith('08-20')).toBe(true);
  });

  test('HH:MM 格式支持(今天或已过滚明天)', () => {
    const r = parseEventTime('15:30');
    expect(r.time).toBe('15:30');
    expect([fmtDate(new Date()), daysFromNow(1)]).toContain(r.date);
  });

  test('下周三 10:00 支持', () => {
    expect(parseEventTime('下周三 10:00').time).toBe('10:00');
  });

  test('无法解析 → null', () => {
    expect(parseEventTime('随便写写')).toBeNull();
  });
});

describe('handleCreateEvent 兼容别名 + 创建链路', () => {
  beforeEach(() => {
    addEvent.mockReset();
    addEvent.mockImplementation(async (data) => ({
      id: 'evt_test',
      ...data,
      startTime: `${data.date}T${data.time}:00+08:00`,
    }));
  });

  test('registry 形态 {title, datetime} → addEvent 收到 date/time(原被契约拒)', async () => {
    const r = await handleCreateEvent({ title: '产品评审', datetime: '明天下午3点' });
    expect(r.success).toBe(true);
    expect(addEvent).toHaveBeenCalledWith(expect.objectContaining({
      title: '产品评审',
      date: daysFromNow(1),
      time: '15:00',
      duration: 60,
    }));
  });

  test('旧契约形态 {summary, start_time} → 别名归一成功(原 title undefined 报错)', async () => {
    const r = await handleCreateEvent({ summary: '周会', start_time: '2026-08-20 10:30' });
    expect(r.success).toBe(true);
    expect(addEvent).toHaveBeenCalledWith(expect.objectContaining({
      title: '周会',
      date: '2026-08-20',
      time: '10:30',
    }));
  });

  test('duration 传递到 addEvent', async () => {
    await handleCreateEvent({ title: '长会', datetime: '明天10点', duration: 120 });
    expect(addEvent).toHaveBeenCalledWith(expect.objectContaining({ duration: 120 }));
  });

  test('缺标题 → 明确报错且不落库', async () => {
    const r = await handleCreateEvent({ datetime: '明天10点' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('标题');
    expect(addEvent).not.toHaveBeenCalled();
  });

  // S2.1: 歧义时间不再报错——改走 prefill 分流（needsClarification + schedule:form SSE）
  test('时间无法解析 → needsClarification + prefill 且不落库', async () => {
    const r = await handleCreateEvent({ title: '测试', datetime: '随便写写' });
    expect(r.success).toBe(true);
    expect(r.created).toBe(false);
    expect(r.needsClarification).toBeTruthy();
    expect(r.prefill).toMatchObject({ title: '测试' });
    expect(addEvent).not.toHaveBeenCalled();
  });
});

describe('CreateCalendarEvent 契约与 registry 对齐(模拟启动 registerIntoRegistry)', () => {
  beforeAll(() => {
    registerIntoRegistry(registry);
  });

  test('模型按 registry 传 {title, datetime} → 校验通过(此前恒被拒)', () => {
    const v = validateToolInput('CreateCalendarEvent', { title: '开会', datetime: '明天下午3点' });
    expect(v.valid).toBe(true);
  });

  test('旧式 {summary, start_time} → 校验通过(别名放行, handler 归一)', () => {
    const v = validateToolInput('CreateCalendarEvent', { summary: '开会', start_time: '2026-08-20 10:30' });
    expect(v.valid).toBe(true);
  });

  test('{title} 缺时间 → 拒绝(anyOf datetime|start_time 至少一个)', () => {
    const v = validateToolInput('CreateCalendarEvent', { title: '开会' });
    expect(v.valid).toBe(false);
  });

  test('缺标题 → 拒绝(required title)', () => {
    const v = validateToolInput('CreateCalendarEvent', { start_time: '2026-08-20 10:30' });
    expect(v.valid).toBe(false);
  });

  test('多余参数 → 拒绝(additionalProperties:false 保持)', () => {
    const v = validateToolInput('CreateCalendarEvent', { title: '开会', datetime: '明天', extra: 1 });
    expect(v.valid).toBe(false);
  });
});

describe('CreateCalendarEvent 智能分流（S2.1）', () => {
  beforeEach(() => {
    addEvent.mockReset();
    addEvent.mockImplementation(async (data) => ({ id: 'evt_s2', ...data }));
    broadcastEvent.mockClear();
    mockUpsertSurface.mockClear();
  });

  test('未传 reminders → 默认提前 10 分钟提醒并透传 addEvent', async () => {
    await handleCreateEvent({ title: '评审', datetime: '明天下午3点' });
    expect(addEvent).toHaveBeenCalledWith(expect.objectContaining({
      reminders: [{ value: 10 }],
    }));
  });

  test('reminders: [] → 用户明说不用提醒', async () => {
    await handleCreateEvent({ title: '评审', datetime: '明天下午3点', reminders: [] });
    expect(addEvent).toHaveBeenCalledWith(expect.objectContaining({ reminders: [] }));
  });

  test('无歧义直建 → created:true + 弹日程卡(surface show)', async () => {
    const r = await handleCreateEvent({ title: '评审', datetime: '明天下午3点' });
    expect(r.success).toBe(true);
    expect(r.created).toBe(true);
    expect(mockUpsertSurface).toHaveBeenCalledWith('schedule-panel', expect.objectContaining({
      data: expect.objectContaining({ action: 'show' }),
    }));
  });

  test('歧义时间 → schedule:form SSE 广播 prefill + surface show', async () => {
    const r = await handleCreateEvent({ title: '开周会', datetime: '时间待定' });
    expect(r.created).toBe(false);
    expect(r.needsClarification).toBeTruthy();
    expect(r.prefill).toMatchObject({ title: '开周会' });
    expect(broadcastEvent).toHaveBeenCalledWith('schedule:form', expect.objectContaining({
      prefill: expect.objectContaining({ title: '开周会' }),
    }));
    expect(mockUpsertSurface).toHaveBeenCalledWith('schedule-panel', expect.objectContaining({
      data: expect.objectContaining({ action: 'show' }),
    }));
    expect(addEvent).not.toHaveBeenCalled();
  });
});
