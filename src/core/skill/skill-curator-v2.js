const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
// eslint-disable-next-line no-unused-vars
const { isCuratorEligible, isPinned, getSkillOrigin, PROVENANCE_SOURCES } = require('./skill-provenance');
// eslint-disable-next-line no-unused-vars
const { bumpUse, bumpView, bumpPatch, getRecord, latestActivityAt, agentCreatedReport, LIFECYCLE_STATES } = require('./skill-usage-telemetry');
const evolutionGraph = require('./skill-evolution-graph');

const CURATOR_V2_STATES = {
  DRAFT: 'draft',
  ACTIVE: 'active',
  STALE: 'stale',
  ARCHIVED: 'archived',
  PINNED: 'pinned',
  UNDER_REVIEW: 'under_review',
  CONSOLIDATED: 'consolidated',
};

const STATE_TRANSITIONS = {
  [CURATOR_V2_STATES.DRAFT]: [CURATOR_V2_STATES.ACTIVE, CURATOR_V2_STATES.ARCHIVED],
  [CURATOR_V2_STATES.ACTIVE]: [CURATOR_V2_STATES.STALE, CURATOR_V2_STATES.PINNED, CURATOR_V2_STATES.ARCHIVED, CURATOR_V2_STATES.UNDER_REVIEW],
  [CURATOR_V2_STATES.STALE]: [CURATOR_V2_STATES.ACTIVE, CURATOR_V2_STATES.ARCHIVED, CURATOR_V2_STATES.UNDER_REVIEW],
  [CURATOR_V2_STATES.ARCHIVED]: [CURATOR_V2_STATES.ACTIVE],
  [CURATOR_V2_STATES.PINNED]: [CURATOR_V2_STATES.ACTIVE],
  [CURATOR_V2_STATES.UNDER_REVIEW]: [CURATOR_V2_STATES.ACTIVE, CURATOR_V2_STATES.CONSOLIDATED, CURATOR_V2_STATES.ARCHIVED],
  [CURATOR_V2_STATES.CONSOLIDATED]: [CURATOR_V2_STATES.ARCHIVED],
};

const DEFAULT_INTERVAL_HOURS = 168;
const DEFAULT_MIN_IDLE_HOURS = 2;
const DEFAULT_STALE_AFTER_DAYS = 30;
const DEFAULT_ARCHIVE_AFTER_DAYS = 90;
const REVIEW_MAX_SKILLS = 20;


class CuratorState {
  constructor(data = {}) {
    this.lastRunAt = data.lastRunAt || null;
    this.lastRunDuration = data.lastRunDuration || 0;
    this.lastRunSummary = data.lastRunSummary || null;
    this.lastRunSummaryShownAt = data.lastRunSummaryShownAt || null;
    this.lastReportPath = data.lastReportPath || null;
    this.paused = data.paused || false;
    this.runCount = data.runCount || 0;
    this.totalSkillsReviewed = data.totalSkillsReviewed || 0;
    this.totalActions = data.totalActions || 0;
  }

  toJSON() {
    return {
      lastRunAt: this.lastRunAt,
      lastRunDuration: this.lastRunDuration,
      lastRunSummary: this.lastRunSummary,
      lastRunSummaryShownAt: this.lastRunSummaryShownAt,
      lastReportPath: this.lastReportPath,
      paused: this.paused,
      runCount: this.runCount,
      totalSkillsReviewed: this.totalSkillsReviewed,
      totalActions: this.totalActions,
    };
  }

  static fromJSON(data) {
    return new CuratorState(data);
  }
}

class CuratorReviewResult {
  constructor(data = {}) {
    this.skillName = data.skillName || '';
    this.action = data.action || 'keep';
    this.rationale = data.rationale || '';
    this.suggestedChanges = data.suggestedChanges || null;
    this.newState = data.newState || null;
    this.consolidateTarget = data.consolidateTarget || null;
    this.patchContent = data.patchContent || null;
  }
}

