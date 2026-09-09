/**
 * Skin Engine - UI 主题定制引擎
 * 
 * 特性:
 * - YAML/JSON 定义皮肤
 * - 语义化颜色键（UI 元素直接绑定）
 * - Spinner 场景区分（等待/思考/动词/翅膀）
 * - 品牌交互文本定制
 * - 用户自定义皮肤（继承 default 最小覆盖）
 */

const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const { getCrabPawSubDir } = require('../path-utils');

// ── 默认皮肤的颜色/Spinner/品牌定义 ──

const DEFAULT_COLORS = {
  // 语义化 UI 颜色（直接绑定 UI 元素）
  banner_border:    '#00D4AA',
  banner_title:     '#00FFCC',
  banner_accent:    '#F59E0B',
  banner_dim:       '#6B7280',
  banner_text:      '#E5E7EB',
  ui_accent:        '#00D4AA',
  ui_label:         '#6366F1',
  ui_ok:            '#10B981',
  ui_error:         '#EF4444',
  ui_warn:          '#F59E0B',
  prompt:           '#00D4AA',
  input_rule:       '#374151',
  response_border:  '#00D4AA',
  session_label:    '#F59E0B',
  session_border:   '#4B5563',
  // 抽象颜色（向后兼容）
  primary:          '#00D4AA',
  secondary:        '#6366F1',
  accent:           '#F59E0B',
  success:          '#10B981',
  warning:          '#F59E0B',
  error:            '#EF4444',
  info:             '#3B82F6',
  text:             '#E5E7EB',
  textMuted:        '#9CA3AF',
  background:       '#1F2937',
  backgroundAlt:    '#111827',
  border:           '#374151',
};

const DEFAULT_SPINNER = {
  interval: 80,
  // 场景区分：等待 API 响应
  waiting_faces: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  // 场景区分：模型推理中
  thinking_faces: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  // 动词：旋转消息中显示的动作词
  thinking_verbs: ['思考中', '分析中', '计算中', '推理中'],
  // 翅膀：装饰性括号对
  wings: [['🦀 ', ' 🦀'], ['🐚 ', ' 🐚']],
  // 向后兼容
  type: 'dots',
  frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
};

const DEFAULT_BRANDING = {
  name: 'CrabPaw',
  tagline: '智能助手',
  version: '1.0.0',
  // 交互文本定制
  welcome:        '欢迎来到 CrabPaw！输入消息或 /help 查看命令。',
  goodbye:        '再见！🦀',
  response_label: '🦀 CrabPaw',
  prompt_symbol:  '❯ ',
  help_header:    '(🦀) 可用命令',
};

const DEFAULT_TOOL_EMOJIS = {
  read: '📖', write: '✏️', search: '🔍', execute: '⚡',
  web: '🌐', think: '💭', code: '💻', file: '📄',
  folder: '📁', default: '🔧',
};

// ── 内置皮肤 ──

