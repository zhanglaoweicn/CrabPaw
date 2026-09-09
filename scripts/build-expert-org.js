#!/usr/bin/env node
/**
 * build-expert-org.js — 专家组织数据导入管线（2026-09-04 部门化重组 P1）
 *
 * 输入：data/experts-from-agency-agents.json（268 位已中文化的 agency-agents 角色）
 *       + D:\Down\agency-agents 源仓库（division 目录索引——id 前缀不可靠，
 *         如 blender/unity/godot 均属 game-development）
 * 输出：data/experts-org.json——全量 268 位，逐位补 department/status/aliases、
 *       清洗 routingKeywords（剥离长描述片段）。泊车岗位保留在人才库（可显式召唤），
 *       不参与自动路由。
 *
 * 用法：node scripts/build-expert-org.js [--source <agency-agents 路径>]
 * 消费方：src/core/experts/index.js 加载（org 文件存在时取代原始 agency 文件）。
 * 纪律：本脚本只生成数据，不改专家人格文本（systemPrompt 原样透传）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_JSON = path.join(ROOT, 'data', 'experts-from-agency-agents.json');
const OUTPUT_JSON = path.join(ROOT, 'data', 'experts-org.json');
const {
  DIVISION_POLICY, DIVISION_PREFIX_FALLBACK, ROLE_ALIASES, resolveDivisionPolicy,
} = require('../src/core/experts/departments');

const args = process.argv.slice(2);
const sourceRepoIdx = args.indexOf('--source');
const AGENCY_REPO = sourceRepoIdx >= 0 ? args[sourceRepoIdx + 1] : 'D:\\Down\\agency-agents';

/** 从源仓库建立 文件名→division 索引（最可靠的 division 事实源） */
function buildDivisionFileIndex() {
  const index = {};
  let divisions = [];
  try {
    const divJson = JSON.parse(fs.readFileSync(path.join(AGENCY_REPO, 'divisions.json'), 'utf8'));
    divisions = Object.keys(divJson.divisions || {});
  } catch (e) {
    console.warn(`[build-org] divisions.json 不可读(${e.message})，退化为目录列举`);
    try { divisions = fs.readdirSync(AGENCY_REPO, { withFileTypes: true }).filter(d => d.isDirectory() && !d.startsWith('.')).map(d => d.name); } catch (e2) { /* 无源仓 */ }
  }
  for (const div of divisions) {
    const dir = path.join(AGENCY_REPO, div);
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.md')) index[f.replace(/\.md$/, '')] = div;
      }
    } catch (e) { /* 目录不存在跳过 */ }
  }
  return index;
}

/** division → 编制判定（文件索引 → 前缀兜底 → unknown） */
function resolveDivision(expertId, fileIndex) {
  if (fileIndex[expertId]) return fileIndex[expertId];
  const prefix = expertId.split('-')[0].toLowerCase();
  if (DIVISION_POLICY[prefix]) return prefix;
  if (DIVISION_PREFIX_FALLBACK[prefix]) return DIVISION_PREFIX_FALLBACK[prefix];
  return 'unknown';
}

/** 清洗 routingKeywords：剥长描述片段（>12 字符），不足 2 个时从 tags 补，封顶 8 */
function cleanKeywords(expert) {
  const orig = Array.isArray(expert.routingKeywords) ? expert.routingKeywords : [];
  const cleaned = orig.filter(k => typeof k === 'string' && k.trim().length > 0 && k.length <= 12);
  if (cleaned.length < 2 && Array.isArray(expert.tags)) {
    for (const t of expert.tags) {
      if (typeof t === 'string' && t.length > 0 && t.length <= 8 && !cleaned.includes(t)) cleaned.push(t);
      if (cleaned.length >= 4) break;
    }
  }
  return [...new Set(cleaned)].slice(0, 8);
}

