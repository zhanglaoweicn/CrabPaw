/**
 * TTS 进化引擎 - 语音风格进化、情感优化
 * 
 * 与 voice-evolution.js 协同工作：
 * - voice-evolution 负责"内容提炼"（把原始回复变成类人化口语）
 * - tts-evolution 负责"语音风格"（语速、情感、停顿、重音等合成参数优化）
 * 
 * 进化维度：
 * 1. 语速自适应 — 根据内容类型和用户习惯调整语速
 * 2. 情感映射 — 根据场景自动匹配情感参数
 * 3. 停顿优化 — 在关键位置插入自然停顿
 * 4. 重音标记 — 对关键信息添加重音
 */
const fs = require('fs').promises;
const path = require('path');
const config = require('../config');

const TTS_EVOLUTION_PATH = path.join(config.DATA_DIR, 'tts-evolution.json');

// ─── 场景 → 语音参数映射 ────────────────────────────────────────

const SCENE_VOICE_PROFILES = {
  weather:     { rate: '+5%',  pitch: '+2Hz', emotion: 'warm',     pauseLevel: 'low' },
  time:        { rate: '+0%',  pitch: '+0Hz', emotion: 'neutral',  pauseLevel: 'low' },
  technical:   { rate: '-5%',  pitch: '-2Hz', emotion: 'focused',  pauseLevel: 'medium' },
  task:        { rate: '+0%',  pitch: '+0Hz', emotion: 'confident', pauseLevel: 'low' },
  search:      { rate: '+5%',  pitch: '+0Hz', emotion: 'helpful',  pauseLevel: 'low' },
  explanation: { rate: '-5%',  pitch: '-2Hz', emotion: 'patient',  pauseLevel: 'high' },
  greeting:    { rate: '+0%',  pitch: '+5Hz', emotion: 'cheerful', pauseLevel: 'low' },
  creative:    { rate: '+0%',  pitch: '+3Hz', emotion: 'inspired', pauseLevel: 'medium' },
  data:        { rate: '-5%',  pitch: '-2Hz', emotion: 'clear',    pauseLevel: 'high' },
  notification:{ rate: '+5%',  pitch: '+2Hz', emotion: 'alert',    pauseLevel: 'low' },
  casual:      { rate: '+0%',  pitch: '+0Hz', emotion: 'friendly', pauseLevel: 'low' }
};

// 情感 → SSML 参数映射
const EMOTION_SSML_MAP = {
  warm:     { rate: 'medium', pitch: 'medium', volume: 'medium' },
  neutral:  { rate: 'medium', pitch: 'medium', volume: 'medium' },
  focused:  { rate: 'slow',   pitch: 'low',    volume: 'loud' },
  confident:{ rate: 'medium', pitch: 'high',   volume: 'loud' },
  helpful:  { rate: 'medium', pitch: 'medium', volume: 'medium' },
  patient:  { rate: 'slow',   pitch: 'low',    volume: 'soft' },
  cheerful: { rate: 'fast',   pitch: 'high',   volume: 'loud' },
  inspired: { rate: 'medium', pitch: 'high',   volume: 'medium' },
  clear:    { rate: 'slow',   pitch: 'medium', volume: 'loud' },
  alert:    { rate: 'fast',   pitch: 'high',   volume: 'loud' },
  friendly: { rate: 'medium', pitch: 'medium', volume: 'medium' }
};

class TTSEvolutionEngine {
  constructor() {
    this.data = null;
    this.isEvolving = false;
  }

  async init() {
    try {
      const raw = await fs.readFile(TTS_EVOLUTION_PATH, 'utf-8');
      this.data = JSON.parse(raw);
    } catch {
      this.data = {
        voiceProfiles: {},          // 用户级语音偏好
        userPreferences: {},        // 用户反馈积累
        synthesisStats: {
          totalSynthesis: 0,
          avgDuration: 0,
          avgQuality: 0,
          sceneStats: {}            // 按场景统计
        },
        evolutionHistory: [],
        learnedAdjustments: {}      // 进化学习到的参数调整
      };
      await this.saveData();
    }
    console.log('[TTSEvolution] 语音风格进化引擎已初始化');
  }