const BUILTIN_SKINS = {
  default: {
    name: 'default',
    description: 'CrabPaw 默认主题 — 青绿与可爱风',
    colors: { ...DEFAULT_COLORS },
    spinner: { ...DEFAULT_SPINNER },
    branding: { ...DEFAULT_BRANDING },
    toolPrefix: '┊',
    toolEmojis: { ...DEFAULT_TOOL_EMOJIS },
    bannerLogo: `
  ██████╗ █████╗ ███████╗███████╗██████╗  █████╗ ███████╗████████╗
 ██╔════╝██╔══██╗██╔════╝██╔════╝██╔══██╗██╔══██╗██╔════╝╚══██╔══╝
 ██║     ███████║███████╗█████╗  ██████╔╝███████║███████╗   ██║   
 ██║     ██╔══██║╚════██║██╔══╝  ██╔══██╗██╔══██║╚════██║   ██║   
 ╚██████╗██║  ██║███████║███████╗██║  ██║██║  ██║███████║   ██║   
  ╚═════╝╚═╝  ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝   ╚═╝   
`,
    bannerHero: '',
  },

  warrior: {
    name: 'warrior',
    description: '战神主题 — 深红与青铜色，攻击性动词',
    colors: {
      banner_border: '#8B0000', banner_title: '#FFD700', banner_accent: '#CD7F32',
      banner_dim: '#6B4423', banner_text: '#FFF8DC',
      ui_accent: '#CD7F32', ui_label: '#DAA520', ui_ok: '#228B22',
      ui_error: '#FF4500', ui_warn: '#FF8C00',
      prompt: '#FFD700', input_rule: '#8B4513',
      response_border: '#CD7F32', session_label: '#DAA520', session_border: '#8B8682',
      primary: '#CD7F32', secondary: '#8B0000', accent: '#FFD700',
      success: '#228B22', warning: '#FF8C00', error: '#FF4500', info: '#DAA520',
      text: '#FFF8DC', textMuted: '#D2B48C',
      background: '#1C1008', backgroundAlt: '#0F0A04', border: '#5C3A1E',
    },
    spinner: {
      interval: 100,
      waiting_faces: ['(⚔)', '(⛨)', '(▲)'],
      thinking_faces: ['(⚔)', '(⌁)', '(<>)'],
      thinking_verbs: ['锻造中', '行军中', '淬火中', '冲锋中'],
      wings: [['⟪⚔', '⚔⟫'], ['⟪▲', '▲⟫']],
      type: 'warrior',
      frames: ['(⚔)', '(⛨)', '(▲)'],
    },
    branding: {
      name: 'Warrior Agent', tagline: '战神之锤',
      welcome: '战士，你的指令？输入消息或 /help 查看命令。',
      goodbye: '战场见！⚔', response_label: '⚔ Warrior',
      prompt_symbol: '⚔ ❯ ', help_header: '(⚔) 可用命令',
    },
    toolPrefix: '⚔',
    toolEmojis: {
      read: '📜', write: '⚒', search: '🔍', execute: '⚔',
      web: '🌐', think: '🧠', code: '🗡', file: '📋',
      folder: '📁', default: '⚔',
    },
    bannerLogo: `
  ██╗    ██╗ █████╗ ██╗   ██╗███████╗██████╗ 
  ██║    ██║██╔══██╗██║   ██║██╔════╝██╔══██╗
  ██║ █╗ ██║███████║██║   ██║█████╗  ██████╔╝
  ██║███╗██║██╔══██║╚██╗ ██╔╝██╔══╝  ██╔══██╗
  ╚███╔███╔╝██║  ██║ ╚████╔╝ ███████╗██║  ██║
   ╚══╝╚══╝ ╚═╝  ╚═╝  ╚═══╝  ╚══════╝╚═╝  ╚═╝
`,
    bannerHero: '',
  },

  ocean: {
    name: 'ocean',
    description: '海神主题 — 深蓝与海绿色，海洋动词',
    colors: {
      banner_border: '#0369A1', banner_title: '#22D3EE', banner_accent: '#06B6D4',
      banner_dim: '#0C4A6E', banner_text: '#E0F2FE',
      ui_accent: '#0EA5E9', ui_label: '#06B6D4', ui_ok: '#10B981',
      ui_error: '#EF4444', ui_warn: '#F59E0B',
      prompt: '#22D3EE', input_rule: '#0369A1',
      response_border: '#0EA5E9', session_label: '#06B6D4', session_border: '#0C4A6E',
      primary: '#0EA5E9', secondary: '#06B6D4', accent: '#22D3EE',
      success: '#10B981', warning: '#F59E0B', error: '#EF4444', info: '#3B82F6',
      text: '#E0F2FE', textMuted: '#7DD3FC',
      background: '#0C4A6E', backgroundAlt: '#082F49', border: '#0369A1',
    },
    spinner: {
      interval: 100,
      waiting_faces: ['🌊', '🐋', '🐠'],
      thinking_faces: ['🌊', '🌀', '🐟'],
      thinking_verbs: ['绘制洋流', '探测深度', '追踪潮汐', '导航中'],
      wings: [['⟨🌊', '🌊⟩'], ['⟨🐚', '🐚⟩']],
      type: 'wave',
      frames: ['🌊', '🐋', '🐠'],
    },
    branding: {
      name: 'Poseidon Agent', tagline: '深海探索',
      welcome: '航海者，海洋已就绪。输入消息或 /help 查看命令。',
      goodbye: '顺风航行！🌊', response_label: '🔱 Poseidon',
      prompt_symbol: '🌊 ❯ ', help_header: '(🔱) 可用命令',
    },
    toolPrefix: '🌊',
    toolEmojis: {
      read: '🐚', write: '🦀', search: '🔭', execute: '⚡',
      web: '🛟', think: '🐋', code: '🐙', file: '📄',
      folder: '📁', default: '⚓',
    },
    bannerLogo: '',
    bannerHero: '',
  },

  forest: {
    name: 'forest',
    description: '森林绿色主题 — 自然生长动词',
    colors: {
      banner_border: '#166534', banner_title: '#22C55E', banner_accent: '#84CC16',
      banner_dim: '#14532D', banner_text: '#ECFDF5',
      ui_accent: '#22C55E', ui_label: '#16A34A', ui_ok: '#10B981',
      ui_error: '#DC2626', ui_warn: '#EAB308',
      prompt: '#22C55E', input_rule: '#166534',
      response_border: '#22C55E', session_label: '#16A34A', session_border: '#166534',
      primary: '#22C55E', secondary: '#16A34A', accent: '#84CC16',
      success: '#10B981', warning: '#EAB308', error: '#DC2626', info: '#059669',
      text: '#ECFDF5', textMuted: '#86EFAC',
      background: '#14532D', backgroundAlt: '#052E16', border: '#166534',
    },
    spinner: {
      interval: 120,
      waiting_faces: ['🌱', '🌿', '🌳'],
      thinking_faces: ['🌱', '🍃', '🌾'],
      thinking_verbs: ['生长中', '培育中', '扎根中', '绽放中'],
      wings: [['⟨🌿', '🌿⟩'], ['⟨🍃', '🍃⟩']],
      type: 'grow',
      frames: ['🌱', '🌿', '🌳'],
    },
    branding: {
      name: 'CrabPaw Forest', tagline: '自然智慧',
      welcome: '欢迎来到森林！输入消息或 /help 查看命令。',
      goodbye: '自然与你同在！🌿', response_label: '🌿 Forest',
      prompt_symbol: '🌿 ❯ ', help_header: '(🌿) 可用命令',
    },
    toolPrefix: '🌿',
    toolEmojis: {
      read: '🍃', write: '🌲', search: '🔎', execute: '⚡',
      web: '🌐', think: '🌻', code: '🎋', file: '📄',
      folder: '📁', default: '🌿',
    },
    bannerLogo: '',
    bannerHero: '',
  },

  midnight: {
    name: 'midnight',
    description: '午夜深色主题 — 星空与梦境',
    colors: {
      banner_border: '#312E81', banner_title: '#A78BFA', banner_accent: '#C084FC',
      banner_dim: '#1E1B4B', banner_text: '#F3E8FF',
      ui_accent: '#A78BFA', ui_label: '#8B5CF6', ui_ok: '#34D399',
      ui_error: '#F87171', ui_warn: '#FBBF24',
      prompt: '#A78BFA', input_rule: '#312E81',
      response_border: '#8B5CF6', session_label: '#C084FC', session_border: '#312E81',
      primary: '#A78BFA', secondary: '#8B5CF6', accent: '#C084FC',
      success: '#34D399', warning: '#FBBF24', error: '#F87171', info: '#60A5FA',
      text: '#F3E8FF', textMuted: '#C4B5FD',
      background: '#1E1B4B', backgroundAlt: '#0F0D24', border: '#312E81',
    },
    spinner: {
      interval: 150,
      waiting_faces: ['🌙', '✨', '💫'],
      thinking_faces: ['🌙', '🔮', '⭐'],
      thinking_verbs: ['观星中', '解梦中', '占卜中', '冥想中'],
      wings: [['⟨🌙', '🌙⟩'], ['⟨✨', '✨⟩']],
      type: 'moon',
      frames: ['🌙', '✨', '💫'],
    },
    branding: {
      name: 'CrabPaw Midnight', tagline: '深夜思考',
      welcome: '夜已深，思绪正浓。输入消息或 /help 查看命令。',
      goodbye: '好梦！🌙', response_label: '🌙 Midnight',
      prompt_symbol: '🌙 ❯ ', help_header: '(🌙) 可用命令',
    },
    toolPrefix: '🌙',
    toolEmojis: {
      read: '📚', write: '✨', search: '🔮', execute: '⚡',
      web: '🌌', think: '💫', code: '🪄', file: '📄',
      folder: '📁', default: '🌙',
    },
    bannerLogo: '',
    bannerHero: '',
  },

  mono: {
    name: 'mono',
    description: '单色极简 — 灰度无色彩，适合屏幕录制',
    colors: {
      banner_border: '#555555', banner_title: '#FFFFFF', banner_accent: '#888888',
      banner_dim: '#666666', banner_text: '#C9D1D9',
      ui_accent: '#888888', ui_label: '#AAAAAA', ui_ok: '#90EE90',
      ui_error: '#FF6B6B', ui_warn: '#FFD700',
      prompt: '#C9D1D9', input_rule: '#555555',
      response_border: '#555555', session_label: '#888888', session_border: '#444444',
      primary: '#FFFFFF', secondary: '#A0A0A0', accent: '#D0D0D0',
      success: '#90EE90', warning: '#FFD700', error: '#FF6B6B', info: '#ADD8E6',
      text: '#FFFFFF', textMuted: '#808080',
      background: '#000000', backgroundAlt: '#0A0A0A', border: '#333333',
    },
    spinner: {
      interval: 60,
      waiting_faces: ['-', '\\', '|', '/'],
      thinking_faces: ['·', '∘', '○', '●'],
      thinking_verbs: ['processing', 'analyzing', 'computing', 'evaluating'],
      wings: [['[', ']'], ['<', '>']],
      type: 'line',
      frames: ['-', '\\', '|', '/'],
    },
    branding: {
      name: 'CrabPaw', tagline: '',
      welcome: 'Welcome. Type your message or /help for commands.',
      goodbye: 'Goodbye.', response_label: 'CrabPaw',
      prompt_symbol: '❯ ', help_header: 'Available Commands',
    },
    toolPrefix: '›',
    toolEmojis: {
      read: '▸', write: '▸', search: '▸', execute: '▸',
      web: '▸', think: '▸', code: '▸', file: '▸',
      folder: '▸', default: '▸',
    },
    bannerLogo: '',
    bannerHero: '',
  },
};

