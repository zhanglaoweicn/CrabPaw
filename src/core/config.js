const fs = require('fs');
const path = require('path');
const { encryptApiKey, decryptApiKey, encryptApiKeysFile, isEncrypted, isCurrentFormat } = require('./secure-storage');
const { _maskToken } = require('./secret-redactor');
const yaml = require('yaml');
const fsAsync = require('fs').promises;
const { toolPolicyManager, TOOL_PROFILES } = require('./tool-profiles');
const { channelRegistry } = require('./channel-registry');
const { routeResolver } = require('./routing');

// ─── 配置缓存 ─────────────────────────────────────────────
let _configCache = null;
let _configCacheTimestamp = 0;
let isProfileManagerInitDone = false;
const CONFIG_CACHE_TTL = 1000; // 1秒缓存有效期

function invalidateConfigCache() {
  _configCache = null;
  _configCacheTimestamp = 0;
}

// 监听配置文件变化，自动失效缓存
let _configWatcher = null;
function setupConfigWatcher() {
  if (_configWatcher) return;
  try {
    const CONFIG_PATH = path.join(process.env.CRABPAW_DATA_DIR || path.join(__dirname, '..', '..', 'data', '.crabpaw'), 'config.json');
    if (fs.existsSync(CONFIG_PATH)) {
      _configWatcher = fs.watch(CONFIG_PATH, () => {
        invalidateConfigCache();
      });
      // 2026-08-31 修复: 无 error 监听时, 文件被删/数据目录不可达等情形抛未处理的
      // EPERM → 整个进程崩溃(测试删临时配置实测复现)。监听并收敛为 warn + 释放
      // 失效句柄(主进程可用时 watcher 重建)。
      _configWatcher.on('error', (err) => {
        console.warn('[config.js] 配置监视器错误(已释放, 下次加载重建):', err && err.message);
        try { _configWatcher.close(); } catch (_) { /* 已失效 */ }
        _configWatcher = null;
      });
    }
  } catch (e) {

    // 忽略监视器设置失败

    console.warn('[config.js] 空 catch 补日志:', e && e.message);
  }

}


const DEFAULT_PORT = 38767;

