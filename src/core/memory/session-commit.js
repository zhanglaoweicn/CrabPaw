/**
 * session-commit.js — 会话收口记忆提交管线（VikingMem 式：提炼 → 决策 → 归档）
 *
 * OpenViking（VLDB 2026 VikingMem）式会话提交：会话静默/关闭时对整个会话做一次收口——
 *   ① 抢救：从近端消息提炼候选事实（flushMemories collectOnly，单次 LLM 调用）
 *   ② 决策：每条候选走 新建/合并/跳过 三选一（VikingMem 的 create/merge/skip）
 *        - 跳过 skip : 与已存记忆近重复（bigram Jaccard ≥ 0.92）→ touch 保活，不新增
 *        - 合并 merge: 同话题 + 更新词/矛盾信号 → 原位覆写已存记忆（autoMemory.updateMemory
 *                      + unified-store.updateMemory + 重嵌入），不再制造平行条目
 *        - 新建 create: 其余 → memoryManager.addMemory 全链路落库（含 FTS/向量/实体图）
 *   ③ 归档：近 30 条消息以内容哈希为确定性 id 入向量库（重复收口 upsert 幂等）
 *   ④ 记忆树：会话摘要叶追加进 global:<sessionId> 树（L0），供 ContextDrillDown 下钻、
 *      hybrid-retrieval 目录感知检索消费
 *   ⑤ Dream：AutoDream 会话计数 +1
 *
 * 触发源（全部汇聚到本模块防抖调度，多源重复事件天然去重）：
 *   - ai.js 每轮请求结束 → harness-lifecycle.onSessionEnd → session:end(trigger=request_end)
 *     → 静默防抖（默认 90s，对话连发时不逐轮跑 LLM）
 *   - SessionManager.closeSession / TTL 清理 → session:end(trigger=session_closed) → 立即提交
 *   - harness-hooks.triggerStopHooks → session:end(trigger=stop_hook) → 汇入同一防抖
 *
 * 幂等：同一会话消息数未增长时重复提交直接跳过（request_end 与 stop_hook 双事件场景）。
 */

const crypto = require('crypto');
const { getEventBus } = require('../events');

// 近重复判定阈值：bigram Jaccard 达到它视为同一条事实（跳过）
const SKIP_SIMILARITY = 0.92;
// 合并判定阈值：无显式更新/矛盾信号时，同话题且相似度达到它才合并（保守）
const MERGE_SIMILARITY = 0.55;
// 信号驱动合并的相似度下限：有更新词/矛盾信号时放宽到此（与候选追踪门槛一致）。
// 短中文文本 bigram 相似度天然偏低（"预算改成20万" vs "预算是10万" ≈0.4），
// 更新词/同单位不同数值本身已是强判定，不能再用高相似度闸门挡掉。
const SIGNAL_MERGE_MIN_SIMILARITY = 0.3;
// 防抖窗口：最后一轮对话结束后静默多久才提交
const DEFAULT_DEBOUNCE_MS = 90 * 1000;
// 归档消息窗口（与 unified-memory 原实现一致）
const ARCHIVE_WINDOW = 30;
// 会话摘要树叶的内容上限（约 300 token）
const TREE_LEAF_MAX_CHARS = 1200;
// 待提交队列上限：超出时立即提交最早的，防 Map 无界增长
const MAX_PENDING = 200;

// 全局单例状态
const _pendingCommits = new Map();   // sessionId → { timer, trigger, scheduledAt }
const _lastCommitState = new Map();  // sessionId → { messageCount, at }
let _commitInFlight = new Set();     // 正在提交中的会话（防并发重入）

function _defaultDeps() {
  const { memoryManager } = require('./memory-system');
  return { memoryManager, embed: true };
}

/**
 * 纯决策函数：对候选事实逐条判定 新建/合并/跳过。
 * 独立导出便于单测（不触碰任何存储）。
 *
 * @param {Array<{type:string, content:string, topic?:string, tags?:Array<string>}>} candidates
 * @param {Array<{id:string, type?:string, content:string, tags?:Array<string>}>} existingMemories
 * @param {MemoryRelations} [relations] 注入的关系引擎（默认新建）
 * @returns {Array<{action:'create'|'merge'|'skip', candidate:object, targetId?:string, similarity?:number, reason?:string}>}
 */
