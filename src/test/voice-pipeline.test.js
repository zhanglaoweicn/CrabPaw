const { BoundedBacklog, NoSpeechWatchdog, computeRms } = require('../core/voice-pipeline');

describe('BoundedBacklog 阈值双级背压', () => {
  it('queue 达到 60% 触发 high（去抖在调用方,此处逐次回调）', () => {
    const b = new BoundedBacklog(10); // maxSize 10 → high 于第 6 块
    const levels = [];
    b.onLevelChange((level) => levels.push(level));
    for (let i = 0; i < 5; i++) b.push(Buffer.alloc(100));
    expect(levels).toEqual([]);
    b.push(Buffer.alloc(100)); // 第 6 块 = 60%
    expect(levels).toEqual(['high']);
  });
  it('high 后低于 20% 触发 ok（迟滞）', () => {
    const b = new BoundedBacklog(10);
    const levels = [];
    b.onLevelChange((level) => levels.push(level));
    for (let i = 0; i < 6; i++) b.push(Buffer.alloc(100));
    // 排空到 2 块(20%)以下 → ok
    const drained = b.drain();
    expect(drained.length).toBe(6);
    expect(levels).toContain('ok');
    expect(b.level()).toBe('ok');
  });
  it('50% 区间不抖动（无迟滞跳变）', () => {
    const b = new BoundedBacklog(10);
    let calls = 0;
    b.onLevelChange(() => calls++);
    for (let i = 0; i < 5; i++) b.push(Buffer.alloc(100));
    b.drain();
    expect(calls).toBe(0);
  });
  it('high 后 ratio 未回落至 20% 前不振荡（迟滞带内保持 high）', () => {
    const b = new BoundedBacklog(10);
    const levels = [];
    b.onLevelChange((level) => levels.push(level));
    for (let i = 0; i < 6; i++) b.push(Buffer.alloc(100)); // ratio 0.6 → high
    expect(levels).toEqual(['high']);
    b.push(Buffer.alloc(100)); // ratio 0.7——修复前此处回弹 ok（振荡）
    b.push(Buffer.alloc(100)); // ratio 0.8
    expect(b.level()).toBe('high');
    expect(levels).toEqual(['high']); // 无 ok 回弹
    const drained = b.drain();
    expect(drained.length).toBe(8);
    expect(b.level()).toBe('ok');
    expect(levels).toEqual(['high', 'ok']);
  });
  it('溢出仍返回 false 并触发 onOverflow', () => {
    const b = new BoundedBacklog(3);
    let overflow = 0;
    b.onOverflow(() => overflow++);
    for (let i = 0; i < 5; i++) b.push(Buffer.alloc(100));
    expect(overflow).toBe(1);
    expect(b.push(Buffer.alloc(100))).toBe(false);
  });
});

describe('computeRms', () => {
  it('全零静音→0', () => {
    expect(computeRms(Buffer.alloc(64))).toBe(0);
  });
  it('满幅→~32768', () => {
    const buf = Buffer.alloc(64);
    for (let i = 0; i < 32; i++) buf.writeInt16LE(32767, i * 2);
    expect(computeRms(buf)).toBeGreaterThan(32000);
  });
});
