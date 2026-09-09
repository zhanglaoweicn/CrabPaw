#!/usr/bin/env node
/**
 * slo-report.js — SLO 基线报告(P1-8, Runtime优化轮)
 *
 * 读取 RunStore 的持久化 run 记录(checkpoints/runrec_*.json),按回合类型聚合:
 *   - 简单问答(无工具调用) vs 工具任务(toolCalls > 0)
 *   - TTFT / 回合时延 / Token / 估算费用的 p50 / p95
 * 输出人读表格 + 机读基线 JSON(data/.crabpaw/assessment/slo-baseline.json),
 * 供《bossagent-系统测评方案》§8 的性能成本基准与漂移对比使用。
 *
 * 用法: node scripts/assessment/slo-report.js [--json]
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../../src/core/config');

const CHECKPOINTS_DIR = path.join(DATA_DIR, 'checkpoints');
const OUT_DIR = path.join(DATA_DIR, 'assessment');
const OUT_FILE = path.join(OUT_DIR, 'slo-baseline.json');

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.max(0, sorted[Math.max(0, idx)]);
}

function round(n, digits = 1) {
  if (n == null) return null;
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

function summarize(values) {
  const nums = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (nums.length === 0) return { count: 0, p50: null, p95: null };
  return {
    count: nums.length,
    p50: percentile(nums, 50),
    p95: percentile(nums, 95),
  };
}

function loadRuns() {
  if (!fs.existsSync(CHECKPOINTS_DIR)) return [];
  // 2026-09-04 SLO 轮: 历史回填——costUsd 缺失/为 0 且 token 齐全时按费率表估算。
  // 背景: 上游 recordUsage 的 cost 传递在真实运行中断链(22 个存量 runrec costUsd 全 0
  // 但 token 齐); 新数据由 run-usage 自愈逻辑写入, 本回填覆盖存量。
  const { MODEL_PRICING } = require('../../src/core/usage-stats');
  const runs = [];
  let backfilled = 0;
  for (const f of fs.readdirSync(CHECKPOINTS_DIR)) {
    if (!f.startsWith('runrec_') || !f.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(CHECKPOINTS_DIR, f), 'utf8'));
      if (rec && rec.runId) {
        const u = rec.usage;
        if (u && !u.costUsd && (u.promptTokens || u.completionTokens)) {
          const models = Object.keys(u.byModel || {});
          const pricing = MODEL_PRICING[models[0]] || MODEL_PRICING.default || { prompt: 0.0001, completion: 0.0001, cache: 0.000005 };
          const nonCached = Math.max(0, (u.promptTokens || 0) - (u.cachedTokens || 0));
          u.costUsd = (nonCached / 1000) * pricing.prompt + ((u.completionTokens || 0) / 1000) * pricing.completion + ((u.cachedTokens || 0) / 1000) * (pricing.cache || 0);
          u.costEstimated = true;
          backfilled++;
        }
        runs.push(rec);
      }
    } catch (e) {
      console.warn(`[slo-report] 跳过损坏记录 ${f}: ${e.message}`);
    }
  }
  if (backfilled > 0) console.log(`[slo-report] 已回填 ${backfilled} 个存量 run 的费用(按费率表估算, source: estimated)`);
  return runs;
}

function buildBaseline(runs) {
  const finished = runs.filter((r) => ['finished', 'error', 'interrupted', 'cancelled'].includes(r.status));
  const groups = {
    all: finished,
    simple_chat: finished.filter((r) => !r.usage || !r.usage.toolCalls),
    tool_task: finished.filter((r) => r.usage && r.usage.toolCalls > 0),
  };

  const report = { generatedAt: new Date().toISOString(), totalRuns: runs.length, byStatus: {}, groups: {} };
  for (const r of runs) {
    report.byStatus[r.status] = (report.byStatus[r.status] || 0) + 1;
  }

  for (const [name, list] of Object.entries(groups)) {
    report.groups[name] = {
      runs: list.length,
      ttftMs: summarize(list.map((r) => r.usage && r.usage.ttftMs)),
      latencyMs: summarize(list
        .filter((r) => r.finishedAt && r.startedAt)
        .map((r) => r.finishedAt - r.startedAt)),
      totalTokens: summarize(list.map((r) => r.usage && r.usage.totalTokens)),
      costUsd: summarize(list.map((r) => r.usage && r.usage.costUsd)),
      llmCalls: summarize(list.map((r) => r.usage && r.usage.llmCalls)),
    };
  }
  return report;
}

function renderTable(report) {
  const fmt = (s, unit) => (s.count === 0 ? '  (无样本)' : `n=${s.count}  p50=${round(s.p50)}${unit}  p95=${round(s.p95)}${unit}`);
  // 2026-09-04 SLO 轮: 费用是分级小数(单回合 $0.005 级), 4 位小数展示——
  // 此前沿用 1 位 round 把真实费用渲染成 "0USD"(数据在, 显示没了)。
  const fmtCost = (s) => (s.count === 0 ? '  (无样本)' : `n=${s.count}  p50=$${round(s.p50, 4)}  p95=$${round(s.p95, 4)}`);
  const lines = [];
  lines.push(`SLO 基线报告  生成于 ${report.generatedAt}`);
  lines.push(`run 总数: ${report.totalRuns}  状态分布: ${JSON.stringify(report.byStatus)}`);
  lines.push('');
  for (const [name, label] of [['all', '全部'], ['simple_chat', '简单问答(无工具)'], ['tool_task', '工具任务']]) {
    const g = report.groups[name];
    lines.push(`── ${label}(${g.runs} 个终态 run) ──`);
    lines.push(`  TTFT      : ${fmt(g.ttftMs, 'ms')}`);
    lines.push(`  回合时延  : ${fmt(g.latencyMs, 'ms')}`);
    lines.push(`  Token     : ${fmt(g.totalTokens, '')}`);
    lines.push(`  估算费用  : ${fmtCost(g.costUsd)}`);
    lines.push(`  LLM 调用  : ${fmt(g.llmCalls, '次')}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** --outliers: 时延异常样本甄别——最慢 8 个 run 的明细(判断 p50/p95 是否被长尾任务污染) */
