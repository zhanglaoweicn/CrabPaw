const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { DATA_DIR } = require('./config');
const { getAuxiliaryClient, TASK_TYPES } = require('./auxiliary-client');

const GOALS_DIR = path.join(DATA_DIR, 'goals');
const MAX_GOAL_TURNS = 20;
const MAX_JUDGE_PARSE_FAILURES = 3;
const DEFAULT_JUDGE_TIMEOUT = 15000;

const GOAL_STATES = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

const JUDGE_SYSTEM_PROMPT = `You are a strict judge evaluating whether an autonomous agent has achieved a user's stated goal. You receive the goal text and the agent's most recent response. Your only job is to decide whether the goal is fully satisfied based on that response.

A goal is DONE only when:
- The response explicitly confirms the goal was completed, OR
- The response clearly shows the final deliverable was produced, OR
- The response explains the goal is unachievable / blocked / needs user input (treat this as DONE with reason describing the block).

Otherwise the goal is NOT done — CONTINUE.

Reply ONLY with a single JSON object on one line:
{"done": <true|false>, "reason": "<one-sentence rationale>"}`;

const JUDGE_USER_PROMPT = `Goal:
{goal}

Agent's most recent response:
{response}

Current time: {current_time}

Is the goal satisfied?`;

const JUDGE_USER_PROMPT_WITH_SUBGOALS = `Goal:
{goal}

Additional criteria (all must also be satisfied for the goal to be DONE):
{subgoals_block}

Agent's most recent response:
{response}

Current time: {current_time}

Decision: For each numbered criterion above, find concrete evidence in the agent's response that the criterion is satisfied. Do not accept generic phrases like 'all requirements met' — require specific evidence. If ANY criterion lacks specific evidence, the goal is NOT done — return CONTINUE.

Is the goal AND every additional criterion satisfied?`;

const CONTINUATION_PROMPT = `[Continuing toward your standing goal]
Goal: {goal}

Continue working toward this goal. Take the next concrete step. If you believe the goal is complete, state so explicitly and stop. If you are blocked and need input from the user, say so clearly and stop.`;

const CONTINUATION_PROMPT_WITH_SUBGOALS = `[Continuing toward your standing goal]
Goal: {goal}

Additional criteria the user added mid-loop:
{subgoals_block}

Continue working toward the goal AND all additional criteria. Take the next concrete step. If you believe the goal and every additional criterion are complete, state so explicitly and stop. If you are blocked and need input from the user, say so clearly and stop.`;

const JUDGE_RESPONSE_SNIPPET_CHARS = 4000;
const DEFAULT_JUDGE_MAX_TOKENS = 4096;

class GoalState {
  constructor(goal, subgoals = []) {
    this.goal = goal;
    this.subgoals = subgoals;
    this.state = GOAL_STATES.ACTIVE;
    this.turnCount = 0;
    this.judgeParseFailures = 0;
    this.createdAt = Date.now();
    this.lastActivityAt = Date.now();
    this.completedAt = null;
    this.judgeHistory = [];
  }

  renderSubgoalsBlock() {
    if (!this.subgoals || this.subgoals.length === 0) return '';
    return this.subgoals.map((sg, i) => `${i + 1}. ${sg}`).join('\n');
  }

  toJSON() {
    return {
      goal: this.goal,
      subgoals: this.subgoals,
      state: this.state,
      turnCount: this.turnCount,
      judgeParseFailures: this.judgeParseFailures,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      completedAt: this.completedAt,
      judgeHistory: this.judgeHistory,
    };
  }

  static fromJSON(data) {
    const state = new GoalState(data.goal, data.subgoals || []);
    state.state = data.state || GOAL_STATES.ACTIVE;
    state.turnCount = data.turnCount || 0;
    state.judgeParseFailures = data.judgeParseFailures || 0;
    state.createdAt = data.createdAt || Date.now();
    state.lastActivityAt = data.lastActivityAt || Date.now();
    state.completedAt = data.completedAt || null;
    state.judgeHistory = data.judgeHistory || [];
    return state;
  }
}

