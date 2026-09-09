const { EventEmitter } = require('events');
const { EnterpriseTypeInferencer } = require('./enterprise-type-inferencer');
const { EnterpriseProfileLoader } = require('./enterprise-profile-loader');

const WIZARD_STEPS = {
  GREETING: 'greeting',
  BUSINESS_TYPE: 'business_type',
  INDUSTRY: 'industry',
  SCALE: 'scale',
  KEY_DOMAINS: 'key_domains',
  CONFIRM: 'confirm',
  COMPLETE: 'complete',
};

const BUSINESS_TYPES = [
  { id: 'ecommerce', name: '电商/零售', description: '在线销售、零售业务' },
  { id: 'saas', name: 'SaaS/软件', description: '软件即服务、技术产品' },
  { id: 'manufacturing', name: '制造/工厂', description: '生产制造、供应链' },
  { id: 'services', name: '咨询/服务', description: '专业服务、咨询顾问' },
  { id: 'finance', name: '金融/投资', description: '金融、投资、保险' },
  { id: 'education', name: '教育/培训', description: '在线教育、培训服务' },
];

const INDUSTRIES = [
  { id: 'internet', name: '互联网/科技' },
  { id: 'retail', name: '零售/消费品' },
  { id: 'manufacturing', name: '制造业' },
  { id: 'finance', name: '金融/银行' },
  { id: 'healthcare', name: '医疗/健康' },
  { id: 'education', name: '教育' },
  { id: 'realestate', name: '房地产/建筑' },
  { id: 'logistics', name: '物流/运输' },
  { id: 'media', name: '媒体/文化' },
  { id: 'agriculture', name: '农业/食品' },
  { id: 'energy', name: '能源/环保' },
  { id: 'government', name: '政府/公共事业' },
  { id: 'legal', name: '法律/合规' },
  { id: 'hospitality', name: '酒店/旅游' },
  { id: 'automotive', name: '汽车/出行' },
  { id: 'telecom', name: '通信/网络' },
  { id: 'entertainment', name: '娱乐/游戏' },
  { id: 'other', name: '其他' },
];

const SCALES = [
  { id: 'startup', name: '初创团队', description: '1-20人', range: [1, 20] },
  { id: 'small', name: '小型企业', description: '20-100人', range: [20, 100] },
  { id: 'medium', name: '中型企业', description: '100-500人', range: [100, 500] },
  { id: 'large', name: '大型企业', description: '500人以上', range: [500, Infinity] },
];

class EnterpriseWizard extends EventEmitter {
  constructor(config = {}) {
    super();
    this._inferencer = config.inferencer || new EnterpriseTypeInferencer();
    this._profileLoader = config.profileLoader || new EnterpriseProfileLoader();
    this._sessions = new Map();
    this._autoInfer = config.autoInfer !== false;
  }

  startSession(userId) {
    const sessionId = `wiz_${Date.now().toString(36)}`;
    const session = {
      id: sessionId,
      userId,
      currentStep: WIZARD_STEPS.GREETING,
      answers: {},
      inferredProfile: null,
      createdAt: Date.now(),
    };

    this._sessions.set(sessionId, session);
    this.emit('session:started', { sessionId, userId });

    return {
      sessionId,
      step: session.currentStep,
      message: this._getGreetingMessage(),
      options: this._getStepOptions(session.currentStep),
    };
  }

  processResponse(sessionId, userResponse) {
    const session = this._sessions.get(sessionId);
    if (!session) {
      return { error: 'Session not found', done: false };
    }

    const step = session.currentStep;
    session.answers[step] = userResponse;

    if (this._autoInfer && step === WIZARD_STEPS.GREETING) {
      const inference = this._inferencer.inferFromDescription(userResponse);
      if (inference.overallConfidence > 0.7) {
        session.inferredProfile = inference;
        session.answers[WIZARD_STEPS.BUSINESS_TYPE] = inference.type;
        session.answers[WIZARD_STEPS.INDUSTRY] = inference.industry;
        session.answers[WIZARD_STEPS.SCALE] = inference.scale;
        session.currentStep = WIZARD_STEPS.CONFIRM;

        return {
          sessionId,
          step: WIZARD_STEPS.CONFIRM,
          message: this._getConfirmMessage(session),
          inferredProfile: inference,
          options: [{ id: 'confirm', label: '确认' }, { id: 'adjust', label: '调整' }],
        };
      }
    }

    const nextStep = this._getNextStep(step, userResponse);
    session.currentStep = nextStep;

    if (nextStep === WIZARD_STEPS.COMPLETE) {
      return this._completeSession(sessionId);
    }

    return {
      sessionId,
      step: nextStep,
      message: this._getStepMessage(nextStep, session),
      options: this._getStepOptions(nextStep),
    };
  }

  completeWithInference(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session || !session.inferredProfile) {
      return { error: 'No inferred profile available' };
    }

