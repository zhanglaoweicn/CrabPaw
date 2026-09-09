const { detectTaskMode } = require('../../src/core/task-mode-detector');

module.exports = {
  name: 'Task Mode Detection',
  cases: [
    {
      id: 'tm_001',
      name: 'detects 分析 task',
      category: 'task_mode',
      run: () => detectTaskMode('帮我做AI直播课的行业分析报告').isTask,
    },
    {
      id: 'tm_002',
      name: 'quick translation is non-task',
      category: 'task_mode',
      run: () => !detectTaskMode('帮我翻译这段文字').isTask,
    },
    {
      id: 'tm_003',
      name: 'short question is non-task',
      category: 'task_mode',
      run: () => !detectTaskMode('今天几号').isTask,
    },
    {
      id: 'tm_004',
      name: '架构设计 is task',
      category: 'task_mode',
      run: () => detectTaskMode('帮我设计一个微服务架构并编写实现方案').isTask,
    },
    {
      id: 'tm_005',
      name: 'very short msg is non-task',
      category: 'task_mode',
      run: () => !detectTaskMode('hello').isTask,
    },
  ],
};