function loadEnv() {
  const envPath = path.join(__dirname, '..', '..', '.env');
  if (!fs.existsSync(envPath)) return;
  
  const content = fs.readFileSync(envPath, 'utf-8');
  const lines = content.split('\n');
  let currentKey = null;
  let currentValue = '';
  let inMultiline = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    
    if (inMultiline) {
      if (trimmed.endsWith('"') && !trimmed.endsWith('\\"')) {
        currentValue += line.substring(0, line.lastIndexOf('"'));
        if (!process.env[currentKey]) {
          process.env[currentKey] = currentValue.replace(/\\"/g, '"');
        }
        inMultiline = false;
        currentKey = null;
        currentValue = '';
      } else {
        currentValue += line + '\n';
      }
      continue;
    }
    
    if (!trimmed || trimmed.startsWith('#')) continue;
    
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    
    const key = trimmed.substring(0, eqIndex).trim();
    let value = trimmed.substring(eqIndex + 1);
    
    if (value.startsWith('"') && !value.endsWith('"')) {
      currentKey = key;
      currentValue = value.substring(1);
      inMultiline = true;
      continue;
    }
    
    value = value.replace(/^["']|["']$/g, '').replace(/\\"/g, '"');
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnv();

// 解析环境变量别名（如 GLM_API_KEY / ZAI_API_KEY / Z_AI_API_KEY 三合一）
try {
  const { resolveAliases } = require('./env-aliases');
  resolveAliases();
} catch (e) {
  /* env-aliases 模块可选，忽略 */
  console.warn('[config.js] 空 catch 补日志:', e && e.message);
}


const BASE_DIR = path.join(__dirname, '..', '..');

const CRABPAW_DATA_DIR = process.env.CRABPAW_DATA_DIR 
  || path.join(BASE_DIR, 'data', '.crabpaw');

const DATA_DIR = CRABPAW_DATA_DIR;

// A3(Runtime差距分析): 一次性归并历史双重嵌套目录 data/.crabpaw/.crabpaw/——
// 历史代码多处 path.join(DATA_DIR, '.crabpaw', ...),而 DATA_DIR 本身已以 .crabpaw
// 结尾,导致 history.db/audit.jsonl/trajectories 等实际落在双重嵌套层。这里在
// config 加载时(早于所有消费者)把嵌套层内容递归合并进 DATA_DIR。
// 迁移安全规则:
//   - 易失目录(运行时指标/缓存,旧进程高频增删)目标已存在时整目录跳过——
//     逐文件搬运在 Windows 目录锁竞争下会拖垮启动(实测数万快照 ENOENT 风暴)
//   - 单次扫描设上限,超限留待下次启动续搬
//   - 被运行中进程锁住的文件(EPERM/EBUSY)静默留下,进程重启后自然可搬
//   - 嵌套层搬空才写 .layout-migrated 永久标记,否则每次启动快速重扫补齐
const VOLATILE_NESTED_DIRS = new Set(['metrics', 'trending-history', 'prompt-cache']);
const MIGRATION_MAX_OPS = 20000;
function _mergeNestedDataDir(src, dst, depth = 0, ops = { n: 0 }) {
  fs.mkdirSync(dst, { recursive: true });
  let moved = 0, skipped = 0;
  for (const name of fs.readdirSync(src)) {
    if (ops.n >= MIGRATION_MAX_OPS) { skipped++; continue; }
    const s = path.join(src, name);
    const d = path.join(dst, name);
    let st;
    try { st = fs.statSync(s); } catch (e) { continue; } // 已被并发方移走
    ops.n++;
    if (st.isDirectory()) {
      if (depth === 0 && VOLATILE_NESTED_DIRS.has(name) && fs.existsSync(d)) { skipped++; continue; }
      const r = _mergeNestedDataDir(s, d, depth + 1, ops);
      moved += r.moved; skipped += r.skipped;
    } else if (!fs.existsSync(d)) {
      try { fs.renameSync(s, d); moved++; } catch (e) {
        if (e.code !== 'ENOENT') skipped++; // ENOENT=并发方已移走; 锁定文件留待重启后重试
      }
    }
  }
  try { if (fs.readdirSync(src).length === 0) fs.rmdirSync(src); } catch (e) { /* 非空保留 */ }
  return { moved, skipped };
}
function _migrateNestedDataDir() {
  try {
    const nested = path.join(DATA_DIR, '.crabpaw');
    const flag = path.join(DATA_DIR, '.layout-migrated');
    if (!fs.existsSync(nested)) { try { fs.writeFileSync(flag, String(Date.now())); } catch (e) { /* ignore */ } return; }
    if (fs.existsSync(flag)) return;
    const { moved, skipped } = _mergeNestedDataDir(nested, DATA_DIR);
    // 仍有残留(如被运行中旧进程锁住的文件)时暂不写标记——下次启动继续重扫补齐;
    // 全部搬空(嵌套层已删)才永久标记。
    if (!fs.existsSync(nested)) {
      try { fs.writeFileSync(flag, String(Date.now())); } catch (e) { /* ignore */ }
    }
    if (moved > 0 || skipped > 0) {
      console.warn(`[config] 数据目录归并: .crabpaw/.crabpaw → .crabpaw (移动 ${moved} 项${skipped > 0 ? `, ${skipped} 项被锁留待下次启动重试` : ''})`);
    }
  } catch (e) {
    console.warn('[config] 数据目录归并失败(忽略,不影响启动):', e && e.message);
  }
}
try { _migrateNestedDataDir(); } catch (e) { console.warn('[config] 数据目录迁移异常(忽略):', e && e.message); }

function getDataDir() {
  return DATA_DIR;
}

const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const API_KEYS_PATH = path.join(DATA_DIR, '.api_keys.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const SCHEDULES_PATH = path.join(DATA_DIR, 'schedules.json');
const WORKSPACE_DIR = path.join(DATA_DIR, 'workspace');
const SKILLS_DIR = path.join(BASE_DIR, 'skills');
const GLOBAL_SKILLS_DIR = path.join(BASE_DIR, 'data', 'skills');
const CONFIG_SUBDIR = path.join(DATA_DIR, 'config');
const ASSISTANT_CONFIG_PATH = path.join(CONFIG_SUBDIR, 'assistant.json');
const USER_CONFIG_PATH = path.join(CONFIG_SUBDIR, 'user.json');
const MAX_BACKUPS = 10;

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(WORKSPACE_DIR)) {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  }
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

ensureDirs();

// 使用统一的原子写入模块，替代本地简化实现
const { atomicWriteFile: atomicWrite } = require('./atomic-write');

function safeReadJson(filePath, defaultValue = null) {
  if (!fs.existsSync(filePath)) {
    return defaultValue;
  }
  
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    // 移除 UTF-8 BOM（某些编辑器会在文件开头写入 BOM）
    const clean = content.replace(/^\uFEFF/, '');
    return JSON.parse(clean);
  } catch (error) {
    console.error(`读取 JSON 文件失败 ${filePath}:`, error.message);
    const backupPath = `${filePath}.backup.${Date.now()}`;
    try {
    fs.copyFileSync(filePath, backupPath);
    console.log(`已创建备份文件: ${backupPath}`);
    } catch (backupError) {
      // ignore backup errors
      console.warn('[config.js] 空 catch 补日志:', backupError && backupError.message);
    }

    
    return defaultValue;
  }
}

function createBackup() {
  if (!fs.existsSync(CONFIG_PATH)) return;
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `config.${timestamp}.json`);
  
  try {
    fs.copyFileSync(CONFIG_PATH, backupPath);
    console.log(`✅ 配置已备份: ${backupPath}`);
    
    const backups = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('config.') && f.endsWith('.json'))
      .sort()
      .reverse();
    
    while (backups.length > MAX_BACKUPS) {
      const oldBackup = path.join(BACKUP_DIR, backups.pop());
      fs.unlinkSync(oldBackup);
    }
  } catch (e) {
    console.error('备份配置失败:', e.message);
  }
}

function loadApiKeys() {
  const encryptedKeys = safeReadJson(API_KEYS_PATH, {});
  const decryptedKeys = {};
  
  for (const [provider, key] of Object.entries(encryptedKeys)) {
    if (key && isEncrypted(key)) {
      const decrypted = decryptApiKey(key);
      if (decrypted) {
        decryptedKeys[provider] = decrypted;
      } else {
        console.warn(`⚠️ 无法解密 ${provider} 的 API Key，请重新配置`);
        decryptedKeys[provider] = '';
      }
    } else if (key) {
      decryptedKeys[provider] = key;
    }
  }
  
  // v2 自动升级（2026-09-02 便携化）：任一存量密文非当前格式且解密成功 →
  // 整表重写为 v2（解不开的条目原样保留，不销毁未来可解的机会）
  const needsUpgrade = Object.entries(encryptedKeys).some(([, v]) => v && !isCurrentFormat(v));
  const anyDecrypted = Object.values(decryptedKeys).some(v => v);
  if (needsUpgrade && anyDecrypted) {
    try {
      const upgraded = {};
      for (const [provider, key] of Object.entries(encryptedKeys)) {
        if (!key) continue;
        const plain = decryptedKeys[provider];
        upgraded[provider] = (plain && !isCurrentFormat(key)) ? encryptApiKey(plain) : key;
      }
      atomicWrite(API_KEYS_PATH, JSON.stringify(upgraded, null, 2));
      console.log('🔐 API Keys 已自动升级到 v2 主密钥格式（便携安全，换机/换网络不再失效）');
    } catch (e) {
      console.error('API Keys 升级重加密失败:', e.message);
    }
  }

  return decryptedKeys;
}

function saveApiKeys(apiKeys) {
  const encryptedKeys = {};

  for (const [provider, key] of Object.entries(apiKeys)) {
    if (!key) continue;
    if (isCurrentFormat(key)) {
      encryptedKeys[provider] = key;
    } else if (isEncrypted(key)) {
      // 旧格式密文：解得出就重加密为 v2；解不开原样保留（不销毁）
      const plain = decryptApiKey(key);
      encryptedKeys[provider] = plain ? encryptApiKey(plain) : key;
    } else {
      encryptedKeys[provider] = encryptApiKey(key);
    }
  }

  atomicWrite(API_KEYS_PATH, JSON.stringify(encryptedKeys, null, 2));
}

function migrateApiKeys() {
  if (fs.existsSync(API_KEYS_PATH)) {
    try {
      const content = fs.readFileSync(API_KEYS_PATH, 'utf-8');
      const apiKeys = JSON.parse(content);
      
      let needsMigration = false;
      // eslint-disable-next-line no-unused-vars
      for (const [key, value] of Object.entries(apiKeys)) {
        if (value && !isEncrypted(value)) {
          needsMigration = true;
          break;
        }
      }
      
      if (needsMigration) {
        console.log('🔐 正在迁移 API Keys 到加密存储...');
        encryptApiKeysFile(API_KEYS_PATH);
      }
    } catch (e) {
      console.error('迁移 API Keys 失败:', e.message);
    }
  }
}

migrateApiKeys();

function maskApiKey(key) {
  if (!key || key.length < 8) return key;
  return _maskToken(key);
}

const defaultConfig = {
  chatChannel: ['none'],
  lark: {
    appId: process.env.LARK_APP_ID || '',
    appSecret: process.env.LARK_APP_SECRET || '',
    // 2026-09-06 补群路由默认字段（group-router 构造依赖; config.json 可覆盖）
    groupPolicy: 'mention_only',
    botName: '',
    botOpenId: '',
  },
  wecom: {
    botId: process.env.WECOM_BOT_ID || '',
    secret: process.env.WECOM_SECRET || '',
    corpId: process.env.WECOM_CORP_ID || '',
    // 2026-09-06 补 agentId 默认位——wecom-tools 的 message/send 必须携带，
    // 此前 defaultConfig 无此字段且 loaded.wecom 不合并，agentid 恒 undefined
    agentId: process.env.WECOM_AGENT_ID || '',
    contactsSecret: '',
    approvalSecret: '',
    botUserId: '',
    botName: '',
    groupPolicy: 'mention_only',
    watchedTemplates: []
  },
  models: {
    currentProvider: 'deepseek',
    defaultModel: 'deepseek-chat',
    toolProfile: 'coding',
    providers: {
      deepseek: { 
        baseUrl: process.env.AI_BASE_URL || 'https://api.deepseek.com/v1', 
        apiKey: process.env.AI_API_KEY || '', 
        model: process.env.AI_MODEL || 'deepseek-chat' 
      },
      kimi: { 
        baseUrl: 'https://api.moonshot.cn/v1', 
        apiKey: '', 
        model: 'moonshot-v1-128k' 
      },
      glm: { 
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4', 
        apiKey: '', 
        model: 'glm-4-flash' 
      },
      qwen: { 
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', 
        apiKey: '', 
        model: 'qwen-turbo' 
      },
      doubao: { 
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', 
        apiKey: '', 
        model: 'doubao-pro-32k' 
      },
      minimax: { 
        baseUrl: 'https://api.minimax.chat/v1', 
        apiKey: '', 
        model: 'abab6-chat' 
      },

      ollama: {
        baseUrl: 'http://localhost:11434/v1',
        apiKey: '',
        model: 'qwen2.5-coder:7b'
      },
      custom: {
        baseUrl: 'http://localhost:8000/v1',
        apiKey: '',
        model: 'custom-model'
      }
    },
    fallbackModel: {
      provider: process.env.FALLBACK_PROVIDER || '',
      model: process.env.FALLBACK_MODEL || '',
      baseUrl: process.env.FALLBACK_BASE_URL || '',
    },
    auxiliary: {
      vision: { provider: process.env.AUX_VISION_PROVIDER || 'auto', model: process.env.AUX_VISION_MODEL || '' },
      compression: { provider: process.env.AUX_COMPRESSION_PROVIDER || 'auto', model: process.env.AUX_COMPRESSION_MODEL || '' },
    },
    routing: {
      chat:       { provider: 'deepseek', model: 'deepseek-chat',       fallback: ['qwen', 'glm'] },
      reasoning:  { provider: 'deepseek', model: 'deepseek-reasoner',   fallback: [] },
      vision:     { provider: 'qwen',     model: 'qwen-vl-plus',        fallback: ['glm', 'doubao'] },
      imageGen:   { provider: 'doubao',   model: 'doubao-seedream-5-0-260128', fallback: ['qwen'] },
      videoGen:   { provider: 'doubao',   model: 'doubao-seedance-1.5-pro',    fallback: [] },
      tts:        { provider: 'doubao',     model: 'volcano-tts',          fallback: [] },
      asr:        { provider: 'doubao',   model: 'doubao-asr-1',        fallback: [] },
      embedding:  { provider: 'ollama',   model: 'bge-m3',             fallback: ['qwen'] },
    }
  },
  imageGeneration: {
    provider: 'doubao',
    model: 'doubao-seedream-5-0-260128',
    providers: {
      doubao: {
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        apiKey: '',
        model: 'doubao-seedream-5-0-260128'
      },
      qwen: {
        baseUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis',
        apiKey: '',
        model: 'wanx-v1'
      }
    }
  },
  videoGeneration: {
    provider: 'doubao',
    model: 'doubao-seedance-1-5-pro-251215',
    providers: {
      doubao: {
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks',
        apiKey: '',
        model: 'doubao-seedance-1-5-pro-251215'
      }
    }
  },
  agent: { name: 'CrabPaw', emoji: '🦀', creature: 'AI Assistant', vibe: '专业、简洁', systemPrompt: '你是一个智能助手' },
  user: { name: '', callMe: '', timezone: 'Asia/Shanghai', notes: '', larkUserId: '', wecomUserId: '', syncMode: 'gui_user' },
  adminUsers: [],
  enableWhitelist: false,
  allowedUsers: [],
  pushTargets: [],
  update: {
    url: '',
    autoCheck: true,
    lastCheck: ''
  },
  voice: {
    // P2(GUI 全量修复 P0): 默认 true——仅影响全新安装(显式关闭的用户配置覆盖默认);
    // 此前默认 false 且 SetupWizard 从不写该字段 → 首启配完 TTS 后语音回复恒静默
    replyEnabled: true,
    ttsProvider: 'doubao',
    defaultVoice: 'zh_female_xiaohe_uranus_bigtts',
    speed: 1.0,
  },
  tts: {
    provider: 'doubao',
    defaultVoice: 'zh_female_xiaohe_uranus_bigtts',
    providers: {
      'edge-tts': {},
      volcengine: { appId: '', accessToken: '' }
    }
  },
  stt: {
    provider: 'volcengine',
    providers: {
      volcengine: { appId: '', accessToken: '' },
      'whisper-openai': { apiKey: '', baseUrl: 'https://api.openai.com/v1' }
    }
  },
  setupCompleted: false
};

function loadConfig() {
  // 检查缓存
  const now = Date.now();
  if (_configCache && (now - _configCacheTimestamp) < CONFIG_CACHE_TTL) {
    return _configCache;
  }

  // 设置配置文件监视器
  setupConfigWatcher();

  const loaded = safeReadJson(CONFIG_PATH, null);
  const assistantConfig = safeReadJson(ASSISTANT_CONFIG_PATH, null);
  const userConfigFile = safeReadJson(USER_CONFIG_PATH, null);
  const savedApiKeys = loadApiKeys();
  
  console.log('📋 加载主配置文件:', CONFIG_PATH);
  
  let merged = { ...defaultConfig };
  
  if (loaded) {
    // Always deep-merge models to preserve default providers
    // (previously only when loaded.models.providers existed, dropping defaults)
    if (loaded.models) {
      merged.models = {
        ...merged.models,
        ...loaded.models,
        providers: {
          ...defaultConfig.models.providers,
          ...loaded.models.providers
        },
        fallbackModel: loaded.models.fallbackModel || defaultConfig.models.fallbackModel,
        auxiliary: {
          ...defaultConfig.models.auxiliary,
          ...(loaded.models.auxiliary || {}),
        },
      };
    }
    
    if (!loaded.imageGeneration) {
      merged.imageGeneration = { ...defaultConfig.imageGeneration };
    } else if (loaded.imageGeneration.providers) {
      merged.imageGeneration = {
        ...defaultConfig.imageGeneration,
        ...loaded.imageGeneration,
        providers: {
          ...defaultConfig.imageGeneration.providers,
          ...loaded.imageGeneration.providers
        }
      };
    }
    
    if (!loaded.videoGeneration) {
      merged.videoGeneration = { ...defaultConfig.videoGeneration };
    } else if (loaded.videoGeneration.providers) {
      merged.videoGeneration = {
        ...defaultConfig.videoGeneration,
        ...loaded.videoGeneration,
        providers: {
          ...defaultConfig.videoGeneration.providers,
          ...loaded.videoGeneration.providers
        }
      };
    }

    // 合并 search 配置（含 Tavily/Bing API Key 等）
    if (loaded.search) {
      merged.search = { ...loaded.search };
    }

    // 合并 voice 配置（含 ASR/TTS Key, Resource ID 等）
    if (loaded.voice) {
      merged.voice = { ...merged.voice, ...loaded.voice };
    }

    // 合并 lark 配置：appId 等非密字段从 config.json 读回（saveConfig 有写入、
    // 此前读取端漏合并导致 isConfigured 恒 false）；appSecret 仍以 .api_keys.json 为单一事实源
    if (loaded.lark) {
      merged.lark = { ...merged.lark, ...loaded.lark };
    }

    // 合并 wecom 配置（与 lark 同款修复 2026-09-06）：此前读取端漏合并，
    // config.json 的 corpId/agentId/botUserId 等全部丢弃，企微子系统整体休眠
    if (loaded.wecom) {
      merged.wecom = { ...merged.wecom, ...loaded.wecom };
    }

    // 保留 setupCompleted 标记（不在 defaultConfig 中，需显式合并）
    if (loaded.setupCompleted !== undefined) {
      merged.setupCompleted = loaded.setupCompleted;
    }

    // 2026-09-09 系统性修复(存储回路不对称): saveConfig 持久化全部节段, 但本函数此前
    // 只恢复固定子集——chatChannel/update/visionGeneration/security/pushTargets 等写入
    // 后每次重载即被静默丢弃(U 盘打包版实测: 视觉 key/百度 key/通道设置"保存后消失")。
    // 补齐全部节段的读回, 与 saveConfig 的写入面对齐。
    if (loaded.chatChannel !== undefined) {
      // string(前端保存)或 array(旧默认)两种形态都接受, 消费端已做归一化
      merged.chatChannel = loaded.chatChannel;
    }
    if (loaded.update && typeof loaded.update === 'object') {
      merged.update = { ...(merged.update || {}), ...loaded.update };
    }
    if (loaded.visionGeneration) {
      if (!loaded.visionGeneration.providers) {
        merged.visionGeneration = { ...(defaultConfig.visionGeneration || {}), ...loaded.visionGeneration };
      } else {
        merged.visionGeneration = {
          ...(defaultConfig.visionGeneration || {}),
          ...loaded.visionGeneration,
          providers: {
            ...(defaultConfig.visionGeneration?.providers || {}),
            ...loaded.visionGeneration.providers
          }
        };
      }
    }
    if (loaded.security && typeof loaded.security === 'object') {
      merged.security = { ...(merged.security || {}), ...loaded.security };
    }
    if (loaded.pushTargets !== undefined) {
      merged.pushTargets = loaded.pushTargets;
    }
    if (loaded.adminUsers !== undefined) {
      merged.adminUsers = loaded.adminUsers;
    }
    if (loaded.modelAssignments && typeof loaded.modelAssignments === 'object') {
      merged.modelAssignments = { ...(merged.modelAssignments || {}), ...loaded.modelAssignments };
    }
    if (loaded.providers && typeof loaded.providers === 'object') {
      // 遗留顶层 providers(POST /config 仍兼容写入此形态)
      merged.providers = { ...(merged.providers || {}), ...loaded.providers };
    }
    if (loaded.tts && typeof loaded.tts === 'object') {
      merged.tts = { ...(merged.tts || {}), ...loaded.tts };
    }
    if (loaded.stt && typeof loaded.stt === 'object') {
      merged.stt = { ...(merged.stt || {}), ...loaded.stt };
    }
  }

  if (merged.models?.providers) {
    for (const [providerId, provider] of Object.entries(merged.models.providers)) {
      const existingKey = provider.apiKey;
      const hasPlaintextKey = existingKey && !existingKey.includes('***') && !isEncrypted(existingKey);

      // 2026-08-03 修复: TTS 提供商（doubao 等）的 key 存于 voice.doubaoKey 而非
      // models.providers——此前只看 models 路径，doubao key 明明有效却每 10s 报假警报
      const voiceFallbackKey = merged.voice && merged.voice[providerId + 'Key'];
      const hasVoiceFallback = typeof voiceFallbackKey === 'string' && voiceFallbackKey.length > 8
        && !voiceFallbackKey.includes('***') && !isEncrypted(voiceFallbackKey);

      if (savedApiKeys[providerId] && savedApiKeys[providerId].trim() !== '') {
        if (!hasPlaintextKey) {
          provider.apiKey = savedApiKeys[providerId];
          console.log('📋 使用加密存储的 API Key: ' + providerId);
        } else {
          console.log('📋 保留配置文件中的明文 API Key: ' + providerId);
        }
      } else if (hasPlaintextKey) {
        console.log('📋 使用配置文件中的明文 API Key: ' + providerId);
      } else if (hasVoiceFallback) {
        console.log('📋 使用 voice 配置中的 TTS API Key: ' + providerId);
      } else {
        console.log('⚠️ ' + providerId + ' 没有有效的 API Key');
      }
    }
  }

  if (merged.lark) {
    const existingSecret = merged.lark.appSecret;
    const hasPlaintextSecret = existingSecret && !existingSecret.includes('***') && !isEncrypted(existingSecret);

    if (savedApiKeys['lark_appSecret'] && savedApiKeys['lark_appSecret'].trim() !== '') {
      if (!hasPlaintextSecret) {
        merged.lark.appSecret = savedApiKeys['lark_appSecret'];
        console.log('📋 使用加密存储的 Lark AppSecret');
      } else {
        console.log('📋 保留配置文件中的明文 Lark AppSecret');
      }
    } else if (hasPlaintextSecret) {
      console.log('📋 使用配置文件中的明文 Lark AppSecret');
    }
  }
  
  if (merged.wecom) {
    const existingSecret = merged.wecom.secret;
    const hasPlaintextSecret = existingSecret && !existingSecret.includes('***') && !isEncrypted(existingSecret);

    if (savedApiKeys['wecom_secret'] && savedApiKeys['wecom_secret'].trim() !== '') {
      if (!hasPlaintextSecret) {
        merged.wecom.secret = savedApiKeys['wecom_secret'];
        console.log('📋 使用加密存储的 WeCom Secret');
      } else {
        console.log('📋 保留配置文件中的明文 WeCom Secret');
      }
    } else if (hasPlaintextSecret) {
      console.log('📋 使用配置文件中的明文 WeCom Secret');
    }
  }
  
  if (merged.imageGeneration?.providers) {
    for (const [providerId, provider] of Object.entries(merged.imageGeneration.providers)) {
      const keyName = `imageGen_${providerId}`;
      const existingKey = provider.apiKey;
      const hasPlaintextKey = existingKey && !existingKey.includes('***') && !isEncrypted(existingKey);
      
      if (savedApiKeys[keyName] && savedApiKeys[keyName].trim() !== '') {
        if (!hasPlaintextKey) {
          provider.apiKey = savedApiKeys[keyName];
          console.log(`📋 使用加密存储的图片生成 API Key: ${providerId}`);
        }
      } else if (hasPlaintextKey) {
        console.log(`📋 使用配置文件中的明文图片生成 API Key: ${providerId}`);
      }
    }
  }
  
  if (merged.videoGeneration?.providers) {
    for (const [providerId, provider] of Object.entries(merged.videoGeneration.providers)) {
      const keyName = `videoGen_${providerId}`;
      const existingKey = provider.apiKey;
      const hasPlaintextKey = existingKey && !existingKey.includes('***') && !isEncrypted(existingKey);
      
      if (savedApiKeys[keyName] && savedApiKeys[keyName].trim() !== '') {
        if (!hasPlaintextKey) {
          provider.apiKey = savedApiKeys[keyName];
          console.log(`📋 使用加密存储的视频生成 API Key: ${providerId}`);
        }
      } else if (hasPlaintextKey) {
        console.log(`📋 使用配置文件中的明文视频生成 API Key: ${providerId}`);
      }
    }
  }
  
  if (assistantConfig) {
    merged.agent = {
      ...merged.agent,
      name: assistantConfig.name || merged.agent.name,
      emoji: assistantConfig.avatar || merged.agent.emoji,
      vibe: assistantConfig.personality || merged.agent.vibe,
      systemPrompt: assistantConfig.systemPrompt || merged.agent.systemPrompt
    };
  }
  
  if (userConfigFile) {
    merged.user = {
      ...merged.user,
      ...userConfigFile
    };
  }
  
  // 合并 Profile 配置（如果有活跃的非 default Profile）
  try {
    const { getActiveProfileConfig } = require('./profile-manager');
    const profileConfig = getActiveProfileConfig();
    if (profileConfig) {
      merged = deepMergeConfig(merged, profileConfig);
      console.log('📋 已合并 Profile 配置');
    }
  } catch (e) {

    // Profile 模块不可用时忽略

    console.warn('[config.js] 空 catch 补日志:', e && e.message);
  }

  
  // 更新缓存
  _configCache = merged;
  _configCacheTimestamp = Date.now();
  
  return merged;
}

function deepMergeConfig(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (key === '_meta') continue; // 跳过 Profile 元数据
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMergeConfig(result[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// eslint-disable-next-line no-unused-vars
function saveConfig(config, incomingData = null) {
  createBackup();
  
  console.log('💾 保存配置 - 接收到的 voice 配置:', config.voice);
  
  const existingConfig = safeReadJson(CONFIG_PATH, {});
  const existingApiKeys = loadApiKeys();
  
  const mainConfig = { ...config };
  mainConfig.models = config.models ? { ...config.models } : {};
  mainConfig.models.providers = config.models?.providers ? { ...config.models.providers } : {};
  for (const [key, provider] of Object.entries(config.models?.providers || {})) {
    mainConfig.models.providers[key] = { ...provider };
  }
  
  const apiKeysToSave = { ...existingApiKeys };
  // 本次保存中被用户/前端显式填写(非掩码)的 provider key 集合——这些已是权威新值,
  // 后续 legacy 明文迁移不得用 config.json 的遗留明文覆盖它们。
  const freshStoreKeys = new Set();
  
  if (config.models?.providers) {
    for (const [providerId, provider] of Object.entries(config.models.providers)) {
      if (provider.apiKey && !provider.apiKey.includes('***')) {
        apiKeysToSave[providerId] = provider.apiKey;
        freshStoreKeys.add(providerId);
      }
      if (existingApiKeys[providerId] && (!provider.apiKey || provider.apiKey.includes('***'))) {
        provider.apiKey = existingApiKeys[providerId];
      }
    }
  }
  
  if (config.lark?.appSecret && !config.lark.appSecret.includes('***')) {
    apiKeysToSave['lark_appSecret'] = config.lark.appSecret;
  }
  if (existingApiKeys['lark_appSecret'] && (!config.lark?.appSecret || config.lark.appSecret.includes('***'))) {
    mainConfig.lark = mainConfig.lark || {};
    mainConfig.lark.appSecret = existingApiKeys['lark_appSecret'];
  }
  
  if (config.wecom?.secret && !config.wecom.secret.includes('***')) {
    apiKeysToSave['wecom_secret'] = config.wecom.secret;
  }
  if (existingApiKeys['wecom_secret'] && (!config.wecom?.secret || config.wecom.secret.includes('***'))) {
    mainConfig.wecom = mainConfig.wecom || {};
    mainConfig.wecom.secret = existingApiKeys['wecom_secret'];
  }

  // 保护 wecom botId/corpId: 前端保存时如果为空，保留已有值
  if (mainConfig.wecom) {
    if (!mainConfig.wecom.botId && existingConfig?.wecom?.botId) {
      mainConfig.wecom.botId = existingConfig.wecom.botId;
    }
    if (!mainConfig.wecom.corpId && existingConfig?.wecom?.corpId) {
      mainConfig.wecom.corpId = existingConfig.wecom.corpId;
    }
  }

  // 保护 lark appId: 前端保存时如果为空，保留已有值
  if (mainConfig.lark) {
    if (!mainConfig.lark.appId && existingConfig?.lark?.appId) {
      mainConfig.lark.appId = existingConfig.lark.appId;
    }
  }

  // 同步 imageGen/videoGen 同 API 的 key: doubao key → volcengine_standard 等
  const doubaoImgKey = mainConfig.imageGeneration?.providers?.doubao?.apiKey;
  if (doubaoImgKey && !doubaoImgKey.includes('***')) {
    // 同步图片生成
    for (const [pid, p] of Object.entries(mainConfig.imageGeneration.providers || {})) {
      if (pid === 'doubao') continue;
      if ((p.baseUrl || '').includes('volces.com') && !p.apiKey) p.apiKey = doubaoImgKey;
    }
    // 同步视频生成
    for (const [pid, p] of Object.entries(mainConfig.videoGeneration?.providers || {})) {
      if (pid === 'doubao') continue;
      if ((p.baseUrl || '').includes('volces.com') && !p.apiKey) p.apiKey = doubaoImgKey;
    }
    // 如果视频的 doubao 也没 key，同步过去
    if (!mainConfig.videoGeneration?.providers?.doubao?.apiKey) {
      if (!mainConfig.videoGeneration) mainConfig.videoGeneration = {};
      if (!mainConfig.videoGeneration.providers) mainConfig.videoGeneration.providers = {};
      if (!mainConfig.videoGeneration.providers.doubao) mainConfig.videoGeneration.providers.doubao = {};
      mainConfig.videoGeneration.providers.doubao.apiKey = doubaoImgKey;
    }
  }

  // 保护 imageGen/videoGen: 前端保存时如果缺少 provider，保留已有
  if (config.imageGeneration?.providers) {
    for (const [pid, provider] of Object.entries(existingConfig?.imageGeneration?.providers || {})) {
      if (!mainConfig.imageGeneration.providers[pid]) {
        mainConfig.imageGeneration.providers[pid] = { ...provider };
      }
    }
  }
  if (config.videoGeneration?.providers) {
    for (const [pid, provider] of Object.entries(existingConfig?.videoGeneration?.providers || {})) {
      if (!mainConfig.videoGeneration.providers[pid]) {
        mainConfig.videoGeneration.providers[pid] = { ...provider };
      }
    }
  }
  
  if (config.imageGeneration?.providers) {
    mainConfig.imageGeneration = { ...config.imageGeneration };
    mainConfig.imageGeneration.providers = {};
    for (const [providerId, provider] of Object.entries(config.imageGeneration.providers)) {
      mainConfig.imageGeneration.providers[providerId] = { ...provider };
      if (provider.apiKey && !provider.apiKey.includes('***')) {
        apiKeysToSave[`imageGen_${providerId}`] = provider.apiKey;
        freshStoreKeys.add(`imageGen_${providerId}`);
      }
      if (existingApiKeys[`imageGen_${providerId}`] && (!provider.apiKey || provider.apiKey.includes('***'))) {
        mainConfig.imageGeneration.providers[providerId].apiKey = existingApiKeys[`imageGen_${providerId}`];
      }
    }
  }
  
  if (config.videoGeneration?.providers) {
    mainConfig.videoGeneration = { ...config.videoGeneration };
    mainConfig.videoGeneration.providers = {};
    for (const [providerId, provider] of Object.entries(config.videoGeneration.providers)) {
      mainConfig.videoGeneration.providers[providerId] = { ...provider };
      if (provider.apiKey && !provider.apiKey.includes('***')) {
        apiKeysToSave[`videoGen_${providerId}`] = provider.apiKey;
        freshStoreKeys.add(`videoGen_${providerId}`);
      }
      if (existingApiKeys[`videoGen_${providerId}`] && (!provider.apiKey || provider.apiKey.includes('***'))) {
        mainConfig.videoGeneration.providers[providerId].apiKey = existingApiKeys[`videoGen_${providerId}`];
      }
    }
  }
  
  // 2026-08-31 修复(密钥保存丢失): config.json 里遗留的明文 provider key 会经
  // deepMerge(existingConfig, mainConfig) 原样存活, 且 loadConfig 的明文优先逻辑
  // (hasPlaintextKey)会遮蔽 .api_keys.json 里新保存的加密 key——表现为"保存成功
  // 但运行时/面板永远是旧 key"。收编: 把仅存在于 config.json 的明文 key 迁入加密
  // 存储后再从文件剥离, 单一事实源 = .api_keys.json。
  const collectLegacyPlaintextKeys = (providers, prefix = '') => {
    for (const [providerId, provider] of Object.entries(providers || {})) {
      const k = provider && provider.apiKey;
      const storeKey = prefix + providerId;
      // 迁移条件是「本次保存没有显式写入该 provider」, 而非「加密存储里没有该键」——
      // 之前用 !apiKeysToSave[storeKey] 判断, 而 apiKeysToSave 被 existingApiKeys 预填,
      // 导致 config.json 遗留的明文 key 永远无法迁入(升级后旧明文被剥离即丢失, 旧加密键顶替)。
      // 迁移应覆盖可能过期的加密键: config.json 明文是磁盘上真实生效的 key。
      if (k && typeof k === 'string' && !k.includes('***') && !isEncrypted(k) && !freshStoreKeys.has(storeKey)) {
        apiKeysToSave[storeKey] = k;
      }
    }
  };
  collectLegacyPlaintextKeys(existingConfig?.models?.providers);
  collectLegacyPlaintextKeys(existingConfig?.imageGeneration?.providers, 'imageGen_');
  collectLegacyPlaintextKeys(existingConfig?.videoGeneration?.providers, 'videoGen_');
  saveApiKeys(apiKeysToSave);
  
  if (config.agent) {
    const assistantData = {
      name: config.agent.name,
      personality: config.agent.vibe,
      systemPrompt: config.agent.systemPrompt,
      avatar: config.agent.emoji
    };
    if (!fs.existsSync(CONFIG_SUBDIR)) {
      fs.mkdirSync(CONFIG_SUBDIR, { recursive: true });
    }
    atomicWrite(ASSISTANT_CONFIG_PATH, JSON.stringify(assistantData, null, 2));
    delete mainConfig.agent;
  }
  
  if (config.user) {
    const userData = {
      name: config.user.name,
      callMe: config.user.callMe,
      timezone: config.user.timezone,
      notes: config.user.notes,
      larkUserId: config.user.larkUserId,
      wecomUserId: config.user.wecomUserId,
      syncMode: config.user.syncMode
    };
    if (!fs.existsSync(CONFIG_SUBDIR)) {
      fs.mkdirSync(CONFIG_SUBDIR, { recursive: true });
    }
    atomicWrite(USER_CONFIG_PATH, JSON.stringify(userData, null, 2));
    delete mainConfig.user;
  }
  
  if (mainConfig.models?.providers) {
    const providersCopy = {};
    for (const [key, provider] of Object.entries(mainConfig.models.providers)) {
      providersCopy[key] = {
        baseUrl: provider.baseUrl,
        model: provider.model
      };
    }
    mainConfig.models.providers = providersCopy;
  }
  
  if (mainConfig.imageGeneration?.providers) {
    const providersCopy = {};
    for (const [key, provider] of Object.entries(mainConfig.imageGeneration.providers)) {
      providersCopy[key] = {
        baseUrl: provider.baseUrl,
        model: provider.model
      };
    }
    mainConfig.imageGeneration.providers = providersCopy;
  }

  if (mainConfig.videoGeneration?.providers) {
    const providersCopy = {};
    for (const [key, provider] of Object.entries(mainConfig.videoGeneration.providers)) {
      providersCopy[key] = {
        baseUrl: provider.baseUrl,
        model: provider.model
      };
    }
    mainConfig.videoGeneration.providers = providersCopy;
  }
  
  if (mainConfig.lark?.appSecret) {
    mainConfig.lark.appSecret = maskApiKey(mainConfig.lark.appSecret);
  }
  
  if (mainConfig.wecom?.secret) {
    mainConfig.wecom.secret = maskApiKey(mainConfig.wecom.secret);
  }
  
  const finalConfig = deepMerge(existingConfig, mainConfig);

  // 2026-08-31 修复(密钥保存丢失)配套: 落盘前剥离 provider key——真值在加密存储,
  // config.json 不再携带任何模型 key, 杜绝遗留明文经 deepMerge 存活后遮蔽新 key。
  // (迁移已在上方 saveApiKeys 前完成, 此处删除不会丢 key。)
  const stripProviderKeys = (providers) => {
    for (const p of Object.values(providers || {})) {
      if (p && typeof p === 'object') delete p.apiKey;
    }
  };
  stripProviderKeys(finalConfig.models?.providers);
  stripProviderKeys(finalConfig.imageGeneration?.providers);
  stripProviderKeys(finalConfig.videoGeneration?.providers);

  console.log('💾 保存配置 - 最终的 voice 配置:', finalConfig.voice);

  // 2026-08-31 修复(Profile 缺陷2/3): 自定义 Profile 激活时, 保存重定向到 Profile
  // 快照——主 config.json 不动(缺陷3 的固化写回已删), 快照随保存同步更新, 加载时
  // 快照=刚保存的值, 不再出现"旧快照遮蔽新设置"的假象。默认档(=主配置)保持原行为。
  // 快照写入由 profile-manager 负责剥离敏感键(密钥单一事实源 .api_keys.json)。
  let pm = null;
  let profileTarget = null;
  try {
    pm = require('./profile-manager');
    // init 仅一次: ensureDefaultProfile 在默认档缺失时会改写 .active_profile
    // 标记(把活跃档换成新建的默认档)——首次启动后默认档必然存在, 重复 init 无害
    // 但避免每保存都扫描/迁移目录。
    if (!isProfileManagerInitDone) {
      pm.init(DATA_DIR);
      isProfileManagerInitDone = true;
    }
    const activeId = pm.getActiveProfile();
    const activeMeta = activeId ? pm.getProfileMeta(activeId) : null;
    if (activeMeta && !activeMeta.isDefault) profileTarget = activeId;
  } catch (e) {
    console.warn('[config.js] 检测活跃 Profile 失败, 回退主配置写盘:', e && e.message);
  }
  if (profileTarget && pm) {
    try {
      pm.writeProfileSnapshotConfig(profileTarget, finalConfig);
      console.log(`📋 保存配置 - Profile ${profileTarget} 激活, 已写入快照(主配置未变)`);
    } catch (e) {
      console.error('[config.js] Profile 快照写入失败, 回退主配置写盘:', e && e.message);
      atomicWrite(CONFIG_PATH, JSON.stringify(finalConfig, null, 2));
    }
  } else {
    atomicWrite(CONFIG_PATH, JSON.stringify(finalConfig, null, 2));
  }

  // 2026-08-31 修复(密钥保存后仍显示旧值): config-handler 的 POST /config 在
  // saveConfig() 之后立刻调用 ctx.config.loadConfig() 刷新 appConfig——但 loadConfig()
  // 有 1s TTL 缓存, 且缓存仅靠不可靠的 fs.watch(config.json) 失效(atomicWrite 的
  // unlink+rename 在 Windows 上常不派发 change/rename 事件)。缓存未失效时 loadConfig()
  // 返回保存前的陈旧配置(旧 API Key), 随后 Object.assign 把 appConfig 覆盖为旧 key →
  // 面板(GET /config 读 appConfig)与运行时恒显旧值, 表现为"保存成功但旧 key 一直生效"。
  // 写盘完成后主动失效缓存, 使紧随其后的 loadConfig() 确定性重读磁盘最新值。
  invalidateConfigCache();
}

function deepMerge(target, source) {
  const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  const result = { ...target };
  
  for (const key of Object.keys(source)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    if (source[key] !== undefined && source[key] !== null) {
      if (
        typeof source[key] === 'object' && 
        !Array.isArray(source[key]) && 
        typeof target[key] === 'object' && 
        !Array.isArray(target[key])
      ) {
        result[key] = deepMerge(target[key], source[key]);
      } else {
        result[key] = source[key];
      }
    }
  }
  
  return result;
}

const defaultSchedules = {
  cron: []
};

function loadSchedules() {
  const loaded = safeReadJson(SCHEDULES_PATH, null);
  if (loaded) {
    return { ...defaultSchedules, ...loaded };
  }
  return { ...defaultSchedules };
}

function saveSchedules(schedules) {
  atomicWrite(SCHEDULES_PATH, JSON.stringify(schedules, null, 2));
  updateHeartbeatFile(schedules);
}

function updateHeartbeatFile(schedules) {
  const heartbeatPath = path.join(WORKSPACE_DIR, 'HEARTBEAT.md');
  
  const taskLines = (schedules.cron || [])
    .filter(task => task.enabled !== false)
    .map(task => {
      const timeDesc = formatCronForHuman(task.cron);
      let actionDesc;
      if (task.action === 'search') {
        actionDesc = `搜索"${task.params?.keyword || ''}"并推送`;
      } else if (task.action === 'reminder') {
        actionDesc = `提醒: ${task.message || task.name}`;
      } else {
        actionDesc = task.action;
      }
      return `- [ ] **${task.name}** - ${timeDesc}，${actionDesc}`;
    });
  
  const content = `# HEARTBEAT.md - Periodic Tasks

This file is read by the AI during conversations to remind it of periodic tasks.

## Active Tasks

${taskLines.length > 0 ? taskLines.join('\n') : '_No active tasks_'}

---

_Keep this file small to limit token burn._
`;
  
  fs.writeFileSync(heartbeatPath, content, 'utf-8');
}

function formatCronForHuman(cronExpr) {
  const parts = cronExpr.split(' ');
  if (parts.length !== 5) return cronExpr;
  
  const [min, hour] = parts;
  
  if (min === '0') {
    return `每天 ${hour}:00`;
  }
  return `每天 ${hour}:${min.padStart(2, '0')}`;
}

function updateWorkspaceFiles(config) {
  const identityPath = path.join(WORKSPACE_DIR, 'IDENTITY.md');
  const userPath = path.join(WORKSPACE_DIR, 'USER.md');
  
  if (config.agent?.name) {
    const identityContent = `# IDENTITY.md - Who Am I?

- **Name:** ${config.agent.name || 'CrabPaw'}
- **Creature:** ${config.agent.creature || 'AI Assistant'}
- **Vibe:** ${config.agent.vibe || '专业、简洁'}
- **Emoji:** ${config.agent.emoji || '🦀'}

---

This file defines who the AI assistant is.
`;
    fs.writeFileSync(identityPath, identityContent, 'utf-8');
  }
  
  if (config.user?.name) {
    const userContent = `# USER.md - About Your Human

- **Name:** ${config.user.name || ''}
- **What to call them:** ${config.user.callMe || ''}
- **Timezone:** ${config.user.timezone || 'Asia/Shanghai'}
- **Notes:** ${config.user.notes || ''}

## Context

${config.user.notes || 'Build this over time.'}

---

The more you know, the better you can help.
`;
    fs.writeFileSync(userPath, userContent, 'utf-8');
  }
}

function recordUser(openId) {
  if (!openId || openId === 'unknown') return;
  
  const memoryPath = path.join(WORKSPACE_DIR, 'MEMORY.md');
  let content = '';
  
  if (fs.existsSync(memoryPath)) {
    content = fs.readFileSync(memoryPath, 'utf-8');
  }
  
  if (content.includes(openId)) return;
  
  if (content.includes('订阅用户')) {
    content = content.replace(/订阅用户[:：]\s*([^\n]*)/, (match, users) => {
      const userList = users.split(',').map(u => u.trim()).filter(Boolean);
      if (!userList.includes(openId)) {
        userList.push(openId);
      }
      return `订阅用户: ${userList.join(', ')}`;
    });
  } else {
    if (!content.includes('# MEMORY.md')) {
      content = `# MEMORY.md - Long-Term Memory

This file stores curated memories and important context.

---

## 用户

订阅用户: ${openId}

---

_Only load in main session (direct chats with your human)._
`;
    } else {
      content += `\n\n## 用户\n\n订阅用户: ${openId}\n`;
    }
  }
  
  fs.writeFileSync(memoryPath, content, 'utf-8');
}

function getPushTargets(config) {
  const targets = [];
  
  if (config.pushTargets && config.pushTargets.length > 0) {
    targets.push(...config.pushTargets);
  }
  
  const memoryPath = path.join(WORKSPACE_DIR, 'MEMORY.md');
  if (fs.existsSync(memoryPath)) {
    const content = fs.readFileSync(memoryPath, 'utf-8');
    const match = content.match(/订阅用户[:：]\s*([^\n]+)/);
    if (match) {
      targets.push(...match[1].split(',').map(u => u.trim()).filter(Boolean));
    }
  }
  
  return [...new Set(targets)];
}


// ============================================================
// Merged from config-loader.js ? YAML-based config loading
// ============================================================

const YAML_CONFIG_FILE_PATH = path.join(__dirname, '..', '..', 'config.yaml');

const YAML_DEFAULT_CONFIG = {
  system: {
    version: '2.0.0',
    language: 'zh-CN',
    timezone: 'Asia/Shanghai',
    logLevel: 'info',
    dataDir: './data/.crabpaw'
  },
  models: {
    provider: 'deepseek',
    model: 'deepseek-chat',
    temperature: 0.7,
    maxTokens: 4000
  },
  tts: {
    enabled: true,
    provider: 'edge-tts',
    voice: 'zh-CN-XiaoxiaoNeural',
    speed: 1.0
  },
  voiceReply: {
    enabled: true,
    refineEnabled: true,
    maxLength: 150,
    evolutionEnabled: true
  },
  memory: {
    enabled: true,
    provider: 'local',
    maxSize: '1GB',
    retentionDays: 90
  },
  evolution: {
    enabled: true,
    autoEvolve: true,
    evolutionInterval: 86400000,
    feedbackInterval: 3600000,
    maxEvolutionSteps: 10
  },
  tools: {
    enabled: true,
    safetyLevel: 'medium',
    approvalRequired: true
  },
  skills: {
    enabled: true,
    autoCreate: true,
    autoEvolve: true,
    // SP2: 推荐质量阈值(0..1, 0=不过滤)。maxSkills/marketEnabled 等运行时键
    // 在 config.yaml 中存在但默认值从未登记——按「只补 minQuality, 其他不动」执行。
    minQuality: 0
  },
  plugins: {
    enabled: true,
    autoLoad: true
  },
  agentScope: {
    advisoryBudget: false,
    advisoryLoop: false,
    compactPrompt: false
  }
};

function replaceEnvVars(value) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (match, varName) => {
      const envValue = process.env[varName];
      if (envValue === undefined) {
        console.warn('\u26a0\ufe0f \u73af\u5883\u53d8\u91cf ' + varName + ' \u672a\u5b9a\u4e49');
        return match;
      }
      return envValue;
    });
  } else if (typeof value === 'object' && value !== null) {
    const result = Array.isArray(value) ? [] : {};
    for (const key in value) {
      result[key] = replaceEnvVars(value[key]);
    }
    return result;
  }
  return value;
}

const VALIDATION_RULES = {
  system: {
    version: { type: 'string', required: true },
    language: { type: 'string', enum: ['zh-CN', 'en-US'] },
    timezone: { type: 'string' },
    logLevel: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] }
  },
  models: {
    provider: { type: 'string', required: true },
    model: { type: 'string', required: true },
    temperature: { type: 'number', min: 0, max: 2 },
    maxTokens: { type: 'number', min: 1 }
  },
  tts: {
    enabled: { type: 'boolean' },
    provider: { type: 'string', enum: ['edge-tts', 'piper'] },
    voice: { type: 'string' },
    speed: { type: 'number', min: 0.5, max: 2 }
  },
  evolution: {
    enabled: { type: 'boolean' },
    autoEvolve: { type: 'boolean' },
    evolutionInterval: { type: 'number', min: 60000 }
  },
  agentScope: {
    advisoryBudget: { type: 'boolean' },
    advisoryLoop: { type: 'boolean' },
    compactPrompt: { type: 'boolean' }
  }
};