function distillFacts(candidates, existingMemories = [], relations = null) {
  const rel = relations || new (require('./memory-relations').MemoryRelations)();
  const decisions = [];

  for (const candidate of candidates || []) {
    if (!candidate || !candidate.content || typeof candidate.content !== 'string') continue;

    let best = null; // { existing, similarity, relation }
    for (const existing of existingMemories) {
      if (!existing || !existing.content) continue;
      const similarity = rel._textSimilarity(candidate.content, existing.content);
      if (similarity < 0.3) continue;

      const analyzed = rel.analyze(
        { id: 'candidate', type: candidate.type, content: candidate.content, topic: candidate.topic, tags: candidate.tags },
        [existing]
      );
      const signal = {
        similarity,
        isUpdate: analyzed.updates.length > 0,
        isContradiction: analyzed.contradictions.length > 0,
        isAssociated: analyzed.associations.length > 0,
      };
      if (!best || similarity > best.similarity) best = { existing, ...signal };
    }

    if (best && best.similarity >= SKIP_SIMILARITY && !best.isContradiction) {
      decisions.push({ action: 'skip', candidate, targetId: best.existing.id, similarity: best.similarity, reason: 'near_duplicate' });
      continue;
    }

    // 信号驱动合并：更新词 / 矛盾（同单位不同数值等）→ 原位覆写，相似度门槛放宽
    if (best && best.similarity >= SIGNAL_MERGE_MIN_SIMILARITY && (best.isUpdate || best.isContradiction)) {
      decisions.push({
        action: 'merge',
        candidate,
        targetId: best.existing.id,
        similarity: best.similarity,
        reason: best.isContradiction ? 'contradiction' : 'update',
      });
      continue;
    }

    // 保守合并：无显式信号但高度同话题重叠（MemoryRelations 关联判定）
    if (best && best.similarity >= MERGE_SIMILARITY && best.isAssociated) {
      decisions.push({ action: 'merge', candidate, targetId: best.existing.id, similarity: best.similarity, reason: 'topic_overwrite' });
      continue;
    }

    decisions.push({ action: 'create', candidate, similarity: best ? best.similarity : 0 });
  }

  return decisions;
}

