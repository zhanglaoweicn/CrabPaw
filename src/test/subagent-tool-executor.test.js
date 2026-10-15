/**
 * subagent-tool-executor.test.js — 子代理默认工具执行器接线回归（2026-09-30 深度检查修复）
 *
 * 实测缺陷（P0 级，多智能体工具链整体失效）：
 *   subagent-enhanced.js `_getDefaultToolExecutor()` 原为 `require('./tool-system')` ——
 *   **该模块不存在**，异常被 `catch { console.warn(...) }` 吞掉，于是执行器对**任何**工具
 *   都返回 `{error: "工具 X 不可用"}`。而它是默认路径：
 *     - execute() 内 `options.toolExecutor || this._getDefaultToolExecutor()`
 *     - tiered-subagent-runner.js:389 `subAgent.execute()` **不传** toolExecutor
 *   即：所有走三级 runner / 专家协作 / 圆桌的子代理一个工具都调不动，只空转到
 *   maxIterations 失败。同时调用面也错（registry 条目字段是 handler 不是 execute）。
 *
 * 本次修复采用**依赖反转注入**（层契约 R1：core 不得 require 上层 src/tools，与
 * self-awareness.js 同款）：core 暴露 setToolRegistry，tools 层启动时注入 registry。
 *
 * 本用例用**自注册的探针工具**验证执行器语义（注入、走 registry.execute、结果形状、
 * 错误分支），刻意不 require('../tools') —— 那是应用启动路径，会拉起全局定时器
 * 使 jest 无法自然退出（--forceExit 才能收尾），不适合放进单元测试。
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

const PROBE = 'ZzExecutorProbe';
let subagent;
let registry;

beforeAll(() => {
  process.env.CRABPAW_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-exec-'));
  require('../core/state').initState({ dataDir: process.env.CRABPAW_DATA_DIR });
  subagent = require('../core/subagent-enhanced');
  ({ registry } = require('../tools/registry'));

  registry.register({
    name: PROBE,
    toolset: 'default',
    category: 'test',
    description: '探针工具：回显入参，用于验证子代理默认执行器接线',
    schema: { type: 'object', properties: { echo: { type: 'string' } }, required: [], additionalProperties: true },
    handler: async (params) => ({ echoed: params && params.echo, via: 'handler' }),
    isReadOnly: true,
    riskLevel: 'low',
  });
});

afterAll(() => {
  delete process.env.CRABPAW_DATA_DIR;
});

function makeAgent() {
  return subagent.createSubAgent({
    type: subagent.SUBAGENT_TYPES.WORKER,
    description: 'probe',
    prompt: 'probe',
    parentAgentId: 'root',
  });
}

describe('子代理默认工具执行器（依赖反转注入）', () => {
  test('未注入注册表时给出"未注入"而非伪装"工具不存在"', async () => {
    subagent.setToolRegistry(null);
    const r = await makeAgent()._getDefaultToolExecutor()(PROBE, JSON.stringify({ echo: 'hi' }));
    expect(r.success).toBe(false);
    expect(r.error).toContain('未注入');
  });

  test('注入后可真实执行，且走 registry 口径（success + data）', async () => {
    subagent.setToolRegistry(registry);
    const r = await makeAgent()._getDefaultToolExecutor()(PROBE, JSON.stringify({ echo: 'hello-executor' }));
    // registry.execute 返回 {success, data}；data 即 handler 返回值
    expect(r.success).toBe(true);
    expect(r.data).toBeTruthy();
    expect(JSON.stringify(r.data)).toContain('hello-executor');
    expect(JSON.stringify(r.data)).toContain('handler');
  });

  test('未注册的工具报"未注册"（与 registry 口径一致）', async () => {
    subagent.setToolRegistry(registry);
    const r = await makeAgent()._getDefaultToolExecutor()('NoSuchTool__xyz', '{}');
    expect(r.success).toBe(false);
    expect(r.error).toContain('未注册');
  });

  test('参数不是合法 JSON 时报错而不抛异常', async () => {
    subagent.setToolRegistry(registry);
    const r = await makeAgent()._getDefaultToolExecutor()(PROBE, 'not-json');
    expect(r.success).toBe(false);
    expect(r.error).toContain('JSON');
  });

  test('tools 层已接线：subagent-tools.js 顶部完成 setToolRegistry', () => {
    // 只加载接线文件（不加载全量 ../tools，避免拉起全局定时器）
    subagent.setToolRegistry(null);
    require('../tools/subagent-tools');
    expect(subagent.getToolRegistry()).toBe(registry);
  });
});
