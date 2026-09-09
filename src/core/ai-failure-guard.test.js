/**
 * 2026-08-15 P1-5: RepeatFailureGuard 并发隔离单测
 *
 * 此前 globalFailureGuard 为模块级单例——用户 A 的连续失败计数会触发
 * 并发用户 B 的 forceFinalAnswer(streamConsecutiveFailures 判定共享)。
 * 修复后按 userId 隔离; chatStream 入口对本轮清零。
 */
const ai = require('./ai');
const { RepeatFailureGuard } = require('./middleware/loop-detection');

test('P1-5: 不同 userId 的 failure guard 互不共享连续失败计数', () => {
  const guardA = ai._getFailureGuard('userA');
  const guardB = ai._getFailureGuard('userB');
  const defaultGuard = ai._getFailureGuard(undefined);

  expect(guardA).toBeInstanceOf(RepeatFailureGuard);
  expect(guardA).not.toBe(guardB);
  expect(defaultGuard).not.toBe(guardA);

  // 用户 A 连续失败 4 次
  for (let i = 0; i < 4; i++) {
    guardA.record('Bash', `sig-${i}`, false, { error: 'boom' });
  }
  expect(guardA.consecutive).toBe(4);
  // 用户 B / 默认用户不受影响(修复前共享单例会一起涨到 4)
  expect(guardB.consecutive).toBe(0);
  expect(defaultGuard.consecutive).toBe(0);

  // 用户 A 成功 → 只清零自己
  guardA.record('Bash', 'sig-x', true, '');
  expect(guardA.consecutive).toBe(0);
  expect(guardB.consecutive).toBe(0);
});

test('P1-5: 同一 userId 返回同一实例(请求内计数连续)', () => {
  const first = ai._getFailureGuard('userC');
  const second = ai._getFailureGuard('userC');
  expect(first).toBe(second);
});


// ── 2026-08-15 审查返工 Important-1: 流读取专用中断 relay ──────
// idleAbort 一次性 latch 误杀整轮: 计时器只在收到 chunk 时重置, 工具执行期间
// (>120s)无 chunk → 超时 abort 把合并信号永久 latch → 工具完成后下一轮 fetch
// 立即 AbortError → 整轮以"用户中断"被杀死。修复: 每轮 fetch 前新建 readAbort,
// 只挂"当前"空闲信号(已 abort 则跳过); 空闲信号持有方超时后换新 controller。
const { createStreamInterruptRelay } = require('./ai');

describe('Important-1: createStreamInterruptRelay(空闲超时不再 latch 后续轮次)', () => {
  // 模拟 chat-handler 语义: 超时 abort 后立刻换新 controller(经 getIdleSignal 暴露)
  function makeIdle() {
    let idle = new AbortController();
    return {
      getSignal: () => idle.signal,
      fireTimeout: () => { idle.abort(); idle = new AbortController(); },
    };
  }

  test('工具执行 120s+ 无 chunk 超时后, 下一轮 fetch 不被误杀(核心回归)', () => {
    const internal = new AbortController();
    const idle = makeIdle();
    const relay = createStreamInterruptRelay({ internalSignal: internal.signal, getIdleSignal: idle.getSignal });

    const read1 = relay.nextReadSignal(); // 第一轮 fetch
    expect(read1.aborted).toBe(false);

    // 工具执行 >120s: 超时 abort(此时无在飞读取, 只 abort 已完成的旧读取)
    idle.fireTimeout();
    expect(idle.getSignal().aborted).toBe(false); // 换新信号未 abort

    // 工具完成后的下一轮 fetch——修复前合并信号已 latch, fetch 立即 AbortError
    const read2 = relay.nextReadSignal();
    expect(read2.aborted).toBe(false);
  });

  test('空闲超时发生在读取中途: 当前读取被中止(既有语义), 后续轮次不受影响', () => {
    const internal = new AbortController();
    const idle = makeIdle();
    const relay = createStreamInterruptRelay({ internalSignal: internal.signal, getIdleSignal: idle.getSignal });

    const read1 = relay.nextReadSignal();
    idle.fireTimeout(); // 120s 无 chunk → 中止当前读取
    expect(read1.aborted).toBe(true);

    const read2 = relay.nextReadSignal(); // 换新 controller 后下一轮
    expect(read2.aborted).toBe(false);
  });

  test('已 abort 的旧 idle 信号不参与合并(latch 不再传染)', () => {
    const internal = new AbortController();
    const stale = new AbortController();
    stale.abort(); // 一次性 latch 已 abort
    const relay = createStreamInterruptRelay({ internalSignal: internal.signal, getIdleSignal: () => stale.signal });
    expect(relay.nextReadSignal().aborted).toBe(false);
  });

  test('内部用户停止信号仍是 latch: 整轮后续 fetch 全部中止', () => {
    const internal = new AbortController();
    const idle = new AbortController();
    const relay = createStreamInterruptRelay({ internalSignal: internal.signal, getIdleSignal: () => idle.signal });

    const read1 = relay.nextReadSignal();
    internal.abort();
    expect(read1.aborted).toBe(true);
    expect(relay.nextReadSignal().aborted).toBe(true); // 用户停止 = 整轮终止
  });

  test('getIdleSignal 抛异常 → 降级仅内部信号(不抛)', () => {
    const internal = new AbortController();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const relay = createStreamInterruptRelay({
      internalSignal: internal.signal,
      getIdleSignal: () => { throw new Error('boom'); },
    });
    const read = relay.nextReadSignal();
    expect(read.aborted).toBe(false);
    internal.abort();
    expect(read.aborted).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
