/**
 * provenance-chain.js — 决策哈希链落库/篡改检测/溯源（semantica ProvenanceManager 范式 JS 版）
 * 存储注入式（store 为 unified-store 实例，含 run/get/all/transaction）。
 *
 * 关于 semantica「entity_id 排除在 checksum 外」的对照裁断（2026-08-25）：
 * 该豁免针对的是实体版本归档重标记（X → X:v:ts）——若哈希含 entity_id，重标记会误报断链。
 * bossagent 决策行主键为 run_id 且不存在行级重命名；实体重命名只发生在 entities 表
 * （writeDecisionGraph 的 'decision:' + run_id），该表不在 recordHash 内。
 * 故无需豁免，但保留此案记录：若未来引入决策行版本归档（复制为新 run_id），
 * 应同步把 run_id 移出 computeRecordHash 的 pick。
 */
const crypto = require('crypto');
const {
  computeRecordHash, computeChecksum,
} = require('./decision-recorder');

const GENESIS = 'GENESIS';
const BASED_ON_MAX = 10;

function getLastChecksum(store) {
  const row = store.get('SELECT checksum FROM decisions ORDER BY sequence_id DESC LIMIT 1');
  return (row && row.checksum) || GENESIS;
}

function rowToRecord(row) {
  return {
    run_id: row.run_id, round_id: row.round_id, user_intent: row.user_intent,
    plan: row.plan, tool_digest: safeParse(row.tool_digest, []),
    conclusion: row.conclusion, verdict: row.verdict,
    evidence_refs: safeParse(row.evidence_refs, []),
    created_at: row.created_at, recorded_at: row.recorded_at,
  };
}

let _duplicateWarned = false;

