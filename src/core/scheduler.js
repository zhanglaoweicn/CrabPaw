/**
 * CrabPaw Scheduler - 使用 cron-parser 的精确 Cron 调度器
 * 
 * 功能：
 * - 精确的 Cron 表达式解析（支持标准 5 字段和扩展 6 字段）
 * - 自动重试机制
 * - 并发控制
 * - 任务状态管理
 */

const { CronExpressionParser } = require('cron-parser');
const { RunManager, RUN_STATUS, MULTITASK_STRATEGY, ConflictError } = require('./run-manager');
const { CronPromptInjectionScanner, CronPromptInjectionBlocked } = require('./security/cron-injection-scanner');
const { isHoliday } = require('./scheduler/holiday-calendar');
const { parseSchedule, SCHEDULE_TYPE } = require('./scheduler/schedule-parser');
const { CronSkillBinder } = require('./scheduler/cron-skill-binder');

const DEFAULT_TIMEOUT = 60000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY = 5000;

const CRON_DISABLED_TOOLSETS = ['cronjob', 'messaging', 'clarify'];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseCron(cronExpr) {
  try {
    const interval = CronExpressionParser.parse(cronExpr, {
      currentDate: new Date(),
      tz: 'Asia/Shanghai'
    });
    return { valid: true, interval };
  } catch (e) {
    console.warn(`⚠️ 无效的 Cron 表达式: "${cronExpr}" - ${e.message}`);
    return { valid: false, error: e.message };
  }
}

function validateCron(cronExpr) {
  try {
    CronExpressionParser.parse(cronExpr);
    return true;
  } catch (e) {
    return false;
  }
}

function shouldRun(cronExpr, now) {
  try {
    const interval = CronExpressionParser.parse(cronExpr, {
      currentDate: new Date(now.getTime() - 60000),
      endDate: now,
      tz: 'Asia/Shanghai'
    });
    
    const prev = interval.prev();
    if (!prev) return false;
    
    const prevTime = prev.getTime();
    const nowTime = now.getTime();
    const diff = nowTime - prevTime;
    
    return diff >= 0 && diff < 65000;
  } catch (e) {
    return false;
  }
}

function getNextRunTime(cronExpr) {
  try {
    const interval = CronExpressionParser.parse(cronExpr, {
      currentDate: new Date(),
      tz: 'Asia/Shanghai'
    });
    return interval.next().toDate();
  } catch (e) {
    return null;
  }
}

function getNextRunTimes(cronExpr, count = 5) {
  try {
    const interval = CronExpressionParser.parse(cronExpr, {
      currentDate: new Date(),
      tz: 'Asia/Shanghai'
    });
    const times = [];
    for (let i = 0; i < count; i++) {
      times.push(interval.next().toDate());
    }
    return times;
  } catch (e) {
    return [];
  }
}

function getCronDescription(cronExpr) {
  try {
    const parts = cronExpr.trim().split(/\s+/);
    const descriptions = [];
    
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    
    if (minute === '*' && hour === '*') {
      descriptions.push('每分钟');
    } else if (minute === '0' && hour === '*') {
      descriptions.push('每小时整点');
    } else if (minute !== '*' && hour !== '*') {
      descriptions.push(`每天 ${hour}:${minute.padStart(2, '0')}`);
    } else if (hour !== '*') {
      descriptions.push(`每小时的 ${minute} 分`);
    } else if (minute !== '*') {
      descriptions.push(`每分钟（当分钟为 ${minute} 时）`);
    }
    
    if (dayOfMonth !== '*') {
      descriptions.push(`每月 ${dayOfMonth} 日`);
    }
    
    if (month !== '*') {
      const monthNames = ['一月', '二月', '三月', '四月', '五月', '六月', 
                          '七月', '八月', '九月', '十月', '十一月', '十二月'];
      const months = month.split(',').map(m => monthNames[parseInt(m) - 1]);
      descriptions.push(`${months.join('、')}`);
    }
    
    if (dayOfWeek !== '*') {
      const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      const days = dayOfWeek.split(',').map(d => dayNames[parseInt(d)]);
      descriptions.push(`每${days.join('、')}`);
    }
    
    return descriptions.join('，') || cronExpr;
  } catch (e) {
    return cronExpr;
  }
}