class SkillCuratorV2 extends EventEmitter {
  constructor(opts = {}) {
    super();
    this._state = new CuratorState();
    this._intervalHours = opts.intervalHours || DEFAULT_INTERVAL_HOURS;
    this._minIdleHours = opts.minIdleHours || DEFAULT_MIN_IDLE_HOURS;
    this._staleAfterDays = opts.staleAfterDays || DEFAULT_STALE_AFTER_DAYS;
    this._archiveAfterDays = opts.archiveAfterDays || DEFAULT_ARCHIVE_AFTER_DAYS;
    this._running = false;
    this._reviewTimer = null;
    this._skillsDir = opts.skillsDir || null;
    this._auxClient = opts.auxClient || null;
    this._stateFile = opts.stateFile || null;
    this._loadState();
  }

  async initialize() {
    this._startReviewTimer();
    this.emit('initialized', { intervalHours: this._intervalHours });
  }

  _startReviewTimer() {
    if (this._reviewTimer) clearInterval(this._reviewTimer);
    const intervalMs = this._intervalHours * 3600000;
    this._reviewTimer = setInterval(() => {
      this.maybeRun();
    }, intervalMs);
  }

  async maybeRun() {
    if (this._state.paused) return;
    if (this._running) return;

    const lastRun = this._state.lastRunAt ? new Date(this._state.lastRunAt).getTime() : 0;
    const elapsed = Date.now() - lastRun;
    const intervalMs = this._intervalHours * 3600000;

    if (elapsed < intervalMs) return;

    await this.runReview();
  }

  async runReview() {
    if (this._running) return;
    this._running = true;
    const startTime = Date.now();

    this.emit('review_started', { runCount: this._state.runCount + 1 });

    try {
      // Pre-run snapshot：curator 操作前创建快照
      try {
        const { createSnapshot } = require('./skill-snapshot');
        createSnapshot('pre-curator-run');
      } catch (_) { console.warn('[skill-curator-v2] Pre-run snapshot failed:', _.message); }

      const transitionResults = this.applyAutomaticTransitions();
      const reviewResults = await this._performDeepReview();

      this._state.lastRunAt = new Date().toISOString();
      this._state.lastRunDuration = Date.now() - startTime;
      this._state.lastRunSummary = this._buildSummary(transitionResults, reviewResults);
      this._state.runCount++;
      this._state.totalSkillsReviewed += transitionResults.checked || 0;
      this._state.totalActions += (transitionResults.archived || 0) + (transitionResults.markedStale || 0) + reviewResults.length;

      this._saveState();

      this.emit('review_completed', {
        duration: this._state.lastRunDuration,
        summary: this._state.lastRunSummary,
        transitions: transitionResults,
        reviews: reviewResults.length,
      });

      return { transitions: transitionResults, reviews: reviewResults };
    } catch (e) {
      this.emit('review_error', { error: e.message });
      throw e;
    } finally {
      this._running = false;
    }
  }

  applyAutomaticTransitions(now = null) {
    if (!now) now = new Date();

    const staleCutoff = new Date(now.getTime() - this._staleAfterDays * 86400000);
    const archiveCutoff = new Date(now.getTime() - this._archiveAfterDays * 86400000);

    const counts = {
      markedStale: 0,
      archived: 0,
      reactivated: 0,
      checked: 0,
      pinned: 0,
      underReview: 0,
    };

    const agentSkills = this._listAgentCreatedSkills();

    for (const skill of agentSkills) {
      counts.checked++;

      if (skill.state === CURATOR_V2_STATES.PINNED) {
        counts.pinned++;
        continue;
      }

      const lastActivity = skill.lastActivity ? new Date(skill.lastActivity) : null;
      const createdAt = skill.createdAt ? new Date(skill.createdAt) : now;
      const anchor = lastActivity || createdAt;
      const currentState = skill.state || CURATOR_V2_STATES.ACTIVE;

      if (anchor <= archiveCutoff && currentState !== CURATOR_V2_STATES.ARCHIVED) {
        if (this._canTransition(currentState, CURATOR_V2_STATES.ARCHIVED)) {
          this._setSkillState(skill.name, CURATOR_V2_STATES.ARCHIVED);
          counts.archived++;
          this.emit('skill_archived', { name: skill.name, reason: 'idle', previousState: currentState });
        }
      } else if (anchor <= staleCutoff && currentState === CURATOR_V2_STATES.ACTIVE) {
        if (this._canTransition(currentState, CURATOR_V2_STATES.STALE)) {
          this._setSkillState(skill.name, CURATOR_V2_STATES.STALE);
          counts.markedStale++;
          this.emit('skill_stale', { name: skill.name, reason: 'idle' });
        }
      } else if (anchor > staleCutoff && currentState === CURATOR_V2_STATES.STALE) {
        if (this._canTransition(currentState, CURATOR_V2_STATES.ACTIVE)) {
          this._setSkillState(skill.name, CURATOR_V2_STATES.ACTIVE);
          counts.reactivated++;
          this.emit('skill_reactivated', { name: skill.name });
        }
      }
    }

    return counts;
  }

