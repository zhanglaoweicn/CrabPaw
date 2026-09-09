/**
 * Cron 技能绑定管理器
 *
 * 让 Cron 任务可以附加一个或多个技能，运行时自动加载技能指令。
 * 技能按顺序加载，提示叠加在技能指令之上。
 *
 * 用法：
 *   const binder = new CronSkillBinder({ skillsDir: '/path/to/skills' });
 *   binder.attach(jobId, ['blogwatcher', 'data-analysis']);
 *   const prompt = binder.buildPrompt(jobId, 'Check feeds and summarize');
 */

const fs = require('fs');
const path = require('path');

class CronSkillBinder {
  constructor(config = {}) {
    this._skillsDir = config.skillsDir || '';
    this._bindings = new Map();   // jobId → { skills: [...], attachedAt }
    this._skillCache = new Map(); // skillName → { body, description }
  }

  // ─── 绑定操作 ─────────────────────────────────────────────

  /**
   * 为任务附加技能（替换已有列表）
   * @param {string} jobId
   * @param {string|string[]} skills 技能名列表
   */
  attach(jobId, skills) {
    const list = Array.isArray(skills) ? skills : [skills];
    this._validateSkills(list);
    this._bindings.set(jobId, {
      skills: list,
      attachedAt: Date.now(),
    });
    return { jobId, skills: list };
  }

  /**
   * 追加技能到已有列表
   */
  addSkill(jobId, skillName) {
    const binding = this._bindings.get(jobId);
    if (!binding) return this.attach(jobId, [skillName]);

    if (!binding.skills.includes(skillName)) {
      binding.skills.push(skillName);
    }
    return { jobId, skills: binding.skills };
  }

  /**
   * 从已有列表移除指定技能
   */
  removeSkill(jobId, skillName) {
    const binding = this._bindings.get(jobId);
    if (!binding) return null;

    binding.skills = binding.skills.filter(s => s !== skillName);
    if (binding.skills.length === 0) {
      this._bindings.delete(jobId);
    }
    return { jobId, skills: binding.skills || [] };
  }

  /**
   * 清除任务的所有技能绑定
   */
  clearSkills(jobId) {
    this._bindings.delete(jobId);
    return { jobId, skills: [] };
  }

  /**
   * 获取任务的技能列表
   */
  getSkills(jobId) {
    return this._bindings.get(jobId)?.skills || [];
  }

  // ─── 提示构建 ─────────────────────────────────────────────

  /**
   * 构建包含技能指令的完整提示
   * 技能按顺序加载，用户 prompt 叠加在最后
   * @param {string} jobId
   * @param {string} userPrompt 用户的任务指令
   * @returns {string} 完整提示文本
   */
  buildPrompt(jobId, userPrompt) {
    const skills = this.getSkills(jobId);
    if (skills.length === 0) return userPrompt;

    const parts = [];

    for (const skillName of skills) {
      const skillData = this._loadSkillContent(skillName);
      if (skillData) {
        parts.push(`## 技能: ${skillName}\n${skillData.description ? `> ${skillData.description}\n\n` : ''}${skillData.body}`);
      }
    }

    parts.push(`## 任务指令\n${userPrompt}`);

    return parts.join('\n\n---\n\n');
  }

  // ─── 序列化 ───────────────────────────────────────────────

  /**
   * 导出所有绑定（用于持久化）
   */
  toJSON() {
    const obj = {};
    for (const [jobId, binding] of this._bindings) {
      obj[jobId] = binding;
    }
    return obj;
  }

  /**
   * 从持久化数据恢复绑定
   */
  loadFromJSON(data) {
    if (!data || typeof data !== 'object') return;
    for (const [jobId, binding] of Object.entries(data)) {
      if (Array.isArray(binding.skills)) {
        this._bindings.set(jobId, binding);
      }
    }
  }

  // ─── 内部方法 ─────────────────────────────────────────────

  _validateSkills(skills) {
    for (const name of skills) {
      if (typeof name !== 'string' || !name.trim()) {
        throw new Error(`无效的技能名: "${name}"`);
      }
    }
  }

  _loadSkillContent(skillName) {
    if (this._skillCache.has(skillName)) {
      return this._skillCache.get(skillName);
    }

    if (!this._skillsDir) return null;

    // 尝试在 skills 目录下查找
    const skillDir = path.join(this._skillsDir, skillName);
    const skillMdPath = path.join(skillDir, 'SKILL.md');

    if (!fs.existsSync(skillMdPath)) return null;

    try {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      const { frontmatter, body } = this._parseFrontmatter(content);

      const data = {
        description: frontmatter.description || '',
        body: body.trim(),
      };

      this._skillCache.set(skillName, data);
      return data;
    } catch {
      return null;
    }
  }

  _parseFrontmatter(content) {
    const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    if (!match) {
      return { frontmatter: {}, body: content };
    }

    const frontmatter = {};
    for (const line of match[1].split('\n')) {
      const kv = line.match(/^(\w+):\s*(.+)$/);
      if (kv) {
        frontmatter[kv[1]] = kv[2].trim();
      }
    }

    return { frontmatter, body: match[2] };
  }
}

module.exports = { CronSkillBinder };
