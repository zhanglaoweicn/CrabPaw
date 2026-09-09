/**
 * event-bus-facade.test.js — D7 B5: UnifiedEventBus 门面语义保持测试
 * (2026-08-27; brief 3 用例 + 消费方 API 兼容用例 + 反向桥用例)
 *
 * 门面 = src/core/events.js EventBus 内核之上的兼容层:
 *   - "cat:type" 名 → kernel.publish; 订阅方经核回调收到 payload 解包直传(契约不变)
 *   - "harness:*" 名 → 本地分发(内核镜像事件, 不回发防环)
 *   - 单段名/多参 emit → 本地 EventEmitter 兜底
 */
'use strict';
const { EventEmitter } = require('events');
const facade = require('../core/event-bus');
const { EventBus, getEventBus } = require('../core/events');
const { installHarnessEventBridge, installReverseBridge } = require('../core/cordis/event-bridge');

describe('event-bus 门面(内核=EventBus 单例)', () => {
  test('on/emit 语义保持: emit("task:started", payload) → on("task:started", (p)=>p) 收到 payload', (done) => {
    const unsub = facade.on('task:started', (p) => {
      expect(p).toMatchObject({ taskId: 't1' });
      unsub();
      done();
    });
    facade.emit('task:started', { taskId: 't1' });
  });

  test('subscribe 返回退订函数', () => {
    const seen = [];
    const unsub = facade.subscribe('fake-sub', 'x:y', (p) => seen.push(p));
    facade.emit('x:y', { a: 1 });
    expect(seen.length).toBe(1);
    unsub();
    facade.emit('x:y', { a: 2 });
    expect(seen.length).toBe(1);
  });

  test('audit log: emit 后 getAuditLog 有记录', () => {
    facade.emit('task:done', { taskId: 't9' });
    expect(facade.getAuditLog(10, 'task:done').length).toBeGreaterThan(0);
  });

  test('harness: 前缀名仅本地分发(内核镜像事件, 不回发内核)', () => {
    const seen = [];
    const off = facade.on('harness:mirror:event', (p) => seen.push(p));
    facade.emit('harness:mirror:event', { a: 1 });
    expect(seen).toEqual([{ a: 1 }]);
    off();
    facade.emit('harness:mirror:event', { a: 2 });
    expect(seen).toHaveLength(1);
  });

  test('eb_007 语义: 任意 EventBus 实例 publish → 门面 harness: 监听方收到 toJSON 载荷; off 退订', () => {
    const received = [];
    const handler = (payload) => { received.push(payload); };
    facade.on('harness:mirror:event', handler);
    const bus = new EventBus();
    bus.publish('mirror', 'event', { ok: 1 });
    facade.off('harness:mirror:event', handler);
    bus.publish('mirror', 'event', { ok: 2 });
    expect(received).toHaveLength(1);
    expect(received[0].category).toBe('mirror');
    expect(received[0].type).toBe('event');
    expect(received[0].payload.ok).toBe(1);
  });

  test('内核 → 门面归一: kernel.publish 直接送达门面 on() 订阅方(载荷解包, scene-bridge 契约)', () => {
    const seen = [];
    const off = facade.on('session:created', (p) => seen.push(p));
    getEventBus().publish('session', 'created', { sessionId: 's1' });
    expect(seen).toEqual([{ sessionId: 's1' }]);
    off();
  });

  test('门面 → 内核归一: facade.emit 进内核路由(含通配), 内核订阅方收到 HarnessEvent', () => {
    const seen = [];
    const off = getEventBus().subscribe('task:*', (event) => seen.push(event));
    facade.emit('task:done', { taskId: 't9' });
    expect(seen).toHaveLength(1);
    expect(seen[0].category).toBe('task');
    expect(seen[0].type).toBe('done');
    expect(seen[0].payload).toMatchObject({ taskId: 't9' });
    off();
  });

  test('taskLifecycle/systemEvent 载荷形状不变', () => {
    const taskSeen = [];
    const sysSeen = [];
    const off1 = facade.on('task:started', (p) => taskSeen.push(p));
    const off2 = facade.on('system:skills_initialized', (p) => sysSeen.push(p));
    facade.taskLifecycle('started', 't1', { name: 'demo' });
    facade.systemEvent('skills_initialized', { skillCount: 3 });
    expect(taskSeen[0]).toMatchObject({ taskId: 't1', name: 'demo' });
    expect(typeof taskSeen[0].timestamp).toBe('number');
    expect(sysSeen[0]).toMatchObject({ skillCount: 3 });
    expect(typeof sysSeen[0].timestamp).toBe('number');
    off1(); off2();
  });

  test('prependListener/removeListener 别名与 on/off 同语义', () => {
    const seen = [];
    const h = (p) => seen.push(p);
    facade.prependListener('task:alias', h);
    facade.emit('task:alias', { taskId: 'a1' });
    facade.removeListener('task:alias', h);
    facade.emit('task:alias', { taskId: 'a2' });
    expect(seen.map((p) => p.taskId)).toEqual(['a1']);
  });

  test('getSubscriberCount/hasSubscribers/getSubscribers 语义与旧实现一致', () => {
    const h = () => {};
    const unsub = facade.subscribe('sub-c', 'count:evt', h);
    expect(facade.getSubscriberCount('count:evt')).toBe(1);
    expect(facade.hasSubscribers('count:evt')).toBe(true);
    const unsub2 = facade.on('count:evt', () => {});
    expect(facade.getSubscriberCount('count:evt')).toBe(2);
    unsub(); unsub2();
    expect(facade.getSubscriberCount('count:evt')).toBe(0);
    expect(facade.hasSubscribers('count:evt')).toBe(false);
    expect(facade.getSubscribers()['count:evt']).toEqual([]);
  });

  test('同一 handler 多事件注册: off 按事件名精确退订内核订阅(双层键控, B5 Fix 1 锁)', () => {
    const seen = [];
    const h = (p) => seen.push(p);
    facade.on('task:a', h);
    facade.on('task:b', h);
    facade.on('task:c', h);
    facade.emit('task:a', { v: 'a' });
    facade.emit('task:b', { v: 'b' });
    facade.emit('task:c', { v: 'c' });
    expect(seen.map((p) => p.v)).toEqual(['a', 'b', 'c']);

    // 逐个按事件名退订; 每退一个, 其余事件的内核订阅不受影响
    facade.off('task:a', h);
    expect(facade.getSubscriberCount('task:a')).toBe(0);
    expect(facade.getSubscriberCount('task:b')).toBe(1);
    expect(facade.getSubscriberCount('task:c')).toBe(1);
    facade.emit('task:b', { v: 'b2' });
    facade.emit('task:c', { v: 'c2' });
    expect(seen.map((p) => p.v)).toEqual(['a', 'b', 'c', 'b2', 'c2']);

    facade.off('task:b', h);
    facade.off('task:c', h);
    expect(facade.getSubscriberCount('task:a')).toBe(0);
    expect(facade.getSubscriberCount('task:b')).toBe(0);
    expect(facade.getSubscriberCount('task:c')).toBe(0);

    facade.emit('task:a', { v: 'a3' });
    facade.emit('task:b', { v: 'b3' });
    facade.emit('task:c', { v: 'c3' });
    expect(seen).toHaveLength(5);
  });

  test('getStats 契约(status.js 消费面): 字段形状不变', () => {
    facade.emit('task:stats', { taskId: 's1' });
    const stats = facade.getStats();
    expect(typeof stats.totalEvents).toBe('number');
    expect(stats.totalEvents).toBeGreaterThan(0);
    expect(typeof stats.eventCounts).toBe('object');
    expect(typeof stats.subscriberCounts).toBe('object');
    expect(typeof stats.auditEnabled).toBe('boolean');
  });

  test('audit 管控: enableAudit(false)/clearAuditLog/getAuditLog(limit)', () => {
    facade.enableAudit(false);
    facade.emit('task:muted', { taskId: 'm1' });
    expect(facade.getAuditLog(100, 'task:muted').length).toBe(0);
    facade.enableAudit(true);
    facade.emit('task:muted', { taskId: 'm2' });
    facade.emit('task:muted', { taskId: 'm3' });
    const entries = facade.getAuditLog(1, 'task:muted');
    expect(entries).toHaveLength(1);
    expect(entries[0].payload).toMatchObject({ taskId: 'm3' });
    facade.clearAuditLog();
    expect(facade.getAuditLog(100, 'task:muted').length).toBe(0);
  });

  test('单段名/多参 emit 走本地兜底(旧 EventEmitter 语义)', () => {
    const seen = [];
    const unsub = facade.on('skills_ping', (a, b) => seen.push([a, b]));
    facade.emit('skills_ping', 1, 2);
    expect(seen).toEqual([[1, 2]]);
    unsub();
    facade.emit('skills_ping', 3, 4);
    expect(seen).toHaveLength(1);
  });

  test('EVENT_TYPES 常量导出不变', () => {
    expect(facade.EVENT_TYPES.TASK_STARTED).toBe('task:started');
    expect(facade.EVENT_TYPES.FLOW_COMPLETED).toBe('flow:completed');
    expect(facade.EVENT_TYPES.SYSTEM_SHUTDOWN).toBe('system:shutdown');
  });
});

