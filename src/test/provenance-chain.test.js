/**
 * provenance-chain.test.js — 决策哈希链落库/篡改检测/溯源（semantica ProvenanceManager 范式）
 */
const { UnifiedMemoryStore } = require('../core/memory/unified-store');
const {
  persistDecision, verifyChain, getLineage, getLastChecksum, rowToRecord,
} = require('../core/memory/provenance-chain');
const {
  createFoldState, foldRunEvent, computeRecordHash, computeChecksum,
} = require('../core/memory/decision-recorder');

function mkRecord(runId) {
  // 走生产同款折叠路径（run:start → tool_call → tool_result → run:finished）
  const state = createFoldState();
  foldRunEvent(state, 'run:start', { roundId: runId, userInput: '查询' + runId, ts: 1 });
  foldRunEvent(state, 'tool_call', { toolName: 'KbSearch', toolId: 't1', toolArgs: '{}', roundId: runId });
  foldRunEvent(state, 'tool_result', { toolName: 'KbSearch', toolId: 't1', success: true, result: 'r', roundId: runId });
  return foldRunEvent(state, 'run:finished', { roundId: runId, ts: 2 }).decision;
}

describe('persistDecision 落库', () => {
  let store;
  beforeEach(() => { store = new UnifiedMemoryStore({ dbPath: ':memory:' }); store.initialize(); });

  test('连续追加链增长且 previous_checksum 衔接', () => {
    persistDecision(store, mkRecord('r1'));
    persistDecision(store, mkRecord('r2'));
    const rows = store.all('SELECT * FROM decisions ORDER BY sequence_id ASC');
    expect(rows).toHaveLength(2);
    expect(rows[0].sequence_id).toBe(1);
    expect(rows[0].previous_checksum).toBe('GENESIS');
    expect(rows[1].sequence_id).toBe(2);
    expect(rows[1].previous_checksum).toBe(rows[0].checksum);
    expect(getLastChecksum(store)).toBe(rows[1].checksum);
  });

  test('重复 run_id 幂等：不重插不推进链，verifyChain 仍全绿', () => {
    const first = persistDecision(store, mkRecord('r1'));
    const second = persistDecision(store, mkRecord('r1'));
    const rows = store.all('SELECT * FROM decisions ORDER BY sequence_id ASC');
    expect(rows).toHaveLength(1);
    expect(second.run_id).toBe('r1');
    expect(second.sequence_id).toBe(first.sequence_id);
    expect(second.checksum).toBe(first.checksum);
    const v = verifyChain(store);
    expect(v.chainIntegrity).toBe(true);
    expect(v.total).toBe(1);
  });

  test('决策节点 + based_on 证据边落库（含 evidence 实体自动创建）', () => {
    persistDecision(store, mkRecord('r1'));
    const node = store.get('SELECT * FROM entities WHERE id = ?', ['decision:r1']);
    expect(node).not.toBeNull();
    expect(node.kind).toBe('decision');
    const edges = store.all('SELECT relation_type, source_entity FROM relations WHERE source_entity = ?', ['decision:r1']);
    expect(edges.length).toBeGreaterThan(0);
    expect(edges[0].relation_type).toBe('based_on');
    const evidence = store.get('SELECT * FROM entities WHERE id LIKE ?', ['evidence:%']);
    expect(evidence).not.toBeNull();
    expect(evidence.kind).toBe('evidence');
  });
});

describe('verifyChain 篡改检测', () => {
  let store;
  beforeEach(() => { store = new UnifiedMemoryStore({ dbPath: ':memory:' }); store.initialize(); });

  test('干净链 → integrity true', () => {
    persistDecision(store, mkRecord('r1'));
    persistDecision(store, mkRecord('r2'));
    expect(verifyChain(store)).toEqual({ chainIntegrity: true, brokenAt: null, total: 2, reason: 'ok' });
  });

  test('改记录内容 → brokenAt 定位到该条', () => {
    persistDecision(store, mkRecord('r1'));
    persistDecision(store, mkRecord('r2'));
    store.run("UPDATE decisions SET conclusion = '被篡改' WHERE run_id = 'r2'");
    const v = verifyChain(store);
    expect(v.chainIntegrity).toBe(false);
    expect(v.brokenAt).toBe(2);
  });

  test('改 checksum → brokenAt 定位', () => {
    persistDecision(store, mkRecord('r1'));
    persistDecision(store, mkRecord('r2'));
    store.run("UPDATE decisions SET checksum = '0000000000000000000000000000000000000000000000000000000000000000' WHERE run_id = 'r2'");
    expect(verifyChain(store).brokenAt).toBe(2);
  });

  test('删中间一条 → brokenAt 定位到断链处', () => {
    persistDecision(store, mkRecord('r1'));
    persistDecision(store, mkRecord('r2'));
    persistDecision(store, mkRecord('r3'));
    store.run("DELETE FROM decisions WHERE run_id = 'r2'");
    const v = verifyChain(store);
    expect(v.chainIntegrity).toBe(false);
    expect(v.brokenAt).toBe(3); // r3 的 previous_checksum 不再是 r1 的 checksum
  });

  test('智能篡改：删行 + 重连指针 + 重算 checksum → sequence 空洞信号仍报 broken', () => {
    persistDecision(store, mkRecord('r1'));
    persistDecision(store, mkRecord('r2'));
    persistDecision(store, mkRecord('r3'));
    store.run("DELETE FROM decisions WHERE run_id = 'r2'");
    // 攻击者重连 r3 → r1，并重算 r3 的 checksum，试图掩盖删除
    const r1 = store.get("SELECT * FROM decisions WHERE run_id = 'r1'");
    const r3 = store.get("SELECT * FROM decisions WHERE run_id = 'r3'");
    const recordHash = computeRecordHash(rowToRecord(r3));
    const newChecksum = computeChecksum({
      sequence_id: r3.sequence_id,
      previous_checksum: r1.checksum,
      recordHash,
      recorded_at: r3.recorded_at,
    });
    store.run(
      "UPDATE decisions SET previous_checksum = ?, checksum = ? WHERE run_id = 'r3'",
      [r1.checksum, newChecksum]
    );
    const v = verifyChain(store);
    expect(v.chainIntegrity).toBe(false);
    expect(v.brokenAt).toBe(3);
    expect(v.reason).toContain('sequence_id');
  });
});

describe('getLineage 溯源', () => {
  let store;
  beforeEach(() => { store = new UnifiedMemoryStore({ dbPath: ':memory:' }); store.initialize(); });

  test('返回决策 + 证据边 + evidence_refs', () => {
    persistDecision(store, mkRecord('r1'));
    const lg = getLineage(store, 'r1');
    expect(lg).not.toBeNull();
    expect(lg.decision.run_id).toBe('r1');
    expect(lg.evidence.length).toBeGreaterThan(0);
    expect(lg.evidenceRefs[0].tool).toBe('KbSearch');
  });

  test('不存在的 runId → null', () => {
    expect(getLineage(store, 'nope')).toBeNull();
  });
});