    session.currentStep = WIZARD_STEPS.COMPLETE;
    return this._completeSession(sessionId);
  }

  adjustProfile(sessionId, field, value) {
    const session = this._sessions.get(sessionId);
    if (!session) return { error: 'Session not found' };

    session.answers[field] = value;

    if (session.inferredProfile) {
      session.inferredProfile[field] = value;
      session.inferredProfile.overallConfidence = 0.5;
    }

    return {
      sessionId,
      step: session.currentStep,
      message: this._getConfirmMessage(session),
      options: [{ id: 'confirm', label: '确认' }, { id: 'adjust', label: '继续调整' }],
    };
  }

  _completeSession(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return { error: 'Session not found' };

    const businessType = session.answers[WIZARD_STEPS.BUSINESS_TYPE];
    const industry = session.answers[WIZARD_STEPS.INDUSTRY];
    const scale = session.answers[WIZARD_STEPS.SCALE];
    const keyDomains = session.answers[WIZARD_STEPS.KEY_DOMAINS] || [];

    const profileKey = `${businessType}_${industry}_${scale}`;
    this._profileLoader.setProfile({ businessType, industry, scale, profileKey, keyDomains });
    const profile = this._profileLoader.getProfile();

    const result = {
      sessionId,
      step: WIZARD_STEPS.COMPLETE,
      done: true,
      profile: {
        businessType,
        industry,
        scale,
        keyDomains,
        profileKey,
        activatedDomains: profile ? (profile.customDomains && profile.customDomains.active ? profile.customDomains.active : keyDomains) : keyDomains,
        defaultCapabilities: [],
      },
    };

    this.emit('session:completed', { sessionId, profile: result.profile });
    return result;
  }

  _getNextStep(currentStep, _response) {
    switch (currentStep) {
      case WIZARD_STEPS.GREETING:
        return WIZARD_STEPS.BUSINESS_TYPE;
      case WIZARD_STEPS.BUSINESS_TYPE:
        return WIZARD_STEPS.INDUSTRY;
      case WIZARD_STEPS.INDUSTRY:
        return WIZARD_STEPS.SCALE;
      case WIZARD_STEPS.SCALE:
        return WIZARD_STEPS.KEY_DOMAINS;
      case WIZARD_STEPS.KEY_DOMAINS:
        return WIZARD_STEPS.CONFIRM;
      case WIZARD_STEPS.CONFIRM:
        return WIZARD_STEPS.COMPLETE;
      default:
        return WIZARD_STEPS.COMPLETE;
    }
  }

  _getGreetingMessage() {
    return '你好！我是 CrabPaw，你的 AI 智能助手。为了更好地为你服务，我需要了解一些关于你公司的基本信息。你可以直接描述你的公司，比如"我们是一家做电商的初创公司"，我会自动识别；或者我们可以一步步来。请告诉我你的公司是做什么的？';
  }

  _getStepMessage(step, session) {
    switch (step) {
      case WIZARD_STEPS.BUSINESS_TYPE:
        return '你的公司属于哪种业务类型？';
      case WIZARD_STEPS.INDUSTRY:
        return '你的公司属于哪个行业？';
      case WIZARD_STEPS.SCALE:
        return '你的公司规模如何？';
      case WIZARD_STEPS.KEY_DOMAINS:
        return '你最关注哪些领域？（可多选）';
      case WIZARD_STEPS.CONFIRM:
        return this._getConfirmMessage(session);
      default:
        return '';
    }
  }

  _getStepOptions(step) {
    switch (step) {
      case WIZARD_STEPS.GREETING:
        return null;
      case WIZARD_STEPS.BUSINESS_TYPE:
        return BUSINESS_TYPES;
      case WIZARD_STEPS.INDUSTRY:
        return INDUSTRIES;
      case WIZARD_STEPS.SCALE:
        return SCALES;
      case WIZARD_STEPS.KEY_DOMAINS:
        return null;
      default:
        return null;
    }
  }

  _getConfirmMessage(session) {
    const bt = BUSINESS_TYPES.find(b => b.id === session.answers[WIZARD_STEPS.BUSINESS_TYPE]);
    const ind = INDUSTRIES.find(i => i.id === session.answers[WIZARD_STEPS.INDUSTRY]);
    const sc = SCALES.find(s => s.id === session.answers[WIZARD_STEPS.SCALE]);

    const parts = [];
    if (bt) parts.push(`业务类型: ${bt.name}`);
    if (ind) parts.push(`行业: ${ind.name}`);
    if (sc) parts.push(`规模: ${sc.name}`);

    return `根据你的描述，我为你生成了以下配置：\n${parts.join('\n')}\n\n是否确认？`;
  }

  getSession(sessionId) {
    return this._sessions.get(sessionId) || null;
  }
}

module.exports = {
  EnterpriseWizard,
  WIZARD_STEPS,
  BUSINESS_TYPES,
  INDUSTRIES,
  SCALES,
};