class Scheduler {
  constructor(config = {}) {
    this.tasks = [];
    this.lastCheck = new Date();
    this.handlers = new Map();
    this.timer = null;
    this.runManager = new RunManager({
      maxConcurrent: 5,
      lockTimeout: 120000
    });
    this._lastExecutionMinute = -1;
    this._injectionScanner = new CronPromptInjectionScanner({
      strictMode: config.strictInjectionScan !== false,
    });
    this._disabledToolsets = [...CRON_DISABLED_TOOLSETS, ...(config.disabledToolsets || [])];
    // 技能绑定器
    this._skillBinder = new CronSkillBinder({ skillsDir: config.skillsDir || '' });
  }
  
  load(schedules) {
    const now = Date.now();
    this.tasks = (schedules.cron || []).filter(t => {
      if (t.enabled === false) return false;
      // 过滤已过期的临时任务
      if (t.type === 'temporary' && t.expireAt && t.expireAt < now) {
        console.log(`🗑️ 跳过已过期临时任务: ${t.name}`);
        return false;
      }
      if (!t.cron || !t.name || !t.action) {
        console.warn(`⚠️ 跳过无效任务: ${t.name || t.id || '未知'} (缺少 cron/name/action)`);
        return false;
      }
      if (!validateCron(t.cron)) {
        console.warn(`⚠️ 跳过无效cron表达式: ${t.name} -> "${t.cron}"`);
        return false;
      }
      t._nextRun = getNextRunTime(t.cron);
      return true;
    });
    
    console.log(`📋 调度器加载了 ${this.tasks.length} 个任务:`);
    for (const task of this.tasks) {
      const desc = getCronDescription(task.cron);
      const next = task._nextRun ? task._nextRun.toLocaleString('zh-CN') : '未知';
      console.log(`   - ${task.name}: ${desc} (下次: ${next})`);
    }
  }
  
  register(action, handler) {
    this.handlers.set(action, handler);
  }
  
