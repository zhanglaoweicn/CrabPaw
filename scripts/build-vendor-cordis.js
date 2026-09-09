/**
 * build-vendor-cordis.js — 将 vendor/*(TS 源码) 打包为 CJS 单产物
 *
 * Phase 0/1(2026-08-25): dsh 姿势源码宿敌——拥有框架层（可审计/可修补/锁版本）。
 * 产物:
 *   vendor/cordis/dist/cordis.cjs         — Cordis 核心 (Context/Fiber/Service/事件)
 *   vendor/cordis/dist/cordis-loader.cjs  — 装配层 (Loader/Include/Group + js-yaml 内闭)
 * 用法: node scripts/build-vendor-cordis.js
 */
const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const esbuild = path.join(ROOT, 'gui', 'node_modules', '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild');
const OUT_DIR = path.join(ROOT, 'vendor', 'cordis', 'dist');

const ALIAS = [
  '--alias:@deepseek-ai/cordis=' + path.join(ROOT, 'vendor', 'cordis', 'src', 'index.ts'),
  '--alias:@deepseek-ai/cosmokit=' + path.join(ROOT, 'vendor', 'cosmokit', 'src', 'index.ts'),
  '--alias:@deepseek-ai/cordis-plugin-loader=' + path.join(ROOT, 'vendor', 'loader', 'src', 'index.ts'),
  '--alias:@deepseek-ai/cordis-plugin-include=' + path.join(ROOT, 'vendor', 'include', 'src', 'index.ts'),
  '--alias:@deepseek-ai/cordis-plugin-group=' + path.join(ROOT, 'vendor', 'group', 'src', 'index.ts'),
];

function build(entry, outfile, extraAlias = []) {
  execFileSync(esbuild, [
    entry,
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--target=node18',
    `--outfile=${outfile}`,
    ...ALIAS,
    ...extraAlias,
  ], { stdio: 'inherit', shell: process.platform === 'win32' });
  console.log(`✅ ${path.relative(ROOT, outfile)}`);
}

build(path.join(ROOT, 'vendor', 'cordis', 'src', 'index.ts'), path.join(OUT_DIR, 'cordis.cjs'));
build(
  path.join(ROOT, 'vendor', 'assembler', 'src', 'index.ts'),
  path.join(OUT_DIR, 'cordis-loader.cjs'),
  // js-yaml 直接内闭（root node_modules 已有，bundle 进产物保证封闭）
  ['--alias:js-yaml=' + path.join(ROOT, 'node_modules', 'js-yaml', 'index.js')],
);
