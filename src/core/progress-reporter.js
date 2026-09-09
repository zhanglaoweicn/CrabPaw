/**
 * Progress Reporter — bridges taskflow progress to the conversation layer
 *
 * Design: thin EventEmitter wrapper over ConversationIntegration.
 * Does not duplicate ConversationIntegration logic; subscribes to its events
 * and translates them into a simpler progress model for the chat layer.
 */

const { EventEmitter } = require('events');

const SUGGESTIONS_BY_STAGE = {
  '信息搜集': ['进入数据分析阶段', '导出原始数据', '查看搜集结果详情'],
  '数据分析': ['进入报告撰写', '生成数据图表', '导出分析结果'],
  '报告撰写': ['生成 Markdown 报告', '生成 PPT', '导出 Word 文档'],
  '需求确认': ['进入方案设计', '查看需求文档', '修改需求范围'],
  '方案设计': ['进入开发执行', '生成架构图', '评审方案'],
  '环境分析': ['进入战略评估', '查看分析报告', '补充调研'],
  '战略评估': ['进入方案规划', '生成思维导图', '查看评估详情'],
  '开发执行': ['生成实现报告', '查看提交记录', '运行测试'],
  '测试验证': ['查看测试报告', '修复失败用例', '进入部署阶段'],
  '部署上线': ['查看部署日志', '验证服务状态', '生成发布说明'],
};

const DEFAULT_SUGGESTIONS = ['继续下一步', '查看详细结果', '生成阶段报告'];

class ProgressReporter extends EventEmitter {
  constructor(opts = {}) {
    super();
    this._conversationIntegration = opts.conversationIntegration || null;
    this._suggestions = new Map();
    this._activeProjects = new Map();
    this.setMaxListeners(20);
  }

  bindToConversationIntegration(ci) {
    if (!ci) return;
    this._conversationIntegration = ci;

    ci.on('stage_complete', (data) => {
      const suggestions = SUGGESTIONS_BY_STAGE[data.stageName] || DEFAULT_SUGGESTIONS;
      this._suggestions.set(data.flowId, suggestions);
      this._activeProjects.set(data.flowId, {
        flowId: data.flowId,
        currentStage: data.stageName,
        stageCount: data.stageCount || 1,
        status: data.status || 'running',
      });
      this.emit('progress', {
        type: 'stage_complete',
        flowId: data.flowId,
        stageName: data.stageName,
        message: 'Stage complete: ' + data.stageName,
        suggestions,
        result: data.result || null,
      });
    });

    ci.on('flow_complete', (data) => {
      this._activeProjects.set(data.flowId, {
        flowId: data.flowId,
        status: 'completed',
      });
      this.emit('progress', {
        type: 'flow_complete',
        flowId: data.flowId,
        message: 'Flow completed successfully',
        suggestions: [
          'Generate Markdown report',
          'Generate PPT presentation',
          'Generate Word document',
          'Generate architecture diagram',
          'Generate data chart',
        ],
      });
    });

    ci.on('flow_error', (data) => {
      this.emit('progress', {
        type: 'flow_error',
        flowId: data.flowId,
        message: 'Flow failed: ' + (data.error || 'unknown error'),
        suggestions: ['Retry', 'View error details', 'Switch to normal conversation'],
      });
    });

    ci.on('suggestion', (data) => {
      this.emit('progress', {
        type: 'suggestion',
        flowId: data.flowId,
        message: data.suggestion || '',
        suggestions: data.suggestions || [],
      });
    });

    ci.on('recommendation', (data) => {
      this.emit('progress', {
        type: 'recommendation',
        flowId: data.flowId,
        message: data.recommendation || '',
        suggestions: data.nextSteps || [],
      });
    });
  }

  getSuggestions(flowId) {
    return this._suggestions.get(flowId) || [];
  }

  getProjectStatus(flowId) {
    return this._activeProjects.get(flowId) || null;
  }

  getActiveProjects() {
    return Array.from(this._activeProjects.values());
  }
}

const globalProgressReporter = new ProgressReporter();

module.exports = { ProgressReporter, globalProgressReporter, SUGGESTIONS_BY_STAGE, DEFAULT_SUGGESTIONS };
