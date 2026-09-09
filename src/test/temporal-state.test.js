/**
 * temporal-state.test.js — 时态状态投影（semantica state_at / reconstruct_at_time 范式）
 */
const { UnifiedMemoryStore } = require('../core/memory/unified-store');
const { activeAt, projectStateAt, queryStateAt, toMs } = require('../core/memory/temporal-state');
const { TemporalGraph } = require('../core/memory/temporal-graph');

const DAY = 24 * 3600 * 1000;

describe('activeAt 时间窗判定（半开区间 [valid_from, valid_to)）', () => {
  test('无窗口字段 → 恒活跃', () => {
    expect(activeAt({}, 1)).toBe(true);
    expect(activeAt({ valid_from: null, valid_to: null }, 1)).toBe(true);
  });

  test('边界语义：valid_from 含入、valid_to 不含入', () => {
    const row = { valid_from: 100, valid_to: 200 };
    expect(activeAt(row, 99)).toBe(false);
    expect(activeAt(row, 100)).toBe(true);
    expect(activeAt(row, 150)).toBe(true);
    expect(activeAt(row, 200)).toBe(false); // 开区间右端
  });

  test('开区间（valid_to 为 null）永远活跃到当前', () => {
    const row = { valid_from: 100, valid_to: null };
    expect(activeAt(row, 1000)).toBe(true);
  });

  test('时间归一化：Date / ISO 字符串 / 无效值', () => {
    const row = { valid_from: 0, valid_to: 2 * DAY };
    expect(activeAt(row, new Date(1))).toBe(true);
    expect(activeAt(row, '1970-01-02T00:00:00.000Z')).toBe(true);
    expect(activeAt(row, new Date(3 * DAY))).toBe(false);
    expect(activeAt(row, null)).toBe(false);
    expect(activeAt(row, 'not-a-date')).toBe(false);
    expect(toMs('not-a-date')).toBeNull();
  });

  test('空行/未定义 → 不活跃（防御）', () => {
    expect(activeAt(null, 100)).toBe(false);
    expect(activeAt(undefined, 100)).toBe(false);
  });
});

describe('projectStateAt 点时刻子图投影', () => {
  const entities = [
    { id: 'e1', valid_from: 0, valid_to: 500 },
    { id: 'e2', valid_from: 100, valid_to: null }, // e2 恒活跃
    { id: 'e3', valid_from: 600, valid_to: 700 },  // t=300 时尚不存在
    { id: 'e4' },                                   // 无窗口 = 恒活跃
  ];
  const relations = [
    { id: 'r1', source_entity: 'e1', target_entity: 'e2', valid_from: 50, valid_to: 300 }, // 窗口内
    { id: 'r2', source_entity: 'e1', target_entity: 'e2', valid_from: 50, valid_to: 100 }, // r 自身到期末
    { id: 'r3', source_entity: 'e1', target_entity: 'e3', valid_from: 50, valid_to: null },// 端点 e3 未活 = 悬边
    { id: 'r4', source_entity: 'e3', target_entity: 'e4', valid_from: 0, valid_to: null }, // 端点 e3 未活
    { id: 'r5', source_entity: 'e4', target_entity: 'e4', valid_from: 100, valid_to: 200 },//
    { id: 'r6', source_entity: 'e4', target_entity: 'e4' },                                // 无窗口恒活
  ];

  test('t=300：实体过滤 + 悬边剔除（r1 的 valid_to=300 为开区间右端已失效）', () => {
    const s = projectStateAt(entities, relations, 300);
    expect(s.entities.map((e) => e.id).sort()).toEqual(['e1', 'e2', 'e4']);
    expect(s.relations.map((r) => r.id).sort()).toEqual(['r6']);
  });

  test('t=150：r1/r5/r6 在窗内，r2 已过期、r3/r4 端点未活', () => {
    const s = projectStateAt(entities, relations, 150);
    expect(s.relations.map((r) => r.id).sort()).toEqual(['r1', 'r5', 'r6']);
  });

  test('实体无窗口 + 关系无窗口 → 全保留（旧库兼容）', () => {
    const s = projectStateAt([{ id: 'a' }, { id: 'b' }], [{ id: 'x', source_entity: 'a', target_entity: 'b' }], 999);
    expect(s.relations).toHaveLength(1);
    expect(s.entities).toHaveLength(2);
  });

  test('实体集合为空 = 端点恒存活（legacy 模式），只按关系窗过滤', () => {
    const s = projectStateAt([], [{ id: 'x', source_entity: 'a', target_entity: 'b', valid_from: null, valid_to: 100 }], 200);
    expect(s.relations).toHaveLength(0);
  });

  test('无效时间点 → 空投影', () => {
    expect(projectStateAt(entities, relations, 'bad')).toEqual({ entities: [], relations: [] });
  });
});

