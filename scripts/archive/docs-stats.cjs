#!/usr/bin/env node
/**
 * scripts/docs-stats.cjs — 文档数字实测脚本（无外部依赖，可复跑）
 *
 * 运行: node scripts/docs-stats.cjs（工作目录 d:\bossagent）
 *
 * 口径说明:
 *   - contractKeys   : src/core/tool-contract.js TOOL_CONTRACTS 的键数（含别名键）
 *   - contractUnique : 去重契约对象数 = new Set(Object.values(TOOL_CONTRACTS)).size
 *   - registryTools  : NODE_ENV=test 下 require src/tools（自注册副作用）后
 *                      registry.getNames().length（NODE_ENV=test 与 evals/index.js
 *                      相同原因：防 heartbeat patrol 触发 server.js 级联）
 *   - uncovered      : registry 工具名中无契约的清单（generateCoverageReport）
 *   - evalSuites     : evals/index.js 中 require('./test-cases/...') 的套件数
 *   - evalCases      : 各套件 module.exports.cases.length 之和（require 失败跳过并记录）
 *   - skills         : data/skills/ 下各子目录含 SKILL.md 的文件数；data/skills
 *                      不存在时回退统计 src/skills 及其子目录的 SKILL.md（见 skillsCaliber）
 *   - coveragePct    : generateCoverageReport(names).coverage
 */
'use strict';

const fs = require('fs');
const path = require('path');

// 必须先于任何 require 设置（与 evals/index.js 相同：ai.js:184 检查 NODE_ENV）
process.env.NODE_ENV = 'test';

const ROOT = path.resolve(__dirname, '..');

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name === 'SKILL.md') out.push(full);
  }
  return out;
}

// ── 1) 契约 ─────────────────────────────────────────────
const { TOOL_CONTRACTS, generateCoverageReport } = require(path.join(ROOT, 'src/core/tool-contract'));
const contractKeys = Object.keys(TOOL_CONTRACTS).length;
const contractUnique = new Set(Object.values(TOOL_CONTRACTS)).size;

// ── 2) 注册工具 ─────────────────────────────────────────
require(path.join(ROOT, 'src/tools')); // 模块自注册副作用
const { registry } = require(path.join(ROOT, 'src/tools/registry'));
const names = registry.getNames();
const registryTools = names.length;

// ── 3) 覆盖率 / 无契约清单 ──────────────────────────────
const coverageReport = generateCoverageReport(names);
const uncovered = coverageReport.uncovered;
const coveragePct = coverageReport.coverage;

// ── 4) Eval 套件与用例 ──────────────────────────────────
const evalIndexSrc = fs.readFileSync(path.join(ROOT, 'evals/index.js'), 'utf8');
const suiteFiles = [...evalIndexSrc.matchAll(/require\(['"]\.\/test-cases\/([^'"]+)['"]\)/g)].map((m) => m[1]);
const evalSuites = suiteFiles.length;
let evalCases = 0;
const evalSkipped = [];
for (const file of suiteFiles) {
  try {
    const mod = require(path.join(ROOT, 'evals/test-cases', file));
    const cases = mod && mod.cases;
    if (Array.isArray(cases)) {
      evalCases += cases.length;
    } else {
      evalSkipped.push(`${file}: no cases array (typeof ${typeof cases})`);
    }
  } catch (err) {
    evalSkipped.push(`${file}: require failed (${err.message})`);
  }
}

// ── 5) Skills ───────────────────────────────────────────
let skills = 0;
let skillsCaliber = '';
const dataSkillsDir = path.join(ROOT, 'data/skills');
if (fs.existsSync(dataSkillsDir)) {
  skillsCaliber = 'data/skills/*/SKILL.md';
  for (const entry of fs.readdirSync(dataSkillsDir, { withFileTypes: true })) {
    if (entry.isDirectory() && fs.existsSync(path.join(dataSkillsDir, entry.name, 'SKILL.md'))) {
      skills += 1;
    }
  }
} else {
  skillsCaliber = 'src/skills/**/SKILL.md (data/skills 不存在，回退口径)';
  skills = walk(path.join(ROOT, 'src/skills'), []).length;
}

// ── 输出（机器可读: label: value） ──────────────────────
console.log('contractKeys: ' + contractKeys);
console.log('contractUnique: ' + contractUnique);
console.log('registryTools: ' + registryTools);
console.log('uncoveredCount: ' + uncovered.length);
console.log('uncovered: ' + (uncovered.length ? uncovered.join(',') : '(none)'));
console.log('evalSuites: ' + evalSuites);
console.log('evalCases: ' + evalCases);
console.log('evalSkippedCount: ' + evalSkipped.length);
for (const s of evalSkipped) console.log('evalSkipped: ' + s);
console.log('skills: ' + skills);
console.log('skillsCaliber: ' + skillsCaliber);
console.log('coveragePct: ' + coveragePct);