// ── tags 去污(2026-09-05) ──
// 上游导入(experts-from-agency-agents.json)把 [division, 品牌色] 写进了 tags——
// 卡片 UI 把这些原始值当能力标签渲染('finance'/'green'/'#E74C3C' 满屏)。
// division 信息本就有 sourceDivision/department 字段承载, 颜色是纯装饰, 都不属 tags。
const NAMED_COLORS = new Set(['green', 'blue', 'red', 'purple', 'teal', 'orange', 'amber', 'cyan',
  'violet', 'pink', 'lime', 'rose', 'fuchsia', 'indigo', 'slate', 'navy', 'gold', 'yellow', 'gray', 'grey']);
function isColorToken(t) {
  const s = String(t).toLowerCase();
  if (/^#[0-9a-f]{3,8}$/.test(s)) return true;
  return /^[a-z]+(-[a-z]+)*$/.test(s) && s.split('-').every(p => NAMED_COLORS.has(p));
}
function sanitizeTags(expert, division) {
  if (!Array.isArray(expert.tags)) return expert.tags;
  return expert.tags.filter(t => {
    if (typeof t !== 'string') return true;
    const s = t.toLowerCase();
    if (s === division || s === expert.sourceDivision) return false;
    return !isColorToken(t);
  });
}

function main() {
  const raw = JSON.parse(fs.readFileSync(SOURCE_JSON, 'utf8'));
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('源数据为空或格式错误');
  const fileIndex = fs.existsSync(AGENCY_REPO) ? buildDivisionFileIndex() : {};
  const usedFileIndex = Object.keys(fileIndex).length > 0;
  console.log(`[build-org] 源 ${raw.length} 位 | 源仓索引 ${usedFileIndex ? `可用(${Object.keys(fileIndex).length} 文件)` : '不可用(纯前缀兜底)'}`);

  const outExperts = [];
  const byDept = {};
  const byDivision = {};
  for (const expert of raw) {
    const division = resolveDivision(expert.id, fileIndex);
    byDivision[division] = (byDivision[division] || 0) + 1;
    const { dept, status, include } = resolveDivisionPolicy(division);
    // select 政策：id 命中 include 关键词 → 转正在编；未命中降为泊车
    let finalDept = dept;
    let finalStatus = status;
    if (status === 'select' && dept) {
      const hit = (include || []).some(kw => expert.id.toLowerCase().includes(kw.toLowerCase()));
      if (hit) finalStatus = 'active';
      else { finalDept = null; finalStatus = 'parked'; }
    }
    if (finalStatus === 'active' && finalDept) byDept[finalDept] = (byDept[finalDept] || 0) + 1;

    // tags 先去污再参与 cleanKeywords 兜底(防 division/颜色渗进 routingKeywords)
    const cleanTags = sanitizeTags(expert, division);
    outExperts.push({
      ...expert,
      tags: cleanTags,
      sourceDivision: division,
      department: finalDept,
      status: finalStatus,
      aliases: ROLE_ALIASES[expert.id] || [],
      routingKeywords: cleanKeywords({ ...expert, tags: cleanTags }),
    });
  }

  const active = outExperts.filter(e => e.status === 'active');
  const output = {
    _note: '部门化重组生成的专家组织数据(build-expert-org.js)——全量保留(泊车可显式召唤,不参与自动路由);人格文本原样透传',
    generatedAt: new Date().toISOString(),
    sourceRepo: fs.existsSync(AGENCY_REPO) ? AGENCY_REPO : '(不可用,前缀兜底)',
    counts: { total: outExperts.length, active: active.length, parked: outExperts.length - active.length, byDepartment: byDept },
    experts: outExperts,
  };
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(output, null, 1), 'utf8');

  console.log(`[build-org] 完成: 在编 ${active.length} / 泊车 ${outExperts.length - active.length}`);
  console.log('[build-org] 部门在编分布:', JSON.stringify(byDept));
  console.log('[build-org] division 分布:', JSON.stringify(byDivision));
  const unknownDiv = outExperts.filter(e => e.sourceDivision === 'unknown' && e.status === 'active');
  if (unknownDiv.length > 0) console.warn(`[build-org] ⚠ ${unknownDiv.length} 位 active 来路不明(unknown division):`, unknownDiv.map(e => e.id).slice(0, 5));
}

main();
