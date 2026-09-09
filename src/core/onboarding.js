const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const { OnboardingEnhancer } = require('./agent/onboarding-enhancer');

const ONBOARDING_FILE = path.join(DATA_DIR, 'onboarding.json');

const ONBOARDING_STAGES = {
  first_message: {
    id: 'first_message',
    trigger: 'first_interaction',
    title: '欢迎使用 CrabPaw',
    tips: [
      '你可以直接告诉我你想做什么，我会调用合适的工具来完成',
      '试试说："帮我搜索最新的AI新闻" 或"创建一个飞书文档"',
      '我可以操作文件、搜索网络、管理飞书应用、执行命令等',
    ],
    suggestedActions: [
      '搜索今天的AI行业资讯',
      '帮我整理工作日程',
      '创建一个项目文档',
    ],
  },
  first_tool_use: {
    id: 'first_tool_use',
    trigger: 'tool_call_count >= 1',
    title: '工具调用入门',
    tips: [
      '很好！你已经看到了工具调用的效果',
      '我可以同时使用多个工具完成复杂任务',
      '如果工具调用失败，我会自动尝试替代方案',
    ],
    suggestedActions: [
      '查看我的技能列表',
      '搜索某个技术问题',
    ],
  },
  first_skill: {
    id: 'first_skill',
    trigger: 'skill_used',
    title: '技能系统',
    tips: [
      '技能是我可以执行的专业化任务模块',
      '你可以通过工作流组合多个技能',
      '我也可以根据需要自动生成新技能',
    ],
    suggestedActions: [
      '查看所有可用技能',
      '创建一个自定义工作流',
    ],
  },
  first_workflow: {
    id: 'first_workflow',
    trigger: 'workflow_created',
    title: '工作流进阶',
    tips: [
      '工作流可以自动化执行多步骤任务',
      '你可以设置定时任务来定期执行工作流',
      '工作流支持条件判断和错误处理',
    ],
    suggestedActions: [
      '创建一个定时任务',
      '查看工作流模板',
    ],
  },
  power_user: {
    id: 'power_user',
    trigger: 'interaction_count >= 20',
    title: '高级功能',
    tips: [
      '你可以使用@file:路径 来引用文件内容',
      '你可以使用@url:链接 来引用网页内容',
      '你可以使用@diff 来查看代码变更',
      '记忆系统会自动保存重要信息供后续使用',
    ],
    suggestedActions: [
      '查看我的记忆',
      '使用@file 引用一个文档',
    ],
  },
  enterprise_setup: {
    id: 'enterprise_setup',
    trigger: 'interaction_count >= 3',
    title: '企业智能体配置',
    tips: [
      '告诉我你的公司类型，我会自动配置最合适的智能体角色',
      '不同企业类型会激活不同的领域知识和专业能力',
      '智能体会根据你的使用习惯持续自我进化',
    ],
    suggestedActions: [
      '配置我的企业类型',
      '查看当前智能体配置',
    ],
  },
};

class OnboardingManager {
  constructor() {
    this.state = null;
    this._loadState();
    this._enhancer = new OnboardingEnhancer();
  }

  get enhancer() {
    return this._enhancer;
  }

  startEnterpriseOnboarding(userId) {
    return this._enhancer.startOnboarding(userId);
  }

  processEnterpriseInput(onboardingId, userInput) {
    return this._enhancer.processInput(onboardingId, userInput);
  }

  _loadState() {
    try {
      if (fs.existsSync(ONBOARDING_FILE)) {
        const data = fs.readFileSync(ONBOARDING_FILE, 'utf-8');
        this.state = JSON.parse(data);
      }
    } catch { console.warn('[onboarding] silent catch, error swallowed'); }
    if (!this.state) {
      this.state = {
        userId: null,
        interactionCount: 0,
        toolCallCount: 0,
        skillUsedCount: 0,
        workflowCreatedCount: 0,
        completedStages: [],
        currentStage: null,
        dismissedTips: [],
        firstInteractionAt: null,
        lastInteractionAt: null,
      };
    }
  }

