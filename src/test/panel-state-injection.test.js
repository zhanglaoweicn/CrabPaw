/**
 * panel-state 注入链路测试 — 2026-08-15
 * buildVolatileContext 每轮组装 volatile 上下文：非 null 面板状态注入块，全 null 零注入。
 */
const { setPanelState } = require('../core/panel-state');
const { buildVolatileContext } = require('../core/context-builder');

// 2026-08-19: 记忆召回(getRelatedMemories)在并行负载下易超默认 5s——全量 3 连挂、
// runInBand 全绿实锤为负载争用而非逻辑失败; 文件级放宽超时。
jest.setTimeout(15000);
// 2026-09-05 flaky 治理(治本): 15s 在 196 套件的全量并行负载下仍偶发超时——
// 本测试只验证面板状态注入, 记忆召回(hybrid 检索)是 buildVolatileContext 的
// 附带行为且与断言无关, 直接截断为空实现(负载无关, 根治超时)。
jest.mock('../core/memory/echo-hints', () => ({
  getRelatedMemories: async () => [],
  buildEchoHints: () => '',
}));

async function buildContext(message) {
  return buildVolatileContext(
    'test-user', message, { activeProjectId: null },
    '[测试时间]', '', { context: '', volatile: '' },
  );
}

describe('panel-state 注入链路（相关度注入）', () => {
  test('weather open + surface → volatileParts 含状态块 + 行内快照', async () => {
    const { getSceneStore } = require('../core/scene/scene-store');
    getSceneStore().upsertSurface('weather-panel', {
      kind: 'weather',
      data: { city: '北京', temp: '28', condition: '晴', humidity: '60%' },
      intent: 'inform',
    });
    setPanelState('weather', 'open');
    const { volatileParts } = await buildContext('天气面板还开着吗');
    const joined = volatileParts.join('\n');
    expect(joined).toContain('## 天气面板状态');
    expect(joined).toContain('当前: ✅ 已打开（北京 28° 晴 · 湿度 60%）');
  });

  test('weather closed → 已关闭块 + 防幻觉行', async () => {
    setPanelState('weather', 'closed');
    const { volatileParts } = await buildContext('天气面板关了没');
    const joined = volatileParts.join('\n');
    expect(joined).toContain('当前: ⛔ 已关闭（用户手动关闭）');
    expect(joined).toContain('⚠️ 如果当前状态为未打开');
  });

  test('全部面板状态过期/未交互 → 零注入', async () => {
    setPanelState('weather', 'closed'); // 先落 closed（真实时间戳）
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now + 121 * 1000); // 再拨过 closed TTL 120s → 归 null
    try {
      const { volatileParts } = await buildContext('你好');
      const joined = volatileParts.join('\n');
      expect(joined).not.toMatch(/## (音乐|热点|天气|股票|文件生成)面板状态/);
    } finally { spy.mockRestore(); }
  });

  test('filegen open + surface → volatileParts 含状态块 + 行内快照', async () => {
    const { getSceneStore } = require('../core/scene/scene-store');
    getSceneStore().upsertSurface('file-panel', {
      kind: 'filegen',
      data: { title: '市场分析报告', phase: 'writing', file: { name: '报告.docx' } },
      intent: 'inform',
    });
    setPanelState('filegen', 'open');
    const { volatileParts } = await buildContext('文件生成面板还在吗');
    const joined = volatileParts.join('\n');
    expect(joined).toContain('## 文件生成面板状态');
    // PANEL_SURFACES 缺 filegen → surfaceData null → 快照分支死代码，状态行只有"已打开"无快照
    expect(joined).toContain('当前: ✅ 已打开（市场分析报告 [writing] 报告.docx）');
  });
});
