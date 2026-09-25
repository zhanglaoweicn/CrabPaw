/**
 * sync-snapshot.mjs — 公开快照仓精确同步(2026-09-25)
 *
 * 为什么不用 tar 整树覆盖: 原 release.ps1 走 `git archive + tar -xf`, 在 Windows 下
 * 会把中文文件名写成 GBK/UTF-8 乱码副本(公开仓实测积了 18 个乱码名重复文件, 正确
 * 命名的同名文件也都在, 属纯垃圾), 且整树覆盖不会删除源码仓已删的文件(陈旧残留)。
 * 本脚本改为按 blob 哈希逐文件比对, 只做三件事:
 *   ① 复制「源码仓有而快照仓无」或「同名但哈希不同」的文件
 *   ② 删除「快照仓有而源码仓无」的文件
 *   ③ 清理删除后留下的空目录
 * 不整树覆盖故无编码风险、无陈旧残留; 可用 --apply 前先看演练输出确认改动范围。
 *
 * 用法:
 *   node scripts/sync-snapshot.mjs [--apply] [--src=<源码仓>] [--snap=<快照仓>]
 *   默认 src=本仓根, snap=$CRABPAW_SNAPSHOT_DIR 或 D:/linker-publish
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_SRC = path.resolve(SCRIPT_DIR, '..')

const argOf = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const SRC = path.resolve(argOf('src', DEFAULT_SRC)).replace(/\\/g, '/')
const SNAP = path.resolve(argOf('snap', process.env.CRABPAW_SNAPSHOT_DIR || 'D:/linker-publish')).replace(/\\/g, '/')
const APPLY = process.argv.includes('--apply')

if (!fs.existsSync(path.join(SNAP, '.git'))) {
  console.error(`[FAIL] 快照仓不存在或不是 git 仓: ${SNAP}`)
  process.exit(1)
}

/**
 * 读 HEAD 树为 Map<相对路径(latin1 字节保真字符串), blob哈希>
 * NUL 分隔 + latin1 是为规避非 UTF-8 文件名的解码歧义: latin1 与字节一一对应,
 * 还原真实路径用 Buffer.from(key, 'latin1')。键必须用字符串——Buffer 作 Map 键
 * 按引用比较恒不相等(本脚本首版踩过, 误判"全部文件都需复制")。
 */
function readTree(cwd) {
  const buf = execFileSync('git', ['ls-tree', '-r', '-z', 'HEAD'], {
    cwd, maxBuffer: 512 * 1024 * 1024,
  })
  const map = new Map()
  for (const entry of buf.toString('latin1').split('\0')) {
    if (!entry) continue
    const tab = entry.indexOf('\t')
    if (tab < 0) continue
    map.set(entry.slice(tab + 1), entry.slice(0, tab).split(' ')[2])
  }
  return map
}

const src = readTree(SRC)
const snap = readTree(SNAP)

const toCopy = []
for (const [p, hash] of src) {
  if (snap.get(p) !== hash) toCopy.push(p)
}
const toDelete = []
for (const p of snap.keys()) {
  if (!src.has(p)) toDelete.push(p)
}

const fmt = (k) => Buffer.from(k, 'latin1').toString('utf8')
console.log(`源码仓 ${SRC} → ${src.size} 文件`)
console.log(`快照仓 ${SNAP} → ${snap.size} 文件`)
console.log(`\n[复制] ${toCopy.length} 个`)
toCopy.forEach((k) => console.log('  ' + fmt(k)))
console.log(`\n[删除] ${toDelete.length} 个`)
toDelete.forEach((k) => console.log('  ' + fmt(k)))

if (!APPLY) {
  console.log('\n(演练模式——加 --apply 才落盘)')
  process.exit(0)
}

const srcRoot = Buffer.from(SRC + '/', 'utf8')
const snapRoot = Buffer.from(SNAP + '/', 'utf8')

for (const k of toCopy) {
  const rel = Buffer.from(k, 'latin1')
  const to = Buffer.concat([snapRoot, rel])
  fs.mkdirSync(path.dirname(to.toString('utf8')), { recursive: true })
  fs.copyFileSync(Buffer.concat([srcRoot, rel]), to)
}
console.log(`\n[ok] 已复制 ${toCopy.length} 个文件`)

let deleted = 0
for (const k of toDelete) {
  try {
    fs.unlinkSync(Buffer.concat([snapRoot, Buffer.from(k, 'latin1')]))
    deleted++
  } catch (e) {
    console.warn('  删除失败:', fmt(k), e.code || e.message)
  }
}
console.log(`[ok] 已删除 ${deleted}/${toDelete.length} 个文件`)

function pruneEmptyDirs(dir) {
  let removed = 0
  for (const name of fs.readdirSync(dir)) {
    if (name === '.git') continue
    const full = path.join(dir, name)
    if (!fs.statSync(full).isDirectory()) continue
    removed += pruneEmptyDirs(full)
    if (fs.readdirSync(full).length === 0) { fs.rmdirSync(full); removed++ }
  }
  return removed
}
console.log(`[ok] 清理空目录 ${pruneEmptyDirs(SNAP)} 个`)
