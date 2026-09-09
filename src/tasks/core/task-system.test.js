/**
 * 任务系统单元测试 - Jest 兼容版本
 */

const { EnhancedScheduler, TASK_STATUS, validateCron, getNextRunTime, shouldRun } = require('./enhanced-scheduler');
const { taskExecutionHistory, taskDependencyManager, taskConditionManager } = require('./task-execution-history');
// eslint-disable-next-line no-unused-vars
const { taskStore } = require('./task-store');

const TEST_TASKS = [
  {
    id: 'test_task_1',
    name: '测试任务1 - 每天早上9点',
    cron: '0 9 * * *',
    action: 'skill',
    skill: 'test_skill',
    params: { instruction: '测试指令1' },
    enabled: true
  },
  {
    id: 'test_task_2',
    name: '测试任务2 - 每小时执行',
    cron: '0 * * * *',
    action: 'search',
    params: { keyword: '测试关键词' },
    enabled: true
  },
  {
    id: 'test_task_3',
    name: '测试任务3 - 工作日下午3点',
    cron: '0 15 * * 1-5',
    action: 'skill',
    skill: 'report_skill',
    params: { instruction: '生成日报' },
    enabled: true
  },
  {
    id: 'test_task_4',
    name: '测试任务4 - 已禁用',
    cron: '30 12 * * *',
    action: 'skill',
    params: { instruction: '禁用的任务' },
    enabled: false
  },
  {
    id: 'test_task_5',
    name: '测试任务5 - 无效Cron',
    cron: 'invalid cron',
    action: 'skill',
    params: { instruction: '无效任务' },
    enabled: true
  }
];

// ── Cron 表达式验证 ──

describe('Cron 表达式验证', () => {
  test('每天早上9点 - 有效', () => {
    expect(validateCron('0 9 * * *')).toBe(true);
  });

  test('每5分钟 - 有效', () => {
    expect(validateCron('*/5 * * * *')).toBe(true);
  });

  test('每年1月1日 - 有效', () => {
    expect(validateCron('0 0 1 1 *')).toBe(true);
  });

  test('工作日早上9点 - 有效', () => {
    expect(validateCron('0 9 * * 1-5')).toBe(true);
  });

  test('无效表达式', () => {
    expect(validateCron('invalid')).toBe(false);
  });

  test('空字符串', () => {
    expect(validateCron('')).toBe(false);
  });

  test('6位表达式(不支持)', () => {
    expect(validateCron('0 9 * * * *')).toBe(false);
  });
});

// ── 下次执行时间计算 ──

describe('下次执行时间计算', () => {
  test('每天早上9点 - 应返回有效日期', () => {
    const nextRun = getNextRunTime('0 9 * * *');
    expect(nextRun).not.toBeNull();
    expect(nextRun).toBeInstanceOf(Date);
  });

  test('每5分钟 - 应返回有效日期', () => {
    const nextRun = getNextRunTime('*/5 * * * *');
    expect(nextRun).not.toBeNull();
    expect(nextRun).toBeInstanceOf(Date);
  });

  test('每年1月1日 - 应返回有效日期', () => {
    const nextRun = getNextRunTime('0 0 1 1 *');
    expect(nextRun).not.toBeNull();
    expect(nextRun).toBeInstanceOf(Date);
  });
});

// ── 任务触发判断 ──

describe('任务触发判断', () => {
  test('正好在触发时间', () => {
    const result = shouldRun('0 9 * * *', new Date('2024-01-15T09:00:00'));
    expect(result).toBe(true);
  });

  test('超过触发时间1分钟', () => {
    const result = shouldRun('0 9 * * *', new Date('2024-01-15T09:01:00'));
    expect(result).toBe(false);
  });

  test('未到触发时间', () => {
    const result = shouldRun('0 9 * * *', new Date('2024-01-15T08:59:00'));
    expect(result).toBe(false);
  });
});

// ── 调度器加载 ──