// ── SkinEngine 类 ──

class SkinEngine {
  constructor(config = {}) {
    this.skinsPath = config.skinsPath || getCrabPawSubDir('skins');
    this.currentSkinName = config.defaultSkin || 'default';
    this.skins = new Map();
    this._customSkins = new Map();

    this._loadBuiltinSkins();
    this._loadCustomSkins();
  }

  _loadBuiltinSkins() {
    for (const [name, skin] of Object.entries(BUILTIN_SKINS)) {
      this.skins.set(name, this._validateSkin(skin));
    }
  }

  _loadCustomSkins() {
    try {
      if (!fs.existsSync(this.skinsPath)) {
        fs.mkdirSync(this.skinsPath, { recursive: true });
        return;
      }
      const files = fs.readdirSync(this.skinsPath);
      for (const file of files) {
        if (file.endsWith('.yaml') || file.endsWith('.yml') || file.endsWith('.json')) {
          try {
            const filePath = path.join(this.skinsPath, file);
            const content = fs.readFileSync(filePath, 'utf8');
            let skin;
            if (file.endsWith('.json')) {
              skin = JSON.parse(content);
            } else {
              skin = yaml.parse(content);
            }
            if (skin && skin.name) {
              const validatedSkin = this._validateSkin(skin);
              this.skins.set(skin.name, validatedSkin);
              this._customSkins.set(skin.name, file);
            }
          } catch (err) {
            console.error(`Failed to load skin ${file}:`, err.message);
          }
        }
      }
    } catch (err) {
      console.error('Failed to load custom skins:', err.message);
    }
  }