function validateConfig(config, rules, path) {
  if (rules === undefined) rules = VALIDATION_RULES;
  if (path === undefined) path = '';
  const errors = [];
  const warnings = [];

  for (const [key, rule] of Object.entries(rules)) {
    const fullPath = path ? path + '.' + key : key;
    const value = config[key];

    if (rule.required && value === undefined) {
      errors.push({
        path: fullPath,
        type: 'missing_required',
        message: '\u7f3a\u5c11\u5fc5\u9700\u5b57\u6bb5: ' + fullPath
      });
      continue;
    }

    if (value === undefined) continue;

    if (rule.type) {
      const actualType = Array.isArray(value) ? 'array' : typeof value;
      if (actualType !== rule.type) {
        errors.push({
          path: fullPath,
          type: 'invalid_type',
          expected: rule.type,
          actual: actualType,
          message: fullPath + ' \u7c7b\u578b\u9519\u8bef\uff0c\u671f\u671b ' + rule.type + '\uff0c\u5b9e\u9645 ' + actualType
        });
      }
    }

    if (rule.enum && !rule.enum.includes(value)) {
      errors.push({
        path: fullPath,
        type: 'invalid_enum',
        expected: rule.enum,
        actual: value,
        message: fullPath + ' \u503c\u65e0\u6548\uff0c\u671f\u671b ' + rule.enum.join(' \u6216 ') + '\uff0c\u5b9e\u9645 ' + value
      });
    }

    if (rule.min !== undefined && typeof value === 'number' && value < rule.min) {
      warnings.push({
        path: fullPath,
        type: 'below_min',
        message: fullPath + ' \u503c ' + value + ' \u5c0f\u4e8e\u6700\u5c0f\u503c ' + rule.min
      });
    }

    if (rule.max !== undefined && typeof value === 'number' && value > rule.max) {
      warnings.push({
        path: fullPath,
        type: 'above_max',
        message: fullPath + ' \u503c ' + value + ' \u5927\u4e8e\u6700\u5927\u503c ' + rule.max
      });
    }
  }

  return { errors: errors, warnings: warnings };
}

