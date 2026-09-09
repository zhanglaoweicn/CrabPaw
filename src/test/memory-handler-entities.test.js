/**
 * memory-handler-entities.test.js — 发布 P1-1 回归测试
 *
 * 背景：/api/memory/entities 恒空双 bug——
 *   Bug A: enhancedMemory.getStats() 是 async，未 await 拿到 Promise → `.entities` 恒 undefined
 *   Bug B: 即使 await，getStats() 返回 { totalEntities, totalAliases, totalLinks, entitiesByType }，
 *          无 `.all` 字段 → entityList 恒 []
 * 修复：handleMemoryEntities 直读 unified-store entities 表（与 memory-graph 面板同源同序）。
 *
 * 断言（修复前均为失败——真回归测试）：
 *   1. 实体列表非空；
 *   2. 每项含 mention_count 字段（且按 mention_count 真实排序）；
 *   3. 响应形状 { success, data: { entities, total } }（前端 apiGet 解包后 result.data.entities 消费）。
 */
const { UnifiedMemoryStore, getUnifiedStore } = require('../core/memory/unified-store');

// 单例先占：在任何模块的 require 链可能触发 getUnifiedStore() 之前，
// 把单例固定为 :memory: 夹具——防止测试进程打开生产 unified-memory.db。
const singletonStore = getUnifiedStore({ dbPath: ':memory:' });

const {
  fetchEntityListFromStore,
  handleMemoryEntities,
} = require('../handlers/memory-handler');

function makeStore() {
  const store = new UnifiedMemoryStore({ dbPath: ':memory:' });
  store.initialize();
  return store;
}

describe('memory-handler entities（发布 P1-1 恒空修复）', () => {
  test('fetchEntityListFromStore 直读 entities 表：非空、含 mention_count 且真实排序', () => {
    const store = makeStore();
    store.upsertEntity({ id: 'e1', name: '台风摩羯', kind: 'concept', mention_count: 5 });
    store.upsertEntity({ id: 'e2', name: 'CrabPaw', kind: 'project', mention_count: 2 });
    store.upsertEntity({ id: 'decision:r1', name: '台风摩羯路径', kind: 'decision', mention_count: 0 });
    store.upsertRelation({
      id: 'rel1', source_entity: 'e1', target_entity: 'decision:r1',
      relation_type: 'based_on', namespace: 'decision', confidence: 1.0,
      metadata: {}, created_at: 1, updated_at: 1,
    });

    const list = fetchEntityListFromStore(store, 100);
    // 修复前恒 []——非空即回归通过
    expect(list.length).toBe(3);
    for (const item of list) {
      expect(item).toHaveProperty('mention_count');
      expect(item).toHaveProperty('name');
      expect(item).toHaveProperty('type');
      expect(item).toHaveProperty('factCount');
    }
    // mention_count 真实排序：5 > 2 > 0
    expect(list.map((e) => e.name)).toEqual(['台风摩羯', 'CrabPaw', '台风摩羯路径']);
    // factCount = relations 表真实关联数（e1 有 1 条 based_on 出边）
    expect(list[0].factCount).toBe(1);
    // type 映射自 kind
    expect(list[1].type).toBe('project');
  });

  test('handleMemoryEntities 响应 { success, data: { entities, total } } 且非空', async () => {
    // 单例已固定为 :memory: 夹具（文件顶部），handler 内部取到的就是它
    singletonStore.upsertEntity({ id: 'e1', name: '台风摩羯', kind: 'concept', mention_count: 3 });
    singletonStore.upsertEntity({ id: 'e2', name: 'CrabPaw', kind: 'project', mention_count: 1 });

    let statusCode = 0;
    let body = null;
    const res = {
      writeHead(code) { statusCode = code; },
      end(payload) {
        try { body = JSON.parse(payload); } catch (e) { body = payload; }
      },
    };
    const req = { method: 'GET', url: '/api/memory/entities' };

    await handleMemoryEntities(req, res, {});

    expect(statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.entities)).toBe(true);
    expect(body.data.entities.length).toBeGreaterThan(0);
    expect(body.data.entities[0]).toHaveProperty('mention_count');
    expect(body.data.total).toBe(2);
  });
});
