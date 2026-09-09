// srs-scheduler.js — 间隔重复（Spaced Repetition）调度纯函数
//
// 2026-08-20 DeepTutor 精华落地: 学习循环——知识实体的遗忘曲线对抗。
// 纯函数设计（无 IO），单测友好; store 列由 unified-store 迁移，读写由调用方完成。
//
// 调度表（与 DeepTutor 一致）:
//   MEMORY    0/1/3/7/14/30/60 天
//   CONCEPT   3/7/14/30 天
//   PROCEDURE 3/7/14 天
//   DESIGN    14/28 天
//
// 状态转移:
//   答对(连对 ≥2 次): 跳 2 级; 答对(连对 1 次): 跳 1 级
//   答错:            降 1 级（不低于 0）
//   索引越界后停留末级（封顶间隔，不再无限拉长）

const SRS_INTERVALS = {
  memory: [0, 1, 3, 7, 14, 30, 60],      // 天
  concept: [3, 7, 14, 30],
  procedure: [3, 7, 14],
  design: [14, 28],
};

const SRS_KINDS = ['memory', 'concept', 'procedure', 'design'];

const DAY_MS = 24 * 60 * 60 * 1000;

/** 取该 kind 的间隔表；未知 kind 回落 concept */
function intervalsFor(kind) {
  return SRS_INTERVALS[kind] || SRS_INTERVALS.concept;
}

/**
 * 复习后的新等级（纯函数）。
 * @param {number} currentIndex 当前等级（0 起，-1/undefined 视为 0）
 * @param {boolean} correct 本次是否答对
 * @param {number} correctStreak 答对前的连对次数（含本次之前的连续答对数）
 * @param {string} kind memory|concept|procedure|design
 * @returns {{ index: number, nextStreak: number }}
 */
function updateLevel(currentIndex, correct, correctStreak, kind) {
  const table = intervalsFor(kind);
  let idx = Number.isFinite(currentIndex) ? Math.max(0, currentIndex) : 0;
  if (idx >= table.length) idx = table.length - 1;

  if (!correct) {
    return { index: Math.max(0, idx - 1), nextStreak: 0 };
  }
  // 连对 ≥2 次（含本次）跳 2 级；否则跳 1 级
  const streak = (correctStreak || 0) + 1;
  const step = streak >= 2 ? 2 : 1;
  return { index: Math.min(idx + step, table.length - 1), nextStreak: streak };
}

/** 某等级对应的下次复习时间戳（ms） */
function nextReviewAt(index, kind, baseTimeMs = Date.now()) {
  const table = intervalsFor(kind);
  const i = Math.min(Math.max(0, index || 0), table.length - 1);
  return baseTimeMs + table[i] * DAY_MS;
}

/** 是否到期（纯函数：dueAt 存在且 <= now） */
function isDue(dueAtMs, nowMs = Date.now()) {
  return typeof dueAtMs === 'number' && Number.isFinite(dueAtMs) && dueAtMs <= nowMs;
}

/** 从记录行（entities 表）解析 SRS 字段，容错 null/undefined */
function rowToSrs(row) {
  if (!row) return null;
  return {
    index: Number.isFinite(row.srs_interval) ? row.srs_interval : 0,
    dueAt: Number.isFinite(row.srs_due_at) ? row.srs_due_at : null,
    streak: Number.isFinite(row.srs_streak) ? row.srs_streak : 0,
    kind: row.kind || 'concept',
  };
}

module.exports = {
  SRS_INTERVALS,
  SRS_KINDS,
  DAY_MS,
  intervalsFor,
  updateLevel,
  nextReviewAt,
  isDue,
  rowToSrs,
};
