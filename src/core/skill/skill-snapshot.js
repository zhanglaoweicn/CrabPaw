/**
 * skill-snapshot.js — Curator 快照与回滚引擎
 * Pre-run backup before any curator mutation. Supports rollback.
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config');
const { atomicWriteJSON } = require('../atomic-write');
const { getLogger } = require('../../core/logger');
const log = getLogger('core-skill-snapshot');

const SNAPSHOT_DIR = path.join(DATA_DIR, 'snapshots');
const MAX_SNAPSHOTS = 10;
const EXCLUDE_DIRS = new Set(['.crabpaw', 'node_modules', '.git', '__pycache__', '.locks', '.archive', '.curator_backups', '.hub']);

function _snapshotId() {
  return `snap-${new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '')}`;
}

function _copyRecursive(src, dest, cb) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (EXCLUDE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const s = path.join(src, entry.name), d = path.join(dest, entry.name);
    if (entry.isDirectory()) _copyRecursive(s, d, cb);
    else { fs.copyFileSync(s, d); if (cb) cb(d, s); }
  }
}

function _clearDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
    else fs.unlinkSync(p);
  }
}

function _listSnapshots() {
  if (!fs.existsSync(SNAPSHOT_DIR)) return [];
  return fs.readdirSync(SNAPSHOT_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name.startsWith('snap-'))
    .map(e => {
      const mf = path.join(SNAPSHOT_DIR, `${e.name}.manifest.json`);
      try { return { id: e.name, ...JSON.parse(fs.readFileSync(mf, 'utf-8')) }; }
      catch { return { id: e.name, createdAt: 'unknown' }; }
    })
    .sort((a, b) => b.id.localeCompare(a.id));
}

function createSnapshot(reason = 'pre-curator-run') {
  const { SKILLS_DIR, GLOBAL_SKILLS_DIR } = require('../config');
  if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const id = _snapshotId();
  const snapPath = path.join(SNAPSHOT_DIR, id);
  fs.mkdirSync(snapPath, { recursive: true });

  if (fs.existsSync(SKILLS_DIR)) _copyRecursive(SKILLS_DIR, path.join(snapPath, 'skills'));
  if (fs.existsSync(GLOBAL_SKILLS_DIR)) _copyRecursive(GLOBAL_SKILLS_DIR, path.join(snapPath, 'global'));

  atomicWriteJSON(path.join(SNAPSHOT_DIR, `${id}.manifest.json`), { id, createdAt: new Date().toISOString(), reason });

  const all = _listSnapshots();
  if (all.length > MAX_SNAPSHOTS) {
    for (const old of all.slice(MAX_SNAPSHOTS)) {
      const p = path.join(SNAPSHOT_DIR, old.id);
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
      try { fs.unlinkSync(path.join(SNAPSHOT_DIR, `${old.id}.manifest.json`)); } catch (e) { console.warn('[skill-snapshot] Failed to clean up old manifest:', e.message); }
    }
  }

  log.info(`[skill-snapshot] 快照 ${id}: ${reason}`);
  return { id, path: snapPath };
}

function rollbackToSnapshot(snapshotId) {
  const { SKILLS_DIR, GLOBAL_SKILLS_DIR } = require('../config');
  const snapPath = path.join(SNAPSHOT_DIR, snapshotId);
  if (!fs.existsSync(snapPath)) throw new Error(`快照 ${snapshotId} 不存在`);

  createSnapshot(`pre-rollback-to-${snapshotId}`);

  const skillsSnap = path.join(snapPath, 'skills');
  if (fs.existsSync(skillsSnap)) { _clearDir(SKILLS_DIR); _copyRecursive(skillsSnap, SKILLS_DIR); }
  const globalSnap = path.join(snapPath, 'global');
  if (fs.existsSync(globalSnap)) { _clearDir(GLOBAL_SKILLS_DIR); _copyRecursive(globalSnap, GLOBAL_SKILLS_DIR); }

  log.info(`[skill-snapshot] 回滚 ${snapshotId} 完成`);
  return { success: true, snapshotId };
}

function listSnapshots() { return _listSnapshots(); }

module.exports = { createSnapshot, rollbackToSnapshot, listSnapshots };