function getDefaultValue_yaml(configPath) {
  const pathParts = configPath.split('.');
  let current = YAML_DEFAULT_CONFIG;

  for (const part of pathParts) {
    if (current[part] === undefined) return undefined;
    current = current[part];
  }

  return current;
}

function convertType(value, targetType) {
  try {
    switch (targetType) {
      case 'string': return String(value);
      case 'number': return Number(value);
      case 'boolean':
        if (typeof value === 'string') return value.toLowerCase() === 'true';
        return Boolean(value);
      case 'array':
        if (typeof value === 'string') return value.split(',').map(function(v) { return v.trim(); });
        return Array.isArray(value) ? value : [value];
      case 'object':
        if (typeof value === 'string') return JSON.parse(value);
        return typeof value === 'object' ? value : null;
      default: return null;
    }
  } catch (err) {
    return null;
  }
}

function autoFixConfig(config, errors) {
  const fixed = JSON.parse(JSON.stringify(config));

  for (const error of errors) {
    const pathParts = error.path.split('.');
    let current = fixed;

    for (let i = 0; i < pathParts.length - 1; i++) {
      if (!current[pathParts[i]]) current[pathParts[i]] = {};
      current = current[pathParts[i]];
    }

    const lastKey = pathParts[pathParts.length - 1];

    if (error.type === 'missing_required') {
      const defaultValue = getDefaultValue_yaml(error.path);
      if (defaultValue !== undefined) {
        current[lastKey] = defaultValue;
        console.log('\ud83d\udd27 \u81ea\u52a8\u4fee\u590d: ' + error.path + ' = ' + defaultValue);
      }
    } else if (error.type === 'invalid_type') {
      const converted = convertType(current[lastKey], error.expected);
      if (converted !== null) {
        current[lastKey] = converted;
        console.log('\ud83d\udd27 \u81ea\u52a8\u4fee\u590d: ' + error.path + ' \u7c7b\u578b\u8f6c\u6362\u4e3a ' + error.expected);
      }
    } else if (error.type === 'invalid_enum') {
      current[lastKey] = error.expected[0];
      console.log('\ud83d\udd27 \u81ea\u52a8\u4fee\u590d: ' + error.path + ' = ' + error.expected[0]);
    }
  }

  return fixed;
}

