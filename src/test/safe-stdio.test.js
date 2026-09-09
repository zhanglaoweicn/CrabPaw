/**
 * safe-stdio.js 测试 — Node 24 Console 兼容性（SafeWriter 必须是真 Writable）
 */
const { Console } = require('console');
const { Writable, isWritable } = require('stream');
const { SafeWriter, installSafeStdio, uninstallSafeStdio } = require('../core/safe-stdio');

function captureWritable(onData) {
  return new Writable({ write(chunk, enc, cb) { onData(chunk.toString()); cb(); } });
}

describe('SafeWriter', () => {
  test('Console({stdout: SafeWriter}) .log 内容落 inner（Node24 丢写回归）', async () => {
    let out = '';
    const inner = captureWritable((s) => { out += s; });
    const writer = new SafeWriter(inner);
    const c = new Console({ stdout: writer, stderr: writer });
    c.log('PROBE-OK');
    c.error('ERR-OK');
    await new Promise((r) => setImmediate(r));
    expect(out).toContain('PROBE-OK');
    expect(out).toContain('ERR-OK');
  });

  test('SafeWriter 是 stream.Writable 实例（Node24 Console 硬要求）', () => {
    const writer = new SafeWriter(captureWritable(() => {}));
    expect(writer).toBeInstanceOf(Writable);
    expect(isWritable(writer)).toBe(true);
  });

  test('EPIPE 吞噬：inner.write 抛 EPIPE 不冒泡不崩溃', async () => {
    const badInner = {
      write() {
        const e = new Error('broken pipe');
        e.code = 'EPIPE';
        throw e;
      },
      on() { return this; },
      columns: 80,
      rows: 24,
      isTTY: false,
    };
    const writer = new SafeWriter(badInner);
    let errorSeen = false;
    writer.on('error', () => { errorSeen = true; });
    expect(() => writer.write('x')).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(errorSeen).toBe(false);
  });
});

describe('installSafeStdio', () => {
  afterEach(() => {
    uninstallSafeStdio();
  });

  test('installSafeStdio 后 console.log 仍写出（mock inner 捕获）', () => {
    let out = '';
    installSafeStdio({
      stdout: captureWritable((s) => { out += s; }),
      stderr: captureWritable((s) => { out += s; }),
    });
    console.log('SAFE-VISIBLE');
    console.error('SAFE-ERR-VISIBLE');
    expect(out).toContain('SAFE-VISIBLE');
    expect(out).toContain('SAFE-ERR-VISIBLE');
  });

  test('uninstallSafeStdio 恢复 console 绑定（再 log 不再落 mock）', () => {
    let out = '';
    installSafeStdio({
      stdout: captureWritable((s) => { out += s; }),
      stderr: captureWritable((s) => { out += s; }),
    });
    console.log('BEFORE-UNINSTALL');
    expect(out).toContain('BEFORE-UNINSTALL');

    uninstallSafeStdio();

    // console 已还原回 install 前的实例：再 log 不再落 mock
    const before = out.length;
    console.log('AFTER-UNINSTALL');
    expect(out.length).toBe(before);
  });

  test('重复 install 幂等（_installed 守卫不重复包裹）', () => {
    let out = '';
    const mock = captureWritable((s) => { out += s; });
    installSafeStdio({ stdout: mock, stderr: mock });
    installSafeStdio({ stdout: mock, stderr: mock });
    console.log('IDEMPOTENT-OK');
    expect(out).toContain('IDEMPOTENT-OK');
  });
});
