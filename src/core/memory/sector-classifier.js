const SECTORS = ['episodic', 'semantic', 'procedural', 'emotional', 'reflective'];

const PATTERNS = {
  episodic: [
    'happened', 'occurred', '事件', 'occurrence', 'incident', '当时', '那天',
    '昨天', '今天', '刚才', 'after that', 'then', 'later', 'earlier', '之前',
    'next', 'last week', 'yesterday', 'this morning', 'this afternoon',
    'at that time', 'when i', 'during', 'session', '对话中', '遇到了',
    'we discussed', 'we talked', 'we met', 'meeting',
  ],
  semantic: [
    'fact', 'is a', 'are', 'means', 'refers to', 'defined as',
    '事实', '定义', '含义', '是指', '指的是', '属于', '类别',
    '特性', '属性', '特征', '类型', '种类', '偏好', 'prefer',
    'preference', '喜欢', '爱好', 'allergic', '过敏', '禁忌',
    'known as', 'also called', 'aka', '本质',
    'user', 'person', 'people', '他们', '用户', '他', '她',
  ],
  procedural: [
    'how to', 'steps', '流程', '步骤', '方法', '办法', '教程',
    'guide', 'tutorial', 'workflow', 'pipeline', 'recipe',
    '技巧', '技能', 'skill', 'technique', '诀窍', 'implementation',
    'implement', 'configure', 'setup', 'install', 'deploy',
    'usage', 'use', 'using', 'how do i', 'how can i',
    '代码', 'code', 'function', 'api', 'command', '指令',
  ],
  emotional: [
    'feel', 'feeling', 'felt', '情感', '感受', '感觉', '情绪',
    'happy', 'sad', 'angry', 'frustrated', 'excited', 'worried',
    '喜欢', '讨厌', '烦', '开心', '难过', '生气', '焦虑',
    '紧张', '放松', '满意', '不满', '失望', '希望',
    'hope', 'wish', 'regret', 'appreciate', '感恩', '感谢',
    'love', 'hate', 'dislike', 'enjoy', 'enjoyed',
    'mood', 'attitude', 'tone', 'vibe', '氛围',
  ],
  reflective: [
    'realize', 'realized', '意识到', '明白', '理解', '领悟',
    'insight', '洞察', '反思', '反省', '思考', 'think',
    'learned', '学到', 'lesson', '经验', 'experience',
    'meta', 'overall', 'summary', '总结', '概括',
    'pattern', '模式', '规律', '趋势', 'trend',
    'improvement', '改进', '成长', 'growth', '进步',
  ],
};

const SECTOR_DECAY_RATES = {
  episodic: 0.015,
  semantic: 0.005,
  procedural: 0.008,
  emotional: 0.020,
  reflective: 0.001,
};

const SECTOR_IMPORTANCE_WEIGHTS = {
  episodic: 1.2,
  semantic: 1.0,
  procedural: 1.1,
  emotional: 1.3,
  reflective: 0.8,
};

class SectorClassifier {
  classify(text) {
    if (!text) return { primary: 'semantic', secondary: null, scores: {} };

    const lower = text.toLowerCase();
    const scores = {};

    for (const [sector, patterns] of Object.entries(PATTERNS)) {
      scores[sector] = 0;
      for (const pat of patterns) {
        if (lower.includes(pat.toLowerCase())) {
          scores[sector] += 1;
        }
      }
      scores[sector] /= Math.max(1, patterns.length);
    }

    const sorted = Object.entries(scores).sort(([, a], [, b]) => b - a);
    const primary = sorted[0][0];
    const secondary = sorted.length > 1 && sorted[1][1] > 0 ? sorted[1][0] : null;

    return { primary, secondary, scores };
  }

  getDecayRate(sector) {
    return SECTOR_DECAY_RATES[sector] || SECTOR_DECAY_RATES.semantic;
  }

  getImportanceWeight(sector) {
    return SECTOR_IMPORTANCE_WEIGHTS[sector] || 1.0;
  }

  getSectors() {
    return [...SECTORS];
  }
}

const _defaultClassifier = new SectorClassifier();

function classifyMemory(text) {
  return _defaultClassifier.classify(text);
}

function getDecayRate(sector) {
  return _defaultClassifier.getDecayRate(sector);
}

function getImportanceWeight(sector) {
  return _defaultClassifier.getImportanceWeight(sector);
}

module.exports = {
  SectorClassifier,
  classifyMemory,
  getDecayRate,
  getImportanceWeight,
  SECTORS,
};