async function loadYamlConfig() {
  try {
    const yamlContent = await fsAsync.readFile(YAML_CONFIG_FILE_PATH, 'utf-8');
    // yaml 包 v2 已移除 .load（改 .parse）——原 yaml.load 抛 TypeError 被 catch 吞掉,
    // 导致配置加载静默回退默认值
    const config = yaml.parse(yamlContent);
    const configWithEnv = replaceEnvVars(config);
    const validation = validateConfig(configWithEnv);

    if (validation.errors.length > 0) {
      console.warn('\u26a0\ufe0f \u914d\u7f6e\u9a8c\u8bc1\u9519\u8bef:', validation.errors);
      const fixedConfig = autoFixConfig(configWithEnv, validation.errors);
      const revalidation = validateConfig(fixedConfig);

      if (revalidation.errors.length > 0) {
        console.error('\u274c \u914d\u7f6e\u4fee\u590d\u540e\u4ecd\u6709\u9519\u8bef:', revalidation.errors);
        throw new Error('\u914d\u7f6e\u9a8c\u8bc1\u5931\u8d25');
      }

      console.log('\u2705 \u914d\u7f6e\u5df2\u81ea\u52a8\u4fee\u590d');
      return fixedConfig;
    }

    if (validation.warnings.length > 0) {
      console.warn('\u26a0\ufe0f \u914d\u7f6e\u9a8c\u8bc1\u8b66\u544a:', validation.warnings);
    }

    console.log('\u2705 \u914d\u7f6e\u52a0\u8f7d\u6210\u529f');
    return configWithEnv;
  } catch (err) {
    console.error('\u274c \u914d\u7f6e\u52a0\u8f7d\u5931\u8d25:', err);
    console.log('\u26a0\ufe0f \u4f7f\u7528\u9ed8\u8ba4\u914d\u7f6e');
    return YAML_DEFAULT_CONFIG;
  }
}