  _validateSkin(skin) {
    const d = BUILTIN_SKINS.default;
    return {
      name: skin.name || 'unnamed',
      description: skin.description || '',
      colors: { ...DEFAULT_COLORS, ...(skin.colors || {}) },
      spinner: {
        ...DEFAULT_SPINNER,
        ...(skin.spinner || {}),
        // 确保 wings 是深拷贝
        wings: (skin.spinner && skin.spinner.wings)
          ? skin.spinner.wings.map(w => [...w])
          : DEFAULT_SPINNER.wings.map(w => [...w]),
      },
      branding: { ...DEFAULT_BRANDING, ...(skin.branding || {}) },
      toolPrefix: skin.toolPrefix || d.toolPrefix,
      toolEmojis: { ...DEFAULT_TOOL_EMOJIS, ...(skin.toolEmojis || {}) },
      bannerLogo: skin.bannerLogo || '',
      bannerHero: skin.bannerHero || '',
    };
  }

  // ── 查询接口 ──

  getSkin(name) {
    return this.skins.get(name || this.currentSkinName) || this.skins.get('default');
  }

  getCurrentSkin() {
    return this.getSkin(this.currentSkinName);
  }

  setSkin(name) {
    if (this.skins.has(name)) {
      this.currentSkinName = name;
      return true;
    }
    return false;
  }

