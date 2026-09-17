/**
 * metrics-pipeline 回归测试（2026-09-18 指标快照写入风暴治理）
 *
 * 背景: 旧实现每 30s 写全新 snapshot_<时间戳>.json,不轮换不清理,实测堆积 263 万个
 * 文件且无任何读取方。修复后: 快照单文件原子覆盖(snapshot-latest.json),启动时后台
 * 流式清扫历史 snapshot_* 遗留文件。
 *
 * 注意: DATA_DIR 在 config require 期固化,本文件在 require 之前设置
 * CRABPAW_DATA_DIR 指向临时目录(与 tool-result-storage.test.js 同款机制)。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-pipeline-'));
process.env.CRABPAW_DATA_DIR = TMP_ROOT;

const { MetricsPipeline } = require('../core/metrics-pipeline');

afterAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

function makePipeline(dir, opts = {}) {
  return new MetricsPipeline({ enabled: true, snapshotIntervalMs: 3600000, metricsDir: dir, ...opts });
}

describe('metrics-pipeline 快照写入收敛', () => {
  test('快照写单文件 snapshot-latest.json,不再产生 snapshot_<时间戳>.json', async () => {
    const dir = path.join(TMP_ROOT, 'write-single');
    const p = makePipeline(dir);

    await p._takeSnapshot();
    await p._takeSnapshot(); // 第二次应原子覆盖而非新建

    const files = fs.readdirSync(dir);
    expect(files).toEqual(['snapshot-latest.json']);

    const snap = JSON.parse(fs.readFileSync(path.join(dir, 'snapshot-latest.json'), 'utf-8'));
    expect(typeof snap.timestamp).toBe('number');
    expect(snap.llm).toBeTruthy();
    expect(snap.tools).toBeTruthy();
  });

  test('getSnapshot 返回内存态指标(消费方不依赖历史快照文件)', () => {
    const p = makePipeline(path.join(TMP_ROOT, 'inmem'));
    p.recordLlmCallStart();
    p.recordLlmCallSuccess(Date.now() - 100, 'deepseek-flash', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    const snap = p.getSnapshot();
    expect(snap.llm.calls.success).toBe(1);
    expect(snap.tokens.total).toBe(15);
  });

  test('shutdown 清除快照定时器', () => {
    const p = makePipeline(path.join(TMP_ROOT, 'shutdown'));
    expect(p._snapshotTimer).toBeTruthy();
    p.shutdown();
    expect(p._snapshotTimer).toBeNull();
  });
});

describe('metrics-pipeline 历史快照清扫', () => {
  test('启动后后台清扫 snapshot_<时间戳>.json 遗留,保留无关文件与 latest', async () => {
    const dir = path.join(TMP_ROOT, 'purge');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'snapshot_1720000000000.json'), '{}');
    fs.writeFileSync(path.join(dir, 'snapshot_1730000000000.json'), '{}');
    fs.writeFileSync(path.join(dir, 'snapshot_1740000000000.json'), '{}');
    fs.writeFileSync(path.join(dir, 'keep.json'), '{}');

    process.env.METRICS_PURGE_DELAY_MS = '0';
    try {
      const p = makePipeline(dir);
      await new Promise((res) => setTimeout(res, 500));
      // 手动触发一次快照,验证 latest 与遗留清扫共存
      await p._takeSnapshot();
    } finally {
      delete process.env.METRICS_PURGE_DELAY_MS;
    }

    const files = fs.readdirSync(dir).sort();
    expect(files).toEqual(['keep.json', 'snapshot-latest.json']);
  });

  test('目录干净时清扫为空操作(无报错)', async () => {
    const dir = path.join(TMP_ROOT, 'clean-purge');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'snapshot-latest.json'), '{}');

    process.env.METRICS_PURGE_DELAY_MS = '0';
    try {
      makePipeline(dir);
      await new Promise((res) => setTimeout(res, 300));
    } finally {
      delete process.env.METRICS_PURGE_DELAY_MS;
    }

    expect(fs.readdirSync(dir)).toEqual(['snapshot-latest.json']);
  });
});