class GoalManager extends EventEmitter {
  constructor(config = {}) {
    super();
    this.maxTurns = config.maxTurns || MAX_GOAL_TURNS;
    this.maxJudgeParseFailures = config.maxJudgeParseFailures || MAX_JUDGE_PARSE_FAILURES;
    this.judgeTimeout = config.judgeTimeout || DEFAULT_JUDGE_TIMEOUT;
    this._currentGoal = null;
    this._paused = false;

    // 记忆桥接：目标完成/失败时自动写入记忆
    this._memoryBridge = config.memoryBridge || null;
  }

  /**
   * 设置记忆桥接（延迟注入，避免循环依赖）
   * @param {object} bridge - { store(entry): Promise<void> }
   */
  setMemoryBridge(bridge) {
    this._memoryBridge = bridge;
  }

  _ensureDir() {
    if (!fs.existsSync(GOALS_DIR)) {
      fs.mkdirSync(GOALS_DIR, { recursive: true });
    }
  }

  set(goal, subgoals = []) {
    this._currentGoal = new GoalState(goal, subgoals);
    this._paused = false;
    this._save();
    this.emit('goal_set', this._currentGoal);
    return this._currentGoal;
  }

  addSubgoal(subgoal) {
    if (!this._currentGoal) return null;
    this._currentGoal.subgoals.push(subgoal);
    this._currentGoal.lastActivityAt = Date.now();
    this._save();
    this.emit('subgoal_added', { goal: this._currentGoal, subgoal });
    return this._currentGoal;
  }

  pause() {
    if (!this._currentGoal) return;
    this._currentGoal.state = GOAL_STATES.PAUSED;
    this._paused = true;
    this._save();
    this.emit('goal_paused', this._currentGoal);
  }

  resume() {
    if (!this._currentGoal) return;
    this._currentGoal.state = GOAL_STATES.ACTIVE;
    this._paused = false;
    this._currentGoal.lastActivityAt = Date.now();
    this._save();
    this.emit('goal_resumed', this._currentGoal);
  }

  complete(reason = '') {
    if (!this._currentGoal) return;
    this._currentGoal.state = GOAL_STATES.COMPLETED;
    this._currentGoal.completedAt = Date.now();
    this._currentGoal.lastActivityAt = Date.now();
    this._save();
    this._bridgeToMemory('completed', reason);
    this.emit('goal_completed', { goal: this._currentGoal, reason });
  }

  fail(reason = '') {
    if (!this._currentGoal) return;
    this._currentGoal.state = GOAL_STATES.FAILED;
    this._currentGoal.completedAt = Date.now();
    this._currentGoal.lastActivityAt = Date.now();
    this._save();
    this._bridgeToMemory('failed', reason);
    this.emit('goal_failed', { goal: this._currentGoal, reason });
  }

  /**
   * 将目标结果桥接到记忆系统
   * 完成的目标写入长期记忆，失败的目标写入经验教训
   */
  async _bridgeToMemory(outcome, reason) {
    if (!this._memoryBridge || !this._currentGoal) return;

    const goal = this._currentGoal;
    const entry = {
      type: outcome === 'completed' ? 'goal_achievement' : 'goal_failure_lesson',
      title: outcome === 'completed'
        ? `目标完成: ${goal.goal.slice(0, 80)}`
        : `目标失败教训: ${goal.goal.slice(0, 80)}`,
      content: [
        `目标: ${goal.goal}`,
        goal.subgoals.length > 0 ? `子目标: ${goal.subgoals.join('; ')}` : '',
        `结果: ${outcome}`,
        `原因: ${reason || '未知'}`,
        `耗时轮次: ${goal.turnCount}`,
        `持续时间: ${((goal.completedAt - goal.createdAt) / 60000).toFixed(1)}分钟`,
      ].filter(Boolean).join('\n'),
      tags: {
        source: 'goal_manager',
        outcome,
        turnCount: String(goal.turnCount),
      },
      timestamp: Date.now(),
    };

    try {
      await this._memoryBridge.store(entry);
      console.log(`[GoalManager] 目标结果已写入记忆 ${outcome} - ${goal.goal.slice(0, 50)}`);
    } catch (e) {
      console.warn(`[GoalManager] 记忆桥接失败: ${e.message}`);
    }
  }