  listSkins() {
    return Array.from(this.skins.entries()).map(([name, skin]) => ({
      name,
      description: skin.description,
      isCustom: this._customSkins.has(name),
      isCurrent: name === this.currentSkinName,
    }));
  }

  // ── 颜色接口（语义化优先，抽象向后兼容） ──

  getColor(key, fallback = '#FFFFFF') {
    const skin = this.getCurrentSkin();
    return skin.colors[key] || fallback;
  }

  /** 获取语义化颜色，若未设置则从抽象颜色映射 */
  getSemanticColor(uiKey) {
    const skin = this.getCurrentSkin();
    if (skin.colors[uiKey]) return skin.colors[uiKey];
    // 回退映射
    const fallbackMap = {
      banner_border: 'border', banner_title: 'primary', banner_accent: 'accent',
      banner_dim: 'textMuted', banner_text: 'text',
      ui_accent: 'accent', ui_label: 'secondary', ui_ok: 'success',
      ui_error: 'error', ui_warn: 'warning',
      prompt: 'primary', input_rule: 'border',
      response_border: 'primary', session_label: 'accent', session_border: 'border',
    };
    return skin.colors[fallbackMap[uiKey]] || '#FFFFFF';
  }

  // ── Spinner 接口（场景区分） ──

  getSpinner() {
    const skin = this.getCurrentSkin();
    return skin.spinner;
  }

  /** 获取等待场景的 spinner */
  getWaitingSpinner() {
    const s = this.getCurrentSkin().spinner;
    return {
      frames: s.waiting_faces || s.frames,
      interval: s.interval,
      wings: s.wings,
    };
  }

  /** 获取思考场景的 spinner */
  getThinkingSpinner() {
    const s = this.getCurrentSkin().spinner;
    return {
      frames: s.thinking_faces || s.frames,
      interval: s.interval,
      verbs: s.thinking_verbs || [],
      wings: s.wings,
    };
  }

  /** 获取当前思考动词（随机选取） */
  getThinkingVerb() {
    const verbs = this.getCurrentSkin().spinner.thinking_verbs || [];
    if (verbs.length === 0) return '';
    return verbs[Math.floor(Math.random() * verbs.length)];
  }