  async _performDeepReview() {
    const staleSkills = this._listSkillsByState(CURATOR_V2_STATES.STALE);
    const underReviewSkills = this._listSkillsByState(CURATOR_V2_STATES.UNDER_REVIEW);

    const candidates = [...staleSkills, ...underReviewSkills].slice(0, REVIEW_MAX_SKILLS);
    const results = [];

    // Phase 1: Individual skill review
    for (const skill of candidates) {
      const review = await this._reviewSkill(skill);
      results.push(review);

      if (review.action === 'archive' && review.newState) {
        this._setSkillState(skill.name, review.newState);
        this.emit('skill_reviewed', { name: skill.name, action: review.action, rationale: review.rationale });
      } else if (review.action === 'consolidate' && review.consolidateTarget) {
        this._setSkillState(skill.name, CURATOR_V2_STATES.CONSOLIDATED);
        this.emit('skill_consolidated', { name: skill.name, target: review.consolidateTarget });
      } else if (review.action === 'patch' && review.patchContent) {
        this._applyPatch(skill.name, review.patchContent);
        this.emit('skill_patched', { name: skill.name });
      } else if (review.action === 'pin') {
        this._setSkillState(skill.name, CURATOR_V2_STATES.PINNED);
        this.emit('skill_pinned_by_review', { name: skill.name });
      }
    }

    // Phase 2: Evolution graph-driven consolidation
    const consolidationResults = await this._performEvolutionConsolidation();
    results.push(...consolidationResults);

    return results;
  }

  async _performEvolutionConsolidation() {
    const recommendations = evolutionGraph.getEvolutionRecommendations();
    const results = [];

    for (const rec of recommendations) {
      if (rec.type === 'consolidate' && rec.skills && rec.skills.length >= 2) {
        const proposals = this.proposeUmbrellaConsolidation();
        const matching = proposals.find(p => rec.skills.includes(p.umbrella) || rec.skills.some(s => s.startsWith(p.prefix)));

        if (matching) {
          const result = new CuratorReviewResult({
            skillName: matching.umbrella,
            action: 'consolidate',
            rationale: matching.rationale,
            consolidateTarget: matching.umbrella,
          });

          // Mark sibling skills as consolidated
          for (const sibling of matching.siblings) {
            this._setSkillState(sibling, CURATOR_V2_STATES.CONSOLIDATED);
            evolutionGraph.addEdge(sibling, matching.umbrella, evolutionGraph.EVOLUTION_RELATIONS.MERGED_INTO, {
              consolidationReason: 'curator_evolution_consolidation',
            });
          }

          // Record in evolution graph
          evolutionGraph.recordConsolidation(matching.siblings, matching.umbrella);

          results.push(result);
          this.emit('skill_evolution_consolidation', {
            umbrella: matching.umbrella,
            siblings: matching.siblings,
            prefix: matching.prefix,
          });
        }
      } else if (rec.type === 'archive_or_replace' && rec.skills) {
        for (const skillName of rec.skills) {
          this._setSkillState(skillName, CURATOR_V2_STATES.ARCHIVED);
          results.push(new CuratorReviewResult({
            skillName,
            action: 'archive',
            rationale: rec.rationale,
            newState: CURATOR_V2_STATES.ARCHIVED,
          }));
          this.emit('skill_low_fitness_archived', { name: skillName, rationale: rec.rationale });
        }
      } else if (rec.type === 'replace' && rec.skills) {
        for (const skillName of rec.skills) {
          this._setSkillState(skillName, CURATOR_V2_STATES.UNDER_REVIEW);
          results.push(new CuratorReviewResult({
            skillName,
            action: 'keep',
            rationale: rec.rationale + ' (marked for rewrite)',
          }));
          this.emit('skill_replace_candidate', { name: skillName, rationale: rec.rationale });
        }
      }
    }

    return results;
  }