/** 会话摘要叶内容：紧凑转录（首条用户消息定主旨 + 近端消息），封顶 TREE_LEAF_MAX_CHARS */
function buildSessionDigest(session) {
  const messages = (session && session.messages) || [];
  const firstUser = messages.find(m => m.role === 'user');
  const header = `[会话归档 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}] 共 ${messages.length} 条消息` +
    (firstUser ? `；主旨: ${String(firstUser.content).slice(0, 100)}` : '');

  const lines = [];
  let used = header.length;
  const tail = messages.slice(-12);
  for (const m of tail) {
    if (typeof m.content !== 'string' || !m.content.trim()) continue;
    const line = `${m.role}: ${m.content.slice(0, 200).replace(/\s+/g, ' ')}`;
    if (used + line.length > TREE_LEAF_MAX_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  return [header, ...lines].join('\n');
}

/**
 * 执行一次会话提交。可注入 deps 便于单测（默认全走真实单例）。
 * @returns {Promise<object>} { skipped, reason?, factsCreated, factsMerged, factsSkipped, chunks, treeLeaf }
 */
async function commitSession(sessionId, opts = {}) {
  const deps = opts.deps || _defaultDeps();
  const memoryManager = deps.memoryManager;
  const result = {
    sessionId,
    skipped: false,
    reason: null,
    trigger: opts.trigger || 'manual',
    factsCreated: 0,
    factsMerged: 0,
    factsSkipped: 0,
    chunks: 0,
    treeLeaf: false,
  };

  if (!sessionId) { result.skipped = true; result.reason = 'no_session_id'; return result; }
  if (_commitInFlight.has(sessionId)) { result.skipped = true; result.reason = 'commit_in_flight'; return result; }
  _commitInFlight.add(sessionId);

  try {
    const session = memoryManager.getSession(sessionId);
    if (!session || !Array.isArray(session.messages) || session.messages.length === 0) {
      result.skipped = true; result.reason = 'empty_session'; return result;
    }
    if (session.messages.length < 2) {
      result.skipped = true; result.reason = 'too_few_messages'; return result;
    }

    // 幂等守卫：消息数未增长（request_end 与 stop_hook 双事件、或同窗口重复事件）→ 跳过
    const last = _lastCommitState.get(sessionId);
    if (last && last.messageCount === session.messages.length) {
      result.skipped = true; result.reason = 'already_committed'; return result;
    }

    // ① 抢救候选事实（collectOnly：只提取不落库，单次 LLM；无 LLM 时正则兜底）
    let candidates = [];
    try {
      const flushed = await memoryManager.flushMemories(sessionId, { collectOnly: true });
      candidates = Array.isArray(flushed?.candidates) ? flushed.candidates : [];
    } catch (e) {
      console.warn('[session-commit] 事实抢救失败（继续归档）:', e.message);
    }

    // ② 提炼决策：新建/合并/跳过
    if (candidates.length > 0) {
      const existingMemories = await memoryManager.getAllMemories();
      const decisions = opts.distillFacts
        ? opts.distillFacts(candidates, existingMemories)
        : distillFacts(candidates, existingMemories);

      for (const d of decisions) {
        try {
          if (d.action === 'create') {
            await memoryManager.addMemory(
              d.candidate.type || 'fact',
              d.candidate.content.slice(0, 80),
              d.candidate.content,
              ['session_commit', d.candidate.type || 'general'],
              'private'
            );
            result.factsCreated++;
          } else if (d.action === 'merge') {
            await _mergeMemory(memoryManager, d, deps);
            result.factsMerged++;
          } else {
            result.factsSkipped++;
          }
        } catch (e) {
          console.warn('[session-commit] 记忆决策执行失败（跳过该条）:', e.message);
        }
      }
    }

    // ③ 归档近端消息入向量库（内容哈希确定性 id，重复提交 upsert 幂等）
    try {
      const store = deps.store || require('./unified-store').getUnifiedStore();      for (let i = 0; i < session.messages.length; i++) {
        const idx = session.messages.length - Math.min(session.messages.length, ARCHIVE_WINDOW) + i;
        const msg = session.messages[idx];
        if (!msg || typeof msg.content !== 'string' || !msg.content.trim()) continue;
        const hash = crypto.createHash('md5').update(msg.content).digest('hex').slice(0, 10);
        store.upsertChunk({
          document_id: `session_${sessionId}_m${hash}`,
          namespace: sessionId,
          content: msg.content,
          chunk_index: 0,
          metadata: { role: msg.role, sessionId, committedAt: Date.now() },
        });
        result.chunks++;
      }
    } catch (e) {
      console.warn('[session-commit] 消息归档失败:', e.message);
    }

    // ④ 会话摘要叶 → 记忆树（global:<sessionId> 目录树，供下钻与目录感知检索）
    try {
      const { getMemoryTreeOrchestrator } = require('./memory-tree-v2');
      const orch = getMemoryTreeOrchestrator();
      const digest = buildSessionDigest(session);
      await orch.appendToTree('global', digest, {
        treeKind: 'global',
        topic: sessionId,
        sessionId,
        kind: 'session_digest',
        trigger: result.trigger,
      });
      result.treeLeaf = true;
    } catch (e) {
      console.warn('[session-commit] 记忆树叶追加失败:', e.message);
    }

    // ⑤ Dream 会话计数
    try {
      if (memoryManager.autoDream && typeof memoryManager.autoDream.incrementSessionCount === 'function') {
        memoryManager.autoDream.incrementSessionCount();
      }
    } catch (e) {
      console.warn('[session-commit] AutoDream 计数失败:', e.message);
    }

    _lastCommitState.set(sessionId, { messageCount: session.messages.length, at: Date.now() });
    if (_lastCommitState.size > 500) {
      const oldestKey = _lastCommitState.keys().next().value;
      _lastCommitState.delete(oldestKey);
    }

    console.log(`[session-commit] 会话已收口 ${sessionId}（trigger=${result.trigger}）: ` +
      `新建 ${result.factsCreated} / 合并 ${result.factsMerged} / 跳过 ${result.factsSkipped}，` +
      `归档 ${result.chunks} 条消息${result.treeLeaf ? '，摘要叶已入记忆树' : ''}`);

    try {
      getEventBus().publish('memory', 'session_committed', { ...result });
    } catch (e) {
      console.warn('[session-commit] 事件发布失败:', e.message);
    }

    return result;
  } finally {
    _commitInFlight.delete(sessionId);
  }
}

/** 合并路径：原位覆写已存记忆（autoMemory + unified-store + FTS 重索引 + 重嵌入） */
async function _mergeMemory(memoryManager, decision, deps = {}) {
  const { candidate, targetId } = decision;
  const content = String(candidate.content || '').slice(0, 2000);
  const title = content.slice(0, 80);

  // autoMemory（MEMORY.md 笔记本 + mem_<id>.md 文件）
  if (memoryManager.autoMemory && typeof memoryManager.autoMemory.updateMemory === 'function') {
    try {
      await memoryManager.autoMemory.updateMemory(targetId, {
        content,
        title,
        updated: Date.now(),
        _mergedFrom: 'session_commit',
      });
    } catch (e) {
      console.warn('[session-commit] autoMemory.updateMemory 失败:', e.message);
    }
  }

  // unified-store（SQLite 主库）；deps.store 缺 updateMemory 方法时自然跳过（测试注入）
  try {
    const store = deps.store || require('./unified-store').getUnifiedStore();
    if (store && typeof store.updateMemory === 'function') {
      store.updateMemory(targetId, { content, title, updated_at: Date.now() / 1000 });
    }
  } catch (e) {
    console.warn('[session-commit] unified-store.updateMemory 失败:', e.message);
  }

  // FTS 重索引（失败降级不阻塞）
  try {
    if (memoryManager.ftsSearch && typeof memoryManager.ftsSearch.indexMemory === 'function') {
      await memoryManager.ftsSearch.indexMemory(targetId, {
        type: candidate.type || 'fact',
        title,
        content,
        tags: candidate.tags || [],
      });
    }
  } catch (e) {
    console.warn('[session-commit] FTS 重索引失败:', e.message);
  }
  // 重嵌入：仅在真实管线（_defaultDeps 标记 embed:true）时进行，测试注入的 deps 不触发
  if (deps.embed === true) {
    try {
      const { globalEmbeddingPipeline } = require('../embedding-pipeline');
      globalEmbeddingPipeline.embedMemory({ id: targetId, text: content })
        .catch(e2 => console.warn('[session-commit] 合并后重嵌入失败:', e2?.message || e2));
    } catch (e) {
      console.warn('[session-commit] 重嵌入接线失败:', e.message);
    }
  }
}

/**
 * 调度一次会话提交（防抖）。
 * @param {string} sessionId
 * @param {object} opts { trigger?: string, delayMs?: number, deps?: object }
 */
function scheduleSessionCommit(sessionId, opts = {}) {
  if (!sessionId) return { scheduled: false, reason: 'no_session_id' };

  // 会话真正关闭/停机：立即提交，不走防抖
  const immediate = opts.trigger === 'session_closed' || opts.trigger === 'shutdown';

  const existing = _pendingCommits.get(sessionId);
  if (existing) {
    if (existing.timer) clearTimeout(existing.timer);
    _pendingCommits.delete(sessionId);
  }

  const run = () => {
    _pendingCommits.delete(sessionId);
    commitSession(sessionId, { trigger: opts.trigger || 'debounce', deps: opts.deps })
      .catch(e => console.warn('[session-commit] 提交失败:', e.message));
  };

  if (immediate) {
    run();
    return { scheduled: true, immediate: true };
  }

  const delayMs = opts.delayMs ?? parseDebounceEnv();
  const timer = setTimeout(run, delayMs);
  if (typeof timer.unref === 'function') timer.unref(); // 不阻塞 CLI 进程退出
  _pendingCommits.set(sessionId, { timer, trigger: opts.trigger, scheduledAt: Date.now() });

  // 队列上限保护：最老的待提交立即落盘
  if (_pendingCommits.size > MAX_PENDING) {
    const oldestId = _pendingCommits.keys().next().value;
    scheduleSessionCommit(oldestId, { trigger: 'overflow' });
  }

  return { scheduled: true, delayMs };
}

/** 优雅停机：所有待提交会话立即提交（best-effort，不阻塞退出） */
function flushPendingCommits() {
  const ids = [..._pendingCommits.keys()];
  for (const id of ids) {
    scheduleSessionCommit(id, { trigger: 'shutdown' });
  }
  return ids;
}

function parseDebounceEnv() {
  const raw = parseInt(process.env.CRABPAW_COMMIT_DEBOUNCE_MS, 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DEBOUNCE_MS;
}

/** 测试辅助：清空全部调度/幂等状态 */
function resetForTest() {
  for (const [, p] of _pendingCommits) {
    if (p.timer) clearTimeout(p.timer);
  }
  _pendingCommits.clear();
  _lastCommitState.clear();
  _commitInFlight = new Set();
}

module.exports = {
  distillFacts,
  buildSessionDigest,
  commitSession,
  scheduleSessionCommit,
  flushPendingCommits,
  resetForTest,
  SKIP_SIMILARITY,
  MERGE_SIMILARITY,
  SIGNAL_MERGE_MIN_SIMILARITY,
  DEFAULT_DEBOUNCE_MS,
  ARCHIVE_WINDOW,
};