describe('调度器加载', () => {
  test('加载有效任务', async () => {
    const scheduler = new EnhancedScheduler();
    const handler = () => ({ success: true });
    scheduler.register('skill', handler);
    scheduler.register('search', handler);

    await scheduler.load({ cron: TEST_TASKS });
    const tasks = scheduler.listTasks();

    expect(tasks.length).toBe(3);
  });

  test('过滤无效Cron', async () => {
    const scheduler = new EnhancedScheduler();
    const handler = () => ({ success: true });
    scheduler.register('skill', handler);
    scheduler.register('search', handler);

    await scheduler.load({ cron: TEST_TASKS });
    const tasks = scheduler.listTasks();

    expect(tasks.find(t => t.id === 'test_task_5')).toBeUndefined();
  });

  test('过滤禁用任务', async () => {
    const scheduler = new EnhancedScheduler();
    const handler = () => ({ success: true });
    scheduler.register('skill', handler);
    scheduler.register('search', handler);

    await scheduler.load({ cron: TEST_TASKS });
    const tasks = scheduler.listTasks();

    expect(tasks.find(t => t.id === 'test_task_4')).toBeUndefined();
  });
});

// ── 任务CRUD操作 ──

describe('任务CRUD操作', () => {
  test('添加任务', async () => {
    const scheduler = new EnhancedScheduler();
    const handler = () => ({ success: true });
    scheduler.register('skill', handler);
    await scheduler.load({ cron: [] });

    scheduler.addTask({
      id: 'crud_test_1',
      name: 'CRUD测试任务',
      cron: '0 10 * * *',
      action: 'skill',
      params: { instruction: '测试' },
      enabled: true
    });

    const added = scheduler.getTaskInfo('crud_test_1');
    expect(added).toBeTruthy();
    expect(added.name).toBe('CRUD测试任务');
  });

  test('更新任务', async () => {
    const scheduler = new EnhancedScheduler();
    const handler = () => ({ success: true });
    scheduler.register('skill', handler);
    await scheduler.load({ cron: [] });

    scheduler.addTask({
      id: 'crud_test_2',
      name: '原始任务',
      cron: '0 10 * * *',
      action: 'skill',
      params: { instruction: '测试' },
      enabled: true
    });

    scheduler.updateTask('crud_test_2', { name: '更新后的任务' });
    const updated = scheduler.getTaskInfo('crud_test_2');
    expect(updated.name).toBe('更新后的任务');
  });

  test('删除任务', async () => {
    const scheduler = new EnhancedScheduler();
    const handler = () => ({ success: true });
    scheduler.register('skill', handler);
    await scheduler.load({ cron: [] });

    scheduler.addTask({
      id: 'crud_test_3',
      name: '待删除任务',
      cron: '0 10 * * *',
      action: 'skill',
      params: { instruction: '测试' },
      enabled: true
    });

    scheduler.removeTask('crud_test_3');
    const removed = scheduler.getTaskInfo('crud_test_3');
    expect(removed).toBeFalsy();
  });
});

// ── 执行历史记录 ──

describe('执行历史记录', () => {
  test('记录执行开始', async () => {
    await taskExecutionHistory.clearHistory('jest_test_history');

    const execution = await taskExecutionHistory.recordExecution('jest_test_history', {
      status: TASK_STATUS.RUNNING,
      startedAt: Date.now(),
      triggeredBy: 'manual'
    });

    expect(execution).toBeTruthy();
    expect(execution.executionId).toBeTruthy();
  });

  test('记录执行完成', async () => {
    await taskExecutionHistory.clearHistory('jest_test_history_2');

    const execution = await taskExecutionHistory.recordExecution('jest_test_history_2', {
      status: TASK_STATUS.RUNNING,
      startedAt: Date.now(),
      triggeredBy: 'manual'
    });

    const completed = await taskExecutionHistory.recordExecution('jest_test_history_2', {
      ...execution,
      endedAt: Date.now(),
      status: TASK_STATUS.SUCCEEDED,
      duration: 1500
    });

    expect(completed.status).toBe(TASK_STATUS.SUCCEEDED);
  });

  test('获取历史记录', async () => {
    await taskExecutionHistory.clearHistory('jest_test_history_3');

    await taskExecutionHistory.recordExecution('jest_test_history_3', {
      status: TASK_STATUS.RUNNING,
      startedAt: Date.now(),
      triggeredBy: 'manual'
    });

    const history = await taskExecutionHistory.getHistory('jest_test_history_3');
    expect(history.length).toBeGreaterThan(0);
  });
});