function printOutliers(runs) {
  const finished = runs
    .filter((r) => ['finished', 'error', 'interrupted', 'cancelled'].includes(r.status) && r.finishedAt && r.startedAt)
    .map((r) => ({
      id: r.runId,
      latency: r.finishedAt - r.startedAt,
      goal: String(r.goal || r.title || '').slice(0, 40),
      toolCalls: (r.usage && r.usage.toolCalls) || 0,
      llmCalls: (r.usage && r.usage.llmCalls) || 0,
      ttft: (r.usage && r.usage.ttftMs) || null,
      status: r.status,
    }))
    .sort((a, b) => b.latency - a.latency)
    .slice(0, 8);
  console.log('── 时延 Top8(异常甄别: 长尾是长任务还是卡死) ──');
  for (const r of finished) {
    console.log(`  ${Math.round(r.latency / 1000)}s  ${r.status}  LLM×${r.llmCalls} 工具×${r.toolCalls}  TTFT=${r.ttft ?? '-'}  ${r.goal}`);
  }
  const legit = finished.filter((r) => r.llmCalls >= 3 || r.toolCalls >= 2).length;
  console.log(`  甄别: Top8 中 ${legit} 个为多调用长任务(时延与工作量相称), 其余需人工复核\n`);
}

function main() {
  const runs = loadRuns();
  if (runs.length === 0) {
    console.log('[slo-report] 无 run 记录可聚合——先正常使用产生对话回合后重试。');
    return;
  }
  if (process.argv.includes('--outliers')) {
    printOutliers(runs);
    return;
  }
  const report = buildBaseline(runs);
  console.log(renderTable(report));
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));
    console.log(`基线 JSON 已写入: ${OUT_FILE}`);
  } catch (e) {
    console.warn('[slo-report] 基线写入失败(仅控制台输出):', e.message);
  }
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  }
}

main();