  _saveState() {
    try {
      const dir = path.dirname(ONBOARDING_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(ONBOARDING_FILE, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch { console.warn('[onboarding] silent catch, error swallowed'); }
  }

  recordInteraction(userId) {
    this.state.userId = userId;
    this.state.interactionCount++;
    this.state.lastInteractionAt = Date.now();
    if (!this.state.firstInteractionAt) {
      this.state.firstInteractionAt = Date.now();
    }
    this._checkStageTransition();
    this._saveState();
  }

  recordToolCall() {
    this.state.toolCallCount++;
    this._checkStageTransition();
    this._saveState();
  }

  recordSkillUse() {
    this.state.skillUsedCount++;
    this._checkStageTransition();
    this._saveState();
  }

  recordWorkflowCreated() {
    this.state.workflowCreatedCount++;
    this._checkStageTransition();
    this._saveState();
  }

  _checkStageTransition() {
    const s = this.state;
    const completed = new Set(s.completedStages);

    if (!completed.has('first_message') && s.interactionCount >= 1) {
      s.completedStages.push('first_message');
    }
    if (!completed.has('first_tool_use') && s.toolCallCount >= 1) {
      s.completedStages.push('first_tool_use');
    }
    if (!completed.has('first_skill') && s.skillUsedCount >= 1) {
      s.completedStages.push('first_skill');
    }
    if (!completed.has('first_workflow') && s.workflowCreatedCount >= 1) {
      s.completedStages.push('first_workflow');
    }
    if (!completed.has('power_user') && s.interactionCount >= 20) {
      s.completedStages.push('power_user');
    }
    if (!completed.has('enterprise_setup') && s.interactionCount >= 3 && s.enterpriseProfileConfigured) {
      s.completedStages.push('enterprise_setup');
    }

    const stageOrder = ['first_message', 'first_tool_use', 'first_skill', 'first_workflow', 'enterprise_setup', 'power_user'];
    for (const stageId of stageOrder) {
      if (!completed.has(stageId)) {
        s.currentStage = stageId;
        return;
      }
    }
    s.currentStage = 'completed';
  }

  getCurrentOnboarding() {
    const stageId = this.state.currentStage;
    if (!stageId || stageId === 'completed') return null;

    const stage = ONBOARDING_STAGES[stageId];
    if (!stage) return null;

    const dismissed = new Set(this.state.dismissedTips);
    const tips = stage.tips.filter((_, i) => !dismissed.has(`${stageId}_tip_${i}`));
    const actions = stage.suggestedActions || [];

    if (tips.length === 0) return null;

    return {
      stageId,
      title: stage.title,
      tips,
      suggestedActions: actions,
      progress: this.state.completedStages.length,
      totalStages: Object.keys(ONBOARDING_STAGES).length,
    };
  }

  buildOnboardingPrompt() {
    const onboarding = this.getCurrentOnboarding();
    if (!onboarding) return '';

    const lines = [];
    lines.push(`## 新手引导 (${onboarding.progress}/${onboarding.totalStages})`);
    lines.push(`### ${onboarding.title}`);
    for (const tip of onboarding.tips) {
      lines.push(`- ${tip}`);
    }
    if (onboarding.suggestedActions.length > 0) {
      lines.push('');
      lines.push('你可以试试');
      for (const action of onboarding.suggestedActions) {
        lines.push(`  - "${action}"`);
      }
    }
    lines.push('');

    return lines.join('\n');
  }

  dismissTip(stageId, tipIndex) {
    const key = `${stageId}_tip_${tipIndex}`;
    if (!this.state.dismissedTips.includes(key)) {
      this.state.dismissedTips.push(key);
      this._saveState();
    }
  }

  skipOnboarding() {
    this.state.currentStage = 'completed';
    this.state.completedStages = Object.keys(ONBOARDING_STAGES);
    this._saveState();
  }

  isOnboardingComplete() {
    return this.state.currentStage === 'completed';
  }

  getStats() {
    return {
      interactionCount: this.state.interactionCount,
      toolCallCount: this.state.toolCallCount,
      skillUsedCount: this.state.skillUsedCount,
      workflowCreatedCount: this.state.workflowCreatedCount,
      completedStages: this.state.completedStages,
      currentStage: this.state.currentStage,
      firstInteractionAt: this.state.firstInteractionAt,
      lastInteractionAt: this.state.lastInteractionAt,
    };
  }

  reset() {
    this.state = {
      userId: null,
      interactionCount: 0,
      toolCallCount: 0,
      skillUsedCount: 0,
      workflowCreatedCount: 0,
      completedStages: [],
      currentStage: null,
      dismissedTips: [],
      firstInteractionAt: null,
      lastInteractionAt: null,
    };
    this._saveState();
  }
}

const globalOnboarding = new OnboardingManager();

module.exports = { OnboardingManager, globalOnboarding, ONBOARDING_STAGES };
