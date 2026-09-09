const fs = require('fs');
const path = require('path');
// 统一使用 canonical frontmatter-parser（2026-08-01 清理内联重复实现）
// eslint-disable-next-line no-unused-vars -- cleanValue/parseYamlBlock 未用，require 解构保留
const { parseFrontmatter, cleanValue, parseYamlBlock, parseMetadata, parseInlineArray } = require('./skill/frontmatter-parser');
const { spawn } = require('child_process');
// eslint-disable-next-line no-unused-vars -- DATA_DIR 未用，require 解构保留
const { SKILLS_DIR, GLOBAL_SKILLS_DIR, DATA_DIR } = require('./config');
const { getSkillEvolver } = require('./skill/skill-evolver');
const { getQualityTracker } = require('./skill/skill-quality-tracker');
// eslint-disable-next-line no-unused-vars -- compactHomePath 未用，require 解构保留
const { buildBudgetedSkillsPrompt, compactHomePath } = require('./skill/skill-prompt-budget');
const { globalSkillEnvManager } = require('./skill/skill-env-manager');
const provenance = require('./skill/skill-provenance');
const telemetry = require('./skill/skill-usage-telemetry');
const { getSkillHealthChecker } = require('./skill/skill-health-checker');

function normalizeSkillName(name) {
  return name.toLowerCase()
    .replace(/[\s/]+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

const JS_SECURITY_PATTERNS = [
  { pattern: /eval\s*\(/g, severity: 'high', desc: '使用 eval()，可能执行任意代码' },
  { pattern: /Function\s*\(/g, severity: 'high', desc: '使用 Function 构造器，可能执行任意代码' },
  { pattern: /child_process/g, severity: 'high', desc: '引用 child_process，可能执行系统命令' },
  { pattern: /require\s*\(\s*['"]child_process/g, severity: 'critical', desc: '直接引入 child_process' },
  { pattern: /(?<!\.)exec\s*\(/g, severity: 'high', desc: '调用 exec，可能执行系统命令' },
  { pattern: /execSync\s*\(/g, severity: 'high', desc: '调用 execSync，可能执行系统命令' },
  { pattern: /spawn\s*\(/g, severity: 'medium', desc: '调用 spawn，可能执行系统命令' },
  { pattern: /fs\.\s*(unlink|rmdir|rm|rename|write|append|truncate|chmod|chown)/g, severity: 'medium', desc: '文件系统写操作' },
  { pattern: /process\.env/g, severity: 'low', desc: '读取环境变量，可能泄露敏感信息' },
  { pattern: /fetch\s*\(\s*['"]https?:\/\//g, severity: 'low', desc: '外部网络请求' },
  { pattern: /XMLHttpRequest/g, severity: 'low', desc: 'XMLHttpRequest 网络请求' },
  { pattern: /WebSocket/g, severity: 'medium', desc: 'WebSocket 连接' },
  { pattern: /atob\s*\(/g, severity: 'low', desc: 'Base64 解码，可能隐藏恶意代码' },
  { pattern: /new\s+Worker/g, severity: 'medium', desc: '创建 Web Worker' },
  { pattern: /import\s*\(/g, severity: 'medium', desc: '动态 import，可能加载外部模块' },
];

const PYTHON_SECURITY_PATTERNS = [
  { pattern: /eval\s*\(/g, severity: 'high', desc: '使用 eval()，可能执行任意代码' },
  { pattern: /exec\s*\(/g, severity: 'high', desc: '使用 exec()，可能执行任意代码' },
  { pattern: /os\.system\s*\(/g, severity: 'high', desc: '使用 os.system()，可能执行系统命令' },
  { pattern: /subprocess/g, severity: 'high', desc: '引用 subprocess，可能执行系统命令' },
  { pattern: /__import__\s*\(/g, severity: 'critical', desc: '使用 __import__()，动态加载模块' },
  { pattern: /pickle\.load\s*\(/g, severity: 'high', desc: '使用 pickle.load()，反序列化可能执行恶意代码' },
  { pattern: /marshal\.loads?\s*\(/g, severity: 'high', desc: '使用 marshal，反序列化可能执行恶意代码' },
  { pattern: /(?<!\.)compile\s*\(/g, severity: 'medium', desc: '使用 compile()，可能编译执行代码' },
  { pattern: /globals\s*\(\s*\)/g, severity: 'high', desc: '使用 globals()，可能访问全局命名空间' },
  { pattern: /locals\s*\(\s*\)/g, severity: 'medium', desc: '使用 locals()，可能访问局部命名空间' },
  { pattern: /open\s*\(\s*['"].*['"].*\)/g, severity: 'medium', desc: '文件读写操作' },
  { pattern: /requests\.(get|post|put|delete)\s*\(/g, severity: 'low', desc: '外部网络请求' },
  { pattern: /urllib/g, severity: 'low', desc: '网络请求库' },
];

function getSecurityPatterns(ext) {
  const lowerExt = ext.toLowerCase();
  if (['.py', '.pyw'].includes(lowerExt)) {
    return PYTHON_SECURITY_PATTERNS;
  }
  return JS_SECURITY_PATTERNS;
}

// P1-2(2026-08-25) 安全扫描增量缓存：目录指纹（条目级 mtime+size）不变 → 直接返回上次结果。
// 扫描本体是全量读盘 1.07MB + 29 条正则，指纹命中可把"每次重扫"变为"技能真变更才扫"。
const _scanCache = new Map(); // skillPath → { fp, findings }

function scanSkillSecurity(skillPath, skillName) {
  const fp = _skillsDirFingerprint(skillPath);
  const cached = _scanCache.get(skillPath);
  if (cached && cached.fp === fp) {
    return cached.findings;
  }
  const findings = [];

  function scanFile(filePath, relPath) {
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (e) {
      return;
    }

    const ext = path.extname(filePath);
    const patterns = getSecurityPatterns(ext);

    for (const { pattern, severity, desc } of patterns) {
      pattern.lastIndex = 0;
      const matches = content.match(pattern);
      if (matches) {
        findings.push({
          file: relPath,
          severity,
          desc,
          count: matches.length
        });
      }
    }
  }

  function walkDir(dir, relBase = '') {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        walkDir(fullPath, relPath);
      } else if (/\.(js|ts|mjs|cjs|sh|bat|cmd|ps1|py|rb|pl)$/i.test(entry.name)) {
        scanFile(fullPath, relPath);
      }
    }
  }

  walkDir(skillPath);

  if (findings.length > 0) {
    const critical = findings.filter(f => f.severity === 'critical');
    const high = findings.filter(f => f.severity === 'high');
    const medium = findings.filter(f => f.severity === 'medium');

    if (critical.length > 0) {
      console.log(`🚨 技能 [${skillName}] 安全扫描发现严重风险:`);
      critical.forEach(f => console.log(`   ❌ [CRITICAL] ${f.file}: ${f.desc} (x${f.count})`));
    }
    if (high.length > 0) {
      console.log(`⚠️ 技能 [${skillName}] 安全扫描发现高风险:`);
      high.forEach(f => console.log(`   ⚡ [HIGH] ${f.file}: ${f.desc} (x${f.count})`));
    }
    if (medium.length > 0) {
      // P0-7(2026-08-25) 日志降噪：MEDIUM 全量逐条打印（2955 条/时段）改为汇总一行
      // （critical/high 保持逐条——威胁面需要可审计）
      const preview = medium.slice(0, 5).map(f => `${f.file}: ${f.desc}(x${f.count})`).join('; ');
      console.log(`ℹ️ 技能 [${skillName}] 安全扫描发现中等风险 ${medium.length} 处（明细仅调试域）: ${preview}${medium.length > 5 ? ' …' : ''}`);
    }
  }

  _scanCache.set(skillPath, { fp, findings });
  return findings;
}

const { execSync, execFileSync } = require('child_process');
// eslint-disable-next-line no-unused-vars -- PORTABLE_LIBS_DIR 未用，require 解构保留
const { checkPipDepsInstalled, getSkillLibDir, getSkillDependenciesInfo, getPythonPathEnv, PORTABLE_LIBS_DIR } = require('./portable-deps');

const _depCache = {}

const _pythonPathMutex = {
  _queue: [],
  _locked: false,
  acquire() {
    return new Promise(resolve => {
      if (!this._locked) {
        this._locked = true;
        resolve();
      } else {
        this._queue.push(resolve);
      }
    });
  },
  release() {
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      next();
    } else {
      this._locked = false;
    }
  }
};

function checkPythonAvailable() {
  if ('python' in _depCache) return _depCache.python
  try {
    execSync('python --version', { stdio: 'ignore', timeout: 3000, windowsHide: true })
    _depCache.python = true
    return true
  } catch (e1) {
    console.warn('[skills] python not found:', e1.message);
    try {
      execSync('python3 --version', { stdio: 'ignore', timeout: 3000, windowsHide: true })
      _depCache.python = true
      return true
    } catch (e2) {
      console.warn('[skills] python3 also not found:', e2.message);
      _depCache.python = false
      return false
    }
  }
}

function checkNPMPackageAvailable(packageName) {
  const key = 'npm:' + packageName
  if (key in _depCache) return _depCache[key]
  try {
    execFileSync('npm', ['list', '-g', packageName], { stdio: 'ignore', timeout: 5000, windowsHide: true })
    _depCache[key] = true
    return true
  } catch {
    _depCache[key] = false
    return false
  }
}

function checkSkillDependencies(skill) {
  const skillId = normalizeSkillName(skill.name);
  const deps = skill.metadata?.crabpaw?.requires || skill.metadata?.openclaw?.requires || skill.metadata?.requires || {};
  const missing = [];
  const bins = Array.isArray(deps.bins) ? deps.bins : (typeof deps.bins === 'string' ? parseInlineArray(deps.bins) : []);
  const npmPkgs = Array.isArray(deps.npm) ? deps.npm : [];
  const pythonPkgs = Array.isArray(deps.pip || deps.core) ? (deps.pip || deps.core) : [];
  const pythonBin = bins.includes('python3') || bins.includes('python') || pythonPkgs.length > 0;
  const systemBins = ['node', 'npm', 'npx', 'python3', 'python', 'git', 'docker'];
  const npmBins = bins.filter(b => !systemBins.includes(b));

  // P1-3(2026-08-25) where 探测缓存：系统命令常驻不变，进程级缓存避免每次技能全量加载
  // 新起 2-6 个 where 子进程（Windows 每个 50-150ms）
  const _binCache = new Map();
  for (const bin of bins.filter(b => systemBins.includes(b))) {
    if (!_binCache.has(bin)) {
      let ok = false;
      try {
        // 2026-09-08: windowsHide——execFileSync 不加此参数时每次探测都弹可见 cmd 窗口
        // （watch 重启全量重扫技能时窗口成串弹，用户实测）
        execFileSync('where', [bin], { stdio: 'ignore', timeout: 3000, windowsHide: true });
        ok = true;
      } catch { ok = false; }
      _binCache.set(bin, ok);
    }
    if (!_binCache.get(bin)) {
      missing.push(`${bin} (系统命令)`);
    }
  }

  if (pythonPkgs.length > 0) {
    const portableCheck = checkPipDepsInstalled(skillId, pythonPkgs);
    if (!portableCheck.installed) {
      if (!checkPythonAvailable()) {
        missing.push('Python');
      }
      missing.push(`Python 依赖未安装到便携式目录 (${portableCheck.missing.join(', ')})`);
    }
  } else if (pythonBin && !checkPythonAvailable()) {
    missing.push('Python');
  }

  for (const bin of npmBins) {
    if (!checkNPMPackageAvailable(bin)) {
      missing.push(`${bin} (npm 包)`);
    }
  }

  for (const pkg of npmPkgs) {
    if (!npmBins.includes(pkg) && !checkNPMPackageAvailable(pkg)) {
      missing.push(`${pkg} (npm 包)`);
    }
  }

  return missing;
}

function getSkillDependencyStatus(skill) {
  const skillId = normalizeSkillName(skill.name);
  const deps = skill.metadata?.crabpaw?.requires || skill.metadata?.openclaw?.requires || skill.metadata?.requires || {};
  const bins = Array.isArray(deps.bins) ? deps.bins : (typeof deps.bins === 'string' ? parseInlineArray(deps.bins) : []);
  const npmPkgs = Array.isArray(deps.npm) ? deps.npm : [];
  const pythonPkgs = Array.isArray(deps.pip || deps.core) ? (deps.pip || deps.core) : [];

  const portableInfo = getSkillDependenciesInfo(skillId);
  const hasPipDeps = pythonPkgs.length > 0;
  const hasNpmDeps = npmPkgs.length > 0;
  const hasBinDeps = bins.length > 0;

  let pipInstalled = false;
  let pipMissing = [];
  if (hasPipDeps) {
    const check = checkPipDepsInstalled(skillId, pythonPkgs);
    pipInstalled = check.installed;
    pipMissing = check.missing || [];
  }

  return {
    hasDependencies: hasPipDeps || hasNpmDeps || hasBinDeps,
    pipDeps: pythonPkgs,
    npmDeps: npmPkgs,
    binDeps: bins,
    pipInstalled,
    pipMissing,
    portableDir: getSkillLibDir(skillId),
    portableInfo,
  };
}

let playwrightSearch = null;
try {
  playwrightSearch = require('./playwright-search');
  console.log('✅ Playwright 搜索模块已加载');
} catch (e) {
  console.log('⚠️ Playwright 搜索模块未安装，将使用 fetch 方式');
}

let evolution = null;
function getEvolution() {
  if (!evolution) {
    // 适配层：桥接旧 SkillEvolution API 到新 SkillQualityTracker + SkillEvolver
    const tracker = getQualityTracker();
    // eslint-disable-next-line no-unused-vars -- getSkillEvolver() 调用保留（惰性初始化可能有副作用）
    const evolver = getSkillEvolver();
    evolution = {
      record(skillName, params, context, result) {
        tracker.recordExecution(skillName, {
          success: result.success,
          durationMs: result.duration || 0,
          error: result.error || null,
          context,
        });
      },
      getScore(skillName) {
        return tracker.getScore(skillName);
      },
      getLeaderboard() {
        return tracker.getLeaderboard();
      },
      getStats() {
        return {
          trackedSkills: tracker._records?.size || 0,
          scoreLeaderboard: tracker.getLeaderboard().slice(0, 5),
        };
      },
    };
  }
  return evolution;
}

function loadSkillsFromDir(skillsDir, source) {
  const registry = {};

  if (!fs.existsSync(skillsDir)) {
    return registry;
  }

  // 2026-08-18 P0: 过滤草稿/隐藏目录(.drafts、testdraft*),不再进入注册表
  const skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory() && !dirent.name.startsWith('.') && !dirent.name.toLowerCase().includes('testdraft'))
    .map(dirent => dirent.name);

  for (const skillName of skillDirs) {
    const skillPath = path.join(skillsDir, skillName);
    const skillMdPath = path.join(skillPath, 'SKILL.md');
    const configPath = path.join(skillPath, 'config.json');

    let skill = {
      name: skillName,
      description: '',
      version: '1.0.0',
      filePath: skillMdPath,
      baseDir: skillPath,
      config: null,
      metadata: {},
      body: '',
      source: source
    };

    if (fs.existsSync(skillMdPath)) {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      const { frontmatter, body } = parseFrontmatter(content);

      skill.name = frontmatter.name || skillName;
      skill.description = frontmatter.description || '';
      skill.body = body.trim();

      // A5(Runtime差距分析): 技能版本管理——此前 frontmatter 无 version 字段,
      // 市场安装一律 1.0.0,无法锁定/升级。声明优先(frontmatter.version),
      // metadata 命名空间回退在下方 nsRead 定义后处理,缺省 1.0.0。
      if (frontmatter.version) skill.version = String(frontmatter.version);

      if (frontmatter.metadata) {
        skill.metadata = parseMetadata(frontmatter.metadata);
      }

      // 条件性激活字段
      if (frontmatter.platforms) {
        skill.platforms = Array.isArray(frontmatter.platforms)
          ? frontmatter.platforms
          : [frontmatter.platforms];
      }
      if (frontmatter.requiresTools) {
        skill.requiresTools = Array.isArray(frontmatter.requiresTools)
          ? frontmatter.requiresTools
          : [frontmatter.requiresTools];
      }
      if (frontmatter.fallbackForTools) {
        skill.fallbackForTools = Array.isArray(frontmatter.fallbackForTools)
          ? frontmatter.fallbackForTools
          : [frontmatter.fallbackForTools];
      }
      // 兼容 metadata.crabpaw 嵌套写法（2026-08-01: 补 openclaw/clawdbot 命名空间 fallback，
      // 统一 "crabpaw 优先 → openclaw → clawdbot → 顶层" 的读取顺序）
      const nsRead = (key) => {
        const m = frontmatter.metadata || {};
        return m.crabpaw?.[key] ?? m.openclaw?.[key] ?? m.clawdbot?.[key] ?? m[key];
      };
      const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : null);
      if (!skill.platforms) skill.platforms = asArray(nsRead('platforms'));
      if (!skill.requiresTools) skill.requiresTools = asArray(nsRead('requiresTools'));
      if (!skill.fallbackForTools) skill.fallbackForTools = asArray(nsRead('fallbackForTools'));
      // A5: metadata 命名空间版本回退(frontmatter.version 未声明时)
      if (!frontmatter.version) {
        const nsVersion = nsRead('version');
        if (nsVersion) skill.version = String(nsVersion);
      }
    }

    if (fs.existsSync(configPath)) {
      try {
        skill.config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      } catch (e) {
        console.warn('读取技能配置失败:', skill.name, e.message);
      }
    }

    registry[normalizeSkillName(skill.name)] = skill;

    // Seed provenance for loaded skills
    const provenanceSource = source === 'builtin'
      ? provenance.PROVENANCE_SOURCES.BUILTIN
      : provenance.PROVENANCE_SOURCES.HUB;
    if (!provenance.getSkillOrigin(skill.name)) {
      provenance.markSkillOrigin(skill.name, provenanceSource);
    }

    // Record view telemetry on load
    telemetry.bumpView(skill.name);

    const securityFindings = scanSkillSecurity(skillPath, skill.name);
    const hasCritical = securityFindings.some(f => f.severity === 'critical');
    // 2026-08-06: 内置技能(builtin, 随仓库分发的官方技能)跳过 critical 阻止——
    // word-docx 等用 child_process.execSync 执行 Python 转 docx 是功能需求,非恶意。
    // 阻止它们导致"写 Word 文档"功能失效。非内置(community/hub)仍严格阻止。
    if (hasCritical && source === 'builtin') {
      console.log(`⚠️ 内置技能 [${skill.name}] 含 CRITICAL 风险但为官方内置,放行加载:`, securityFindings.filter(f => f.severity === 'critical').map(f => f.desc).join('; '));
      skill.securityWarning = true;
      skill.securityFindings = securityFindings;
    } else if (hasCritical) {
      console.log(`🚫 技能 [${skill.name}] 因严重安全风险被阻止加载`);
      skill.securityWarning = true;
      skill.securityBlocked = true;
      skill.securityFindings = securityFindings;
      skill.available = false;
    }

    const missingDeps = checkSkillDependencies(skill);
    if (missingDeps.length > 0) {
      skill.available = false;
      skill.missingDeps = missingDeps;
      const label = source === 'builtin' ? '内置' : source === 'global' ? '全局' : source;
      console.log(`⚠️ ${label}技能 [${skill.name}] 缺少依赖: ${missingDeps.join(', ')}`);
    } else {
      skill.available = true;
    }

    // 平台过滤（platforms 字段）
    if (skill.available && skill.platforms && skill.platforms.length > 0) {
      const PLATFORM_MAP = { 'macos': 'darwin', 'linux': 'linux', 'windows': 'win32' };
      const currentPlatform = process.platform;
      const matched = skill.platforms.some(p => {
        const normalized = String(p).toLowerCase().trim();
        const mapped = PLATFORM_MAP[normalized] || normalized;
        return currentPlatform.startsWith(mapped);
      });
      if (!matched) {
        skill.available = false;
        skill.platformMismatch = true;
      }
    }
  }

  return registry;
}

function load() {
  console.log(`📁 加载内置技能: ${SKILLS_DIR}`);
  const builtinRegistry = loadSkillsFromDir(SKILLS_DIR, 'builtin');
  Object.values(builtinRegistry).forEach(s => console.log(`✅ 内置技能: ${s.name}`));

  console.log(`📁 加载全局技能: ${GLOBAL_SKILLS_DIR}`);
  const globalRegistry = loadSkillsFromDir(GLOBAL_SKILLS_DIR, 'global');
  Object.values(globalRegistry).forEach(s => console.log(`🌐 全局技能: ${s.name}`));

  // 检测同名技能冲突
  const conflicts = Object.keys(builtinRegistry).filter(k => globalRegistry[k]);
  if (conflicts.length > 0) {
    console.log(`⚠️ 检测到 ${conflicts.length} 个同名技能冲突（全局版本将覆盖内置版本）:`);
    for (const key of conflicts) {
      const builtin = builtinRegistry[key];
      const global = globalRegistry[key];
      console.log(`   🔀 ${key}: builtin [${builtin.source}] → global [${global.source}]`);
      if (builtin.securityWarning) console.log(`      ⚠️ 内置版本有安全警告`);
      if (global.securityWarning) console.log(`      ⚠️ 全局版本有安全警告`);
    }
  }

  const merged = { ...builtinRegistry };
  for (const [key, globalSkill] of Object.entries(globalRegistry)) {
    if (merged[key]) {
      merged[key] = { ...merged[key], _overriddenBy: 'global' };
    }
    merged[key] = globalSkill;
  }
  return merged;
}

async function execute(skillName, params, registry, aiSummarize) {
  const skill = registry[skillName];
  const startTime = Date.now();
  const evolution = getEvolution();

  if (!skill) {
    return `❌ 技能 **${skillName}** 未注册`;
  }

  // Record use telemetry on execution
  telemetry.bumpUse(skillName);

  if (skill.securityBlocked) {
    const criticalFindings = (skill.securityFindings || [])
      .filter(f => f.severity === 'critical')
      .map(f => f.description);
    return `🚫 技能 **${skillName}** 因安全风险被阻止执行。原因: ${criticalFindings.join('; ')}`;
  }

  if (skillName === 'multi-search-engine') {
    const keyword = params.keyword || params.query || '';
    const preferredEngine = params.engine || null;

    if (!keyword) return '⚠️ 请提供搜索关键词';

    const timestamp = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

    let allResults = [];
    let successfulEngine = null;
    let searchStats = null;

    if (playwrightSearch) {
      try {
        console.log('🎭 使用 Playwright 搜索...');
        const result = await playwrightSearch.multiSearch(keyword, preferredEngine);
        
        if (result.results && result.results.length > 0) {
          allResults = result.results;
          successfulEngine = result.engine;
          searchStats = result.stats;
          console.log(`✅ Playwright 搜索成功: ${successfulEngine}`);
          if (searchStats) {
            console.log(`📅 今日新闻: ${searchStats.today} 条`);
          }
        } else if (result.error) {
          console.log(`⚠️ Playwright 搜索失败: ${result.error}`);
        }
      } catch (e) {
        console.log(`❌ Playwright 搜索异常: ${e.message}`);
      }
    }
    
    if (allResults.length === 0) {
      console.log('📥 降级使用 fetch 方式搜索...');
      
      const engines = skill?.config?.engines || [];
      const engineOrder = preferredEngine
        ? [preferredEngine, ...engines.filter(e => e.name !== preferredEngine).map(e => e.name)]
        : engines.map(e => e.name);
      
      for (const engineName of engineOrder) {
        const engineConfig = engines.find(e => e.name === engineName);
        if (!engineConfig) continue;
        
        const searchUrl = engineConfig.url.replace('{keyword}', encodeURIComponent(keyword));
        
        try {
          const resp = await fetch(searchUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
              'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
              'Accept-Encoding': 'gzip, deflate, br',
              'Connection': 'keep-alive',
              'Sec-Fetch-Dest': 'document',
              'Sec-Fetch-Mode': 'navigate',
              'Sec-Fetch-Site': 'none',
              'Sec-Fetch-User': '?1',
              'Cache-Control': 'max-age=0'
            }
          });

          const html = await resp.text();
          const results = parseSearchResults(html, engineName);

          if (results.length > 0) {
            allResults = [...allResults, ...results];
            successfulEngine = engineName;
            if (allResults.length >= 15) break;
          }
        } catch (e) {
          console.log(`❌ 引擎[${engineName}]失败: ${e.message}`);
          continue;
        }
      }
    }
    
    if (allResults.length > 0) {
      const uniqueResults = [];
      const seenTitles = new Set();
      for (const r of allResults) {
        if (!seenTitles.has(r.title)) {
          seenTitles.add(r.title);
          uniqueResults.push(r);
        }
      }
      
      const aiSummary = aiSummarize ? await aiSummarize(keyword, uniqueResults) : null;

      if (aiSummary) {
        evolution.record(skillName, params, { message: keyword }, { success: true, duration: Date.now() - startTime, output: aiSummary.substring(0, 200) });
        return aiSummary;
      }

      const searchMethod = playwrightSearch ? 'Playwright' : 'fetch';
      const report = formatReport({ keyword, engine: successfulEngine || '多引擎', results: uniqueResults, searchUrl: '', timestamp, method: searchMethod, stats: searchStats });
      evolution.record(skillName, params, { message: keyword }, { success: true, duration: Date.now() - startTime, output: report.substring(0, 200) });
      return report;
    } else {
      const errorReport = `## 🔍 搜索简报

**关键词**: ${keyword}
**时间**: ${timestamp}

---

❌ 各大搜索引擎均未返回有效结果

**可能原因**:
- 网络连接问题
- 搜索引擎反爬虫机制
- 关键词敏感度过高

💡 **建议**:
- 尝试更换关键词
- 检查网络连接
`;
      evolution.record(skillName, params, { message: keyword }, { success: false, duration: Date.now() - startTime, output: '', error: 'no-results' });
      return errorReport;
    }
  }

  const executorResult = await executeSkillModule(skillName, skill, params, startTime, evolution);
  if (executorResult.handled) {
    return executorResult.output;
  }

  const fallbackResult = `⚠️ 技能 **${skillName}** 已注册但未实现执行逻辑`;
  evolution.record(skillName, params, {}, { success: false, duration: Date.now() - startTime, output: '', error: 'not-implemented' });
  return fallbackResult;
}

async function executeSkillModule(skillName, skill, params, startTime, evolution) {
  if (!skill.baseDir) {
    return { handled: false };
  }

  const skillId = normalizeSkillName(skillName);
  const portablePathEnv = getPythonPathEnv(skillId);

  const envSpec = skill.metadata?.env || null;
  if (envSpec) {
    globalSkillEnvManager.activate(skillId, envSpec);
  }

  if (portablePathEnv) {
    await _pythonPathMutex.acquire();
  }

  let prevPythonPath;
  try {
    if (portablePathEnv) {
      prevPythonPath = process.env.PYTHONPATH;
      process.env.PYTHONPATH = portablePathEnv + (prevPythonPath ? path.delimiter + prevPythonPath : '');
    }

  const executorCandidates = [
    { file: 'executor.js', method: 'execute' },
    { file: 'analyzer.js', method: null },
    { file: 'summarizer.js', method: 'summarize' },
    { file: 'index.js', method: 'execute' }
  ];

  for (const candidate of executorCandidates) {
    const modulePath = path.join(skill.baseDir, candidate.file);
    if (!fs.existsSync(modulePath)) continue;

    const resolvedPath = path.resolve(modulePath);
    const allowedDirs = [SKILLS_DIR, GLOBAL_SKILLS_DIR].map(d => path.resolve(d));
    const isAllowed = allowedDirs.some(allowedDir => resolvedPath.startsWith(allowedDir + path.sep) || resolvedPath === allowedDir);
    
    if (!isAllowed) {
      console.error(`❌ 拒绝加载非法路径的模块: ${resolvedPath}`);
      continue;
    }

    try {
      const Module = require(modulePath);
      const instance = typeof Module === 'function' ? new Module() : Module;

      const input = params.data || params.input || params.text || params;
      const options = skill.config?.config || {};

      if (typeof instance.setEnv === 'function' && portablePathEnv) {
        instance.setEnv({ PYTHONPATH: process.env.PYTHONPATH });
      }

      let result;

      if (candidate.method && typeof instance[candidate.method] === 'function') {
        result = await instance[candidate.method](input, options, params);
      } else if (typeof instance.execute === 'function') {
        result = await instance.execute(input, options, params);
      } else if (typeof instance.analyze === 'function') {
        result = instance.analyze(input, options);
        if (result && !result.error && typeof instance.formatReport === 'function') {
          const report = instance.formatReport(result);
          evolution.record(skillName, params, { message: skillName }, { success: true, duration: Date.now() - startTime, output: String(report).substring(0, 200) });
          return { handled: true, output: report };
        }
      } else if (typeof instance.summarize === 'function') {
        result = instance.summarize(input);
      } else if (typeof Module === 'function') {
        result = await Module(input, options, params);
      } else {
        continue;
      }

      if (result && result.error) {
        evolution.record(skillName, params, {}, { success: false, duration: Date.now() - startTime, output: '', error: result.error });
        return { handled: true, output: `❌ ${skillName} 执行失败: ${result.error}` };
      }

      const output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      evolution.record(skillName, params, { message: skillName }, { success: true, duration: Date.now() - startTime, output: String(output).substring(0, 200) });
      // 触发后置执行分析器
      try {
        const { getExecutionAnalyzer } = require('./skill/execution-analyzer');
        getExecutionAnalyzer().onExecutionComplete({ skillName, success: true, durationMs: Date.now() - startTime });
      } catch (_) { console.warn('[skills] execution analyzer (success) failed:', _.message); }
      return { handled: true, output };
    } catch (e) {
      console.error(`❌ 技能 ${skillName} 执行失败 (${candidate.file}):`, e.message);
      evolution.record(skillName, params, {}, { success: false, duration: Date.now() - startTime, output: '', error: e.message });
      // 触发后置执行分析器（evolution analyzer）
      try {
        const { getExecutionAnalyzer } = require('./skill/execution-analyzer');
        getExecutionAnalyzer().onExecutionComplete({ skillName, success: false, durationMs: Date.now() - startTime, error: e.message });
      } catch (_) { console.warn('[skills] execution analyzer (failure) failed:', _.message); }
      return { handled: true, output: `❌ 技能 ${skillName} 执行失败: ${e.message}` };
    }
  }

  return { handled: false };
  } finally {
    if (envSpec) {
      globalSkillEnvManager.deactivate(skillId);
    }
    if (portablePathEnv) {
      if (prevPythonPath !== undefined) {
        process.env.PYTHONPATH = prevPythonPath;
      } else {
        delete process.env.PYTHONPATH;
      }
      _pythonPathMutex.release();
    }
  }
}

function parseSearchResults(html, engine) {
  const results = [];
  
  if (engine === '百度') {
    const titleMatches = html.match(/<h3[^>]*class="[^"]*ec_title[^"]*"[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g) || [];
    const descMatches = html.match(/<div[^>]*class="[^"]*ec_desc[^"]*"[^>]*>[\s\S]*?<[^>]*>([\s\S]*?)<\/[^>]+>/g) || [];
    const urlMatches = html.match(/class="c-showurl[^>]*>[\s\S]*?<span[^>]*>([^<]+)<\/span>/g) || [];
    
    for (let i = 0; i < Math.min(titleMatches.length, 10); i++) {
      const titleMatch = titleMatches[i].match(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
      const desc = descMatches[i] ? cleanHtmlTags(descMatches[i]).substring(0, 200) : '';
      const source = urlMatches[i] ? cleanHtmlTags(urlMatches[i]).substring(0, 50) : 'baidu.com';
      
      if (titleMatch) {
        let title = cleanHtmlTags(titleMatch[2]).trim();
        let link = titleMatch[1];
        
        if (link.includes('baidu.php') || link.includes('ad.baidu.com') ||
            title.includes('广告') || title.includes('推广') || title.includes('彩票')) {
          continue;
        }
        
        if (title && title.length > 2) {
          if (link.startsWith('/')) {
            link = 'https://www.baidu.com' + link;
          }
          results.push({ title, link, desc, source });
        }
      }
    }
  } else if (engine === '必应' || engine === 'Bing CN' || engine === 'Bing INT') {
    const liBlocks = html.match(/<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>[\s\S]*?<\/li>/g) || [];

    for (let i = 0; i < Math.min(liBlocks.length, 10); i++) {
      const block = liBlocks[i];

      const titleMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
      const descMatch = block.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/);
      const citeMatch = block.match(/<cite[^>]*>([\s\S]*?)<\/cite>/);

      if (titleMatch) {
        const title = cleanHtmlTags(titleMatch[2]).trim();
        const link = titleMatch[1];
        const desc = descMatch ? cleanHtmlTags(descMatch[1]).trim().substring(0, 200) : '';
        const source = citeMatch ? cleanHtmlTags(citeMatch[1]).trim() : '';

        if (title && title.length > 2) {
          results.push({ title, link, desc, source: source || 'bing.com' });
        }
      }
    }
  } else if (engine === '搜狗') {
    const blocks = html.match(/<div[^>]*class="[^"]*vrwrap[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>/g) || [];
    for (let i = 0; i < Math.min(blocks.length, 10); i++) {
      const titleMatch = blocks[i].match(/<a[^>]*class="[^"]*title[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
      const descMatch = blocks[i].match(/<p[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/p>/);
      if (titleMatch) {
        const title = cleanHtmlTags(titleMatch[2]).trim();
        let link = titleMatch[1];
        const desc = descMatch ? cleanHtmlTags(descMatch[1]).trim().substring(0, 200) : '';
        if (title && title.length > 2 && !link.includes('ads.sogou.com')) {
          if (link.startsWith('/')) link = 'https://www.sogou.com' + link;
          results.push({ title, link, desc, source: 'sogou.com' });
        }
      }
    }
  } else if (engine === '360搜索') {
    const blocks = html.match(/<div[^>]*class="[^"]*result[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>/g) || [];
    for (let i = 0; i < Math.min(blocks.length, 10); i++) {
      const titleMatch = blocks[i].match(/<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
      const descMatch = blocks[i].match(/<div[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/div>/);
      if (titleMatch) {
        const title = cleanHtmlTags(titleMatch[2]).trim();
        let link = titleMatch[1];
        const desc = descMatch ? cleanHtmlTags(descMatch[1]).trim().substring(0, 200) : '';
        if (title && title.length > 2) {
          if (link.startsWith('/')) link = 'https://www.so.com' + link;
          results.push({ title, link, desc, source: 'so.com' });
        }
      }
    }
  } else if (engine === '神马搜索') {
    const blocks = html.match(/<div[^>]*class="[^"]*card[^"]*"[^>]*>[\s\S]*?<\/div>\s*<\/div>/g) || [];
    for (let i = 0; i < Math.min(blocks.length, 10); i++) {
      const titleMatch = blocks[i].match(/<a[^>]*href="([^"]*)"[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/a>/);
      const descMatch = blocks[i].match(/<p[^>]*>([\s\S]*?)<\/p>/);
      if (titleMatch) {
        const title = cleanHtmlTags(titleMatch[2]).trim();
        let link = titleMatch[1];
        const desc = descMatch ? cleanHtmlTags(descMatch[1]).trim().substring(0, 200) : '';
        if (title && title.length > 2) {
          results.push({ title, link, desc, source: 'sm.cn' });
        }
      }
    }
  }

  return results;
}

function cleanHtmlTags(html) {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function formatReport({ keyword, engine, results, searchUrl, timestamp, method, stats }) {
  const uniqueResults = results.filter((r, i, arr) => {
    if (!r.title || r.title.length < 3) return false;
    const firstIndex = arr.findIndex(item => item.title === r.title);
    return firstIndex === i;
  }).slice(0, 10);
  
  const resultItems = uniqueResults.map((r, i) => {
    const title = r.title || '无标题';
    const date = r.date ? ` [${r.date}]` : '';
    const desc = r.desc ? `\n${r.desc}` : '';
    const link = r.link ? `\n[查看详情](${r.link})` : '';
    
    return `**${i + 1}. ${title}**${date}${desc}${link}`;
  }).join('\n\n');
  
  const methodBadge = method === 'Playwright' ? '🎭 Playwright' : '📥 fetch';
  const statsInfo = stats ? ` | 今日: ${stats.today}条` : '';
  
  return `## ${keyword} - 搜索简报

> 搜索引擎: ${engine} | 方式: ${methodBadge}${statsInfo} | 时间: ${timestamp}

---

${resultItems}

---

共找到 ${uniqueResults.length} 条相关结果 · [查看更多](${searchUrl})
`;
}

// 检查技能是否有执行器
function hasExecutor(skill) {
  if (!skill.baseDir) return false;
  const executorFiles = ['executor.js', 'analyzer.js', 'summarizer.js', 'index.js'];
  for (const file of executorFiles) {
    if (fs.existsSync(path.join(skill.baseDir, file))) {
      return true;
    }
  }
  return false;
}

function renderSkillSection(skill) {
  // 2026-08-01: emoji 命名空间兼容（此前只读 openclaw，crabpaw 技能永远显示 📦）
  const metaNs = skill.metadata || {};
  const emoji = metaNs.crabpaw?.emoji || metaNs.openclaw?.emoji || metaNs.clawdbot?.emoji || '📦';
  const executable = hasExecutor(skill);
  const statusTag = executable ? '' : ' [参考信息]';

  let argHint = '';
  if (skill.arguments && skill.arguments.length > 0) {
    argHint = skill.argumentHint || `参数: ${skill.arguments.join(', ')}`;
  }

  const commandExample = extractCommandExample(skill);

  return `
## ${emoji} ${skill.name}${statusTag}

${skill.description || '无描述'}
${argHint ? `\n**参数**: ${argHint}` : ''}
${commandExample ? `\n**调用命令**: \`${commandExample}\`` : ''}
${!executable ? '\n⚠️ **注意**: 此技能仅有说明文档，无执行器代码，需手动实现或通过其他方式调用。' : ''}

### 使用说明

${skill.instructions || skill.body || '暂无详细说明'}
`;
}

function renderSkillTail(skills) {
  const executableSkills = skills.filter(s => hasExecutor(s));
  const referenceSkills = skills.filter(s => !hasExecutor(s));

  const skillCommands = executableSkills.map(skill => {
    const cmd = extractCommandExample(skill);
    if (cmd) {
      return { name: skill.name, command: cmd };
    }
    return null;
  }).filter(Boolean);

  const commandExamples = skillCommands.map(s =>
    `- ${s.name}: \`${s.command}\``
  ).join('\n');

  return `${referenceSkills.length > 0 ? `
## 📚 参考型技能

以下技能仅提供说明文档，无执行器代码：
${referenceSkills.map(s => `- ${s.name}`).join('\n')}

这些技能需要手动实现或通过其他方式调用。
` : ''}

## ⚠️ 关键规则 - 必须遵守

1. **技能命令必须完整执行**：技能文档中包含具体的命令格式，必须完整复制执行
2. **禁止返回文本确认**：绝对不要返回"需要确认"的文本或"让我检查一下技能"，直接调用 Bash 工具执行命令
3. **识别用户意图后直接调用对应技能**：根据用户问题，直接执行对应的技能命令

${commandExamples ? `
## 技能命令速查表

${commandExamples}
` : ''}

## 正确示例

用户: "贵州茅台股票分析"
你的操作: 调用 Bash 工具，参数: {"command": "python scripts/flashclaw_stock.py run --text \\"贵州茅台\\""}

## 错误示例（禁止）

用户: "贵州茅台股票分析"
你的操作: 返回文本 "让我检查一下技能" ← 这是错误的！
你的操作: 返回文本 "需要确认" ← 这是错误的！
`;
}

function buildSkillsPrompt(skills, limits) {
  if (!skills || skills.length === 0) {
    return `
# 可用技能

当前没有加载任何技能。将技能的 SKILL.md 文件放入 skills 目录即可使用。
`;
  }

  const budgetedPrompt = buildBudgetedSkillsPrompt(skills, limits);
  if (budgetedPrompt) return budgetedPrompt;

  const skillSections = skills.map(renderSkillSection).join('\n---\n');

  return `
# 可用技能

以下技能可以通过 Bash 工具执行对应的 CLI 命令来使用：

${skillSections}

${renderSkillTail(skills)}`;
}

// ── P1-4: 技能清单按需注入（渐进披露） ─────────────────────────
// 算法（披露）: message 与技能文本（name/displayName/description/category/tags）
// 的 token 集合重叠度——ASCII 词（含 slug 拆分）+ 中文逐字符 bigram。
// score = 0.6 × 覆盖率(|M∩S|/|M|) + 0.4 × Jaccard(|M∩S|/|M∪S|)。
// 命中门槛: score ≥ max(绝对下限 0.2, 最高分 × 0.7)——相对截断抑制
// "帮我/一下"等高频 bigram 噪声。无命中 → 全量回退（能力零回退不变式）。
const SCOPED_SKILL_MAX_INLINE = 24;
const SCOPED_SKILL_MIN_SCORE = 0.2;
const SCOPED_SKILL_RELATIVE_CUTOFF = 0.7;
// 2026-09-07 P0: 正文内联阈值与限长——分数达标(任务与技能确有语义交集)才内联,
// 防止长正文对弱相关任务刷屏; 限长保住预算(remotion-video 全文约 4.5KB)。
const SCOPED_SKILL_INLINE_BODY_MIN_SCORE = 0.25;
const SCOPED_SKILL_INLINE_BODY_MAX_CHARS = 3000;
const SCOPED_SKILL_NO_EXPAND_CATEGORIES = new Set(['general']);

function _skillMatchableText(skill) {
  const m = skill.metadata || {};
  const displayName = m.crabpaw?.name || m.openclaw?.name || m.clawdbot?.name || m.name || '';
  const category = m.crabpaw?.category || m.openclaw?.category || m.clawdbot?.category || m.category || '';
  const tags = m.crabpaw?.tags || m.openclaw?.tags || m.clawdbot?.tags || m.tags || '';
  return [skill.name, displayName, skill.description, category,
    Array.isArray(tags) ? tags.join(' ') : String(tags)]
    .filter(Boolean).join(' ');
}

function _matchTokenSet(text) {
  const tokens = new Set();
  if (!text) return tokens;
  const lower = String(text).toLowerCase();
  const words = lower.match(/[a-z0-9][a-z0-9._/-]*/g) || [];
  for (const w of words) {
    for (const part of w.split(/[._/-]+/)) {
      if (part.length >= 2) tokens.add(part);
    }
  }
  const cjk = lower.match(/[一-鿿]+/g) || [];
  for (const seg of cjk) {
    for (let i = 0; i < seg.length - 1; i++) tokens.add(seg.slice(i, i + 2));
  }
  return tokens;
}

function _scoreSkillForMessage(msgTokens, skill) {
  const skillTokens = _matchTokenSet(_skillMatchableText(skill));
  if (skillTokens.size === 0) return 0;
  let intersection = 0;
  for (const t of msgTokens) {
    if (skillTokens.has(t)) intersection++;
  }
  const coverage = msgTokens.size > 0 ? intersection / msgTokens.size : 0;
  const union = msgTokens.size + skillTokens.size - intersection;
  const jaccard = union > 0 ? intersection / union : 0;
  return coverage * 0.6 + jaccard * 0.4;
}

function _skillCategoryOf(skill) {
  const m = skill.metadata || {};
  return m.crabpaw?.category || m.openclaw?.category || m.clawdbot?.category || m.category || '';
}

function buildSkillsPromptScoped(message, skills, options = {}) {
  const limits = options.limits;
  // 能力零回退不变式: 无消息/无技能 → 全量
  if (!message || typeof message !== 'string' || !skills || skills.length === 0) {
    return buildSkillsPrompt(skills, limits);
  }

  const msgTokens = _matchTokenSet(message.trim());
  if (msgTokens.size === 0) return buildSkillsPrompt(skills, limits);

  const scored = skills.map(skill => ({ skill, score: _scoreSkillForMessage(msgTokens, skill) }));
  const topScore = scored.reduce((max, x) => Math.max(max, x.score), 0);
  const cutoff = Math.max(
    typeof options.minScore === 'number' ? options.minScore : SCOPED_SKILL_MIN_SCORE,
    topScore * SCOPED_SKILL_RELATIVE_CUTOFF
  );

  const hits = scored
    .filter(x => x.score >= cutoff && x.score > 0)
    .sort((a, b) => b.score - a.score);

  // 无命中 → 全量回退（能力零回退——设计不变式）
  if (hits.length === 0) {
    return buildSkillsPrompt(skills, limits);
  }

  // 命中 + 同分类资源（同 category 技能一并注入补全上下文；general 为默认噪声分类不扩展）
  const hitNames = new Set(hits.map(h => h.skill.name));
  const hitCategories = new Set(
    hits.map(h => _skillCategoryOf(h.skill))
      .filter(c => c && !SCOPED_SKILL_NO_EXPAND_CATEGORIES.has(c))
  );
  const expanded = scored.filter(x =>
    !hitNames.has(x.skill.name) &&
    hitCategories.size > 0 && hitCategories.has(_skillCategoryOf(x.skill))
  ).sort((a, b) => b.score - a.score);

  const maxInline = options.maxInline || SCOPED_SKILL_MAX_INLINE;
  const selected = [...hits.map(h => h.skill), ...expanded.map(x => x.skill)].slice(0, maxInline);

  // 技能总量本就少（≤ 注入上限）时保持全量原格式
  if (selected.length >= skills.length) {
    return buildSkillsPrompt(skills, limits);
  }

  const scopedPrompt = buildBudgetedSkillsPrompt(selected, limits);
  const totalCount = skills.length;
  const injectedCount = selected.length;

  // 2026-09-07 P0: 渐进披露设计指望模型看到描述后主动 Read SKILL.md——弱模型
  // 不可靠(宣传片实测: remotion-video 已列进候选池, 模型全程未读正文, 不知道
  // 工作区项目路径, 盲搜到超时)。最高分命中达阈值时把正文内联进 prompt
  // (截断限长), 方法论必达; 内联的是清单外增量信息, 不改变原清单格式。
  let inlineBodySection = '';
  const topHit = hits[0];
  if (topHit && topHit.score >= SCOPED_SKILL_INLINE_BODY_MIN_SCORE) {
    const topSkill = topHit.skill;
    const topBody = String(topSkill.instructions || topSkill.body || '').trim();
    if (topBody) {
      const bodyTruncated = topBody.length > SCOPED_SKILL_INLINE_BODY_MAX_CHARS;
      inlineBodySection = `\n\n## 📌 本任务命中技能「${topSkill.name}」的执行方法（高置信匹配，正文已内联——直接照此执行，无需再读取技能文件）\n\n${topBody.slice(0, SCOPED_SKILL_INLINE_BODY_MAX_CHARS)}${bodyTruncated ? '\n\n…（正文过长已截断；需要完整版可用 Read 读取该技能的 SKILL.md）' : ''}\n`;
    }
  }

  const summaryLine = `\n> 技能可用 ${totalCount} 个（本语境注入 ${injectedCount} 个；需要完整列表或指定技能请说"技能列表"/询问该技能）`;
  return scopedPrompt + inlineBodySection + summaryLine;
}

function extractCommandExample(skill) {
  const body = skill.instructions || skill.body || '';
  const skillPath = skill.path;
  
  const codeBlockRegex = /```(?:bash|shell|sh)?\s*\n?(python\s+[^\n]+)/g;
  const match = codeBlockRegex.exec(body);
  if (match) {
    let cmd = match[1].trim();
    if (skillPath) {
      const skillDir = path.dirname(skillPath);
      cmd = cmd.replace(/python\s+(\S+\.py)/, (m, scriptPath) => {
        if (!path.isAbsolute(scriptPath)) {
          const fullPath = path.join(skillDir, scriptPath);
          console.log(`🔧 [技能路径转换] ${skill.name}: ${scriptPath} -> ${fullPath}`);
          return `python "${fullPath}"`;
        }
        return m;
      });
    }
    return cmd;
  }
  
  const pythonMatch = body.match(/python\s+(\S+\.py)\s+(\S+)/);
  if (pythonMatch) {
    let scriptPath = pythonMatch[1];
    const args = pythonMatch[2];
    if (skillPath && !path.isAbsolute(scriptPath)) {
      const skillDir = path.dirname(skillPath);
      scriptPath = path.join(skillDir, scriptPath);
      console.log(`🔧 [技能路径转换] ${skill.name}: ${pythonMatch[1]} -> ${scriptPath}`);
    }
    return `python "${scriptPath}" ${args}`;
  }
  
  const npxMatch = body.match(/npx\s+\S+/);
  if (npxMatch) {
    return npxMatch[0];
  }
  
  return null;
}

// P1-1(2026-08-25) 技能加载指纹缓存：loadSkills 的三个高频调用方（self-awareness 60s 感知 /
// heartbeat 5min 巡检 / init 24h 健康检查）此前每次都全量重读 89 目录 105 文件 1.07MB。
// 指纹 = 两个技能目录的条目级 (mtimeMs+size) 摘要（跳过 . 前缀目录，与加载器过滤一致）——
// 技能目录真变更才重载；变更时 loadSkills 内的健康检查/质量同步会自然重跑。
let _skillsLoadCache = null;
let _skillsFingerprint = null;

function _skillsDirFingerprint(dir) {
  let acc = '';
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      try {
        const st = fs.statSync(p);
        acc += `${e.name}:${st.mtimeMs}:${st.size};`;
      } catch { /* 条目消失 */ }
    }
  } catch { return 'ERR'; }
  return acc;
}

function loadSkills() {
  // P1-1: 指纹命中 → 返回缓存（调用方只读语义；技能变更即失效并重跑全量）
  const fp = `${_skillsDirFingerprint(SKILLS_DIR)}|${_skillsDirFingerprint(GLOBAL_SKILLS_DIR)}`;
  if (_skillsLoadCache && fp === _skillsFingerprint) {
    return _skillsLoadCache;
  }
  const builtin = loadSkillsFromDir(SKILLS_DIR, 'builtin');
  const global = loadSkillsFromDir(GLOBAL_SKILLS_DIR, 'global');
  
  const allSkills = [...Object.values(builtin), ...Object.values(global)];
  
  const skills = allSkills.map(skill => ({
    name: skill.name,
    description: skill.description,
    instructions: skill.body,
    metadata: skill.metadata,
    arguments: skill.arguments || [],
    argumentHint: skill.argumentHint || '',
    allowedTools: skill.allowedTools,
    path: skill.filePath,
    source: skill.source,
    available: skill.available,
    platforms: skill.platforms || null,
    requiresTools: skill.requiresTools || [],
    fallbackForTools: skill.fallbackForTools || [],
    platformMismatch: skill.platformMismatch || false,
  }));

  // 启动时执行技能健康检查
  try {
    const checker = getSkillHealthChecker();
    const report = checker.check(skills);
    if (report.issues > 0) {
      console.log(checker.formatReport(report));
    }
  } catch { /* 健康检查失败时静默降级 */ }

  // 将技能来源同步到 QualityTracker
  try {
    const tracker = getQualityTracker();
    if (tracker && tracker._initialized) {
      for (const skill of skills) {
        tracker.setProvenance(skill.name, skill.source || 'unknown');
      }
    }
  } catch (e) {
    /* 来源同步失败静默降级 */
    console.warn('[skills.js] 空 catch 补日志:', e && e.message);
  }

  _skillsLoadCache = skills;
  _skillsFingerprint = fp;
  return skills;
}


// ===== ??????? skill-executor.js ???=====
/**
 * 校验 skillName 防止路径穿越
 */
function _validateSkillName(name) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('skillName 不能为空');
  }
  if (name.includes('..') || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new Error(`skillName 包含非法字符: ${name}`);
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`skillName 格式非法: ${name}`);
  }
  return name;
}

const EXECUTOR_STATE = {
  IDLE: 'idle',
  INITIALIZING: 'initializing',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled'
};

const EXECUTOR_TYPE = {
  JAVASCRIPT: 'javascript',
  PYTHON: 'python',
  SHELL: 'shell',
  HTTP: 'http',
  WORKFLOW: 'workflow',
  BUILTIN: 'builtin'
};

class SkillExecutorBase {
  constructor(config = {}) {
    this.config = config;
    this.state = EXECUTOR_STATE.IDLE;
    this.startTime = null;
    this.endTime = null;
    this.result = null;
    this.error = null;
    this.childProcess = null;
    this.timeout = config.timeout || 60000;
    this.maxOutputSize = config.maxOutputSize || 1024 * 1024;
  }

  async initialize() {
    this.state = EXECUTOR_STATE.INITIALIZING;
    await this.onInitialize();
    this.state = EXECUTOR_STATE.IDLE;
  }

  async onInitialize() {}

  async execute(input, context = {}) {
    if (this.state === EXECUTOR_STATE.RUNNING) {
      throw new Error('Executor is already running');
    }

    this.state = EXECUTOR_STATE.RUNNING;
    this.startTime = Date.now();
    this.result = null;
    this.error = null;

    try {
      const validatedInput = this.validateInput(input);
      const result = await this.runWithTimeout(validatedInput, context);
      
      this.result = result;
      this.state = EXECUTOR_STATE.COMPLETED;
      this.endTime = Date.now();
      
      return {
        success: true,
        data: result,
        duration: this.endTime - this.startTime,
        state: this.state
      };
    } catch (e) {
      this.error = e;
      this.state = e.message?.includes('timeout') ? EXECUTOR_STATE.TIMEOUT : EXECUTOR_STATE.FAILED;
      this.endTime = Date.now();
      
      return {
        success: false,
        error: e.message,
        duration: this.endTime - this.startTime,
        state: this.state
      };
    }
  }

  async runWithTimeout(input, context) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Execution timeout after ${this.timeout}ms`));
        this.cancel();
      }, this.timeout);

      this.run(input, context)
        .then((result) => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch((e) => {
          clearTimeout(timeoutId);
          reject(e);
        });
    });
  }

  // eslint-disable-next-line no-unused-vars -- context 保留以符合子类重写签名
  async run(_input, context) {
    throw new Error('run() must be implemented by subclass');
  }

  validateInput(input) {
    if (input === undefined || input === null) {
      return {};
    }
    return input;
  }

  cancel() {
    if (this.childProcess) {
      this.childProcess.kill('SIGTERM');
      this.state = EXECUTOR_STATE.CANCELLED;
    }
  }

  getState() {
    return {
      state: this.state,
      startTime: this.startTime,
      endTime: this.endTime,
      duration: this.endTime ? this.endTime - (this.startTime || 0) : null,
      hasResult: !!this.result,
      hasError: !!this.error
    };
  }

  async cleanup() {
    this.state = EXECUTOR_STATE.IDLE;
    this.result = null;
    this.error = null;
    this.startTime = null;
    this.endTime = null;
  }
}

// 2026-08-04: 执行器路径白名单——GLOBAL_SKILLS_DIR(全局)或 SKILLS_DIR(项目内置)均放行
function isPathInSkillsDirs(resolvedPath) {
  const dirs = [GLOBAL_SKILLS_DIR, SKILLS_DIR].map(d => path.resolve(d) + path.sep);
  return dirs.some(d => resolvedPath.startsWith(d));
}

class JavaScriptExecutor extends SkillExecutorBase {
  constructor(config = {}) {
    super(config);
    this.type = EXECUTOR_TYPE.JAVASCRIPT;
  }

  async run(input, context) {
    const { scriptPath, functionName = 'execute', args = [] } = input;

    if (!scriptPath || !fs.existsSync(scriptPath)) {
      throw new Error(`Script not found: ${scriptPath}`);
    }

    // 路径白名单校验：scriptPath 必须在 GLOBAL_SKILLS_DIR 或 SKILLS_DIR(内置)内
    const resolvedScript = path.resolve(scriptPath);
    if (!isPathInSkillsDirs(resolvedScript)) {
      throw new Error(`Security: scriptPath must be within skills directory: ${scriptPath}`);
    }

    const module = require(resolvedScript);
    const fn = module[functionName] || module.default || module;

    if (typeof fn !== 'function') {
      throw new Error(`Function "${functionName}" not found in ${scriptPath}`);
    }

    // 2026-08-04 P0 修复:参数断裂——args 默认 [] → fn(...args, context) 把整个
    // input 对象丢弃,执行器收到 context={} → 技能全部空壳执行。
    // 统一将 input(含 LLM 传入的 params + scriptPath)作为首参传给 fn(input, context)
    return await (args && args.length > 0 ? fn(...args, context) : fn(input, context));
  }
}

class PythonExecutor extends SkillExecutorBase {
  constructor(config = {}) {
    super(config);
    this.type = EXECUTOR_TYPE.PYTHON;
    this.pythonPath = config.pythonPath || 'python';
  }

  async run(input, _context) {
    const { scriptPath, args = [], env = {} } = input;

    if (!scriptPath || !fs.existsSync(scriptPath)) {
      throw new Error(`Script not found: ${scriptPath}`);
    }

    // 路径白名单校验：scriptPath 必须在 GLOBAL_SKILLS_DIR 或 SKILLS_DIR(内置)内
    const resolvedScript = path.resolve(scriptPath);
    if (!isPathInSkillsDirs(resolvedScript)) {
      throw new Error(`Security: scriptPath must be within skills directory: ${scriptPath}`);
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(this.pythonPath, [resolvedScript, ...args], {
        env: { ...process.env, ...env },
        cwd: path.dirname(resolvedScript),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      this.childProcess = proc;

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
        if (stdout.length > this.maxOutputSize) {
          proc.kill();
          reject(new Error('Output size exceeded limit'));
        }
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        this.childProcess = null;
        
        if (code === 0) {
          try {
            const result = stdout.trim() ? JSON.parse(stdout) : { output: stdout };
            resolve(result);
          } catch {
            resolve({ output: stdout, stderr });
          }
        } else {
          reject(new Error(`Python script failed with code ${code}: ${stderr}`));
        }
      });

      proc.on('error', (e) => {
        this.childProcess = null;
        reject(e);
      });

      if (input.stdin) {
        proc.stdin.write(JSON.stringify(input.stdin));
        proc.stdin.end();
      }
    });
  }
}

class ShellExecutor extends SkillExecutorBase {
  constructor(config = {}) {
    super(config);
    this.type = EXECUTOR_TYPE.SHELL;
    this.shell = config.shell || process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';
    this.maxStdoutSize = config.maxStdoutSize || 1024 * 1024; // 1MB stdout 限制
  }

  async run(input, _context) {
    const { command, cwd, env = {} } = input;
    
    if (!command) {
      throw new Error('No command provided');
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(this.shell,
        process.platform === 'win32' ? ['/c', command] : ['-c', command],
        {
          cwd: cwd || process.cwd(),
          env: { ...process.env, ...env },
          stdio: ['pipe', 'pipe', 'pipe'],
          // 2026-08-22 实机修复: windowsHide——GUI 模式防 CMD 弹窗（同 safe-exec）
          windowsHide: true
        }
      );

      this.childProcess = proc;

      let stdout = '';
      let stderr = '';
      let stdoutTruncated = false;

      proc.stdout.on('data', (data) => {
        if (stdout.length < this.maxStdoutSize) {
          stdout += data.toString();
          if (stdout.length > this.maxStdoutSize) {
            stdout = stdout.slice(0, this.maxStdoutSize);
            stdoutTruncated = true;
          }
        }
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        this.childProcess = null;
        resolve({
          exitCode: code,
          stdout: stdout.trim() + (stdoutTruncated ? '\n...[truncated]' : ''),
          stderr: stderr.trim(),
          success: code === 0
        });
      });

      proc.on('error', (e) => {
        this.childProcess = null;
        reject(e);
      });
    });
  }
}

class BuiltinExecutor extends SkillExecutorBase {
  constructor(config = {}) {
    super(config);
    this.type = EXECUTOR_TYPE.BUILTIN;
    this.handlers = new Map();
  }

  register(name, handler) {
    this.handlers.set(name, handler);
  }

  async run(input, context) {
    const { action, params = {} } = input;
    
    const handler = this.handlers.get(action);
    if (!handler) {
      throw new Error(`Unknown builtin action: ${action}`);
    }

    return await handler(params, context);
  }
}

class ExecutorFactory {
  constructor() {
    this.executors = new Map();
    this.config = {
      defaultTimeout: 60000,
      maxOutputSize: 1024 * 1024,
      pythonPath: 'python'
    };
  }

  setConfig(config) {
    this.config = { ...this.config, ...config };
  }

  getExecutor(type, options = {}) {
    const key = `${type}:${options.id || 'default'}`;
    
    if (!this.executors.has(key)) {
      const config = { ...this.config, ...options };
      
      switch (type) {
        case EXECUTOR_TYPE.JAVASCRIPT:
          this.executors.set(key, new JavaScriptExecutor(config));
          break;
        case EXECUTOR_TYPE.PYTHON:
          this.executors.set(key, new PythonExecutor(config));
          break;
        case EXECUTOR_TYPE.SHELL:
          this.executors.set(key, new ShellExecutor(config));
          break;
        case EXECUTOR_TYPE.BUILTIN:
          this.executors.set(key, new BuiltinExecutor(config));
          break;
        default:
          throw new Error(`Unknown executor type: ${type}`);
      }
    }
    
    return this.executors.get(key);
  }

  createExecutor(type, options = {}) {
    const config = { ...this.config, ...options };
    
    switch (type) {
      case EXECUTOR_TYPE.JAVASCRIPT:
        return new JavaScriptExecutor(config);
      case EXECUTOR_TYPE.PYTHON:
        return new PythonExecutor(config);
      case EXECUTOR_TYPE.SHELL:
        return new ShellExecutor(config);
      case EXECUTOR_TYPE.BUILTIN:
        return new BuiltinExecutor(config);
      default:
        throw new Error(`Unknown executor type: ${type}`);
    }
  }

  clear() {
    for (const executor of this.executors.values()) {
      if (executor.cancel) {
        executor.cancel();
      }
    }
    this.executors.clear();
  }
}

const globalExecutorFactory = new ExecutorFactory();

// 2026-08-04: 技能卡元数据——从 SKILL.md frontmatter 提取展示信息
function readSkillMeta(skillPath, skillName) {
  try {
    const skillMd = path.join(skillPath, 'SKILL.md');
    if (fs.existsSync(skillMd)) {
      const content = fs.readFileSync(skillMd, 'utf-8');
      const { frontmatter } = parseFrontmatter(content);
      const meta = frontmatter.metadata?.crabpaw || frontmatter.metadata?.openclaw || {};
      return {
        displayName: frontmatter.name || skillName,
        emoji: meta.emoji || '📦',
        category: meta.category || frontmatter.metadata?.category || 'general',
      };
    }
  } catch (e) { console.warn('[skills] 技能元数据解析失败:', e.message); }
  return { displayName: skillName, emoji: '📦', category: 'general' };
}

// 2026-08-04: 步骤模板——按技能类别映射展示阶段(纯视觉阶段,executor 无阶段回调)
function skillStageSteps(category) {
  const cat = String(category || '').toLowerCase();
  if (/document|doc|report|presentation|article|word|pdf|ppt|html/.test(cat)) return ['收集内容', '组织大纲', '编写生成', '输出预览'];
  if (/code|program|script|develop|review/.test(cat)) return ['分析需求', '编写代码', '运行验证', '输出结果'];
  if (/research|search|analysis|data|deep|agent|api/.test(cat)) return ['检索资料', '分析综合', '生成结果', '输出结果'];
  if (/chart|visual|image|media|music|voice/.test(cat)) return ['解析素材', '绘制生成', '渲染输出', '输出结果'];
  return ['准备阶段', '执行生成', '输出结果'];
}

function detectExecutorType(skillPath) {
  const executorJs = path.join(skillPath, 'executor.js');
  const executorPy = path.join(skillPath, 'executor.py');
  const skillSh = path.join(skillPath, 'skill.sh');

  if (fs.existsSync(executorJs)) {
    return { type: EXECUTOR_TYPE.JAVASCRIPT, path: executorJs };
  }
  if (fs.existsSync(executorPy)) {
    return { type: EXECUTOR_TYPE.PYTHON, path: executorPy };
  }
  if (fs.existsSync(skillSh)) {
    return { type: EXECUTOR_TYPE.SHELL, path: skillSh };
  }
  // 2026-08-04 P1: 补齐 executeSkillModule 支持的候选执行器——analyzer.js/
  // summarizer.js/index.js(此前全局 financial-analyst 只有 analyzer.js → 被拒执行)
  const jsCandidates = ['analyzer.js', 'summarizer.js', 'index.js'];
  for (const cand of jsCandidates) {
    const p = path.join(skillPath, cand);
    if (fs.existsSync(p)) return { type: EXECUTOR_TYPE.JAVASCRIPT, path: p };
  }

  return null;
}

// 2026-08-18 P0: 执行链记录——usageTracker(写 skill-usage.json)与 lifecycleManager
// (recordSkillUsage 写 skill-lifecycle.json 并更新质量分)。此前 executeSkillAdvanced
// 零记录接口调用: data/.crabpaw/skill-scores.json 407 个技能全 0.5、
// skill-recommender.json usageStats=0 整链纸面的根因。setImmediate 异步不阻塞返回,全 try/catch。
function _recordSkillExecution(skillName, ok) {
  try {
    setImmediate(() => {
      try {
        const { usageTracker: _ut } = require('./skill-usage-tracker');
        _ut.recordCall(skillName, ok);
      } catch (e) { console.warn('[skills] usageTracker.recordCall 失败:', e && e.message); }
      try {
        const { getSkillLifecycleManager: _gl } = require('./skill-lifecycle');
        _gl().recordSkillUsage(skillName, ok);
      } catch (e) { console.warn('[skills] lifecycleManager.recordSkillUsage 失败:', e && e.message); }
    });
  } catch (e) { console.warn('[skills] 执行记录调度失败:', e && e.message); }
}

// 2026-08-18 P1: 禁用技能名单(服务端缓存 5s)——skill-handler toggle 写入
// data/disabled-skills.json。executeSkillAdvanced 此前按目录名直查文件系统,
// 绕过 registry 与禁用名单,禁用技能仍可执行。
let _disabledSkillsCache = null;
let _disabledSkillsCacheAt = 0;
function _loadDisabledSkillNames() {
  try {
    const now = Date.now();
    if (_disabledSkillsCache && now - _disabledSkillsCacheAt < 5000) {
      return _disabledSkillsCache;
    }
    const p = path.join(DATA_DIR, 'disabled-skills.json');
    if (fs.existsSync(p)) {
      const list = JSON.parse(fs.readFileSync(p, 'utf-8'));
      _disabledSkillsCache = Array.isArray(list) ? list : [];
      _disabledSkillsCacheAt = now;
    } else {
      // 文件不存在时不缓存(置 null),保证禁用名单首次写入立即可见,而非吞掉空缓存 5s
      _disabledSkillsCache = null;
      _disabledSkillsCacheAt = 0;
    }
  } catch (e) {
    console.warn('[skills] 读取禁用技能列表失败:', e && e.message);
    _disabledSkillsCache = _disabledSkillsCache || [];
    _disabledSkillsCacheAt = Date.now();
  }
  return _disabledSkillsCache || [];
}

async function executeSkillAdvanced(skillName, input, context = {}) {
  _validateSkillName(skillName);
  // 2026-08-18 P1: 禁用技能检查(disabled-skills.json, 5s 缓存)
  const _disabled = _loadDisabledSkillNames();
  if (_disabled.some(d => d && (d === skillName || normalizeSkillName(d) === normalizeSkillName(skillName)))) {
    return { success: false, error: '技能已禁用: ' + skillName };
  }
  // --- TaskRun hook (non-blocking) ---
  let _taskRunRef = null;
  let _taskRunStoreInst = null;
  try {
    _taskRunStoreInst = require("./task-orchestration/task-run").globalTaskRunStore;
    _taskRunRef = _taskRunStoreInst.createTaskRun({ title: "技能: " + skillName, source: "skill", skill: skillName });
    _taskRunStoreInst.updateLane(_taskRunRef.id, _taskRunRef.lanes[0].id, { stage: "执行中", status: "running", progress: 30 });
  } catch (e) { console.warn("[skills] TaskRun 接线失败:", e.message || e); }
  // --- end TaskRun hook ---
  // 2026-08-04: 支持双目录——全局技能(data/skills)优先,项目内置技能(skills/)兜底。
  // 此前仅查 GLOBAL_SKILLS_DIR,LLM 经 skill_manage execute html-generator 等内置技能 → "Skill not found"
  // 2026-08-04 P0 修复:全局目录遮蔽——data/skills/deep-research 等只有 SKILL.md
  // 无执行器,遮蔽内置真执行器(skills/deep-research/executor.js) → "No executor found"。
  // 查找规则:全局目录优先,但若全局目录无执行器则回退内置目录(内置仍无则报错)
  let skillPath = null;
  const globalPath = path.join(GLOBAL_SKILLS_DIR, skillName);
  const localPath = path.join(SKILLS_DIR, skillName);
  if (fs.existsSync(globalPath) && detectExecutorType(globalPath)) {
    skillPath = globalPath;
  } else if (fs.existsSync(localPath) && detectExecutorType(localPath)) {
    skillPath = localPath;
  } else if (fs.existsSync(globalPath)) {
    skillPath = globalPath; // 保留原始路径,下方报 No executor found 更准确
  }

  if (!skillPath || !fs.existsSync(skillPath)) {
    if (_taskRunRef && _taskRunStoreInst) { try { _taskRunStoreInst.failTask(_taskRunRef.id, "Skill not found: " + skillName); } catch (e) { console.warn("[skills] TaskRun fail failed:", e.message || e); } }
    return {
      success: false,
      error: `Skill not found: ${skillName}`
    };
  }

  const executorInfo = detectExecutorType(skillPath);

  if (!executorInfo) {
    if (_taskRunRef && _taskRunStoreInst) { try { _taskRunStoreInst.failTask(_taskRunRef.id, "No executor found for skill: " + skillName); } catch (e) { console.warn("[skills] TaskRun fail failed:", e.message || e); } }
    return {
      success: false,
      error: `No executor found for skill: ${skillName}`
    };
  }

  // 2026-08-04: 表现层事件源——技能执行卡(SkillStageHost)消费。
  // 不改技能系统本身,只在调用点包装广播:started → (executor 无阶段回调) → completed/error
  const skillMeta = readSkillMeta(skillPath, skillName);
  try {
    const { broadcastEvent } = require('./sse-broadcast');
    broadcastEvent('skill:started', {
      skill: skillName,
      displayName: skillMeta.displayName,
      emoji: skillMeta.emoji,
      category: skillMeta.category,
      steps: skillStageSteps(skillMeta.category),
    });
  } catch (e) { console.warn('[skills] skill:started 广播失败:', e.message); }

  const executor = globalExecutorFactory.createExecutor(executorInfo.type, {
    ...context,
    skillPath
  });

  const executeInput = {
    ...input,
    scriptPath: executorInfo.path
  };

  const startedAt = Date.now();
  let result;
  try {
    result = await executor.execute(executeInput, context);
  } catch (e) {
    console.error(`[skills] ${skillName} 执行异常:`, e.message);
    if (_taskRunRef && _taskRunStoreInst) {
      try { _taskRunStoreInst.failTask(_taskRunRef.id, e.message); } catch (e2) { console.warn("[skills] TaskRun fail failed:", e2.message || e2); }
    }
    try {
      const { broadcastEvent: _be2 } = require('./sse-broadcast');
      _be2('skill:error', {
        skill: skillName,
        displayName: skillMeta.displayName,
        emoji: skillMeta.emoji,
        error: e.message,
        durationMs: Date.now() - startedAt,
      });
    } catch (_) { console.warn('[skills] skill:error 广播失败:', _.message); }
    _recordSkillExecution(skillName, false);
    return { success: false, error: e.message };
  }

  // 2026-08-04: 完成/失败事件——技能卡显示 ✓ 后自动淡出,或错误卡
  try {
    const { broadcastEvent } = require('./sse-broadcast');
    if (result && result.success === false) {
      broadcastEvent('skill:error', {
        skill: skillName,
        displayName: skillMeta.displayName,
        emoji: skillMeta.emoji,
        error: typeof result.error === 'string' ? result.error : (result.message || '执行失败'),
        durationMs: Date.now() - startedAt,
      });
    } else {
      const outputPath = result?.outputPath || result?.filePath || (result?.data && (result.data.outputPath || result.data.path)) || '';
      const summary = typeof result?.summary === 'string' ? result.summary
        : result?.outputSummary || (typeof result?.message === 'string' ? result.message : '');
      broadcastEvent('skill:completed', {
        skill: skillName,
        displayName: skillMeta.displayName,
        emoji: skillMeta.emoji,
        summary,
        outputPath,
        durationMs: Date.now() - startedAt,
      });
    }
  } catch (e) { console.warn('[skills] skill 完成事件广播失败:', e.message); }

  // 反馈闭环：执行完成后触发质量追踪和后置分析
  try {
    const { getReviewFork } = require('./evolution/conversation-review-fork');
    const reviewFork = getReviewFork();
    if (reviewFork._initialized && context.sessionId) {
      // 异步触发，不阻塞执行结果返回
      setImmediate(() => {
        reviewFork.reviewAfterTurn({
          sessionId: context.sessionId,
          messages: context.messages || context.conversationLog || [],
          loadedSkills: context.loadedSkills || [skillName],
        }).catch(e => {
          console.warn('[skill-executor] reviewFork 调用异常:', e.message);
        });
      });
    }
  } catch (e) { console.warn('[skills] feedback loop not available, degraded:', e.message); }
  // --- TaskRun: mark complete/fail (try/catch, non-blocking) ---
  if (_taskRunRef && _taskRunStoreInst) {
    try {
      if (result && result.success === false) {
        _taskRunStoreInst.updateLane(_taskRunRef.id, _taskRunRef.lanes[0].id, { stage: "失败", status: "failed", progress: 100 });
        _taskRunStoreInst.failTask(_taskRunRef.id, (result && result.error) || "执行失败");
      } else {
        const artifacts = [];
        if (result && result.outputPath) artifacts.push({ name: String(result.outputPath).split("/").pop().split("\\").pop(), path: result.outputPath });
        if (result && result.filePath) artifacts.push({ name: String(result.filePath).split("/").pop().split("\\").pop(), path: result.filePath });
        _taskRunStoreInst.updateLane(_taskRunRef.id, _taskRunRef.lanes[0].id, { stage: "完成", status: "done", progress: 100 });
        _taskRunStoreInst.completeTask(_taskRunRef.id, { message: (result && result.summary) || "技能执行完成", artifacts });
      }
    } catch (e) { console.warn("[skills] TaskRun complete failed:", e.message || e); }
  }
  // 2026-08-18 P0: 执行链记录(成功/失败)
  _recordSkillExecution(skillName, !(result && result.success === false));
  return result;
}


function createExecutor(type, options = {}) {
  const config = { ...globalExecutorFactory.config, ...options };

  switch (type) {
    case EXECUTOR_TYPE.JAVASCRIPT:
      return new JavaScriptExecutor(config);
    case EXECUTOR_TYPE.PYTHON:
      return new PythonExecutor(config);
    case EXECUTOR_TYPE.SHELL:
      return new ShellExecutor(config);
    case EXECUTOR_TYPE.BUILTIN:
      return new BuiltinExecutor(config);
    default:
      throw new Error(`Unknown executor type: ${type}`);
  }
}


module.exports = {
  load,
  execute,
  loadSkills,
  buildSkillsPrompt,
  buildSkillsPromptScoped,
  getEvolution,
  scanSkillSecurity,
  checkSkillDependencies,
  getSkillDependencyStatus,
  checkSkillHealth: (skills, toolNames) => getSkillHealthChecker().check(skills, toolNames),
  getLeaderboard: () => getEvolution().getLeaderboard(),
  getSkillStats: (skillName) => getEvolution().getScore(skillName),
  SkillExecutorBase,
  JavaScriptExecutor,
  PythonExecutor,
  ShellExecutor,
  BuiltinExecutor,
  ExecutorFactory,
  globalExecutorFactory,
  EXECUTOR_STATE,
  EXECUTOR_TYPE,
  detectExecutorType,
  executeSkillAdvanced,
  createExecutor,
  getAllWithSource: () => {
    const builtin = loadSkillsFromDir(SKILLS_DIR, 'builtin');
    const global = loadSkillsFromDir(GLOBAL_SKILLS_DIR, 'global');

    const normalize = (skill) => ({
      ...skill,
      id: normalizeSkillName(skill.name)
    });

    return {
      builtin: Object.values(builtin).map(normalize),
      global: Object.values(global).map(normalize),
      all: [...Object.values(builtin), ...Object.values(global)].map(normalize)
    };
  }
};