  /** 格式化带翅膀的 spinner 帧 */
  formatSpinnerFrame(frame, wingIndex = 0) {
    const wings = this.getCurrentSkin().spinner.wings || [];
    if (wings.length === 0) return frame;
    const wing = wings[wingIndex % wings.length];
    return `${wing[0]}${frame}${wing[1]}`;
  }

  // ── 品牌接口（交互文本） ──

  getBranding() {
    const skin = this.getCurrentSkin();
    return skin.branding;
  }

  getWelcome() {
    return this.getCurrentSkin().branding.welcome || DEFAULT_BRANDING.welcome;
  }

  getGoodbye() {
    return this.getCurrentSkin().branding.goodbye || DEFAULT_BRANDING.goodbye;
  }

  getResponseLabel() {
    return this.getCurrentSkin().branding.response_label || DEFAULT_BRANDING.response_label;
  }

  getPromptSymbol() {
    return this.getCurrentSkin().branding.prompt_symbol || DEFAULT_BRANDING.prompt_symbol;
  }

  getHelpHeader() {
    return this.getCurrentSkin().branding.help_header || DEFAULT_BRANDING.help_header;
  }

  // ── 工具接口 ──

  getToolEmoji(toolName) {
    const skin = this.getCurrentSkin();
    return skin.toolEmojis[toolName] || skin.toolEmojis.default || '🔧';
  }

  getToolPrefix() {
    return this.getCurrentSkin().toolPrefix;
  }

  // ── CRUD ──

  createSkin(name, baseSkin = 'default', overrides = {}) {
    const base = this.skins.get(baseSkin) || BUILTIN_SKINS.default;
    const newSkin = this._validateSkin({ ...base, name, ...overrides });
    this.skins.set(name, newSkin);
    this._saveSkin(name, newSkin);
    return newSkin;
  }

  updateSkin(name, updates) {
    const skin = this.skins.get(name);
    if (!skin) return null;
    const updatedSkin = this._validateSkin({ ...skin, ...updates, name });
    this.skins.set(name, updatedSkin);
    this._saveSkin(name, updatedSkin);
    return updatedSkin;
  }

  deleteSkin(name) {
    if (BUILTIN_SKINS[name]) return false;
    const deleted = this.skins.delete(name);
    if (deleted) {
      const filename = this._customSkins.get(name);
      if (filename) {
        try {
          const filePath = path.join(this.skinsPath, filename);
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (err) {
          console.error(`Failed to delete skin file:`, err.message);
        }
        this._customSkins.delete(name);
      }
    }
    return deleted;
  }

  _saveSkin(name, skin) {
    try {
      if (!fs.existsSync(this.skinsPath)) {
        fs.mkdirSync(this.skinsPath, { recursive: true });
      }
      const filename = `${name}.yaml`;
      const filePath = path.join(this.skinsPath, filename);
      fs.writeFileSync(filePath, yaml.stringify(skin));
      this._customSkins.set(name, filename);
    } catch (err) {
      console.error(`Failed to save skin ${name}:`, err.message);
    }
  }

  formatText(text, colorKey = 'text') {
    const color = this.getColor(colorKey);
    return { text, color };
  }

  exportSkin(name) {
    const skin = this.skins.get(name);
    if (!skin) return null;
    return yaml.stringify(skin);
  }

  importSkin(content, format = 'yaml') {
    try {
      let skin;
      if (format === 'json') {
        skin = JSON.parse(content);
      } else {
        skin = yaml.parse(content);
      }
      if (!skin || !skin.name) {
        throw new Error('Invalid skin: missing name');
      }
      const validatedSkin = this._validateSkin(skin);
      this.skins.set(skin.name, validatedSkin);
      this._saveSkin(skin.name, validatedSkin);
      return validatedSkin;
    } catch (err) {
      console.error('Failed to import skin:', err.message);
      return null;
    }
  }
}

module.exports = {
  SkinEngine,
  BUILTIN_SKINS,
  DEFAULT_COLORS,
  DEFAULT_SPINNER,
  DEFAULT_BRANDING,
  DEFAULT_TOOL_EMOJIS,
};