  start() {
    if (this.timer) return;
    
    this.runManager.start();
    
    this.timer = setInterval(() => {
      this.tick();
    }, 60000);
    
    this.tick();
    
    console.log('⏰ 调度器已启动');
  }
  
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.runManager.stop();
  }
  
  async tick() {
    const now = new Date();
    const currentMinute = now.getMinutes();
    
    if (currentMinute === this._lastExecutionMinute) {
      return;
    }
    
    this._lastExecutionMinute = currentMinute;
    this.lastCheck = now;
    
    for (const task of this.tasks) {
      if (task._paused) continue;

      // 节假日跳过
      if (task.skipHoliday && isHoliday(now)) {
        continue;
      }

      if (shouldRun(task.cron, now)) {
        // 注入技能提示
        const jobId = task.id || task.name;
        const boundSkills = this._skillBinder.getSkills(jobId);
        const enhancedTask = { ...task };
        if (boundSkills.length > 0 && task.prompt) {
          enhancedTask.prompt = this._skillBinder.buildPrompt(jobId, task.prompt);
        }
        this.executeWithRetry(enhancedTask);
        task._nextRun = getNextRunTime(task.cron);
      }
    }
  }
  
  async executeWithRetry(task) {
    if (task.prompt || task.command) {
      const promptToScan = [task.prompt, task.command].filter(Boolean).join('\n');
      const scanResult = this._injectionScanner.scan(promptToScan, {
        jobId: task.id || task.name,
        jobName: task.name,
      });
      if (scanResult.blocked) {
        const err = new CronPromptInjectionBlocked(scanResult);
        console.error(`🚫 Cron任务被注入防护阻止: ${task.name} - ${err.message}`);
        this._notifyBlocked(task, scanResult);
        throw err;
      }
    }

    const threadId = task.id || task.name;
    const resourceId = `task:${threadId}`;
    
    const maxRetries = task.maxRetries ?? DEFAULT_MAX_RETRIES;
    const timeout = task.timeout ?? DEFAULT_TIMEOUT;
    const retryDelay = task.retryDelay ?? DEFAULT_RETRY_DELAY;
    const strategy = task.multitaskStrategy || MULTITASK_STRATEGY.REJECT;
    
    let lastError = null;
    const startedAt = Date.now();
    const { taskExecutionHistory } = require('../tasks/core/task-execution-history');
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`⏰ 执行任务: ${task.name} (尝试 ${attempt}/${maxRetries})`);
        
        const handler = this.handlers.get(task.action);
        if (!handler) {
          const error = new Error(`未知的任务类型: ${task.action}`);
          throw error;
        }
        
        const run = await this.runManager.execute(
          threadId,
          async (signal) => {
            if (signal.aborted) {
              throw new Error('任务已取消');
            }
            return handler({ ...task, signal });
          },
          {
            resourceId,
            timeout,
            multitaskStrategy: strategy
          }
        );
        
        if (run.status === RUN_STATUS.COMPLETED) {
          console.log(`✅ 任务完成: ${task.name}`);
          // 记录执行历史
          taskExecutionHistory.recordExecution(threadId, {
            startedAt,
            endedAt: Date.now(),
            status: 'completed',
            result: run.result,
            duration: Date.now() - startedAt,
            triggeredBy: 'scheduler',
          }).catch(e => console.debug('[scheduler] Operation failed:', e?.message));
          return run.result;
        }
        
        if (run.status === RUN_STATUS.CANCELLED) {
          console.log(`⏹️ 任务已取消: ${task.name}`);
          taskExecutionHistory.recordExecution(threadId, {
            startedAt,
            endedAt: Date.now(),
            status: 'cancelled',
            duration: Date.now() - startedAt,
            triggeredBy: 'scheduler',
          }).catch(e => console.debug('[scheduler] Operation failed:', e?.message));
          return;
        }
        
        if (run.status === RUN_STATUS.TIMEOUT) {
          throw new Error(`任务执行超时 (${timeout}ms)`);
        }
        
        throw run.error || new Error('任务执行失败');
        
      } catch (e) {
        if (e instanceof ConflictError) {
          console.log(`⏭️ 任务 ${task.name} 正在执行中，跳过本次触发`);
          return;
        }
        
        lastError = e;
        console.error(`❌ 任务执行失败: ${task.name} (尝试 ${attempt}/${maxRetries})`, e.message);
        
        if (attempt < maxRetries) {
          console.log(`🔄 ${retryDelay/1000}秒后重试...`);
          await sleep(retryDelay);
        }
      }
    }
    
    console.error(`❌ 任务最终失败: ${task.name}`, lastError?.message);
    
    // 记录失败历史
    taskExecutionHistory.recordExecution(threadId, {
      startedAt,
      endedAt: Date.now(),
      status: 'failed',
      error: lastError?.message || '未知错误',
      duration: Date.now() - startedAt,
      triggeredBy: 'scheduler',
    }).catch(e => console.debug('[scheduler] Operation failed:', e?.message));
    
    if (task.onFailure) {
      console.log(`📢 执行失败回调: ${task.onFailure}`);
    }
  }
  
  async execute(task) {
    return this.executeWithRetry(task);
  }
  
  getTaskStatus(taskId) {
    const inflight = this.runManager.getInflightRuns(taskId);
    return inflight.length > 0 ? 'running' : 'idle';
  }
  
  getStats() {
    return this.runManager.getStats();
  }

  getExecutionHistory(taskId, limit = 20) {
    const { taskExecutionHistory } = require('../tasks/core/task-execution-history');
    if (taskId) {
      return taskExecutionHistory.getHistory(taskId, limit);
    }
    return taskExecutionHistory.getAllHistory(limit);
  }
  
  cancelTask(taskId, reason = '用户取消') {
    return this.runManager.cancelByThread(taskId, reason);
  }
  
  getTaskInfo(taskId) {
    const task = this.tasks.find(t => t.id === taskId || t.name === taskId);
    if (!task) return null;
    
    const jobId = task.id || task.name;
    return {
      ...task,
      nextRun: task._nextRun,
      description: task._scheduleDescription || getCronDescription(task.cron),
      status: this.getTaskStatus(taskId),
      paused: !!task._paused,
      skills: this._skillBinder.getSkills(jobId),
      upcomingRuns: getNextRunTimes(task.cron, 5)
    };
  }
  
  addTask(task) {
    // 支持自然语言调度：如果 task.schedule 存在，优先解析
    if (task.schedule && !task.cron) {
      const parsed = parseSchedule(task.schedule);
      if (!parsed) {
        throw new Error(`无法解析调度表达式: "${task.schedule}"`);
      }
      task.cron = parsed.cron;
      task._scheduleType = parsed.type;
      task._scheduleDescription = parsed.description;
      // 一次性任务
      if (parsed.type === SCHEDULE_TYPE.ONCE || parsed.type === SCHEDULE_TYPE.ONCE_AT) {
        task.type = 'temporary';
        task.expireAt = parsed.runAt;
        task.repeat = 1;
      }
      if (parsed.intervalMs) {
        task._intervalMs = parsed.intervalMs;
      }
      if (parsed.repeat !== undefined) {
        task.repeat = parsed.repeat;
      }
    }

    if (!task.cron || !task.name || !task.action) {
      throw new Error('任务必须包含 cron(或 schedule), name, action');
    }
    if (!validateCron(task.cron)) {
      throw new Error(`无效的 Cron 表达式: ${task.cron}`);
    }
    
    task._nextRun = getNextRunTime(task.cron);
    this.tasks.push(task);

    // 技能绑定
    if (task.skills && task.skills.length > 0) {
      const jobId = task.id || task.name;
      this._skillBinder.attach(jobId, task.skills);
    }
    
    const desc = task._scheduleDescription || getCronDescription(task.cron);
    console.log(`✅ 添加任务: ${task.name} (${desc}, 下次执行: ${task._nextRun?.toLocaleString('zh-CN')})`);
    return task;
  }
  
  removeTask(taskId) {
    const index = this.tasks.findIndex(t => t.id === taskId || t.name === taskId);
    if (index === -1) return false;
    
    const removed = this.tasks.splice(index, 1)[0];
    this._skillBinder.clearSkills(taskId);
    console.log(`🗑️ 移除任务: ${removed.name}`);
    return true;
  }
  
  updateTask(taskId, updates) {
    const task = this.tasks.find(t => t.id === taskId || t.name === taskId);
    if (!task) return null;
    
    // 支持自然语言调度更新
    if (updates.schedule && !updates.cron) {
      const parsed = parseSchedule(updates.schedule);
      if (!parsed) {
        throw new Error(`无法解析调度表达式: "${updates.schedule}"`);
      }
      updates.cron = parsed.cron;
      updates._scheduleType = parsed.type;
      updates._scheduleDescription = parsed.description;
      if (parsed.type === SCHEDULE_TYPE.ONCE || parsed.type === SCHEDULE_TYPE.ONCE_AT) {
        updates.type = 'temporary';
        updates.expireAt = parsed.runAt;
        updates.repeat = 1;
      }
    }

    if (updates.cron && !validateCron(updates.cron)) {
      throw new Error(`无效的 Cron 表达式: ${updates.cron}`);
    }
    
    Object.assign(task, updates);
    
    if (updates.cron) {
      task._nextRun = getNextRunTime(task.cron);
    }

    // 技能绑定更新
    const jobId = task.id || task.name;
    if (updates.skills) {
      this._skillBinder.attach(jobId, updates.skills);
    }
    if (updates.addSkill) {
      this._skillBinder.addSkill(jobId, updates.addSkill);
    }
    if (updates.removeSkill) {
      this._skillBinder.removeSkill(jobId, updates.removeSkill);
    }
    if (updates.clearSkills) {
      this._skillBinder.clearSkills(jobId);
    }
    
    console.log(`📝 更新任务: ${task.name}`);
    return task;
  }

  // ─── 生命周期操作 ─────────────────────────────────────────

  /**
   * 暂停任务（保留但不调度）
   */
  pauseTask(taskId) {
    const task = this.tasks.find(t => t.id === taskId || t.name === taskId);
    if (!task) return null;
    task._paused = true;
    console.log(`⏸️ 暂停任务: ${task.name}`);
    return { taskId, paused: true };
  }

  /**
   * 恢复暂停的任务
   */
  resumeTask(taskId) {
    const task = this.tasks.find(t => t.id === taskId || t.name === taskId);
    if (!task) return null;
    task._paused = false;
    task._nextRun = getNextRunTime(task.cron);
    console.log(`▶️ 恢复任务: ${task.name}`);
    return { taskId, resumed: true, nextRun: task._nextRun };
  }

  /**
   * 立即触发任务（不等待下次调度）
   */
  async runTask(taskId) {
    const task = this.tasks.find(t => t.id === taskId || t.name === taskId);
    if (!task) return null;

    // 构建包含技能的提示
    const jobId = task.id || task.name;
    const boundSkills = this._skillBinder.getSkills(jobId);
    const enhancedTask = { ...task };
    if (boundSkills.length > 0 && task.prompt) {
      enhancedTask.prompt = this._skillBinder.buildPrompt(jobId, task.prompt);
    }

    console.log(`⚡ 手动触发任务: ${task.name}${boundSkills.length ? ` (技能: ${boundSkills.join(', ')})` : ''}`);
    return this.executeWithRetry(enhancedTask);
  }

  _notifyBlocked(task, scanResult) {
    const categories = [...new Set(scanResult.findings.map(f => f.category))];
    console.warn(`🚫 Cron注入检测报告 - 任务: ${task.name}`);
    console.warn(`   发现 ${scanResult.findingCount} 个问题, 类别: ${categories.join(', ')}`);
    for (const f of scanResult.findings.slice(0, 5)) {
      console.warn(`   - [${f.severity}] ${f.category}: "${f.matched}" at index ${f.index}`);
    }
  }

  getDisabledToolsets() {
    return [...this._disabledToolsets];
  }

  isToolsetAllowed(toolsetName) {
    return !this._disabledToolsets.includes(toolsetName);
  }

  getInjectionScanStats() {
    return this._injectionScanner.getStats();
  }
}

let _instance = null;

/**
 * Scheduler 全局单例（2026-08-18 残留修复）
 * panels/status.js 与 CLI schedule 命令此前解构不存在的 getScheduler → 恒 undefined
 * 调用即 TypeError（纸面接线）。与 getSharedSessionPersistence 同模式。
 */
function getScheduler(config) {
  if (!_instance) {
    _instance = new Scheduler(config);
  }
  return _instance;
}

module.exports = {
  Scheduler,
  getScheduler,
  CronPromptInjectionBlocked,
  CRON_DISABLED_TOOLSETS,
  parseCron,
  validateCron,
  shouldRun,
  getNextRunTime,
  getNextRunTimes,
  getCronDescription,
  DEFAULT_TIMEOUT,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_DELAY,
  RUN_STATUS,
  MULTITASK_STRATEGY,
  // 新增导出
  parseSchedule,
  SCHEDULE_TYPE,
  CronSkillBinder,
};
