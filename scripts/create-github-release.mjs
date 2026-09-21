#!/usr/bin/env node
/**
 * create-github-release.mjs — 发版第三步：创建 GitHub Release 并上传便携包
 * 用法:
 *   node scripts/create-github-release.mjs <version> <notesFile> <zipPath> [--dry-run]
 * 流程: GCM 取 token → 创建 Release(tag=v版本, body=notes) → 流式上传 zip 资产 → size 校验
 * 说明: GitHub Releases 是应用内更新(updater.ts)的唯一数据源, 本脚本是"更新到 GitHub 即可"
 *      标准流程的落地件。大上传走 Node https(经验: curl 大上传收尾被掐必败)。
 */
import https from 'https';
import fs from 'fs';
import { execSync } from 'child_process';

const REPO = 'zhanglaoweicn/CrabPaw';

const args = process.argv.slice(2).filter(a => a !== '--dry-run');
const dryRun = process.argv.includes('--dry-run');
const [version, notesFile, zipPath] = args;
if (!version || !notesFile || !zipPath || !fs.existsSync(zipPath)) {
  console.error('用法: node scripts/create-github-release.mjs <version> <notesFile> <zipPath> [--dry-run]');
  process.exit(1);
}
const zipSize = fs.statSync(zipPath).size;
const notes = fs.readFileSync(notesFile, 'utf-8');
console.log(`版本: v${version}  资产: ${zipPath} (${(zipSize / 1048576).toFixed(1)} MB)`);

// GCM 取 token（git credential fill, 与 replace-release-asset.mjs 同款）
const cred = execSync('git credential fill', {
  input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8',
});
const token = cred.split('\n').find((l) => l.startsWith('password='))?.slice(9);
if (!token) { console.error('未取得 GitHub token'); process.exit(1); }
console.log('token: 已取得(' + token.slice(0, 6) + '...)');

function req(method, host, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const r = https.request({ host, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

if (dryRun) {
  console.log('[DRY-RUN] 将创建 Release: tag=v' + version + ', title=CrabPaw v' + version);
  console.log('[DRY-RUN] 将上传资产: ' + zipPath + ' (' + zipSize + ' bytes)');
  process.exit(0);
}

// 1) 创建 Release（tag 指向公开快照仓 main——发版前 release.ps1 已同步 main）
const createBody = JSON.stringify({
  tag_name: 'v' + version,
  target_commitish: 'main',
  name: 'CrabPaw v' + version,
  body: notes,
});
const created = await req('post', 'api.github.com', `/repos/${REPO}/releases`, {
  'User-Agent': 'crabpaw-release',
  Authorization: 'Bearer ' + token,
  'Content-Type': 'application/json',
  'Content-Length': Buffer.byteLength(createBody),
}, createBody);

if (created.status !== 201) {
  console.error('[FAIL] 创建 Release 失败: HTTP ' + created.status + '\n' + created.body.slice(0, 400));
  process.exit(1);
}
const release = JSON.parse(created.body);
console.log(`[OK] Release 创建: id=${release.id}, tag=${release.tag_name}`);

// 2) 上传 zip 资产（流式）
const uploadBase = release.upload_url.replace(/\{\?name,label\}$/, '');
const assetName = `CrabPaw-${version}-win64-Portable.zip`;
const upload = await new Promise((resolve, reject) => {
  const u = new URL(uploadBase + '?name=' + encodeURIComponent(assetName));
  const r = https.request({
    host: u.host, path: u.pathname + u.search, method: 'POST',
    headers: {
      'User-Agent': 'crabpaw-release',
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/zip',
      'Content-Length': zipSize,
    },
    timeout: 600000,
  }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
  });
  r.on('error', reject);
  r.setTimeout(600000, () => { r.destroy(); reject(new Error('上传超时(10min)')); });
  fs.createReadStream(zipPath).pipe(r);
});

if (upload.status !== 201) {
  console.error('[FAIL] 资产上传失败: HTTP ' + upload.status + '\n' + upload.body.slice(0, 400));
  process.exit(1);
}
const asset = JSON.parse(upload.body);
if (Number(asset.size) !== zipSize) {
  console.error(`[FAIL] 资产尺寸不一致: 远端 ${asset.size} vs 本地 ${zipSize}——删除资产并重试!`);
  await req('delete', 'api.github.com', `/repos/${REPO}/releases/assets/${asset.id}`, {
    'User-Agent': 'crabpaw-release', Authorization: 'Bearer ' + token,
  });
  process.exit(1);
}

console.log(`[OK] 资产上传: id=${asset.id}, name=${asset.name}, size=${asset.size} ✓ 校验一致`);
console.log(`[OK] Release 页面: ${release.html_url}`);
console.log('提醒: 应用内更新(updater)读 /releases/latest——正式发布(非 draft/prerelease)即对全部用户可见。');
