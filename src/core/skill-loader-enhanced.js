const fs = require('fs');
const path = require('path');


const PLATFORM_MAP = {
  'macos': 'darwin',
  'linux': 'linux',
  'windows': 'win32'
};

const CURRENT_PLATFORM = process.platform;

const THREAT_PATTERNS = {
  exfiltration: [
    { pattern: /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/gi, severity: 'critical', desc: 'curl 命令泄露密钥' },
    { pattern: /wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/gi, severity: 'critical', desc: 'wget 命令泄露密钥' },
    { pattern: /fetch\s*\([^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|API)/gi, severity: 'critical', desc: 'fetch 调用泄露密钥' },
    { pattern: /\$HOME\/\.ssh|~\/\.ssh/g, severity: 'high', desc: '访问 SSH 目录' },
    { pattern: /\$HOME\/\.aws|~\/\.aws/g, severity: 'high', desc: '访问 AWS 凭证目录' },
    { pattern: /\$HOME\/\.gnupg|~\/\.gnupg/g, severity: 'high', desc: '访问 GPG 密钥目录' },
    { pattern: /\$HOME\/\.kube|~\/\.kube/g, severity: 'high', desc: '访问 Kubernetes 配置目录' },
    { pattern: /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass)/g, severity: 'critical', desc: '读取敏感文件' },
    { pattern: /printenv|env\s*\|/g, severity: 'high', desc: '导出所有环境变量' },
    { pattern: /os\.environ\b(?!.*\.get\s*\(\s*["']PATH)/g, severity: 'high', desc: 'Python 访问所有环境变量' },
    { pattern: /process\.env\[/g, severity: 'high', desc: 'Node.js 访问环境变量' },
  ],
  injection: [
    { pattern: /ignore\s+previous\s+instructions/gi, severity: 'critical', desc: 'Prompt 注入攻击' },
    { pattern: /ignore\s+all\s+previous/gi, severity: 'critical', desc: 'Prompt 注入攻击' },
    { pattern: /disregard\s+your\s+instructions/gi, severity: 'critical', desc: 'Prompt 注入攻击' },
    { pattern: /forget\s+your\s+instructions/gi, severity: 'critical', desc: 'Prompt 注入攻击' },
    { pattern: /new\s+instructions:/gi, severity: 'critical', desc: 'Prompt 注入攻击' },
    { pattern: /system\s+prompt:/gi, severity: 'high', desc: '系统提示词注入' },
    { pattern: /<system>/gi, severity: 'high', desc: '系统标签注入' },
  ],
  destructive: [
    { pattern: /rm\s+-rf\s+\//g, severity: 'critical', desc: '删除根目录' },
    { pattern: /rm\s+-rf\s+~/g, severity: 'critical', desc: '删除用户目录' },
    { pattern: /mkfs/g, severity: 'critical', desc: '格式化磁盘' },
    { pattern: /dd\s+if=.*of=\/dev/g, severity: 'critical', desc: '磁盘覆写' },
    { pattern: /:\(\)\{\s*:\|:\s*&\s*\};\s*:/g, severity: 'critical', desc: 'Fork 炸弹' },
  ],
  persistence: [
    { pattern: /crontab\s+-e/g, severity: 'high', desc: '修改 cron 任务' },
    { pattern: /\/etc\/init\.d/g, severity: 'high', desc: '修改启动脚本' },
    { pattern: /\/etc\/systemd/g, severity: 'high', desc: '修改 systemd 服务' },
    { pattern: /LaunchAgents|LaunchDaemons/g, severity: 'high', desc: '修改 macOS 启动项' },
    { pattern: /~\/\.bashrc|~\/\.zshrc|~\/\.profile/g, severity: 'medium', desc: '修改 shell 配置' },
  ],
  network: [
    { pattern: /nc\s+-l/g, severity: 'critical', desc: '创建网络监听' },
    { pattern: /\/dev\/tcp/g, severity: 'critical', desc: 'Bash 网络连接' },
    { pattern: /reverse\s+shell/gi, severity: 'critical', desc: '反向 Shell' },
    { pattern: /\b(dig|nslookup|host)\s+[^\n]*\$/g, severity: 'high', desc: 'DNS 数据泄露' },
  ],
  obfuscation: [
    { pattern: /base64\s+-d/g, severity: 'high', desc: 'Base64 解码执行' },
    { pattern: /eval\s*\(/g, severity: 'high', desc: '动态代码执行' },
    { pattern: /Function\s*\(/g, severity: 'high', desc: '动态函数创建' },
    { pattern: /__import__\s*\(/g, severity: 'high', desc: 'Python 动态导入' },
    { pattern: /exec\s*\(/g, severity: 'high', desc: 'Python 动态执行' },
  ]
};

const TRUST_LEVELS = {
  builtin: { scan: false, autoAllow: true },
  trusted: { scan: true, allowCaution: true },
  community: { scan: true, allowCaution: false },
  agent_created: { scan: true, allowCaution: true }
};

function getCurrentPlatform() {
  return CURRENT_PLATFORM;
}

function matchesPlatform(frontmatter) {
  const platforms = frontmatter.platforms || frontmatter.metadata?.crabpaw?.platforms;
  if (!platforms) return true;
  
  const platformList = Array.isArray(platforms) ? platforms : [platforms];
  
  for (const p of platformList) {
    const normalized = String(p).toLowerCase().trim();
    const mapped = PLATFORM_MAP[normalized] || normalized;
    if (CURRENT_PLATFORM.startsWith(mapped)) {
      return true;
    }
  }
  
  return false;
}

function scanForThreats(content, filePath) {
  const findings = [];
  const ext = path.extname(filePath).toLowerCase();
  
  const scannableExts = ['.js', '.ts', '.mjs', '.cjs', '.py', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd'];
  if (!scannableExts.includes(ext)) {
    return findings;
  }
  
  const lines = content.split('\n');
  
  for (const [category, patterns] of Object.entries(THREAT_PATTERNS)) {
    for (const { pattern, severity, desc } of patterns) {
      pattern.lastIndex = 0;
      const matches = content.match(pattern);
      if (matches) {
        let lineNum = 1;
        for (let i = 0; i < lines.length; i++) {
          pattern.lastIndex = 0;
          if (pattern.test(lines[i])) {
            lineNum = i + 1;
            break;
          }
        }
        
        findings.push({
          category,
          severity,
          file: filePath,
          line: lineNum,
          description: desc,
          match: matches[0]?.substring(0, 100) || ''
        });
      }
    }
  }
  
  return findings;
}

function scanSkillDirectory(skillPath, trustLevel = 'community') {
  const allFindings = [];
  const stats = {
    scannedFiles: 0,
    critical: 0,
    high: 0,
    medium: 0,
    low: 0
  };
  
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
        if (['node_modules', '.git', '__pycache__', 'venv', '.venv'].includes(entry.name)) {
          continue;
        }
        walkDir(fullPath, relPath);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        const scannableExts = ['.js', '.ts', '.mjs', '.cjs', '.py', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd'];
        
        if (scannableExts.includes(ext)) {
          try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            const findings = scanForThreats(content, relPath);
            allFindings.push(...findings);
            stats.scannedFiles++;
          } catch (e) {
            // Skip unreadable files
          }
        }
      }
    }
  }
  
  walkDir(skillPath);
  
  for (const f of allFindings) {
    if (f.severity === 'critical') stats.critical++;
    else if (f.severity === 'high') stats.high++;
    else if (f.severity === 'medium') stats.medium++;
    else stats.low++;
  }
  
  const verdict = stats.critical > 0 ? 'dangerous' :
                  stats.high > 0 ? 'caution' : 'safe';
  
  const trustConfig = TRUST_LEVELS[trustLevel] || TRUST_LEVELS.community;
  let allowed = true;
  let reason = '';
  
  if (trustConfig.scan) {
    if (verdict === 'dangerous') {
      allowed = false;
      reason = `发现 ${stats.critical} 个严重威胁`;
    } else if (verdict === 'caution' && !trustConfig.allowCaution) {
      allowed = false;
      reason = `发现 ${stats.high} 个高风险威胁`;
    }
  }
  
  return {
    verdict,
    allowed,
    reason,
    findings: allFindings,
    stats
  };
}

function createSkillMetadata(skill, options = {}) {
  const { includeBody = false, includeReferences = false } = options;
  
  const metadata = {
    name: skill.name,
    description: skill.description?.substring(0, 1024) || '',
    version: skill.metadata?.version || '1.0.0',
    category: skill.metadata?.crabpaw?.category || skill.metadata?.openclaw?.category || 'general',
    platforms: skill.metadata?.crabpaw?.platforms || skill.metadata?.openclaw?.platforms || null,
    available: skill.available !== false,
    source: skill.source,
    trustLevel: skill.source === 'builtin' ? 'builtin' : 
                skill.source === 'global' ? 'community' : 'community',
    hasExecutor: skill.hasExecutor || false,
    missingDeps: skill.missingDeps || [],
    securityWarning: skill.securityWarning || false
  };
  
  if (includeBody && skill.body) {
    metadata.body = skill.body;
  }
  
  if (includeReferences && skill.baseDir) {
    const refsDir = path.join(skill.baseDir, 'references');
    if (fs.existsSync(refsDir)) {
      metadata.references = fs.readdirSync(refsDir)
        .filter(f => f.endsWith('.md'))
        .map(f => `references/${f}`);
    }
  }
  
  return metadata;
}

function listSkillsMetadata(registry, options = {}) {
  const { platform, category, availableOnly } = options;
  
  const skills = [];
  
  for (const [key, skill] of Object.entries(registry)) {
    if (platform && !matchesPlatform(skill.metadata || {})) {
      continue;
    }
    
    if (category && skill.metadata?.crabpaw?.category !== category && 
        skill.metadata?.openclaw?.category !== category) {
      continue;
    }
    
    if (availableOnly && skill.available === false) {
      continue;
    }
    
    skills.push({
      id: key,
      ...createSkillMetadata(skill)
    });
  }
  
  return skills;
}

function viewSkillContent(skillName, registry, options = {}) {
  const { reference } = options;
  
  const skill = registry[skillName] || registry[skillName.toLowerCase()];
  
  if (!skill) {
    return {
      success: false,
      error: `技能 "${skillName}" 不存在`
    };
  }
  
  if (reference) {
    const refPath = path.join(skill.baseDir, reference);
    if (!fs.existsSync(refPath)) {
      return {
        success: false,
        error: `参考文件 "${reference}" 不存在`
      };
    }
    
    try {
      const content = fs.readFileSync(refPath, 'utf-8');
      return {
        success: true,
        type: 'reference',
        skillName: skill.name,
        reference,
        content
      };
    } catch (e) {
      return {
        success: false,
        error: `读取参考文件失败: ${e.message}`
      };
    }
  }
  
  return {
    success: true,
    type: 'skill',
    ...createSkillMetadata(skill, { includeBody: true, includeReferences: true })
  };
}

function getSkillCategories(registry) {
  const categories = new Map();
  
  for (const skill of Object.values(registry)) {
    const category = skill.metadata?.crabpaw?.category || 
                     skill.metadata?.openclaw?.category || 
                     'general';
    
    if (!categories.has(category)) {
      categories.set(category, {
        name: category,
        count: 0,
        skills: []
      });
    }
    
    const cat = categories.get(category);
    cat.count++;
    cat.skills.push(skill.name);
  }
  
  return Object.fromEntries(categories);
}

module.exports = {
  getCurrentPlatform,
  matchesPlatform,
  scanForThreats,
  scanSkillDirectory,
  createSkillMetadata,
  listSkillsMetadata,
  viewSkillContent,
  getSkillCategories,
  THREAT_PATTERNS,
  TRUST_LEVELS
};
