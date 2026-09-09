#!/usr/bin/env node
/**
 * check-layer-contract.js — 层契约闸门（P0-①, 2026-09-03）
 *
 * 背景（Pi/dsh 对标轮结论）：层边界此前只靠文档与自觉维持，core 层 27 个文件
 * 已反向依赖上层（如 ai.js require('../tools')——相当于 pi-agent-core import
 * pi-coding-agent，方向倒挂）。本闸门把"层只是层"编码进 CI：冻结存量
 * （baseline），禁止增量（新违规直接红，修一处收敛一处）。
 *
 * 规则：
 *   R1 core→upper        src/core/** 不得 require 上层顶层目录
 *                        （tools/handlers/channels/taskflow/schedule/datasources/cli）
 *   R2 loop-root→domain  src/core 根文件不得 require core 内应用域子目录
 *                        （evolution/perception/panels/scene——Loop 与产品域的界线，
 *                        迁移方向：事件反转/注册表注入，见 cordis 对标轮结论）
 *
 * 用法：
 *   node scripts/check-layer-contract.js            # 校验（CI/precommit）
 *   node scripts/check-layer-contract.js --update   # 重建 baseline（修完违规后收敛）
 *
 * 原则：新违规 → exit 1（改代码；扩 baseline 必须先消除违规再收敛）。
 *       baseline 中已消失的条目 → warning 提示 --update 收敛（不阻塞）。
 *       只做静态字面量 require/import 分析；动态 require 不在本闸门射程内。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');
const BASELINE_PATH = path.join(__dirname, 'layer-contract-baseline.json');

/** R1: core 禁止上探的顶层目录（应用/接入层资产） */
const FORBIDDEN_TOP = ['tools', 'handlers', 'channels', 'taskflow', 'schedule', 'datasources', 'cli'];
/** R2: core 根（Loop 层的家）禁止依赖的应用域子目录 */
const FORBIDDEN_CORE_DOMAINS = ['evolution', 'perception', 'panels', 'scene'];

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function listJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full === path.join(SRC_DIR, 'test')) continue;
      listJsFiles(full, out);
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
      out.push(full);
    }
  }
  return out;
}

/** 相对规格 → 仓内 posix 路径；解析不到（动态/包名/可选文件）返回 null */
function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')];
  for (const cand of candidates) {
    const st = fs.statSync(cand, { throwIfNoEntry: false });
    if (st && st.isFile()) return toPosix(path.relative(ROOT, cand));
  }
  return null;
}

function extractSpecs(content) {
  const specs = [];
  const requireRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  const importRe = /(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = requireRe.exec(content))) specs.push(m[1]);
  while ((m = importRe.exec(content))) specs.push(m[1]);
  return specs;
}

function classify(relFile, relTarget) {
  const hits = [];
  if (relFile.startsWith('src/core/')) {
    for (const top of FORBIDDEN_TOP) {
      if (relTarget === `src/${top}` || relTarget.startsWith(`src/${top}/`)) {
        hits.push({ rule: 'R1-core-to-upper', target: relTarget });
        break;
      }
    }
  }
  if (/^src\/core\/[^/]+\.js$/.test(relFile)) {
    for (const dom of FORBIDDEN_CORE_DOMAINS) {
      if (relTarget.startsWith(`src/core/${dom}/`)) {
        hits.push({ rule: 'R2-loop-root-to-domain', target: relTarget });
        break;
      }
    }
  }
  return hits;
}

function scanViolations() {
  const files = listJsFiles(SRC_DIR);
  const violations = new Map(); // key -> { file, rule, target }
  for (const file of files) {
    const relFile = toPosix(path.relative(ROOT, file));
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch (e) {
      console.warn(`[layer-contract] 读文件失败(跳过): ${relFile}: ${e.message}`);
      continue;
    }
    for (const spec of extractSpecs(content)) {
      const relTarget = resolveSpec(file, spec);
      if (!relTarget) continue;
      for (const hit of classify(relFile, relTarget)) {
        const key = `${relFile} :: ${hit.rule} :: ${hit.target}`;
        if (!violations.has(key)) violations.set(key, { file: relFile, rule: hit.rule, target: hit.target });
      }
    }
  }
  return { files: files.length, violations: [...violations.values()] };
}

function loadBaseline() {
  try {
    return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  } catch (e) {
    return { violations: [] };
  }
}

function main() {
  const update = process.argv.includes('--update');
  const { files, violations } = scanViolations();
  const keys = violations.map((v) => `${v.file} :: ${v.rule} :: ${v.target}`).sort();

  if (update) {
    const baseline = {
      generatedAt: new Date().toISOString(),
      note: '层契约闸门存量冻结清单——只减不增；扩条目=扩违规，须先改代码。重建: npm run layer:baseline',
      violations: keys,
    };
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`[layer-contract] baseline 已重建: ${keys.length} 条存量违规（扫描 ${files} 个文件）`);
    return 0;
  }

  const baseline = loadBaseline();
  const baselineSet = new Set(baseline.violations || []);
  const currentSet = new Set(keys);
  const fresh = keys.filter((k) => !baselineSet.has(k));
  const stale = [...baselineSet].filter((k) => !currentSet.has(k));

  const byRule = {};
  for (const v of violations) byRule[v.rule] = (byRule[v.rule] || 0) + 1;

  console.log(`[layer-contract] 扫描 ${files} 个文件：存量 ${keys.length} 条（baseline ${baselineSet.size} 条）`);
  for (const [rule, n] of Object.entries(byRule).sort()) console.log(`  ${rule}: ${n}`);

  if (stale.length > 0) {
    console.warn(`[layer-contract] ⚠ baseline 中 ${stale.length} 条违规已消失（修复生效），建议运行 npm run layer:baseline 收敛：`);
    for (const k of stale.slice(0, 10)) console.warn(`  - ${k}`);
  }

  if (fresh.length > 0) {
    console.error(`\n[layer-contract] ✗ ${fresh.length} 条新增层违规（冻结清单外）。修复方向：依赖反转/事件化/下沉注册表；确属 Phase 1 例外须先改代码再收敛 baseline：`);
    for (const k of fresh) console.error(`  + ${k}`);
    return 1;
  }

  console.log('[layer-contract] ✓ 无新增层违规');
  return 0;
}

process.exit(main());