describe('queryStateAt 存储级时点快照', () => {
  let store;
  beforeEach(() => { store = new UnifiedMemoryStore({ dbPath: ':memory:' }); store.initialize(); });

  function seed() {
    store.run(
      `INSERT INTO entities (id, name, kind, mention_count, created_at, updated_at)
       VALUES (?, ?, ?, 0, 0, 0)`,
      ['e1', '甲', 'concept']
    );
    store.run(
      `INSERT INTO entities (id, name, kind, mention_count, created_at, updated_at)
       VALUES (?, ?, ?, 0, 0, 0)`,
      ['e2', '乙', 'concept']
    );
    store.run(
      `INSERT INTO relations (id, source_entity, target_entity, relation_type, confidence, valid_from, valid_to, created_at, updated_at)
       VALUES (?, ?, ?, 'quoted_by', 1.0, 100, 400, 0, 0)`,
      ['r1', 'e1', 'e2']
    );
    store.run(
      `INSERT INTO relations (id, source_entity, target_entity, relation_type, confidence, valid_from, valid_to, created_at, updated_at)
       VALUES (?, ?, ?, 'quoted_by', 0.5, 0, NULL, 0, 0)`,
      ['r2', 'e2', 'e1']
    );
  }

  test('时点投影：窗内外关系正确取舍（含全部 relation_type）', () => {
    seed();
    const at300 = queryStateAt(store, 300);
    expect(at300.relations.map((r) => r.id).sort()).toEqual(['r1', 'r2']);
    const at500 = queryStateAt(store, 500);
    expect(at500.relations.map((r) => r.id)).toEqual(['r2']);
    expect(at500.entities.map((e) => e.id).sort()).toEqual(['e1', 'e2']);
  });

  test('无效时间点 → 空投影', () => {
    seed();
    expect(queryStateAt(store, 'nope')).toEqual({ entities: [], relations: [] });
  });

  test('TemporalGraph.stateAt 经注入 store 与 queryStateAt 等价', () => {
    seed();
    const tg = new TemporalGraph();
    tg._store = store; // 注入测试 store，避免走全局单例碰真实 DB
    const at300 = tg.stateAt(300);
    expect(at300.entities.length).toBe(2);
    expect(at300.relations.length).toBe(2);
  });

  test('memories 表已含时态列（schema 迁移生效）', () => {
    const now = Date.now();
    store.run(
      `INSERT INTO memories (id, type, title, content, valid_from, valid_to, recorded_at, created_at, updated_at)
       VALUES ('m1', 'general', 't', 'c', 100, 200, 150, 0, 0)`,
      []
    );
    expect(store.get('SELECT valid_from, valid_to, recorded_at FROM memories WHERE id = ?', ['m1']))
      .toMatchObject({ valid_from: 100, valid_to: 200, recorded_at: 150 });
    expect(activeAt({ valid_from: 100, valid_to: 200 }, 150)).toBe(true);
  });
});
