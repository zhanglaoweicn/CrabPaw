const { EventEmitter } = require('events');
const { EnterpriseWizard, WIZARD_STEPS } = require('./enterprise-wizard');
const { EnterpriseProfileLoader } = require('./enterprise-profile-loader');
const { DomainRegistry } = require('./domain-registry');
const { CapabilityRegistry } = require('./capability-registry');

const ONBOARDING_PHASES = {
  WELCOME: 'welcome',
  QUICK_SETUP: 'quick_setup',
  PROFILE_CONFIRM: 'profile_confirm',
  FIRST_TASK: 'first_task',
  GUIDED_TOUR: 'guided_tour',
  COMPLETE: 'complete',
};

class OnboardingEnhancer extends EventEmitter {
  constructor(config = {}) {
    super();
    this._wizard = config.wizard || new EnterpriseWizard();
    this._profileLoader = config.profileLoader || new EnterpriseProfileLoader();
    this._domainRegistry = config.domainRegistry || new DomainRegistry();
    this._capabilityRegistry = config.capabilityRegistry || new CapabilityRegistry();
    this._sessions = new Map();
    this._quickSetupEnabled = config.quickSetupEnabled !== false;
  }

  startOnboarding(userId) {
    const onboardingId = `onb_${Date.now().toString(36)}`;
    const session = {
      id: onboardingId,
      userId,
      phase: ONBOARDING_PHASES.WELCOME,
      wizardSessionId: null,
      profile: null,
      suggestedTasks: [],
      completedSteps: [],
      createdAt: Date.now(),
    };

    this._sessions.set(onboardingId, session);
    this.emit('onboarding:started', { onboardingId, userId });

    return {
      onboardingId,
      phase: ONBOARDING_PHASES.WELCOME,
      message: this._getWelcomeMessage(),
      actions: this._getWelcomeActions(),
    };
  }

  processInput(onboardingId, userInput) {
    const session = this._sessions.get(onboardingId);
    if (!session) return { error: 'Onboarding session not found' };

    switch (session.phase) {
      case ONBOARDING_PHASES.WELCOME:
        return this._handleWelcome(session, userInput);
      case ONBOARDING_PHASES.QUICK_SETUP:
        return this._handleQuickSetup(session, userInput);
      case ONBOARDING_PHASES.PROFILE_CONFIRM:
        return this._handleProfileConfirm(session, userInput);
      case ONBOARDING_PHASES.FIRST_TASK:
        return this._handleFirstTask(session, userInput);
      case ONBOARDING_PHASES.GUIDED_TOUR:
        return this._handleGuidedTour(session, userInput);
      default:
        return { error: 'Invalid phase' };
    }
  }

  _handleWelcome(session, userInput) {
    if (this._quickSetupEnabled && userInput && userInput.trim().length > 10) {
      session.phase = ONBOARDING_PHASES.QUICK_SETUP;
      const wizardResult = this._wizard.startSession(session.userId);
      session.wizardSessionId = wizardResult.sessionId;

      const quickResult = this._wizard.processResponse(wizardResult.sessionId, userInput);

      if (quickResult.inferredProfile) {
        session.profile = quickResult.inferredProfile;
        session.phase = ONBOARDING_PHASES.PROFILE_CONFIRM;

        return {
          onboardingId: session.id,
          phase: ONBOARDING_PHASES.PROFILE_CONFIRM,
          message: quickResult.message,
          profile: quickResult.inferredProfile,
          actions: quickResult.options,
        };
      }

      return {
        onboardingId: session.id,
        phase: ONBOARDING_PHASES.QUICK_SETUP,
        message: quickResult.message,
        actions: quickResult.options,
      };
    }

    session.phase = ONBOARDING_PHASES.QUICK_SETUP;
    const wizardResult = this._wizard.startSession(session.userId);
    session.wizardSessionId = wizardResult.sessionId;

    return {
      onboardingId: session.id,
      phase: ONBOARDING_PHASES.QUICK_SETUP,
      message: wizardResult.message,
      actions: wizardResult.options,
    };
  }