// ── 任务依赖管理 ──

describe('任务依赖管理', () => {
  test('添加依赖', () => {
    taskDependencyManager.addDependency('jest_task_a', 'jest_task_b');
    const deps = taskDependencyManager.getDependencies('jest_task_a');
    expect(deps).toContain('jest_task_b');
  });

  test('获取依赖者', () => {
    const dependents = taskDependencyManager.getDependents('jest_task_b');
    expect(dependents).toContain('jest_task_a');
  });

  test('检查依赖满足', async () => {
    const checkResult = await taskDependencyManager.checkDependenciesMet(
      'jest_task_a',
      (id) => id === 'jest_task_b' ? TASK_STATUS.SUCCEEDED : TASK_STATUS.PENDING
    );
    expect(checkResult.met).toBe(true);
  });

  test('移除依赖', () => {
    taskDependencyManager.removeDependency('jest_task_a', 'jest_task_b');
    const deps = taskDependencyManager.getDependencies('jest_task_a');
    expect(deps.length).toBe(0);
  });
});

// ── 任务条件评估 ──

describe('任务条件评估', () => {
  test('工作日条件(周一) - 应允许执行', async () => {
    taskConditionManager.setCondition('jest_weekday_task', {
      type: 'weekday',
      params: { days: [1, 2, 3, 4, 5] }
    });

    const result = await taskConditionManager.evaluateCondition('jest_weekday_task', {
      now: new Date('2024-01-15T10:00:00')
    });
    expect(result.shouldRun).toBe(true);
  });

  test('工作日条件(周六) - 应禁止执行', async () => {
    const result = await taskConditionManager.evaluateCondition('jest_weekday_task', {
      now: new Date('2024-01-20T10:00:00')
    });
    expect(result.shouldRun).toBe(false);
  });

  test('工作时间窗口(下午2点) - 应允许执行', async () => {
    taskConditionManager.setCondition('jest_work_hours_task', {
      type: 'time_window',
      params: { startHour: 9, endHour: 18 }
    });

    const result = await taskConditionManager.evaluateCondition('jest_work_hours_task', {
      now: new Date('2024-01-15T14:00:00')
    });
    expect(result.shouldRun).toBe(true);
  });

  test('工作时间窗口(晚上8点) - 应禁止执行', async () => {
    const result = await taskConditionManager.evaluateCondition('jest_work_hours_task', {
      now: new Date('2024-01-15T20:00:00')
    });
    expect(result.shouldRun).toBe(false);
  });
});

// ── 调度器统计 ──

describe('调度器统计', () => {
  test('获取任务总数', async () => {
    const scheduler = new EnhancedScheduler();
    const handler = () => ({ success: true });
    scheduler.register('skill', handler);
    scheduler.register('search', handler);

    await scheduler.load({ cron: TEST_TASKS.slice(0, 3) });
    const stats = scheduler.getStats();

    expect(stats.totalTasks).toBe(3);
  });

  test('获取运行状态', async () => {
    const scheduler = new EnhancedScheduler();
    const handler = () => ({ success: true });
    scheduler.register('skill', handler);

    await scheduler.load({ cron: [] });
    const stats = scheduler.getStats();

    expect(typeof stats.isRunning).toBe('boolean');
  });
});