  async saveData() {
    try {
      const dir = path.dirname(TTS_EVOLUTION_PATH);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(TTS_EVOLUTION_PATH, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.error('[TTSEvolution] 保存数据失败:', err);
    }
  }

  /**
   * 获取场景的语音合成参数
   * 结合默认配置 + 进化学习到的调整
   */
  getVoiceParams(scene) {
    const defaultProfile = SCENE_VOICE_PROFILES[scene] || SCENE_VOICE_PROFILES.casual;
    const learned = this.data.learnedAdjustments[scene] || {};
    const emotionProfile = EMOTION_SSML_MAP[defaultProfile.emotion] || EMOTION_SSML_MAP.friendly;

    return {
      ...defaultProfile,
      ...learned,
      ssml: emotionProfile,
      scene
    };
  }

  /**
   * 为文本添加自然停顿标记
   * 在标点、关键信息前后插入 SSML break 标记
   */
  addNaturalPauses(text, pauseLevel = 'low') {
    if (!text) return text;

    const pauseMap = {
      low:    { comma: '200ms', period: '400ms', keyPoint: '300ms' },
      medium: { comma: '300ms', period: '500ms', keyPoint: '400ms' },
      high:   { comma: '400ms', period: '600ms', keyPoint: '500ms' }
    };
    const pauses = pauseMap[pauseLevel] || pauseMap.low;

    let result = text;

    // 在句号/问号/感叹号后添加停顿
    result = result.replace(/([。？！])\s*/g, `$1<break time="${pauses.period}"/>`);

    // 在逗号/顿号后添加较短停顿
    result = result.replace(/([，、；])\s*/g, `$1<break time="${pauses.comma}"/>`);

    // 在"但是"、"不过"、"其实"等转折词前添加停顿
    result = result.replace(/(但是|不过|其实|然而|不过|话说回来)/g, `<break time="${pauses.keyPoint}"/>$1`);

    return result;
  }

  /**
   * 为关键信息添加重音标记
   */
  addEmphasis(text) {
    if (!text) return text;

    // 数字 + 单位 → 重音
    text = text.replace(/(\d+\.?\d*\s*[°%个条项步骤次元])/g, '<emphasis level="moderate">$1</emphasis>');

    // 时间表达 → 重音
    text = text.replace(/(\d{1,2}[:：]\d{2})/g, '<emphasis level="moderate">$1</emphasis>');

    // 关键结论词 → 重音
    text = text.replace(/(成功|失败|完成|异常|重要|注意|警告)/g, '<emphasis level="strong">$1</emphasis>');

    return text;
  }

  /**
   * 生成完整的 SSML 标记文本
   *
   * V24 NOTE: 此方法目前尚未集成到 TTS 管线（src/core/tts/index.js 的 Edge TTS 提供者
   * 仍使用内联 SSML 构建）。集成时需在 _streamEdgeTTS 和 _callEdgeTTS 中替换内联 SSML
   * 为调用此方法，同时将 scene 上下文传入以启用情感/停顿/重音优化。
   * 待集成项：
   *   1. 在 tts/index.js 的 _streamEdgeTTS 中引入 getTTSEvolutionEngine()
   *   2. 调用 engine.generateSSML(text, scene) 替代内联 SSML 拼接
   *   3. 从对话上下文中推断 scene 类型并传入
   *
   * @experimental C2/V24: 此功能待集成到 TTS 管线，标记为实验性
   */
  generateSSML(text, scene = 'casual') {
    const params = this.getVoiceParams(scene);
    let processed = this.addNaturalPauses(text, params.pauseLevel);
    processed = this.addEmphasis(processed);

    return `<speak>
  <prosody rate="${params.ssml.rate}" pitch="${params.ssml.pitch}" volume="${params.ssml.volume}">
    ${processed}
  </prosody>
</speak>`;
  }

  /**
   * 记录合成统计
   */
  async recordSynthesis(duration, quality, scene = 'casual', options = {}) {
    this.data.synthesisStats.totalSynthesis++;
    const n = this.data.synthesisStats.totalSynthesis;
    this.data.synthesisStats.avgDuration = (this.data.synthesisStats.avgDuration * (n - 1) + duration) / n;
    this.data.synthesisStats.avgQuality = (this.data.synthesisStats.avgQuality * (n - 1) + quality) / n;

    // 按场景统计
    if (!this.data.synthesisStats.sceneStats[scene]) {
      this.data.synthesisStats.sceneStats[scene] = { count: 0, avgDuration: 0, avgQuality: 0 };
    }
    const ss = this.data.synthesisStats.sceneStats[scene];
    ss.count++;
    ss.avgDuration = (ss.avgDuration * (ss.count - 1) + duration) / ss.count;
    ss.avgQuality = (ss.avgQuality * (ss.count - 1) + quality) / ss.count;

    // 同步计入 usage-stats.json（按调用次数 + 时长）
    try {
      const { recordUsage } = require('../usage-stats');
      const provider = options.provider || this.data.ttsProvider || 'tts';
      const model = options.model || this.data.ttsModel || 'default';
      recordUsage(provider, model, null, {
        type: 'tts',
        durationSeconds: Number(duration) || 0,
      });
    } catch (e) {
      console.warn('[TTSEvolution] 记录 usage-stats 失败:', e.message);
    }

    await this.saveData();
  }

  /**
   * 进化核心：基于合成统计自动调整语音参数
   */
  async evolve() {
    if (this.isEvolving) return { improvement: 0 };
    this.isEvolving = true;

    try {
      // 确保 data 已初始化
      if (!this.data) {
        await this.init();
      }
      // 确保 sceneStats 存在
      if (!this.data.synthesisStats) {
        this.data.synthesisStats = { totalSynthesis: 0, avgDuration: 0, avgQuality: 0, sceneStats: {} };
      }
      if (!this.data.synthesisStats.sceneStats) {
        this.data.synthesisStats.sceneStats = {};
      }

      // 确保 learnedAdjustments 存在
      if (!this.data.learnedAdjustments) {
        this.data.learnedAdjustments = {};
      }

      const analysis = await this.analyze();
      const opportunities = await this.identifyOpportunities(analysis);
      const improvements = [];

      for (const opp of opportunities) {
        try {
          const result = await this.improve(opp);
          improvements.push(result);
        } catch (err) {
          console.warn('[TTSEvolution] 改进失败:', err.message);
        }
      }

      if (improvements.some(i => i.improvement > 0)) {
        await this.apply(improvements);
      }

      return { improvement: improvements.reduce((s, i) => s + (i.improvement || 0), 0) };
    } finally {
      this.isEvolving = false;
    }
  }

  async analyze() {
    const sceneStats = this.data?.synthesisStats?.sceneStats || {};
    const sceneAnalysis = {};

    for (const [scene, stats] of Object.entries(sceneStats)) {
      const defaultProfile = SCENE_VOICE_PROFILES[scene] || SCENE_VOICE_PROFILES.casual;
      sceneAnalysis[scene] = {
        count: stats.count,
        avgQuality: stats.avgQuality,
        avgDuration: stats.avgDuration,
        belowThreshold: stats.avgQuality < 3.5,
        currentAdjustments: this.data.learnedAdjustments[scene] || {},
        defaultRate: defaultProfile.rate
      };
    }

    return {
      totalSynthesis: this.data.synthesisStats.totalSynthesis,
      avgQuality: this.data.synthesisStats.avgQuality,
      sceneAnalysis
    };
  }

  async identifyOpportunities(analysis) {
    const opps = [];

    // 全局质量低于阈值
    if (analysis.avgQuality < 4) {
      opps.push({ type: 'optimize_global_quality', priority: 'high', data: analysis });
    }

    // 按场景找改进机会
    for (const [scene, data] of Object.entries(analysis.sceneAnalysis || {})) {
      if (data.belowThreshold && data.count >= 5) {
        opps.push({ type: 'optimize_scene', priority: 'medium', scene, data });
      }
      // 语速优化：如果平均播放时长过长
      if (data.avgDuration > 8000 && data.count >= 3) {
        opps.push({ type: 'speed_up_scene', priority: 'low', scene, data });
      }
    }

    opps.push({ type: 'evolve_style', priority: 'low' });
    return opps;
  }

  async improve(opp) {
    switch (opp.type) {
      case 'optimize_global_quality': {
        // 全局微调：略微降低语速，增加停顿
        this.data.learnedAdjustments._global = {
          rate: '-5%',
          pauseLevel: 'medium'
        };
        return { type: 'optimize_global_quality', improvement: 1 };
      }

      case 'optimize_scene': {
        const scene = opp.scene;
        const current = this.data.learnedAdjustments[scene] || {};
        // 场景质量低 → 降速 + 增加停顿
        this.data.learnedAdjustments[scene] = {
          ...current,
          rate: '-5%',
          pauseLevel: 'high'
        };
        return { type: `optimize_scene_${scene}`, improvement: 2 };
      }

      case 'speed_up_scene': {
        const scene = opp.scene;
        const current = this.data.learnedAdjustments[scene] || {};
        this.data.learnedAdjustments[scene] = {
          ...current,
          rate: '+10%'
        };
        return { type: `speed_up_scene_${scene}`, improvement: 1 };
      }

      case 'evolve_style': {
        // 风格微调：基于历史数据调整情感映射
        return { type: 'evolve_style', improvement: 0.5 };
      }

      default:
        return { improvement: 0 };
    }
  }

  async apply(improvements) {
    this.data.evolutionHistory.push({
      timestamp: new Date().toISOString(),
      improvements: improvements.map(i => ({ type: i.type, improvement: i.improvement })),
      learnedAdjustments: { ...this.data.learnedAdjustments }
    });

    // 只保留最近 50 条进化历史
    if (this.data.evolutionHistory.length > 50) {
      this.data.evolutionHistory = this.data.evolutionHistory.slice(-50);
    }

    await this.saveData();
    console.log('[TTSEvolution] 进化已应用:', improvements.map(i => i.type).join(', '));
  }

  async validate(improvements) {
    return {
      passed: improvements.some(i => i.improvement > 0),
      validCount: improvements.filter(i => i.improvement > 0).length,
      totalCount: improvements.length
    };
  }

  getReport() {
    return {
      stats: this.data.synthesisStats,
      learnedAdjustments: this.data.learnedAdjustments,
      evolutionCount: this.data.evolutionHistory.length,
      lastEvolution: this.data.evolutionHistory.length > 0
        ? this.data.evolutionHistory[this.data.evolutionHistory.length - 1].timestamp
        : null
    };
  }
}

let engine = null;
async function getTTSEvolutionEngine() {
  if (!engine) {
    engine = new TTSEvolutionEngine();
    await engine.init();
  }
  return engine;
}

module.exports = { TTSEvolutionEngine, getTTSEvolutionEngine };