  get current() {
    return this._currentGoal;
  }

  get isActive() {
    return this._currentGoal && this._currentGoal.state === GOAL_STATES.ACTIVE && !this._paused;
  }

  /**
   * 获取当前活跃目标的上下文文本，用于注入 system prompt
   * @returns {string|null} 返回目标上下文文本，无活跃目标时返回 null
   */
  getActiveGoalContext() {
    if (!this.isActive || !this._currentGoal) return null;
    const g = this._currentGoal;
    const lines = [
      `[当前目标] ${g.goal}`,
      `      进度: ${g.turnCount}/${this.maxTurns} 轮`,
    ];
    if (g.subgoals && g.subgoals.length > 0) {
      lines.push('子目标:');
      g.subgoals.forEach((sg, i) => lines.push(`  ${i + 1}. ${sg}`));
    }
    return lines.join('\n');
  }

  nextContinuationPrompt() {
    if (!this._currentGoal || !this.isActive) return null;

    this._currentGoal.turnCount++;
    this._currentGoal.lastActivityAt = Date.now();

    if (this._currentGoal.turnCount > this.maxTurns) {
      this.pause();
      this.emit('goal_max_turns', this._currentGoal);
      return null;
    }

    if (this._currentGoal.subgoals.length > 0) {
      return CONTINUATION_PROMPT_WITH_SUBGOALS
        .replace('{goal}', this._currentGoal.goal)
        .replace('{subgoals_block}', this._currentGoal.renderSubgoalsBlock());
    }

    return CONTINUATION_PROMPT.replace('{goal}', this._currentGoal.goal);
  }

  async judgeGoal(lastResponse) {
    if (!this._currentGoal || !this.isActive) {
      return { status: 'done', reason: 'no active goal', shouldContinue: false };
    }

    if (!lastResponse || !lastResponse.trim()) {
      return { status: 'continue', reason: 'empty response (nothing to evaluate)', shouldContinue: true };
    }

    const currentTime = new Date().toLocaleString();
    const cleanSubgoals = (this._currentGoal.subgoals || []).filter(s => s && s.trim());

    let userPrompt;
    if (cleanSubgoals.length > 0) {
      userPrompt = JUDGE_USER_PROMPT_WITH_SUBGOALS
        .replace('{goal}', this._currentGoal.goal.slice(0, 2000))
        .replace('{subgoals_block}', this._currentGoal.renderSubgoalsBlock().slice(0, 2000))
        .replace('{response}', lastResponse.slice(0, JUDGE_RESPONSE_SNIPPET_CHARS))
        .replace('{current_time}', currentTime);
    } else {
      userPrompt = JUDGE_USER_PROMPT
        .replace('{goal}', this._currentGoal.goal.slice(0, 2000))
        .replace('{response}', lastResponse.slice(0, JUDGE_RESPONSE_SNIPPET_CHARS))
        .replace('{current_time}', currentTime);
    }

    try {
      const auxiliaryClient = getAuxiliaryClient();
      const result = await auxiliaryClient.callLlm({
        taskType: TASK_TYPES.CURATOR,
        messages: [
          { role: 'system', content: JUDGE_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        maxTokens: DEFAULT_JUDGE_MAX_TOKENS,
        temperature: 0,
        timeout: this.judgeTimeout,
      });

      const text = result?.content || result?.choices?.[0]?.message?.content || '';
      return this._parseJudgeResponse(text);
    } catch (e) {
      this._currentGoal.judgeParseFailures++;
      if (this._currentGoal.judgeParseFailures >= this.maxJudgeParseFailures) {
        this.pause();
        this.emit('goal_judge_failed', this._currentGoal);
      }
      return { status: 'continue', reason: 'judge_error', shouldContinue: true, error: e.message };
    }
  }

  _parseJudgeResponse(text) {
    if (!text || !text.trim()) {
      this._currentGoal.judgeParseFailures++;
      return { status: 'continue', reason: 'judge returned empty response', shouldContinue: true, parseFailed: true };
    }

    let parsed = null;
    let parseFailed = false;

    try {
      let cleaned = text.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      parsed = JSON.parse(cleaned);
    } catch {
      const jsonMatch = text.match(/\{[\s\S]*?\}/);
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[0]);
        } catch {
          parseFailed = true;
        }
      } else {
        parseFailed = true;
      }
    }

