const { EventEmitter } = require('events');
const { ENTERPRISE_TYPES, ENTERPRISE_INDUSTRIES, ENTERPRISE_SCALES } = require('./enterprise-profile-loader');

const TYPE_SIGNALS = {
  manufacturing: {
    keywords: ['工厂', '制造', '生产', '车间', '产线', '加工', '制造型', 'factory', 'manufacturing', 'production'],
    indicators: ['qc', 'warehouse', 'rnd', 'procurement'],
  },
  service: {
    keywords: ['服务', '咨询', '培训', '外包', '服务型', 'service', 'consulting'],
    indicators: ['hr', 'planning', 'brand'],
  },
  trade: {
    keywords: ['贸易', '批发', '零售', '经销', '贸易型', 'trade', 'retail', 'wholesale'],
    indicators: ['warehouse', 'logistics', 'sales'],
  },
  technology: {
    keywords: ['科技', '技术', '软件', '互联网', 'AI', 'SaaS', '科技型', 'technology', 'software', 'internet'],
    indicators: ['tech', 'product'],
  },
  project: {
    keywords: ['项目', '工程', '建设', '施工', '项目型', 'project', 'engineering', 'construction'],
    indicators: ['procurement', 'planning'],
  },
  conglomerate: {
    keywords: ['集团', '多元化', '综合', '控股', '综合型', 'conglomerate', 'group', 'holding'],
    indicators: ['investment', 'strategy', 'brand'],
  },
};

const INDUSTRY_SIGNALS = {
  tech_internet: ['互联网', '平台', '电商', '社交', 'internet', 'platform', 'ecommerce'],
  tech_ai: ['人工智能', 'AI', '机器学习', '深度学习', '大模型', 'artificial intelligence', 'machine learning'],
  tech_saas: ['SaaS', '云服务', '订阅', 'SaaS', 'cloud', 'subscription'],
  manufacturing_auto: ['汽车', '整车', '零部件', 'automobile', 'auto', 'vehicle'],
  manufacturing_food: ['食品', '饮料', '餐饮', 'food', 'beverage'],
  manufacturing_electronics: ['电子', '芯片', '半导体', 'electronics', 'semiconductor', 'chip'],
  trade_retail: ['零售', '门店', '商超', 'retail', 'store'],
  trade_crossborder: ['跨境', '进出口', '外贸', 'crossborder', 'import', 'export'],
  service_consulting: ['咨询', '顾问', '咨询公司', 'consulting', 'advisory'],
  service_education: ['教育', '培训', '学校', 'education', 'training'],
  finance_banking: ['银行', '金融', '信贷', 'banking', 'finance'],
  finance_insurance: ['保险', '理赔', 'insurance'],
  healthcare_pharma: ['医药', '制药', '生物', 'pharmaceutical', 'pharma', 'biotech'],
  healthcare_hospital: ['医院', '医疗', '临床', 'hospital', 'healthcare'],
  realestate_development: ['房地产', '楼盘', '地产', 'real estate', 'property'],
  energy_new: ['新能源', '光伏', '风电', '储能', 'new energy', 'solar', 'wind'],
  logistics_express: ['快递', '物流', '配送', 'express', 'logistics'],
  media_content: ['传媒', '内容', '影视', 'media', 'content', 'entertainment'],
};

const SCALE_SIGNALS = {
  small: ['小公司', '创业', '初创', '几个人', 'startup', 'small', '10人', '20人', '30人', '50人以下'],
  medium: ['中型', '百人', '几十人', 'medium', '100人', '200人', '500人'],
  large: ['大型', '千人', '万人', '集团', '上市公司', 'large', '1000人', '5000人', '10000人'],
};

class EnterpriseTypeInferencer extends EventEmitter {
  // eslint-disable-next-line no-unused-vars
  constructor(config = {}) {
    super();
  }

  inferFromConversation(messages) {
    const text = (messages || []).map(m => typeof m === 'string' ? m : (m.content || '')).join(' ').toLowerCase();

    const typeResult = this._inferType(text);
    const industryResult = this._inferIndustry(text, typeResult.typeId);
    const scaleResult = this._inferScale(text);

    const result = {
      type: typeResult.typeId,
      typeConfidence: typeResult.confidence,
      industry: industryResult.industryId,
      industryConfidence: industryResult.confidence,
      scale: scaleResult.scaleId,
      scaleConfidence: scaleResult.confidence,
      overallConfidence: (typeResult.confidence + industryResult.confidence + scaleResult.confidence) / 3,
      signals: {
        type: typeResult.signals,
        industry: industryResult.signals,
        scale: scaleResult.signals,
      },
    };

    this.emit('infer:complete', result);
    return result;
  }

