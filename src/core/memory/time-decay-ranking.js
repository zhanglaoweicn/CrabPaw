/**
 * Event Time-Decay Ranking — 检索侧事件时间衰减排序
 *
 * 思想来源：OpenViking（volcengine）#5214 "event time-decay ranking" 的工程逻辑移植
 * （仅移植设计思想，零代码复制，规避 AGPL —— 2026-10-15 技术债治理轮）
 *
 * 与既有能力的分工（不重复造轮子）：
 *   - memory-decay.js 是【存储侧】遗忘曲线：按艾宾浩斯衰减记忆"强度"，负责修剪淘汰；
 *   - 本模块是【检索侧】排序融合：查询时把"事件新鲜度"平滑折算进排序分，
 *     解决 RRF 多路融合中"同分旧事压新事"的平票问题（RRF 只看路内排名，不看时间）。
 *
 * 设计要点：
 *   1. 平滑指数衰减（非阶梯函数）：score = exp(-ln2 × ageDays / halfLifeDays)，
 *      半衰期默认 14 天，floor 兜底防老记忆归零；
 *   2. 无时间戳项视为"中性"（因子=1，不打折不奖励）——未知 ≠ 陈旧；
 *   3. weight 控制融合强度：factor = 1 - weight × (1 - score)，
 *      weight=0 完全关闭（默认，保证既有 462 eval 用例零回归），weight=1 全量乘法融合。
 */

const DEFAULT_HALF_LIFE_DAYS = 14;
const DEFAULT_FLOOR = 0.05;
const DEFAULT_WEIGHT = 0;
const MS_PER_DAY = 86400000;

/**
 * 计算单条事件的时间衰减因子，返回 [floor, 1] 区间内的分数。
 * @param {number|undefined} eventTimeMs 事件时间戳（毫秒）；falsy 视为中性
 * @param {{now?:number, halfLifeDays?:number, floor?:number}} [opts]
 * @returns {number}
 */
function eventTimeDecayScore(eventTimeMs, opts = {}) {
  const now = opts.now ?? Date.now();
  const halfLifeDays = opts.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  const floor = opts.floor ?? DEFAULT_FLOOR;

  if (!eventTimeMs || halfLifeDays <= 0) return 1; // 中性：不打折也不奖励

  const ageDays = Math.max(0, (now - eventTimeMs) / MS_PER_DAY);
  const decayed = Math.exp((-Math.LN2 * ageDays) / halfLifeDays);
  return floor + (1 - floor) * decayed;
}

/**
 * 把时间衰减因子融合进一组检索结果（原地风格，返回同一数组便于链式）。
 * 逐条改写 item.combinedScore 与 item.scores.eventDecay。
 *
 * @param {Array<{combinedScore:number, scores?:object}>} results
 * @param {{weight?:number, halfLifeDays?:number, floor?:number, now?:number,
 *          timestampOf?:Function}} [opts]
 *   timestampOf(item) 允许调用方自定义取时戳（默认取 item.eventAt || item.occurredAt
 *   || item.updatedAt || item.updated_at —— 与 hybrid-retrieval 现有字段对齐）
 * @returns {Array} 同一 results 引用（便于链式调用）
 */
function applyEventTimeDecay(results, opts = {}) {
  const weight = opts.weight ?? DEFAULT_WEIGHT;
  if (weight <= 0 || !Array.isArray(results) || results.length === 0) return results;

  const now = opts.now ?? Date.now();
  const timestampOf =
    opts.timestampOf ||
    ((item) => item.eventAt || item.occurredAt || item.updatedAt || item.updated_at || 0);

  for (const item of results) {
    const score = eventTimeDecayScore(timestampOf(item), { now, halfLifeDays: opts.halfLifeDays, floor: opts.floor });
    const factor = 1 - weight * (1 - score); // weight=0 → 1（不变）；weight=1 → score
    if (item.scores) item.scores.eventDecay = score;
    if (typeof item.combinedScore === 'number') item.combinedScore *= factor;
  }
  return results;
}

module.exports = {
  eventTimeDecayScore,
  applyEventTimeDecay,
  DEFAULT_HALF_LIFE_DAYS,
  DEFAULT_FLOOR,
  DEFAULT_WEIGHT,
};
