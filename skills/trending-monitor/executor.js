/**
 * trending-monitor — 热度追踪与趋势报告
 * 用法：execute({ action: 'snapshot'|'compare'|'weekly', platform?: 'all' })
 * 历史数据存 data/.crabpaw/trending-history/<yyyy-mm-dd>.json
 */
const fs = require('fs');
const path = require('path');
const config = require('../../src/core/config');
const { fetchAllTrending } = require('../../src/core/trending-scraper');

const HISTORY_DIR = path.join(config.DATA_DIR, '.crabpaw', 'trending-history');

function ensureDir() { fs.mkdirSync(HISTORY_DIR, { recursive: true }); }

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function snapshot() {
  ensureDir();
  const results = await fetchAllTrending();
  const file = path.join(HISTORY_DIR, `${todayKey()}.json`);
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {};
  const merged = {};
  for (const key of Object.keys(results)) {
    merged[key] = { fetchedAt: Date.now(), items: results[key].items || [] };
  }
  fs.writeFileSync(file, JSON.stringify({ ...existing, ...merged }, null, 2));
  return { success: true, file, platforms: Object.keys(merged), itemCount: Object.values(merged).reduce((n, v) => n + v.items.length, 0) };
}

function compare() {
  ensureDir();
  const files = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith('.json')).sort();
  if (files.length < 2) return { success: false, error: '历史数据不足（至少需要 2 天快照）' };
  const prev = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, files[files.length - 2]), 'utf-8'));
  const curr = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, files[files.length - 1]), 'utf-8'));
  const lines = [];
  for (const platform of Object.keys(curr)) {
    const prevItems = (prev[platform]?.items || []).map(i => i.title);
    const currItems = curr[platform]?.items || [];
    const rises = currItems.filter(i => !prevItems.includes(i.title)).slice(0, 10);
    if (rises.length > 0) lines.push(`【${platform}】新上榜：${rises.map(i => i.title).join('、')}`);
  }
  return { success: true, content: lines.length > 0 ? lines.join('\n') : '无显著变化', prevFile: files[files.length - 2], currFile: files[files.length - 1] };
}

function weekly() {
  ensureDir();
  const files = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith('.json')).sort().slice(-7);
  if (files.length === 0) return { success: false, error: '没有历史数据，先执行 snapshot' };
  const platforms = {};
  for (const f of files) {
    const data = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), 'utf-8'));
    for (const platform of Object.keys(data)) {
      for (const item of data[platform].items || []) {
        if (!platforms[platform]) platforms[platform] = {};
        platforms[platform][item.title] = (platforms[platform][item.title] || 0) + 1;
      }
    }
  }
  const lines = [];
  for (const platform of Object.keys(platforms)) {
    const top = Object.entries(platforms[platform]).sort((a, b) => b[1] - a[1]).slice(0, 10);
    lines.push(`【${platform}】本周高频：${top.map(([title, count]) => `${title}(${count}次)`).join('、')}`);
  }
  return { success: true, content: lines.join('\n'), daysCovered: files.length };
}

async function execute(params = {}) {
  const action = params.action || 'snapshot';
  try {
    if (action === 'snapshot') return await snapshot();
    if (action === 'compare') return compare();
    if (action === 'weekly') return weekly();
    return { success: false, error: `未知动作: ${action}（支持 snapshot/compare/weekly）` };
  } catch (err) {
    console.error('[trending-monitor] 失败:', err);
    return { success: false, error: `热度追踪失败: ${err.message}` };
  }
}

module.exports = { execute };