async function saveYamlConfig(config) {
  try {
    const yamlContent = yaml.dump(config, {
      indent: 2,
      lineWidth: -1,
      noRefs: true
    });
    await fsAsync.writeFile(YAML_CONFIG_FILE_PATH, yamlContent, 'utf-8');
    console.log('\u2705 \u914d\u7f6e\u4fdd\u5b58\u6210\u529f');
  } catch (err) {
    console.error('\u274c \u914d\u7f6e\u4fdd\u5b58\u5931\u8d25:', err);
    throw err;
  }
}

function getConfigValue(config, path, defaultValue) {
  if (defaultValue === undefined) defaultValue = undefined;
  const pathParts = path.split('.');
  let current = config;

  for (const part of pathParts) {
    if (current === undefined || current === null) return defaultValue;
    current = current[part];
  }

  return current !== undefined ? current : defaultValue;
}

function setConfigValue(config, path, value) {
  const pathParts = path.split('.');
  let current = config;

  for (let i = 0; i < pathParts.length - 1; i++) {
    if (!current[pathParts[i]]) current[pathParts[i]] = {};
    current = current[pathParts[i]];
  }

  current[pathParts[pathParts.length - 1]] = value;
}

let yamlCachedConfig = null;

async function getConfig() {
  if (!yamlCachedConfig) {
    yamlCachedConfig = await loadYamlConfig();
  }
  return yamlCachedConfig;
}