  inferFromDescription(description) {
    return this.inferFromConversation([description]);
  }

  _inferType(text) {
    const scores = {};

    for (const [typeId, signals] of Object.entries(TYPE_SIGNALS)) {
      let score = 0;
      const matched = [];

      for (const kw of signals.keywords) {
        if (text.includes(kw.toLowerCase())) {
          score += kw.length;
          matched.push(kw);
        }
      }

      if (score > 0) {
        scores[typeId] = { score, signals: matched };
      }
    }

    if (Object.keys(scores).length === 0) {
      return { typeId: 'technology', confidence: 0.3, signals: [] };
    }

    const sorted = Object.entries(scores).sort((a, b) => b[1].score - a[1].score);
    const best = sorted[0];

    return {
      typeId: best[0],
      confidence: Math.min(best[1].score / 20, 1.0),
      signals: best[1].signals,
    };
  }

  _inferIndustry(text, typeId) {
    const scores = {};
    const relevantIndustries = Object.entries(INDUSTRY_SIGNALS).filter(([id]) => {
      const industryDef = ENTERPRISE_INDUSTRIES[id];
      return !typeId || !industryDef || industryDef.parentType === typeId;
    });

    for (const [industryId, keywords] of relevantIndustries) {
      let score = 0;
      const matched = [];

      for (const kw of keywords) {
        if (text.includes(kw.toLowerCase())) {
          score += kw.length;
          matched.push(kw);
        }
      }

      if (score > 0) {
        scores[industryId] = { score, signals: matched };
      }
    }

    if (Object.keys(scores).length === 0) {
      const defaultIndustry = Object.entries(ENTERPRISE_INDUSTRIES).find(
        ([, v]) => v.parentType === typeId
      );
      return {
        industryId: defaultIndustry ? defaultIndustry[0] : 'tech_internet',
        confidence: 0.2,
        signals: [],
      };
    }

    const sorted = Object.entries(scores).sort((a, b) => b[1].score - a[1].score);
    const best = sorted[0];

    return {
      industryId: best[0],
      confidence: Math.min(best[1].score / 15, 1.0),
      signals: best[1].signals,
    };
  }

  _inferScale(text) {
    const scores = {};

    for (const [scaleId, keywords] of Object.entries(SCALE_SIGNALS)) {
      let score = 0;
      const matched = [];

      for (const kw of keywords) {
        if (text.includes(kw.toLowerCase())) {
          score += kw.length;
          matched.push(kw);
        }
      }

      if (score > 0) {
        scores[scaleId] = { score, signals: matched };
      }
    }

    if (Object.keys(scores).length === 0) {
      return { scaleId: 'medium', confidence: 0.3, signals: [] };
    }

    const sorted = Object.entries(scores).sort((a, b) => b[1].score - a[1].score);
    const best = sorted[0];

    return {
      scaleId: best[0],
      confidence: Math.min(best[1].score / 10, 1.0),
      signals: best[1].signals,
    };
  }

  generateClarificationQuestions(inference) {
    const questions = [];

    if (inference.typeConfidence < 0.5) {
      questions.push({
        id: 'type',
        question: '贵公司的主要业务类型是什么？',
        options: Object.values(ENTERPRISE_TYPES).map(t => ({
          value: t.id,
          label: t.name,
          description: t.description,
        })),
      });
    }

    if (inference.industryConfidence < 0.5) {
      const relevantIndustries = Object.values(ENTERPRISE_INDUSTRIES).filter(
        i => i.parentType === inference.type
      );

      if (relevantIndustries.length > 0) {
        questions.push({
          id: 'industry',
          question: '贵公司属于哪个行业？',
          options: relevantIndustries.map(i => ({
            value: i.id,
            label: i.name,
          })),
        });
      }
    }

    if (inference.scaleConfidence < 0.5) {
      questions.push({
        id: 'scale',
        question: '贵公司的规模大约是？',
        options: Object.values(ENTERPRISE_SCALES).map(s => ({
          value: s.id,
          label: s.name,
        })),
      });
    }

    return questions;
  }
}

module.exports = { EnterpriseTypeInferencer };