describe('反向桥(cordis → harness, D7 B5)', () => {
  test('installReverseBridge: 插件 ctx.events.emit("cat:type", payload) → 内核 publish; 卸载还原', () => {
    const ctx = { events: new EventEmitter() };
    const received = [];
    const off = getEventBus().subscribe('task:started', (e) => received.push(e.payload));
    const unbridge = installReverseBridge(ctx);
    ctx.events.emit('task:started', { taskId: 't2' });
    expect(received).toEqual([{ taskId: 't2' }]);
    // 防环: harness: 前缀不回发; 单段名不转发
    ctx.events.emit('harness:task:started', { taskId: 'tX' });
    ctx.events.emit('singlepart', { a: 1 });
    expect(received).toHaveLength(1);
    unbridge();
    ctx.events.emit('task:started', { taskId: 't3' });
    expect(received).toHaveLength(1);
    off();
  });

  test('反向桥尊重 cordis thisArg 首参语义(事件名在对象之后)', () => {
    const ctx = { events: new EventEmitter() };
    const received = [];
    const off = getEventBus().subscribe('tool:call_start', (e) => received.push(e.payload));
    const unbridge = installReverseBridge(ctx);
    ctx.events.emit({ plugin: 'p1' }, 'tool:call_start', { tool: 'Bash' });
    expect(received).toEqual([{ tool: 'Bash' }]);
    unbridge();
    off();
  });

  test('双向桥组合: 正向镜像 + 反向转发 + 卸载, 无环(harness: 不回声)', () => {
    const ctx = { events: new EventEmitter() };
    const cordisSeen = [];
    ctx.events.on('harness:task:started', (p) => cordisSeen.push(p));
    const un = installHarnessEventBridge(ctx);

    // 正向: facade.emit → 内核 → cordis harness: 镜像
    facade.emit('task:started', { taskId: 't4' });
    expect(cordisSeen).toHaveLength(1);
    expect(cordisSeen[0]).toMatchObject({ category: 'task', type: 'started' });

    // 反向+正向合成: 插件 emit task: → 内核 → 同树 harness: 监听可见(恰好一次, 不环)
    ctx.events.emit('task:started', { taskId: 't5' });
    expect(cordisSeen).toHaveLength(2);

    un();
    facade.emit('task:started', { taskId: 't6' });
    expect(cordisSeen).toHaveLength(2);
  });
});
