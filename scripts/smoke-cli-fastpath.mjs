#!/usr/bin/env node
// CLI 快路径冒烟（2026-08-27）——验证 plugin/help/version 走轻量 boot 且功能正常; --full 恢复全量。
// 用法: node scripts/smoke-cli-fastpath.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli', 'index.js');
const FAST_MAX_MS = 5000; // 快路径验收: verify/list <5s

const run = (args, label) => {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000, windowsHide: true,
  });
  if (r.error) console.warn(`[${label}] spawn 错误: ${r.error.message}`);
  return { label, args, r, ms: Date.now() - t0 };
};

// 主 boot 标记(快路径必须全无)。注: 不能用裸 /🔌/——plugin-system.js 模块装载期
// 恒打「🔌 插件系统 v3 桥接就绪」(fast 与全量都有, 非 main() boot), 须锚定 main()
// 的英文句式「🔌 Starting plugin system」。
const BOOT_RE = /🧬|🔌 Starting plugin system|🧠|🎯|📡/;

const out = run(['plugin', 'verify', 'stock-data-source'], 'fast-verify');
const fastOut = out.r.stdout + out.r.stderr;
const hasHeavyBoot = BOOT_RE.test(fastOut);
const ok1 = out.r.status === 0 && !hasHeavyBoot && out.ms < FAST_MAX_MS
  && /✓ stock-data-source \[unsigned\]/.test(fastOut);

const outList = run(['plugin', 'list'], 'fast-list');
const listOut = outList.r.stdout + outList.r.stderr;
const listHeavy = BOOT_RE.test(listOut);
const ok2 = outList.r.status === 0 && !listHeavy && outList.ms < FAST_MAX_MS
  && /业务|memory-consistency/.test(listOut);

const outFull = run(['--full', 'plugin', 'list'], 'full-list');
const fullOut = outFull.r.stdout + outFull.r.stderr;
const ok3 = outFull.r.status === 0 && (BOOT_RE.test(fullOut) || /📦 插件装配/.test(fullOut));

const outHelp = run(['--help'], 'fast-help');
const helpOut = outHelp.r.stdout + outHelp.r.stderr;
const ok4 = outHelp.r.status === 0 && !BOOT_RE.test(helpOut)
  && outHelp.ms < FAST_MAX_MS && /用法:/.test(helpOut);

console.log(`[smoke-cli-fastpath] verify=${ok1 ? 'OK' : 'FAIL'} (${out.ms}ms) list=${ok2 ? 'OK' : 'FAIL'} (${outList.ms}ms) full=${ok3 ? 'OK' : 'FAIL'} (${outFull.ms}ms) help=${ok4 ? 'OK' : 'FAIL'} (${outHelp.ms}ms)`);
console.log(ok1 && ok2 && ok3 && ok4 ? '✅ 快路径冒烟通过' : '❌ 存在失败项（fast boot 日志如下）');
if (!ok1) console.log(fastOut.slice(-1200));
if (!ok2) console.log(listOut.slice(-1200));
if (!ok3) console.log(fullOut.slice(-1200));
process.exit(ok1 && ok2 && ok3 && ok4 ? 0 : 1);