    if (parseFailed || !parsed || typeof parsed !== 'object') {
      this._currentGoal.judgeParseFailures++;
      const statusMatch = text.match(/STATUS:\s*(continue|done)/i);
      const reasonMatch = text.match(/REASON:\s*(.+)/i);
      if (statusMatch) {
        const status = statusMatch[1].toLowerCase();
        const reason = reasonMatch ? reasonMatch[1].trim() : 'legacy_format';
        this._currentGoal.judgeHistory.push({ turn: this._currentGoal.turnCount, status, reason, timestamp: Date.now() });
        if (status === 'done') {
          this.complete(reason);
          return { status: 'done', reason, shouldContinue: false, parseFailed: true };
        }
        return { status: 'continue', reason, shouldContinue: true, parseFailed: true };
      }
      return { status: 'continue', reason: `judge reply was not JSON: ${text.slice(0, 200)}`, shouldContinue: true, parseFailed: true };
    }

    this._currentGoal.judgeParseFailures = 0;

    let done = parsed.done;
    if (typeof done === 'string') {
      done = ['true', 'yes', '1', 'done'].includes(done.trim().toLowerCase());
    } else {
      done = Boolean(done);
    }
    const reason = String(parsed.reason || 'no reason provided').trim();

    this._currentGoal.judgeHistory.push({
      turn: this._currentGoal.turnCount,
      status: done ? 'done' : 'continue',
      reason,
      timestamp: Date.now(),
    });

    if (done) {
      if (reason === 'agent-declined' || reason.includes('cannot complete') || reason.includes('blocked')) {
        this.fail(reason);
      } else {
        this.complete(reason);
      }
      return { status: 'done', reason, shouldContinue: false, parseFailed: false };
    }

