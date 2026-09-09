#!/usr/bin/env node
/**
 * harness-facts.js — 结构性事实生成（P0-③, dsh 对标机制⑤, 2026-09-03）
 *
 * 背景：HARNESS.md/AGENTS.md 中的数字此前靠手改，已实测漂移（宣称 209 主键 /
 * 52 套件 / 418 用例 / PROMPT_VERSION 3.0.0，实测 233 / 54 / 434 / 代码无常量）。
 * 本脚本从单一事实源（代码）生成数字块写入两份文档的标记区，并提供 --check
 * 把"文档数字 = 代码真值"变成 CI/precommit 门槛——治理从文档编码进机器。
 *
 * 事实源：
 *   - 工具契约:   src/core/tool-contract.js → TOOL_CONTRACTS / LEGACY_*_ALIASES
 *   - 审计事件:   src/core/audit-log-v2.js → AUDIT_EVENTS
 *   - Eval 规模:  evals/suite-registry.js → suites[].cases
 *   - 提示词版本: src/core/system-prompt.js 的 PROMPT_VERSION 常量（不存在则如实标注"未检出"）
 *
 * 用法：
 *   node scripts/harness-facts.js           # 打印 JSON
 *   node scripts/harness-facts.js --write   # 更新 AGENTS.md / HARNESS.md 的生成块
 *   node scripts/harness-facts.js --check   # 校验生成块与代码一致（exit 1 = 漂移）
 *
 * 注意：事实源 require 链会留打开句柄（watcher/定时器），结束必须显式 process.exit。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DOC_FILES = ['AGENTS.md', 'HARNESS.md'];
const BEGIN_RE = /<!-- BEGIN GENERATED: harness-facts[\s\S]*?<!-- END GENERATED: harness-facts -->/;

function warnFact(name, e) {
  process.stderr.write(`[harness-facts] ⚠ 事实源 ${name} 不可用(${e.message})——该项将标"未检出"\n`);
}

function collectFacts() {
  const facts = { errors: [] };

  try {
    const t = require('../src/core/tool-contract');
    const primary = Object.keys(t.TOOL_CONTRACTS || {}).length;
    const snake = Object.keys(t.LEGACY_SNAKE_ALIASES || {}).length;
    const kebab = Object.keys(t.LEGACY_KEBAB_ALIASES || {}).length;
    facts.toolContracts = { primary, snake, kebab, aliases: snake + kebab, total: primary + snake + kebab };
  } catch (e) {
    facts.toolContracts = null;
    facts.errors.push('tool-contract');
    warnFact('tool-contract', e);
  }

  try {
    const a = require('../src/core/audit-log-v2');
    facts.auditEventTypes = a.AUDIT_EVENTS ? Object.keys(a.AUDIT_EVENTS).length : null;
    if (!facts.auditEventTypes) throw new Error('AUDIT_EVENTS 未导出');
  } catch (e) {
    facts.auditEventTypes = null;
    facts.errors.push('audit-log-v2');
    warnFact('audit-log-v2', e);
  }

  try {
    const reg = require('../evals/suite-registry');
    const suites = Array.isArray(reg.suites) ? reg.suites.length : 0;
    const cases = reg.suites.reduce((acc, s) => acc + ((s && Array.isArray(s.cases) && s.cases.length) || 0), 0);
    facts.evals = { suites, cases };
  } catch (e) {
    facts.evals = null;
    facts.errors.push('suite-registry');
    warnFact('suite-registry', e);
  }

  try {
    const srcText = fs.readFileSync(path.join(ROOT, 'src/core/system-prompt.js'), 'utf8');
    const m = srcText.match(/PROMPT_VERSION\s*=\s*['"]([^'"]+)['"]/);
    facts.promptVersion = m ? m[1] : null;
  } catch (e) {
    facts.promptVersion = null;
    facts.errors.push('system-prompt');
    warnFact('system-prompt', e);
  }

  return facts;
}

function buildBlock(facts) {
  const tc = facts.toolContracts;
  const ev = facts.evals;
  const ae = facts.auditEventTypes;
  const pv = facts.promptVersion;
  const na = '未检出';
  const rows = [
    '| 事实 | 实测值 | 单一事实源 |',
    '|---|---|---|',
    `| 工具契约主键 | ${tc ? tc.primary : na} | src/core/tool-contract.js → TOOL_CONTRACTS |`,
    `| 契约遗留别名 | ${tc ? `${tc.aliases}（snake ${tc.snake} + kebab ${tc.kebab}）` : na} | 同上 → LEGACY_SNAKE/KEBAB_ALIASES |`,
    `| 契约键合计 | ${tc ? tc.total : na} | 上两行之和 |`,
    `| 审计事件类型 | ${ae ?? na} | src/core/audit-log-v2.js → AUDIT_EVENTS |`,
    `| Eval 套件 / 用例 | ${ev ? `${ev.suites} / ${ev.cases}` : na} | evals/suite-registry.js |`,
    `| PROMPT_VERSION | ${pv || '未检出（代码中无常量，版本记录见 HARNESS.md 提示词版本表）'} | src/core/system-prompt.js |`,
  ];
  return [
    '<!-- BEGIN GENERATED: harness-facts (scripts/harness-facts.js — npm run facts:write 更新 / facts:check 校验; 请勿手改数字) -->',
    ...rows,
    `<!-- 生成时间: ${new Date().toISOString()} -->`,
    '<!-- END GENERATED: harness-facts -->',
  ].join('\n');
}

/** 生成块中可比较的部分（行级, 不含时间戳行） */
function comparableRows(blockText) {
  return blockText
    .split('\n')
    .filter((l) => l.startsWith('| ') && !l.startsWith('|---'))
    .map((l) => l.trim())
    .join('\n');
}