async function reloadConfig() {
  yamlCachedConfig = await loadYamlConfig();
  return yamlCachedConfig;
}


// ============================================================
// Merged from config-manager.js ? Unified Config Management
// ============================================================

const MANAGER_DEFAULT_CONFIG_PATH = path.join(process.cwd(), 'crabpaw.json');

const DEFAULT_CONFIG = {
  version: '1.0.0',
  agent: {
    id: 'default',
    name: 'CrabPaw Agent',
    description: 'A powerful AI agent with SubAgent support',
    model: 'deepseek',
    toolProfile: 'coding',
  },
  models: {
    default: 'deepseek',
    providers: {
      minimax: {
        baseUrl: 'https://api.minimax.chat/v1',
        model: 'MiniMax-Text-01',
        apiKey: null,
      },
      kimi: {
        baseUrl: 'https://api.moonshot.cn/v1',
        model: 'moonshot-v1-auto',
        apiKey: null,
      },
      deepseek: {
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        apiKey: null,
      },
      openai: {
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        apiKey: null,
      },
      claude: {
        baseUrl: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet-4-20250514',
        apiKey: null,
      },
    },
  },
  channels: {
    enabled: ['cli'],
    configs: {},
  },
  tools: {
    profile: 'coding',
    customPolicies: {},
    alsoAllow: [],
  },
  routing: {
    bindings: [],
    dmScope: 'main',
  },
  subagents: {
    maxConcurrent: 5,
    defaultTimeout: 300000,
    autoCleanup: true,
  },
  gateway: {
    port: 3000,
    host: '127.0.0.1',
    auth: {
      mode: 'token',
      token: null,
    },
  },
  logging: {
    level: 'info',
    file: null,
  },
  agentScope: {
    advisoryBudget: false,
    advisoryLoop: false,
    compactPrompt: false,
  },
};

