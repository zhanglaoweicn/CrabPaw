/**
 * BossProfileManager — 老板画像
 *
 * 从记忆（fact/preference/correction）聚合老板核心身份：
 * name/company/industry/role/teamSize/preferences/communicationStyle 七维白名单。
 * 稳定性加权：首次写入直接记录；覆写需同源信号 ≥2 次（防对话噪音污染画像）。
 * 持久化: data/.crabpaw/boss-profile.json（无敏感信息）。
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

const FIELD_WHITELIST = ['name', 'company', 'industry', 'role', 'teamSize', 'preferences', 'communicationStyle'];
const STABLE_THRESHOLD = 2; // 覆写已有字段需要的同值信号次数
const PROFILE_FILE = path.join(config.DATA_DIR, 'boss-profile.json');

// 提取器：fact/preference 内容 → 字段值（确定性规则，v1 不做 LLM 提取）
// 末组允许 $（行尾）以匹配无标点的短句，如 "我叫张伟"
const EXTRACTORS = [
  { field: 'name', match: /(?:我是|我叫|我是老板)?\s*([一-龥]{2,4})(?:老板|总|经理)?\s*(?:，|,|。|的|$)/, take: 1 },
  { field: 'company', match: /(?:在|开|经营|创办|管理|拥有)\s*([一-龥]{2,12})(?:公司|企业|工厂|店|餐饮|连锁)/, take: 0 },
  { field: 'industry', match: /(?:做|经营|搞|从事)\s*([一-龥]{2,8})(?:生意|行业|的|业务)/, take: 0 },
  { field: 'teamSize', match: /(?:有|共|大概|约)\s*(\d{1,3})\s*(?:个|名|人)/, take: 0 },
];

function extractFields(content) {
  const out = {};
  for (const ex of EXTRACTORS) {
    const m = String(content).match(ex.match);
    if (m && m[ex.take]) out[ex.field] = m[ex.take];
  }
  if (/(餐饮|饭店|火锅|快餐|连锁门店)/.test(content)) out.industry = '餐饮';
  else if (/(汽修|汽车服务|4S|维修保养)/.test(content)) out.industry = '汽修';
  else if (/(贸易|批发|商行)/.test(content)) out.industry = '贸易';
  return out;
}

function sanitize(profile) {
  const out = {};
  for (const k of FIELD_WHITELIST) if (profile[k] !== undefined) out[k] = profile[k];
  return out;
}

class BossProfileManager {
  constructor({ storageFile = PROFILE_FILE } = {}) {
    this._storageFile = storageFile;
    this._profile = this._load();
    this._signalCount = this._loadSignals();
  }

  _load() {
    try {
      if (!fs.existsSync(this._storageFile)) return {};
      return JSON.parse(fs.readFileSync(this._storageFile, 'utf8')) || {};
    } catch (e) {
      console.error('[boss-profile] 读取失败:', e.message || e);
      return {};
    }
  }

  _loadSignals() {
    try {
      const f = this._storageFile.replace(/\.json$/, '.signals.json');
      if (!fs.existsSync(f)) return {};
      return JSON.parse(fs.readFileSync(f, 'utf8')) || {};
    } catch (e) { console.error('[boss-profile] 信号计数读取失败:', e.message || e); return {}; }
  }

  _persist() {
    try {
      fs.mkdirSync(path.dirname(this._storageFile), { recursive: true });
      fs.writeFileSync(this._storageFile, JSON.stringify(this._profile, null, 2), 'utf8');
      const f = this._storageFile.replace(/\.json$/, '.signals.json');
      fs.writeFileSync(f, JSON.stringify(this._signalCount, null, 2), 'utf8');
    } catch (e) {
      console.error('[boss-profile] 持久化失败:', e.message || e);
    }
  }

  /** 注入一条记忆信号（fact/preference/correction，或直接 field-value 对） */
  ingest(memory) {
    try {
      if (!memory) return;

      // 直接 field-value 对（无 content 字段时视为直接赋值）
      if (typeof memory.content !== 'string') {
        const direct = sanitize(memory);
        for (const [field, value] of Object.entries(direct)) {
          const key = `${field}:${value}`;
          this._signalCount[key] = (this._signalCount[key] || 0) + 1;
          // 首次写入直接记录；覆写需 ≥ STABLE_THRESHOLD 次同值信号
          if (this._profile[field] === undefined || this._signalCount[key] >= STABLE_THRESHOLD) {
            if (this._profile[field] !== value) {
              this._profile[field] = value;
            }
          }
        }
        this._persist();
        return;
      }

      const extracted = extractFields(memory.content);
      for (const [field, value] of Object.entries(extracted)) {
        const key = `${field}:${value}`;
        this._signalCount[key] = (this._signalCount[key] || 0) + 1;
        // 首次写入直接记录；覆写需 ≥ STABLE_THRESHOLD 次同值信号
        if (this._profile[field] === undefined || this._signalCount[key] >= STABLE_THRESHOLD) {
          if (this._profile[field] !== value) {
            this._profile[field] = value;
          }
        }
      }
      // preference 型：直接并入 preferences 数组（白名单去重）
      if (memory.type === 'preference' && /(喜欢|偏好|习惯|不喜欢)/.test(memory.content)) {
        const prefs = Array.isArray(this._profile.preferences) ? this._profile.preferences : [];
        const brief = memory.content.slice(0, 60);
        if (!prefs.includes(brief)) prefs.push(brief);
        this._profile.preferences = prefs.slice(-10);
      }
      this._persist();
    } catch (e) {
      console.error('[boss-profile] ingest 失败:', e.message || e);
    }
  }

  getProfile() { return { ...this._profile }; }

  /** system prompt 固定段；空画像返回 '' */
  getIdentityBlock() {
    const p = this._profile;
    const parts = [];
    if (p.name) parts.push(`老板称呼: ${p.name}`);
    if (p.industry) parts.push(`行业: ${p.industry}`);
    if (p.company) parts.push(`公司: ${p.company}`);
    if (p.teamSize) parts.push(`团队规模: ${p.teamSize} 人`);
    if (p.role) parts.push(`角色: ${p.role}`);
    if (p.preferences && p.preferences.length) parts.push(`偏好: ${p.preferences.slice(0, 3).join('；')}`);
    if (parts.length === 0) return '';
    return `【老板画像】\n${parts.map((s) => `- ${s}`).join('\n')}\n`;
  }
}

const globalBossProfile = new BossProfileManager();
function getBossProfile() { return globalBossProfile; }

module.exports = { BossProfileManager, getBossProfile, extractFields };