function main() {
  const mode = process.argv.includes('--write') ? 'write' : process.argv.includes('--check') ? 'check' : 'print';
  const facts = collectFacts();

  if (mode === 'print') {
    console.log(JSON.stringify(facts, null, 2));
    return 0;
  }

  const expectedBlock = buildBlock(facts);
  let failed = false;

  for (const doc of DOC_FILES) {
    const docPath = path.join(ROOT, doc);
    let text;
    try {
      text = fs.readFileSync(docPath, 'utf8');
    } catch (e) {
      console.error(`[harness-facts] ✗ 文档读取失败: ${doc}: ${e.message}`);
      failed = true;
      continue;
    }

    if (mode === 'write') {
      if (!BEGIN_RE.test(text)) {
        console.error(`[harness-facts] ✗ ${doc} 缺少生成块标记（BEGIN/END GENERATED: harness-facts），请先手动放置标记对`);
        failed = true;
        continue;
      }
      fs.writeFileSync(docPath, text.replace(BEGIN_RE, expectedBlock));
      console.log(`[harness-facts] ✓ 已更新 ${doc} 生成块`);
      continue;
    }

    // check
    const m = text.match(BEGIN_RE);
    if (!m) {
      console.error(`[harness-facts] ✗ ${doc} 缺少生成块标记（BEGIN/END GENERATED: harness-facts）`);
      failed = true;
      continue;
    }
    const actualRows = comparableRows(m[0]);
    const expectedRows = comparableRows(expectedBlock);
    if (actualRows === expectedRows) {
      console.log(`[harness-facts] ✓ ${doc} 与代码真值一致`);
    } else {
      failed = true;
      console.error(`[harness-facts] ✗ ${doc} 数字与代码漂移（npm run facts:write 修正）：`);
      const actualLines = actualRows.split('\n');
      const expectedLines = expectedRows.split('\n');
      for (let i = 0; i < Math.max(actualLines.length, expectedLines.length); i++) {
        if (actualLines[i] !== expectedLines[i]) {
          console.error(`  文档: ${actualLines[i] || '(缺行)'}`);
          console.error(`  真值: ${expectedLines[i] || '(多行)'}`);
        }
      }
    }
  }

  return failed ? 1 : 0;
}

const code = main();
// 事实源 require 链会留打开句柄（eval 用例模块的 watcher/定时器）, 显式退出
process.exit(code);