class ConfigManager {
  constructor(configPath) {
    if (configPath === undefined) configPath = MANAGER_DEFAULT_CONFIG_PATH;
    this.configPath = configPath;
    this.config = null;
    this.watchers = [];
  }

  load() {
    try {
      if (fs.existsSync(this.configPath)) {
        const cnt = fs.readFileSync(this.configPath, 'utf8');
        const loaded = JSON.parse(cnt);
        this.config = this.mergeWithDefaults(loaded);
      } else {
        this.config = Object.assign({}, DEFAULT_CONFIG);
      }
      
      this.applyConfig();
      return this.config;
    } catch (error) {
      console.error('Failed to load config:', error.message);
      this.config = Object.assign({}, DEFAULT_CONFIG);
      return this.config;
    }
  }

  mergeWithDefaults(loaded) {
    const merged = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    
    for (const key of Object.keys(loaded)) {
      if (typeof loaded[key] === 'object' && !Array.isArray(loaded[key]) && typeof merged[key] === 'object' && !Array.isArray(merged[key])) {
        merged[key] = Object.assign({}, merged[key], loaded[key]);
        for (const subKey of Object.keys(loaded[key])) {
          if (typeof loaded[key][subKey] === 'object' && !Array.isArray(loaded[key][subKey]) && typeof merged[key][subKey] === 'object' && !Array.isArray(merged[key][subKey])) {
            merged[key][subKey] = Object.assign({}, merged[key][subKey], loaded[key][subKey]);
          }
        }
      } else {
        merged[key] = loaded[key];
      }
    }
    
    return merged;
  }

  applyConfig() {
    if (!this.config) return;
    
    if (this.config.tools && this.config.tools.customPolicies) {
      for (const [name, policy] of Object.entries(this.config.tools.customPolicies)) {
        toolPolicyManager.registerCustomProfile(name, policy);
      }
    }
    
    if (this.config.routing && this.config.routing.bindings) {
      routeResolver.clearBindings();
      for (const binding of this.config.routing.bindings) {
        routeResolver.registerBinding(binding);
      }
    }
    
    if (this.config.agent) {
      routeResolver.registerAgent(this.config.agent.id, this.config.agent);
    }
  }

  save() {
    try {
      const cnt = JSON.stringify(this.config, null, 2);
      fs.writeFileSync(this.configPath, cnt, 'utf8');
      return true;
    } catch (error) {
      console.error('Failed to save config:', error.message);
      return false;
    }
  }

  get(key, defaultValue) {
    if (defaultValue === undefined) defaultValue = undefined;
    if (!this.config) this.load();
    
    const keys = key.split('.');
    let value = this.config;
    
    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = value[k];
      } else {
        return defaultValue;
      }
    }
    
    return value;
  }

  set(key, value) {
    if (!this.config) this.load();
    
    const keys = key.split('.');
    let obj = this.config;
    
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (!(k in obj) || typeof obj[k] !== 'object') {
        obj[k] = {};
      }
      obj = obj[k];
    }
    
    obj[keys[keys.length - 1]] = value;
    this.notifyWatchers(key, value);
    return this;
  }

  update(updates) {
    if (!this.config) this.load();
    
    for (const [key, value] of Object.entries(updates)) {
      this.set(key, value);
    }
    
    return this;
  }

  watch(callback) {
    this.watchers.push(callback);
    var self = this;
    return function() {
      const index = self.watchers.indexOf(callback);
      if (index !== -1) {
        self.watchers.splice(index, 1);
      }
    };
  }

  notifyWatchers(key, value) {
    for (const watcher of this.watchers) {
      try {
        watcher(key, value, this.config);
      } catch (error) {
        console.error('Config watcher error:', error);
      }
    }
  }

  getModelConfig(modelId) {
    const providers = this.get('models.providers', {});
    const defaultModel = this.get('models.default', 'minimax');
    
    const model = modelId || defaultModel;
    
    if (providers[model]) {
      return Object.assign({ id: model }, providers[model]);
    }
    
    return null;
  }

  getChannelConfig(channelId) {
    const channel = channelRegistry.resolve(channelId);
    if (!channel) return null;
    
    const configs = this.get('channels.configs', {});
    return Object.assign({}, channel, { config: configs[channelId] || {} });
  }

  getToolPolicy() {
    const profile = this.get('tools.profile', 'coding');
    const alsoAllow = this.get('tools.alsoAllow', []);
    
    let policy = toolPolicyManager.resolveToolProfilePolicy(profile);
    
    if (alsoAllow.length > 0 && policy) {
      policy = Object.assign({}, policy, { allow: (policy.allow || []).concat(alsoAllow) });
    }
    
    return policy;
  }

  getEnabledChannels() {
    const enabled = this.get('channels.enabled', ['cli']);
    var self = this;
    return enabled.map(function(id) { return self.getChannelConfig(id); }).filter(Boolean);
  }

  getSubAgentConfig() {
    return this.get('subagents', {
      maxConcurrent: 5,
      defaultTimeout: 300000,
      autoCleanup: true,
    });
  }

  validate() {
    const errors = [];
    
    const model = this.get('agent.model');
    if (!model) {
      errors.push('agent.model is required');
    }
    
    const modelConfig = this.getModelConfig(model);
    if (!modelConfig) {
      errors.push('Unknown model: ' + model);
    } else if (!modelConfig.apiKey) {
      errors.push('API key not set for model: ' + model);
    }
    
    const toolProfile = this.get('tools.profile');
    if (!TOOL_PROFILES[toolProfile]) {
      errors.push('Unknown tool profile: ' + toolProfile);
    }
    
    return {
      valid: errors.length === 0,
      errors: errors,
    };
  }

  export() {
    if (!this.config) this.load();
    return JSON.stringify(this.config, null, 2);
  }

  import_config(jsonString) {
    try {
      const config = JSON.parse(jsonString);
      this.config = this.mergeWithDefaults(config);
      this.applyConfig();
      return true;
    } catch (error) {
      console.error('Failed to import config:', error.message);
      return false;
    }
  }

  getAll() {
    if (!this.config) this.load();
    return JSON.parse(JSON.stringify(this.config));
  }

  init() {
    if (!this.config) this.load();
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.configPath)) {
      this.save();
    }
    return this;
  }

  reset() {
    this.config = Object.assign({}, DEFAULT_CONFIG);
    this.applyConfig();
    return this;
  }
}

const configManager = new ConfigManager();

module.exports = {
  BASE_DIR,
  getDataDir,
  DATA_DIR,
  CONFIG_PATH,
  API_KEYS_PATH,
  loadApiKeys,
  saveApiKeys,
  WORKSPACE_DIR,
  SKILLS_DIR,
  GLOBAL_SKILLS_DIR,
  DEFAULT_PORT,
  loadConfig,
  saveConfig,
  loadSchedules,
  saveSchedules,
  updateWorkspaceFiles,
  recordUser,
  getPushTargets,
  // From config-loader (YAML-based)
  loadYamlConfig,
  saveYamlConfig,
  getConfig,
  reloadConfig,
  invalidateConfigCache,
  getConfigValue,
  setConfigValue,
  validateConfig,
  autoFixConfig,
  replaceEnvVars,
  YAML_DEFAULT_CONFIG,
  VALIDATION_RULES,
  // From config-manager
  ConfigManager,
  configManager,
  DEFAULT_CONFIG,
  DEFAULT_CONFIG_PATH: MANAGER_DEFAULT_CONFIG_PATH,
};