  async _reviewSkill(skill) {
    const result = new CuratorReviewResult({
      skillName: skill.name,
      action: 'keep',
      rationale: 'No issues found',
    });

    const lastActivity = skill.lastActivity ? new Date(skill.lastActivity) : null;
    const daysSinceActivity = lastActivity
      ? (Date.now() - lastActivity.getTime()) / 86400000
      : 999;

    if (daysSinceActivity > this._archiveAfterDays * 0.8) {
      result.action = 'archive';
      result.newState = CURATOR_V2_STATES.ARCHIVED;
      result.rationale = `Skill inactive for ${Math.round(daysSinceActivity)} days, approaching archive threshold`;
      return result;
    }

    const similarSkills = this._findSimilarSkills(skill);
    if (similarSkills.length >= 2) {
      result.action = 'consolidate';
      result.consolidateTarget = similarSkills[0].name;
      result.rationale = `Similar to ${similarSkills.map(s => s.name).join(', ')}`;
      return result;
    }

    if (skill.usageCount > 50 && daysSinceActivity < 7) {
      result.action = 'pin';
      result.rationale = `High-usage skill (${skill.usageCount} uses), auto-pinning to prevent staleness`;
      return result;
    }

    return result;
  }

  _canTransition(fromState, toState) {
    const allowed = STATE_TRANSITIONS[fromState];
    return allowed ? allowed.includes(toState) : false;
  }

  _setSkillState(name, newState) {
    try {
      const skillFile = this._findSkillFile(name);
      if (!skillFile) return false;

      let content = fs.readFileSync(skillFile, 'utf-8');
      const stateRegex = /^state:\s*.+$/m;
      if (stateRegex.test(content)) {
        content = content.replace(stateRegex, `state: ${newState}`);
      } else {
        const frontmatterEnd = content.indexOf('---', 3);
        if (frontmatterEnd > 0) {
          content = content.slice(0, frontmatterEnd) + `state: ${newState}\n` + content.slice(frontmatterEnd);
        }
      }

      fs.writeFileSync(skillFile, content, 'utf-8');
      this.emit('skill_state_changed', { name, newState });
      return true;
    } catch (e) {
      this.emit('skill_state_error', { name, error: e.message });
      return false;
    }
  }

  _applyPatch(name, patchContent) {
    try {
      const skillFile = this._findSkillFile(name);
      if (!skillFile) return false;
      fs.writeFileSync(skillFile, patchContent, 'utf-8');
      return true;
    } catch {
      return false;
    }
  }

  _listAgentCreatedSkills() {
    return agentCreatedReport().map(rec => ({
      name: rec.name,
      state: rec.state,
      lastActivity: rec.last_activity_at,
      createdAt: rec.created_at,
      usageCount: rec.use_count,
      viewCount: rec.view_count,
      patchCount: rec.patch_count,
      pinned: rec.pinned,
      createdBy: 'agent',
    }));
  }