function persistDecision(store, record) {
  return store.transaction((tx) => {
    // 幂等守卫：同一 run_id 已存在则返回既有行记录，不重插、不推进链
    // （INSERT OR REPLACE 会先删旧行再插新行，重复落库会把链条打断并造成假篡改报警）
    const existing = tx.get('SELECT * FROM decisions WHERE run_id = ?', [record.run_id]);
    if (existing) {
      if (!_duplicateWarned) {
        _duplicateWarned = true;
        console.warn('[provenance-chain] 重复 run_id，幂等返回既有记录（不重插、不推进链）:', record.run_id);
      }
      return { ...rowToRecord(existing), sequence_id: existing.sequence_id, checksum: existing.checksum };
    }
    // 事务内定序：MAX(sequence_id)+1 与行插入、previous_checksum 指针同属一个原子单元
    const seqRow = tx.get('SELECT MAX(sequence_id) AS m FROM decisions');
    const sequence_id = ((seqRow && seqRow.m) || 0) + 1;
    const previous_checksum = getLastChecksum(tx);
    const recordHash = computeRecordHash(record);
    const checksum = computeChecksum({ sequence_id, previous_checksum, recordHash, recorded_at: record.recorded_at });

    tx.run(
      `INSERT OR REPLACE INTO decisions
       (run_id, round_id, user_intent, plan, tool_digest, conclusion, verdict, evidence_refs, created_at, recorded_at, sequence_id, previous_checksum, checksum)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.run_id, record.round_id || record.run_id, record.user_intent, record.plan,
       JSON.stringify(record.tool_digest), record.conclusion, record.verdict,
       JSON.stringify(record.evidence_refs), record.created_at, record.recorded_at,
       sequence_id, previous_checksum, checksum]
    );
    writeDecisionGraph(tx, record);
    return { run_id: record.run_id, sequence_id, checksum };
  });
}

function writeDecisionGraph(tx, record) {
  const decisionId = 'decision:' + record.run_id;
  tx.run(
    `INSERT OR REPLACE INTO entities (id, name, kind, aliases, metadata, mention_count, last_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    [decisionId, record.user_intent.slice(0, 40) || record.run_id, 'decision',
     JSON.stringify([]), JSON.stringify({ source: 'decision', run_id: record.run_id }),
     record.recorded_at, record.recorded_at, record.recorded_at]
  );
  // based_on 证据边（上限 10，目标不存在则创建 evidence 实体）
  for (const ref of (record.evidence_refs || []).slice(0, BASED_ON_MAX)) {
    const key = crypto.createHash('sha256').update(ref.tool + ':' + ref.summary).digest('hex').slice(0, 16);
    const evidenceId = 'evidence:' + key;
    tx.run(
      `INSERT OR REPLACE INTO entities (id, name, kind, aliases, metadata, mention_count, last_seen_at, created_at, updated_at)
       VALUES (?, ?, 'evidence', ?, ?, 0, ?, ?, ?)`,
      [evidenceId, ref.summary.slice(0, 40), JSON.stringify([]), JSON.stringify({ source: 'decision' }),
       record.recorded_at, record.recorded_at, record.recorded_at]
    );
    tx.run(
      `INSERT OR REPLACE INTO relations (id, source_entity, target_entity, relation_type, namespace, confidence, metadata, created_at, updated_at)
       VALUES (?, ?, ?, 'based_on', 'decision', 1.0, ?, ?, ?)`,
      ['de_' + decisionId.slice(9) + '_' + key, decisionId, evidenceId,
       JSON.stringify({ source: 'decision', tool: ref.tool }), record.recorded_at, record.recorded_at]
    );
  }
}

function verifyChain(store) {
  // 全链校验（runId 不做局部裁剪——校验语义即「整链不可篡改」）
  // 双信号（semantica verify_chain 范式）：
  //  信号一：自身 checksum 重算匹配 + previous_checksum 与前任一致（防改内容/断链）；
  //  信号二：sequence_id 连续无空洞（防「删行 + 重连指针 + 重算 checksum」的智能篡改——
  //         前向指针可被重连，但序号空洞无法隐藏）。
  const rows = store.all('SELECT * FROM decisions ORDER BY sequence_id ASC');
  let prevChecksum = null;
  let prevSeq = 0;
  for (const row of rows) {
    if (row.sequence_id !== prevSeq + 1) {
      return { chainIntegrity: false, brokenAt: row.sequence_id, total: rows.length, reason: 'sequence_id 空洞/重复（行被删除且指针已重连）' };
    }
    const recordHash = computeRecordHash(rowToRecord(row));
    const expected = computeChecksum({ sequence_id: row.sequence_id, previous_checksum: prevChecksum || GENESIS, recordHash, recorded_at: row.recorded_at });
    if (row.checksum !== expected) {
      return { chainIntegrity: false, brokenAt: row.sequence_id, total: rows.length, reason: 'checksum 失配（内容或指针被篡改）' };
    }
    if (prevChecksum !== null && row.previous_checksum !== prevChecksum) {
      return { chainIntegrity: false, brokenAt: row.sequence_id, total: rows.length, reason: 'previous_checksum 断链' };
    }
    prevChecksum = row.checksum;
    prevSeq = row.sequence_id;
  }
  return { chainIntegrity: true, brokenAt: null, total: rows.length, reason: 'ok' };
}

function getLineage(store, runId) {
  const row = store.get('SELECT * FROM decisions WHERE run_id = ?', [runId]);
  if (!row) return null;
  const decisionId = 'decision:' + runId;
  const edges = store.all(
    `SELECT r.relation_type, r.confidence, r.metadata, e.name AS target_name, e.kind AS target_kind
     FROM relations r LEFT JOIN entities e ON e.id = r.target_entity
     WHERE r.source_entity = ? ORDER BY r.created_at ASC`,
    [decisionId]
  );
  return {
    decision: rowToRecord(row),
    evidence: edges.map((e) => ({ relationType: e.relation_type, confidence: e.confidence, target: e.target_name || e.target_kind, metadata: safeParse(e.metadata, {}) })),
    evidenceRefs: safeParse(row.evidence_refs, []),
  };
}

function safeParse(text, fallback) {
  try { return JSON.parse(text); } catch (e) { return fallback; }
}

module.exports = { persistDecision, verifyChain, getLineage, rowToRecord, getLastChecksum, GENESIS };