    return { status: 'continue', reason, shouldContinue: true, parseFailed: false };
  }

  // eslint-disable-next-line no-unused-vars
  async evaluateAfterTurn(lastResponse, { userInitiated = true } = {}) {
    if (!this._currentGoal || this._currentGoal.state !== GOAL_STATES.ACTIVE) {
      return {
        status: this._currentGoal?.state || null,
        shouldContinue: false,
        continuationPrompt: null,
        verdict: 'inactive',
        reason: 'no active goal',
        message: '',
      };
    }

    this._currentGoal.turnCount++;
    this._currentGoal.lastActivityAt = Date.now();

    const judgeResult = await this.judgeGoal(lastResponse);
    const verdict = judgeResult.status === 'done' ? 'done' : 'continue';

    if (judgeResult.parseFailed) {
      this._currentGoal.judgeParseFailures++;
    } else {
      this._currentGoal.judgeParseFailures = 0;
    }

    if (verdict === 'done') {
      return {
        status: 'done',
        shouldContinue: false,
        continuationPrompt: null,
        verdict: 'done',
        reason: judgeResult.reason,
        message: `✅ 目标已达到 ${judgeResult.reason}`,
      };
    }

    if (this._currentGoal.judgeParseFailures >= this.maxJudgeParseFailures) {
      this.pause();
      return {
        status: 'paused',
        shouldContinue: false,
        continuationPrompt: null,
        verdict: 'continue',
        reason: judgeResult.reason,
        message: `⚠️ 目标已暂停 — 判断模型连续 ${this._currentGoal.judgeParseFailures} 次返回无法解析的结果。请检查辅助模型配置后使用 /goal resume 继续。`,
      };
    }

    if (this._currentGoal.turnCount >= this.maxTurns) {
      this.pause();
      return {
        status: 'paused',
        shouldContinue: false,
        continuationPrompt: null,
        verdict: 'continue',
        reason: judgeResult.reason,
        message: `⚠️ 目标已暂停 — 已使用 ${this._currentGoal.turnCount}/${this.maxTurns} 轮。使用 /goal resume 继续，或 /goal clear 停止。`,
      };
    }

    this._save();

    return {
      status: 'active',
      shouldContinue: true,
      continuationPrompt: this._buildContinuationPrompt(),
      verdict: 'continue',
      reason: judgeResult.reason,
      message: `🔄 继续推进目标 (${this._currentGoal.turnCount}/${this.maxTurns}): ${judgeResult.reason}`,
    };
  }

  _buildContinuationPrompt() {
    if (!this._currentGoal || this._currentGoal.state !== GOAL_STATES.ACTIVE) return null;
    if (this._currentGoal.subgoals && this._currentGoal.subgoals.length > 0) {
      return CONTINUATION_PROMPT_WITH_SUBGOALS
        .replace('{goal}', this._currentGoal.goal)
        .replace('{subgoals_block}', this._currentGoal.renderSubgoalsBlock());
    }
    return CONTINUATION_PROMPT.replace('{goal}', this._currentGoal.goal);
  }

  _save() {
    if (!this._currentGoal) return;
    this._ensureDir();
    const filepath = path.join(GOALS_DIR, 'current-goal.json');
    try {
      const tmp = filepath + '.tmp.' + Date.now();
      fs.writeFileSync(tmp, JSON.stringify(this._currentGoal.toJSON(), null, 2), 'utf-8');
      fs.renameSync(tmp, filepath);
    } catch (e) {
      console.warn('[GoalManager] 保存失败:', e.message);
    }
  }

  load() {
    const filepath = path.join(GOALS_DIR, 'current-goal.json');
    if (!fs.existsSync(filepath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
      this._currentGoal = GoalState.fromJSON(data);
      if (this._currentGoal.state === GOAL_STATES.ACTIVE) {
        this._paused = false;
      }
      return this._currentGoal;
    } catch {
      return null;
    }
  }

  clear() {
    this._currentGoal = null;
    this._paused = false;
    const filepath = path.join(GOALS_DIR, 'current-goal.json');
    try {
      if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    } catch { console.warn('[goal-manager] silent catch, error swallowed'); }
    this.emit('goal_cleared');
  }

  getStatus() {
    if (!this._currentGoal) return 'No active goal';
    const g = this._currentGoal;
    const lines = [
      `🎯 Goal: ${g.goal}`,
      `State: ${g.state} | Turns: ${g.turnCount}/${this.maxTurns}`,
    ];
    if (g.subgoals.length > 0) {
      lines.push('Subgoals:');
      g.subgoals.forEach((sg, i) => lines.push(`  ${i + 1}. ${sg}`));
    }
    return lines.join('\n');
  }
}

let _instance = null;

function getGoalManager(config) {
  if (!_instance) {
    _instance = new GoalManager(config);
    _instance.load();
  }
  return _instance;
}

module.exports = {
  GoalManager,
  GoalState,
  GOAL_STATES,
  getGoalManager,
};