  _listSkillsByState(state) {
    const skills = [];
    const dirs = this._getSkillDirs();

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillFile = path.join(dir, entry.name, 'SKILL.md');
          if (fs.existsSync(skillFile)) {
            const skill = this._parseSkillMeta(skillFile, entry.name);
            if (skill && skill.state === state) {
              skills.push(skill);
            }
          }
        }
      }
    }

    return skills;
  }

  _findSimilarSkills(skill) {
    const allSkills = this._listAgentCreatedSkills();
    return allSkills.filter(s =>
      s.name !== skill.name &&
      this._computeSimilarity(s.name, skill.name) > 0.5
    );
  }

  _computeSimilarity(a, b) {
    const aParts = a.toLowerCase().split(/[-_]/);
    const bParts = b.toLowerCase().split(/[-_]/);
    let common = 0;
    for (const part of aParts) {
      if (bParts.includes(part)) common++;
    }
    return (common * 2) / (aParts.length + bParts.length);
  }

  findPrefixClusters() {
    const skills = this._listAgentCreatedSkills();
    const clusters = new Map();

    for (const skill of skills) {
      const parts = skill.name.toLowerCase().split(/[-_]/);
      if (parts.length < 2) continue;

      const prefix = parts[0];
      if (!clusters.has(prefix)) {
        clusters.set(prefix, []);
      }
      clusters.get(prefix).push(skill);
    }

    return new Map([...clusters.entries()].filter(([, skills]) => skills.length >= 2));
  }

  proposeUmbrellaConsolidation() {
    const clusters = this.findPrefixClusters();
    const proposals = [];

    for (const [prefix, members] of clusters) {
      const umbrella = this._selectUmbrella(members);
      const siblings = members.filter(m => m.name !== umbrella.name);

      proposals.push({
        prefix,
        umbrella: umbrella.name,
        siblings: siblings.map(s => s.name),
        strategy: siblings.length >= 3 ? 'create_new_umbrella' : 'merge_into_existing',
        rationale: `${members.length} skills share prefix "${prefix}"; ` +
          (siblings.length >= 3
            ? `create a new class-level umbrella and absorb all siblings`
            : `merge into "${umbrella.name}" as the broadest existing skill`),
      });
    }

    return proposals;
  }

  _selectUmbrella(members) {
    const scored = members.map(m => {
      let score = 0;
      if (m.usageCount > 10) score += 3;
      else if (m.usageCount > 0) score += 1;
      if (m.patchCount > 0) score += 2;
      const parts = m.name.split(/[-_]/);
      if (parts.length <= 2) score += 2;
      if (m.state === CURATOR_V2_STATES.ACTIVE) score += 1;
      return { ...m, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0];
  }

  _parseSkillMeta(filePath, name) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!frontmatterMatch) return null;

      const meta = { name };
      const yaml = frontmatterMatch[1];
      for (const line of yaml.split('\n')) {
        const match = line.match(/^(\w+):\s*(.+)$/);
        if (match) {
          meta[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
        }
      }

      return meta;
    } catch {
      return null;
    }
  }

  _findSkillFile(name) {
    const dirs = this._getSkillDirs();
    for (const dir of dirs) {
      const skillFile = path.join(dir, name, 'SKILL.md');
      if (fs.existsSync(skillFile)) return skillFile;
    }
    return null;
  }

  _getSkillDirs() {
    const dirs = [];
    if (this._skillsDir) dirs.push(this._skillsDir);
    return dirs;
  }

  _buildSummary(transitions, reviews) {
    const parts = [];
    if (transitions.archived > 0) parts.push(`${transitions.archived} archived`);
    if (transitions.markedStale > 0) parts.push(`${transitions.markedStale} marked stale`);
    if (transitions.reactivated > 0) parts.push(`${transitions.reactivated} reactivated`);
    if (reviews.length > 0) parts.push(`${reviews.length} reviewed`);
    return parts.length > 0 ? parts.join(', ') : 'No changes';
  }

  _loadState() {
    if (!this._stateFile) return;
    try {
      if (fs.existsSync(this._stateFile)) {
        const data = JSON.parse(fs.readFileSync(this._stateFile, 'utf-8'));
        this._state = CuratorState.fromJSON(data);
      }
    } catch (e) { console.warn('[skill-curator-v2] Operation failed:', e.message); }
  }

  _saveState() {
    if (!this._stateFile) return;
    try {
      const dir = path.dirname(this._stateFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._stateFile, JSON.stringify(this._state.toJSON(), null, 2), 'utf-8');
    } catch (e) { console.warn('[skill-curator-v2] Operation failed:', e.message); }
  }

  getState() {
    return this._state.toJSON();
  }

  pause() {
    this._state.paused = true;
    this._saveState();
    this.emit('paused');
  }

  resume() {
    this._state.paused = false;
    this._saveState();
    this.emit('resumed');
  }

  shutdown() {
    if (this._reviewTimer) {
      clearInterval(this._reviewTimer);
      this._reviewTimer = null;
    }
    this._saveState();
    this.emit('shutdown');
  }
}

let _instance = null;

function getSkillCuratorV2(opts = {}) {
  if (!_instance) {
    _instance = new SkillCuratorV2(opts);
  }
  return _instance;
}

module.exports = {
  SkillCuratorV2,
  CuratorState,
  CuratorReviewResult,
  CURATOR_V2_STATES,
  STATE_TRANSITIONS,
  getSkillCuratorV2,
};
