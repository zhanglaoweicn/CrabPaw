/**
 * RunUsageCollector 单元测试——B5(Runtime差距分析实施)
 * 覆盖: LLM/工具用量累计、按模型分组、endRunUsage 取走即删、runId 缺省 no-op。
 */

const usage = require('./run-usage');

describe('RunUsageCollector', () => {
  test('多次 LLM 调用与工具调用正确累计', () => {
    usage.recordLlmUsage('run_a', { provider: 'glm', model: 'glm-4', promptTokens: 100, completionTokens: 50, totalTokens: 150, cost: 0.01 });
    usage.recordLlmUsage('run_a', { provider: 'glm', model: 'glm-4', promptTokens: 200, completionTokens: 30, totalTokens: 230, cost: 0.02 });
    usage.recordToolCall('run_a', 'Read');
    usage.recordToolCall('run_a', 'Bash');

    const snap = usage.snapshotRunUsage('run_a');
    expect(snap.llmCalls).toBe(2);
    expect(snap.toolCalls).toBe(2);
    expect(snap.promptTokens).toBe(300);
    expect(snap.completionTokens).toBe(80);
    expect(snap.totalTokens).toBe(380);
    expect(snap.costUsd).toBeCloseTo(0.03);
    expect(snap.byModel['glm-4'].llmCalls).toBe(2);
  });

  test('endRunUsage 返回累计并移除(幂等)', () => {
    usage.recordLlmUsage('run_b', { model: 'm1', totalTokens: 10 });
    const totals = usage.endRunUsage('run_b');
    expect(totals.llmCalls).toBe(1);
    expect(totals.totalTokens).toBe(10);
    expect(usage.endRunUsage('run_b')).toBeNull();
    expect(usage.snapshotRunUsage('run_b')).toBeNull();
  });

  test('runId 缺省/未知 run 全部 no-op 不抛错', () => {
    expect(() => {
      usage.recordLlmUsage(null, { totalTokens: 5 });
      usage.recordToolCall(undefined, 'Read');
      expect(usage.snapshotRunUsage(null)).toBeNull();
      expect(usage.endRunUsage('never_started')).toBeNull();
    }).not.toThrow();
  });

  test('异常输入(非数值 tokens)不抛错且按 0 计', () => {
    expect(() => usage.recordLlmUsage('run_c', { totalTokens: 'not-a-number', model: 123 })).not.toThrow();
    const snap = usage.snapshotRunUsage('run_c');
    expect(snap.totalTokens).toBe(0);
    expect(snap.byModel['123'].llmCalls).toBe(1);
  });

  test('recordTtft 只记首次(P0-4)', () => {
    usage.recordTtft('run_ttft', 350);
    usage.recordTtft('run_ttft', 999); // 二次覆盖无效
    expect(usage.snapshotRunUsage('run_ttft').ttftMs).toBe(350);
  });

  test('TTFT 随 endRunUsage 带出', () => {
    usage.recordTtft('run_ttft2', 120);
    const totals = usage.endRunUsage('run_ttft2');
    expect(totals.ttftMs).toBe(120);
  });
});