  _handleQuickSetup(session, userInput) {
    const result = this._wizard.processResponse(session.wizardSessionId, userInput);

    if (result.step === WIZARD_STEPS.CONFIRM || result.done) {
      session.profile = result.profile;
      session.phase = ONBOARDING_PHASES.PROFILE_CONFIRM;
    }

    return {
      onboardingId: session.id,
      phase: session.phase,
      message: result.message,
      actions: result.options,
      profile: result.profile || session.profile,
    };
  }

  _handleProfileConfirm(session, userInput) {
    if (userInput === 'confirm' || userInput === '确认') {
      session.phase = ONBOARDING_PHASES.FIRST_TASK;
      const suggestions = this._generateTaskSuggestions(session.profile);

      return {
        onboardingId: session.id,
        phase: ONBOARDING_PHASES.FIRST_TASK,
        message: '太好了！配置完成。你可以试试以下任务来体验 CrabPaw 的能力：',
        suggestedTasks: suggestions,
      };
    }

    return {
      onboardingId: session.id,
      phase: ONBOARDING_PHASES.QUICK_SETUP,
      message: '好的，让我们重新调整配置。请选择你的业务类型：',
      actions: this._wizard._getStepOptions(WIZARD_STEPS.BUSINESS_TYPE),
    };
  }

  _handleFirstTask(session, _userInput) {
    session.completedSteps.push('first_task');
    session.phase = ONBOARDING_PHASES.GUIDED_TOUR;

    return {
      onboardingId: session.id,
      phase: ONBOARDING_PHASES.GUIDED_TOUR,
      message: '很好！你还可以了解以下功能：',
      tourItems: this._getTourItems(),
    };
  }

  _handleGuidedTour(session, _userInput) {
    session.completedSteps.push('guided_tour');
    session.phase = ONBOARDING_PHASES.COMPLETE;

    this.emit('onboarding:completed', {
      onboardingId: session.id,
      userId: session.userId,
      profile: session.profile,
    });

    return {
      onboardingId: session.id,
      phase: ONBOARDING_PHASES.COMPLETE,
      done: true,
      message: '设置完成！CrabPaw 已经根据你的企业类型配置好了智能体。你可以随时开始对话，我会自动匹配最合适的角色来帮你。',
      profile: session.profile,
    };
  }

  _generateTaskSuggestions(profile) {
    const suggestions = [];
    const domains = profile?.activatedDomains || ['tech'];

    const taskTemplates = {
      tech: { name: '代码审查', description: '让技术智能体帮你审查代码', capability: 'reviewer' },
      marketing: { name: '市场分析', description: '生成市场分析报告', capability: 'analyst' },
      finance: { name: '财务报表', description: '分析财务数据', capability: 'analyst' },
      legal: { name: '合同审查', description: '审查合同条款', capability: 'reviewer' },
      hr: { name: '招聘需求', description: '生成岗位描述', capability: 'writer' },
      operations: { name: '流程优化', description: '分析运营流程', capability: 'analyst' },
      sales: { name: '客户分析', description: '分析客户数据', capability: 'analyst' },
      product: { name: '需求分析', description: '整理产品需求', capability: 'researcher' },
    };

    for (const domainId of domains) {
      const template = taskTemplates[domainId];
      if (template) {
        suggestions.push({ ...template, domainId });
      }
    }

    if (suggestions.length === 0) {
      suggestions.push(taskTemplates.tech);
    }

    return suggestions.slice(0, 3);
  }

  _getTourItems() {
    return [
      { name: '多角色协作', description: '不同任务自动分配不同专业角色' },
      { name: '流程模板', description: '常见业务流程一键执行' },
      { name: '自我进化', description: '智能体随使用不断优化' },
      { name: '领域知识', description: '内置行业专业知识' },
    ];
  }

  _getWelcomeMessage() {
    return '欢迎来到 CrabPaw！我可以根据你的企业类型自动配置最合适的智能体。你可以直接告诉我你的公司情况，或者我们一步步来设置。';
  }

  _getWelcomeActions() {
    return [
      { id: 'quick', label: '快速描述公司' },
      { id: 'step_by_step', label: '逐步设置' },
    ];
  }

  getSession(onboardingId) {
    return this._sessions.get(onboardingId) || null;
  }
}

module.exports = { OnboardingEnhancer, ONBOARDING_PHASES };
