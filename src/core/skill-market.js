/**
 * CrabPaw Skill Market - 技能市场引擎
 *
 * 支持三种安装来源:
 *   - GitHub 仓库直装
 *   - URL 直装
 *   - 本地市场搜索 + GitHub Topics搜索
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const net = require('net');
const dns = require('dns');
// eslint-disable-next-line no-unused-vars
const { execSync, execFileSync } = require('child_process');
const { URL } = require('url');
const { GLOBAL_SKILLS_DIR, SKILLS_DIR } = require('./config');
const { scanSkillDirectory } = require('./skill-loader-enhanced');

const QUARANTINE_DIR = path.join(GLOBAL_SKILLS_DIR, '.quarantine');
const MARKET_CACHE_FILE = path.join(GLOBAL_SKILLS_DIR, '.market-cache.json');
const MAX_DOWNLOAD_SIZE = 50 * 1024 * 1024;
const DOWNLOAD_TIMEOUT = 30000;
const MAX_REDIRECTS = 3; // 发布 S-2a: URL 安装重定向上限 3 跳
const GITHUB_API = 'https://api.github.com';

// ============================================================
// 校验工具
// ============================================================

function _validateSkillName(name) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('skillName 不能为空');
  }
  if (name.includes('..') || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new Error(`skillName 包含非法字符: ${name}`);
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`skillName 格式错误: ${name}，只能使用英文、数字、下划线和短横线`);
  }
  return name;
}

// ============================================================
// URL 安装来源安全校验（发布 S-2a SSRF 防护）
// ============================================================

/**
 * 私网/环回/保留地址判定（IPv4 段属 + IPv6 前缀，含 v4-mapped 形态）。
 * 非合法 IP 一律按不安全处理。
 */
function _isBlockedIp(ip) {
  const v = net.isIP(ip);
  if (!v) return true;
  if (v === 4) {
    const parts = ip.split('.').map(Number);
    const a = parts[0];
    const b = parts[1];
    if (a === 0 || a === 10 || a === 127) return true;      // 0/8 本网络, 10/8, 127/8 环回
    if (a === 100 && b >= 64 && b <= 127) return true;      // 100.64/10 CGNAT 共享地址
    if (a === 169 && b === 254) return true;                // 169.254/16 链路本地
    if (a === 172 && b >= 16 && b <= 31) return true;       // 172.16/12
    if (a === 192 && b === 168) return true;                // 192.168/16
    if (a === 192 && b === 0) return true;                  // 192.0.0/24 IETF 特殊用途
    if (a >= 224) return true;                              // 组播 224/4 + 保留 240/4
    return false;
  }
  const lower = ip.toLowerCase();
  const mapped = lower.match(/::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return _isBlockedIp(mapped[1]);               // v4-mapped
  if (lower === '::' || lower === '::1') return true;       // 未指定/环回
  if (/^f[c-d]/.test(lower)) return true;                   // fc00::/7 ULA
  if (/^fe[89ab]/.test(lower)) return true;                 // fe80::/10 链路本地
  if (lower.startsWith('ff')) return true;                  // ff00::/8 组播
  return false;
}

function _defaultDnsLookup(host) {
  return new Promise((resolve, reject) => {
    dns.lookup(host, { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)));
  });
}

/**
 * 技能 URL 安装来源白名单判定（发布 S-2a）。
 * - 协议白名单：仅 http/https；
 * - hostname 为 IP 字面量 -> 直接判段；
 * - 域名 -> 先 DNS 解析（dns.lookup all）再判——任一解析结果落私网/环回即拒绝（防 DNS 重绑定）。
 * resolver 可注入以便单测离线断言（默认真实 dns.lookup）。
 */
async function isAllowedSkillSourceUrl(url, options = {}) {
  const { resolver = _defaultDnsLookup } = options;
  if (typeof url !== 'string' || !url.trim()) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    console.warn('[SkillMarket] URL 解析失败:', url, e.message);
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const hostname = parsed.hostname || '';
  if (net.isIP(hostname)) return !_isBlockedIp(hostname);
  let addresses;
  try {
    addresses = await resolver(hostname);
  } catch (e) {
    console.warn('[SkillMarket] DNS 解析失败:', hostname, e.message);
    return false;
  }
  const ips = (Array.isArray(addresses) ? addresses : [addresses])
    .map((r) => (typeof r === 'string' ? r : r && r.address))
    .filter(Boolean);
  if (ips.length === 0) return false;
  return !ips.some((ip) => _isBlockedIp(ip));
}

// ============================================================
// 本地市场
// ============================================================

const BUILTIN_MARKETPLACE = [
  { name: 'code-review', displayName: '代码审查', category: 'development', description: '智能代码审查与质量分析，自动发现代码中的潜在问题和改进点' },
  { name: 'git-ops', displayName: 'Git 操作', category: 'development', description: 'Git 操作助手：commit/push/PR/branch等，让版本管理更轻松' },
  { name: 'shell-enhance', displayName: 'Shell 增强', category: 'system', description: '命令行增强与脚本生成，提升终端操作效率' },
  { name: 'image-analyze', displayName: '图片分析', category: 'media', description: '智能图片分析与OCR识别，提取图片中的文字和信息' },
  { name: 'meeting-summary', displayName: '会议摘要', category: 'productivity', description: '会议内容智能摘要，快速获取会议要点和行动项' },
  { name: 'api-tester', displayName: 'API 测试', category: 'development', description: 'API接口自动化测试，快速验证接口功能和性能' },
  { name: 'knowledge-base', displayName: '知识库', category: 'productivity', description: '本地知识库管理，构建个人或团队的知识体系' },
  { name: 'scheduled-task', displayName: '定时任务', category: 'automation', description: '定时任务调度与监控，自动化执行周期性操作' },
  { name: 'database-query', displayName: '数据库查询', category: 'development', description: '数据库查询助手，支持多种数据库的智能查询' },
  { name: 'news-digest', displayName: '新闻摘要', category: 'information', description: '新闻摘要与信息聚合，快速获取感兴趣的资讯' },
  { name: 'translation-pro', displayName: '翻译专家', category: 'productivity', description: '专业翻译与本地化服务，支持多语言互译' },
  { name: 'weather', displayName: '天气查询', category: 'information', description: '查询实时天气和天气预报信息' },
  { name: 'system-info', displayName: '系统信息', category: 'system', description: '获取系统运行状态、硬件配置等信息' },
  { name: 'pdf-generator', displayName: 'PDF 生成', category: 'document', description: 'PDF 文档生成，含4种专业排版模板、CSS渲染、封面页、页码' },
  { name: 'html-generator', displayName: 'HTML 生成', category: 'document', description: 'HTML 网页生成，含5种CSS模板、响应式设计、代码高亮' },
  { name: 'video-generator', displayName: '视频生成', category: 'media', description: 'AI视频生成(文生视频/图生视频) + 视频编辑(截图/裁剪/转换)' },
  { name: 'healthcheck', displayName: '健康检查', category: 'system', description: '系统健康状态监控和检查' },
  { name: 'article-writer', displayName: '文章写作', category: 'writing', description: '智能文章写作助手，支持多种文体和风格' },
  { name: 'content-planner', displayName: '内容规划', category: 'productivity', description: '内容创作规划和排期管理' },
  { name: 'price-monitor', displayName: '价格监控', category: 'shopping', description: '商品价格监控和价格变动提醒' },
  { name: 'product-research', displayName: '产品调研', category: 'analysis', description: '产品市场调研和竞品分析' },
  { name: 'promo-planner', displayName: '促销规划', category: 'marketing', description: '营销活动规划和促销策略制定' },
  { name: 'file-manager', displayName: '文件管理', category: 'system', description: '文件浏览、搜索和管理工具' },
  { name: 'file-organizer', displayName: '文件整理', category: 'productivity', description: '智能文件分类和整理助手' },
  { name: 'doc-processor', displayName: '文档处理', category: 'document', description: '文档格式转换和批量处理' },
  { name: 'markdown-converter', displayName: 'Markdown 转换', category: 'document', description: 'Markdown与多种格式互相转换' },
  { name: 'report-generator', displayName: '报告生成', category: 'document', description: '自动化报告生成，支持数据可视化' },
  { name: 'email-assistant', displayName: '邮件助手', category: 'productivity', description: '邮件撰写、回复和管理的智能助手' },
  { name: 'review-analyzer', displayName: '评论分析', category: 'analysis', description: '用户评论情感分析和观点提取' },
  { name: 'wechat-article-search', displayName: '公众号搜索', category: 'search', description: '搜索微信公众号文章和内容' },
  { name: 'trending-monitor', displayName: '热点监控', category: 'information', description: '实时热点话题追踪和趋势分析' },
  { name: 'browser-use', displayName: '浏览器控制', category: 'automation', description: '自动化浏览器操作和网页交互' },
  { name: 'excel-xlsx', displayName: 'Excel 处理', category: 'document', description: 'Excel 电子表格读写和数据处理' },
  { name: 'excel-generator', displayName: 'Excel 生成', category: 'document', description: 'Excel 电子表格生成，含专业格式化、条件格式、配色方案、KPI卡片' },
  { name: 'word-docx', displayName: 'Word 处理', category: 'document', description: 'Word 文档读写和格式处理' },
  { name: 'powerpoint-pptx', displayName: 'PPT 处理', category: 'document', description: 'PowerPoint 演示文稿创建和编辑' },
  { name: 'pptx-generator', displayName: 'PPT 生成', category: 'document', description: 'PowerPoint 演示文稿生成，含5种配色方案、5种幻灯片类型、专业排版' },
  { name: 'self-improving-agent', displayName: '自我改进', category: 'ai', description: '智能体自我优化和能力提升' },
  { name: 'prompt-engineering-expert', displayName: '提示词专家', category: 'ai', description: 'Prompt 工程最佳实践和优化建议' },
  { name: 'listing-optimizer', displayName: '列表优化', category: 'marketing', description: '商品列表和描述优化，提升转化率' },
]

// ============================================================
// ClawHub 注册表 — 精选 GitHub 技能仓库
// ============================================================

// ClawHub 注册表 — 精选 GitHub 技能仓库
// 这些仓库会被定期缓存，搜索时从缓存匹配
const CLAWHUB_SEARCH_TOPICS = ['codex-skill', 'clawdbot-skill', 'ai-skill'];


const CLAWHUB_CACHE_FILE = path.join(GLOBAL_SKILLS_DIR, '.clawhub-cache.json');
const CLAWHUB_CACHE_TTL = 3600000; // 1 小时缓存


/**
 * GitHub 搜索结果 → 市场条目映射（纯函数, 导出供单测）。
 *
 * SP2 治理: securityReviewed 恒 false——下载前未经任何安全审查,
 * 不得以 stars 数冒充"已审查"（旧实现 stars>5 → true 纯造假）。
 * 实际防线在安装时: skill-loader-enhanced 的 quarantine 隔离扫描。
 */
function _mapGitHubItemToResult(item, topic) {
  return {
    name: item.name,
    slug: item.name,
    repo: item.full_name,
    description: item.description || "",
    author: item.owner?.login || "unknown",
    downloads: item.stargazers_count || 0,
    stars: item.stargazers_count || 0,
    rating: Math.min(5, ((item.stargazers_count || 0) / 20) + 3),
    category: topic.replace("-skill", ""),
    tags: item.topics || [topic],
    url: item.html_url,
    updatedAt: item.updated_at,
    version: "1.0.0",
    registry: "clawhub",
    // 下载前未审查, 不冒充——安装时经 quarantine 扫描兜底
    securityReviewed: false,
    source: "clawhub",
    installed: isSkillInstalled(item.name),
  };
}

async function _searchClawHubFromGitHub(query, limit) {
  const lowerQuery = (query || "").toLowerCase();
  const allResults = [];

  for (const topic of CLAWHUB_SEARCH_TOPICS) {
    try {
      const q = lowerQuery ? encodeURIComponent(lowerQuery) + "+" : "";
      const searchUrl = GITHUB_API + "/search/repositories?q=" + q + "topic:" + topic + "&per_page=" + Math.min(limit, 10) + "&sort=stars&order=desc";
      const data = await fetchUrl(searchUrl, { timeout: 8000 });
      const parsed = JSON.parse(data.toString());

      if (parsed.items) {
        for (const item of parsed.items) {
          if (allResults.find(r => r.repo === item.full_name)) continue;
          allResults.push(_mapGitHubItemToResult(item, topic));
        }
      }
    } catch (e) {
      console.warn("[ClawHub] topic " + topic + " search failed:", e.message);
    }
  }

  return allResults;
}

// ============================================================
// ============================================================
// HTTP 请求
// ============================================================

async function fetchUrl(url, options = {}) {
  const {
    timeout = DOWNLOAD_TIMEOUT,
    maxSize = MAX_DOWNLOAD_SIZE,
    maxRedirects = MAX_REDIRECTS,
    validateTarget = null
  } = options;

  if (maxRedirects <= 0) {
    throw new Error('Too many redirects');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch (e) {
    throw new Error('无效 URL: ' + String(url));
  }

  // 发布 S-2a SSRF: 每一跳（初始 URL + 每次重定向目标）都过目标校验。
  // 协议白名单 + 私网/环回阻断由调用方注入的 validateTarget 承担
  // （installFromUrl 注入 isAllowedSkillSourceUrl；GitHub/registry 等管理员可信源不注入）。
  if (validateTarget && !(await validateTarget(parsedUrl.toString()))) {
    throw new Error('目标地址不允许');
  }

  const protocol = parsedUrl.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = protocol.get(url, {
      headers: {
        'User-Agent': 'CrabPaw-SkillInstaller/2.0',
        'Accept': 'application/json, application/octet-stream, */*'
      },
      timeout
    }, async (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl;
        try {
          // 相对重定向按当前 URL 解析（旧实现直接 new URL(location) 会抛错）
          redirectUrl = new URL(res.headers.location, parsedUrl).toString();
        } catch (e) {
          reject(new Error('无效的重定向地址: ' + res.headers.location));
          return;
        }
        try {
          // 发布 S-2a: 重定向目标逐跳复校验
          if (validateTarget && !(await validateTarget(redirectUrl))) {
            reject(new Error('目标地址不允许'));
            return;
          }
        } catch (e) {
          reject(e);
          return;
        }
        fetchUrl(redirectUrl, { ...options, maxRedirects: maxRedirects - 1 }).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
        return;
      }

      const chunks = [];
      let size = 0;

      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxSize) {
          req.destroy();
          reject(new Error(`响应超过 ${maxSize} 字节限制`));
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        resolve(Buffer.concat(chunks));
      });

      res.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
  });
}

// ============================================================
// 搜索
// ============================================================

async function searchSkills(query, options = {}) {
  const { limit = 20, source = 'all' } = options;
  const results = [];
  const lowerQuery = query.toLowerCase();

  // 1. 本地市场匹配
  if (source === 'all' || source === 'local') {
    for (const skill of BUILTIN_MARKETPLACE) {
      const displayName = (skill.displayName || skill.name || '').toLowerCase();
      if (skill.name.includes(lowerQuery) ||
          displayName.includes(lowerQuery) ||
          skill.category.includes(lowerQuery) ||
          (skill.description || '').toLowerCase().includes(lowerQuery)) {
        results.push({
          name: skill.displayName || skill.name,
          slug: skill.name,
          category: skill.category,
          description: skill.description,
          author: 'CrabPaw',
          downloads: 0,
          rating: 0,
          tags: [],
          source: 'local',
          installed: true,
        });
      }
    }
  }

  // 2. 已安装技能匹配
  if (source === 'all' || source === 'local') {
    const installed = listInstalledSkills();
    for (const skill of installed) {
      if (skill.name.includes(lowerQuery) && !results.find(r => r.name === skill.name)) {
        results.push({
          ...skill,
          source: 'installed',
          installed: true,
        });
      }
    }
  }

// 3. GitHub Topics 搜索
  if (source === 'all' || source === 'github') {
    try {
      const ghResults = await searchGitHubTopics(query, limit);
      for (const gh of ghResults) {
        if (!results.find(r => r.name === gh.name)) {
          results.push({
            ...gh,
            source: 'github',
            installed: isSkillInstalled(gh.name),
          });
        }
      }
    } catch (e) {
      console.warn('[SkillMarket] GitHub 搜索异常:', e.message);
    }
  }

  // 4. ClawHub 注册表搜索
  if (source === 'all' || source === 'clawhub') {
    try {
      const chResults = await searchClawHub(query, { limit });
      if (chResults.success && chResults.skills) {
        for (const skill of chResults.skills) {
          if (!results.find(r => r.slug === skill.slug)) {
            results.push(skill);
          }
        }
      }
    } catch (e) {
      console.warn('[SkillMarket] ClawHub 搜索异常:', e.message);
    }
  }

  return {
    success: true,
    skills: results.slice(0, limit),
    total: results.length,
  };
}

async function searchGitHubTopics(query, limit = 10) {
  const topics = ['crabpaw-skill', 'codex-skill', 'clawdbot-skill', 'ai-skill'];
  const results = [];

  for (const topic of topics) {
    if (results.length >= limit) break;
    try {
      const url = `${GITHUB_API}/search/repositories?q=${encodeURIComponent(query)}+topic:${topic}&per_page=${Math.min(limit, 10)}&sort=updated`;
      // 2026-08-27 审计 S7: 4 个 topic 串行各 30s 超时最坏 120s——
      // GitHub 不可达时能力商店搜索必挂到前端假超时。补 8s(与 clawhub 同款先例)。
      const data = await fetchUrl(url, { timeout: 8000 });
      const parsed = JSON.parse(data.toString());

      if (parsed.items) {
        for (const item of parsed.items) {
          results.push({
            name: item.name,
            // 2026-08-26 审计 S3: GitHub 项此前缺 slug → 前端"安装"无标识可传,
            // 搜索到的一切都装不了。补 slug=repo(唯一标识), 前端按 source==='github'
            // 走 github 安装通道(与"高级导入"同路径)。
            slug: item.full_name,
            description: item.description || '',
            category: topic.replace('-skill', ''),
            stars: item.stargazers_count,
            repo: item.full_name,
            url: item.html_url,
            updatedAt: item.updated_at,
          });
        }
      }
    } catch (e) {

      // 单个 topic 搜索失败不影响其他

      console.warn('[skill-market.js] 空 catch 补日志:', e && e.message);
    }

  }

  return results;
}

// ============================================================
// 安装
// ============================================================

async function installFromGitHub(repo, options = {}) {
  const { skillPath = '', branch = 'main', force = false } = options;

  console.log(`[SkillMarket] 从 GitHub 安装: ${repo}`);

  const parts = repo.split('/');
  const owner = parts[0];
  const repoName = parts[1];
  if (!owner || !repoName) {
    return { success: false, error: '请使用 GitHub 仓库格式 owner/repo' };
  }

  try {
    const tarballUrl = `https://api.github.com/repos/${owner}/${repoName}/tarball/${branch}`;
    return await _installFromArchive(tarballUrl, {
      skillName: repoName,
      source: `github:${repo}`,
      trustLevel: 'community',
      subPath: skillPath,
      force,
    });
  } catch (e) {
    return { success: false, error: `GitHub 安装失败: ${e.message}` };
  }
}

async function installFromUrl(url, options = {}) {
  const { skillName, source = 'url', trustLevel = 'community', subPath = '', force = false } = options;
  if (skillName) _validateSkillName(skillName);
  // 发布 S-2a SSRF: 初始 URL 先验（协议白名单 + 私网/环回阻断，域名先解析再判），
  // 重定向目标逐跳复校验在 fetchUrl 内完成（防 302 跳到内网/环回）。
  if (!(await isAllowedSkillSourceUrl(url))) {
    return { success: false, error: '目标地址不允许' };
  }
  console.log(`[SkillMarket] 从 URL 安装: ${url}`);
  return _installFromArchive(url, { skillName, source, trustLevel, subPath, force, validateTarget: isAllowedSkillSourceUrl });
}

async function _installFromArchive(archiveUrl, options = {}) {
  const { skillName, source = 'url', trustLevel = 'community', subPath = '', force = false, validateTarget = null } = options;

  try {
    const archiveBuffer = await fetchUrl(archiveUrl, { validateTarget });

    if (!fs.existsSync(QUARANTINE_DIR)) {
      fs.mkdirSync(QUARANTINE_DIR, { recursive: true });
    }

    const quarantinePath = path.join(QUARANTINE_DIR, `${skillName}_${Date.now()}`);
    fs.mkdirSync(quarantinePath, { recursive: true });

    const archivePath = path.join(quarantinePath, 'archive.tar.gz');
    fs.writeFileSync(archivePath, archiveBuffer);

    let extractedPath = quarantinePath;
    try {
      execFileSync('tar', ['-xzf', archivePath, '-C', quarantinePath], { timeout: 15000, stdio: 'pipe', windowsHide: true });
    } catch (_) {
      console.warn('[SkillMarket] tar 解压失败，继续尝试直接读取...');
    }

    if (subPath) {
      extractedPath = path.join(quarantinePath, subPath);
    }

    console.log('[SkillMarket] 安全检查中...');
    const scanResult = scanSkillDirectory(quarantinePath, trustLevel);

    if (!scanResult.allowed && !force) {
      return { success: false, error: `安全检查未通过: ${scanResult.reason}`, scanResult };
    }

    if (scanResult.findings && scanResult.findings.length > 0) {
      console.log(`[SkillMarket] 发现 ${scanResult.findings.length} 个警告`);
    }

    const skillDir = path.join(GLOBAL_SKILLS_DIR, skillName);
    if (fs.existsSync(skillDir) && !force) {
      return { success: false, error: `技能 "${skillName}" 已存在，请使用 force=true 覆盖安装` };
    }

    if (fs.existsSync(skillDir)) {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }
    _copyDirRecursive(extractedPath, skillDir);
    _updateMarketCache(skillName, source);

    return {
      success: true, skillName, skillPath: skillDir, source, trustLevel,
      warnings: scanResult.findings?.length > 0 ? scanResult.findings : undefined,
    };
  } catch (e) {
    console.error('[SkillMarket] 安装失败:', e.message);
    return { success: false, error: e.message };
  }
}

function _copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      _copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function _updateMarketCache(skillName, source) {
  let cache = {};
  try {
    if (fs.existsSync(MARKET_CACHE_FILE)) {
      cache = JSON.parse(fs.readFileSync(MARKET_CACHE_FILE, 'utf-8'));
    }
  } catch (_) { console.warn('[skill-market] 读取技能缓存失败:', _.message); }
  cache[skillName] = { source, installedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const dir = path.dirname(MARKET_CACHE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(MARKET_CACHE_FILE, JSON.stringify(cache, null, 2));
}

// ============================================================
// 工具函数
// ============================================================

function isSkillInstalled(skillName) {
  const builtinPath = path.join(SKILLS_DIR, skillName, 'SKILL.md');
  const globalPath = path.join(GLOBAL_SKILLS_DIR, skillName, 'SKILL.md');
  return fs.existsSync(builtinPath) || fs.existsSync(globalPath);
}

function listInstalledSkills() {
  const skills = [];

  const scanDir = (dir, source) => {
    if (!fs.existsSync(dir)) return;
    const dirs = fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name);
    for (const name of dirs) {
      const skillMdPath = path.join(dir, name, 'SKILL.md');
      if (fs.existsSync(skillMdPath)) {
        skills.push({ name, path: path.join(dir, name), source, installedAt: fs.statSync(skillMdPath).mtime });
      }
    }
  };

  scanDir(SKILLS_DIR, 'builtin');
  scanDir(GLOBAL_SKILLS_DIR, 'global');
  return skills;
}

function getSkillDetail(skillName) {
  const searchPaths = [path.join(SKILLS_DIR, skillName), path.join(GLOBAL_SKILLS_DIR, skillName)];
  for (const skillPath of searchPaths) {
    const skillMdPath = path.join(skillPath, 'SKILL.md');
    if (fs.existsSync(skillMdPath)) {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      const stat = fs.statSync(skillMdPath);
      const frontMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const metadata = {};
      if (frontMatch) {
        const lines = frontMatch[1].split('\n');
        for (const line of lines) {
          const m = line.match(/^(\w+):\s*(.*)$/);
          if (m) metadata[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
      }
      return {
        name: skillName, path: skillPath, metadata,
        content: content.slice(frontMatch ? frontMatch[0].length : 0).trim(),
        size: stat.size, modifiedAt: stat.mtime,
      };
    }
  }
  return null;
}

function uninstallSkill(skillName) {
  const globalPath = path.join(GLOBAL_SKILLS_DIR, skillName);
  const builtinPath = path.join(SKILLS_DIR, skillName);

  if (fs.existsSync(globalPath)) {
    fs.rmSync(globalPath, { recursive: true, force: true });
    _removeFromMarketCache(skillName);
    return { success: true, skillName, source: 'global' };
  }
  if (fs.existsSync(builtinPath)) {
    return { success: false, error: `内置技能 "${skillName}" 不可卸载` };
  }
  return { success: false, error: `技能 "${skillName}" 不存在` };
}

function _removeFromMarketCache(skillName) {
  try {
    if (fs.existsSync(MARKET_CACHE_FILE)) {
      const cache = JSON.parse(fs.readFileSync(MARKET_CACHE_FILE, 'utf-8'));
      delete cache[skillName];
      fs.writeFileSync(MARKET_CACHE_FILE, JSON.stringify(cache, null, 2));
    }
  } catch (_) { console.warn('[skill-market] 清除技能缓存失败:', _.message); }
}

function getMarketStatus() {
  const installed = listInstalledSkills();
  const registryUrl = (process.env.CRABPAW_SKILL_REGISTRY || '').replace(/\/+$/, '');
  return {
    registryUrl: registryUrl || '',
    availableRemote: !!registryUrl,
    installedCount: installed.length,
    totalInstalled: installed.length,
    builtinCount: installed.filter(s => s.source === 'builtin').length,
    globalCount: installed.filter(s => s.source === 'global').length,
    marketplaceSize: BUILTIN_MARKETPLACE.length,
    marketAvailable: true,
  };
}

// ============================================================
// Registry 安装
// ============================================================

/**
 * 从 Registry 服务器安装技能
 * GET {registryUrl}/api/skills/{slug}/download → tar.gz
 */
async function installFromRegistry(slug, options = {}) {
  const { force = false } = options;
  const registryUrl = (process.env.CRABPAW_SKILL_REGISTRY || '').replace(/\/+$/, '');
  if (!registryUrl) return { success: false, error: '未配置 CRABPAW_SKILL_REGISTRY' };
  const skillName = slug.replace(/^@/, '').replace(/\//g, '-');
  _validateSkillName(skillName);
  try {
    const downloadUrl = `${registryUrl}/api/skills/${encodeURIComponent(slug)}/download`;
    const archiveBuffer = await fetchUrl(downloadUrl, { timeout: 30000 });
    if (!archiveBuffer || archiveBuffer.length < 100) return { success: false, error: '下载失败' };
    if (!fs.existsSync(QUARANTINE_DIR)) fs.mkdirSync(QUARANTINE_DIR, { recursive: true });
    const qPath = path.join(QUARANTINE_DIR, `reg_${skillName}_${Date.now()}`);
    fs.mkdirSync(qPath, { recursive: true });
    const archivePath = path.join(qPath, 'archive.tar.gz');
    fs.writeFileSync(archivePath, archiveBuffer);
    let extractedPath = qPath;
    try {
      execFileSync('tar', ['-xzf', archivePath, '-C', qPath], { timeout: 15000, stdio: 'pipe', windowsHide: true });
      const subDirs = fs.readdirSync(qPath, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.'));
      if (subDirs.length === 1) extractedPath = path.join(qPath, subDirs[0].name);
    } catch (_) {
      try {
        // 2026-08-29 安全收口: extract-zip 全版本 zip-slip (CWE-22, CVSS 8.1) 无上游
        // 补丁——tar 失败后的 zip 兜底解压改统一安全解压 safeExtractZip。
        const { safeExtractZip } = require('./safe-zip');
        const zipDir = path.join(qPath, 'zip');
        fs.mkdirSync(zipDir, { recursive: true });
        await safeExtractZip(archivePath, zipDir);
        const subs = fs.readdirSync(zipDir, { withFileTypes: true }).filter(d => d.isDirectory());
        extractedPath = subs.length === 1 ? path.join(zipDir, subs[0].name) : zipDir;
      } catch (e2) { return { success: false, error: `解压失败: ${e2.message}` }; }
    }
    const skillDir = path.join(GLOBAL_SKILLS_DIR, skillName);
    if (fs.existsSync(skillDir) && !force) return { success: false, error: `技能 "${skillName}" 已存在` };
    if (fs.existsSync(skillDir)) fs.rmSync(skillDir, { recursive: true, force: true });
    _copyDirRecursive(extractedPath, skillDir);
    fs.rmSync(qPath, { recursive: true, force: true });
    return { success: true, skillName, skillPath: skillDir };
  } catch (e) {
    return { success: false, error: `安装失败: ${e.message}` };
  }
}

// ============================================================
// ClawHub API (deprecated)
// ============================================================

function _loadClawHubCache() {
  try {
    if (fs.existsSync(CLAWHUB_CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CLAWHUB_CACHE_FILE, "utf-8"));
      if (Date.now() - raw._ts < CLAWHUB_CACHE_TTL) {
        return raw.data || [];
      }
    }
  } catch (_) { console.warn('[skill-market] 读取 ClawHub 缓存失败:', _.message); }
  return null;
}

function _saveClawHubCache(data) {
  try {
    const dir = path.dirname(CLAWHUB_CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CLAWHUB_CACHE_FILE, JSON.stringify({ _ts: Date.now(), data }, null, 2));
  } catch (_) { console.warn('[skill-market] 保存 ClawHub 缓存失败:', _.message); }
}

async function searchClawHub(query, options) {
  const { limit = 20 } = options || {};
  const lowerQuery = (query || "").toLowerCase();
  const results = [];

  // 1. 本地市场（内置技能）
  for (const skill of BUILTIN_MARKETPLACE) {
    const displayName = (skill.displayName || skill.name || "").toLowerCase();
    if (!lowerQuery || skill.name.includes(lowerQuery) ||
        displayName.includes(lowerQuery) ||
        (skill.description || "").toLowerCase().includes(lowerQuery)) {
      results.push({
        name: skill.displayName || skill.name,
        slug: skill.name,
        description: skill.description,
        author: "CrabPaw",
        downloads: 999,
        rating: 4.0,
        category: skill.category,
        tags: [],
        registry: "clawhub",
        // 内置目录随仓库分发（版本受控）→ 置 true 合理; 与 GitHub 远程条目
        // (securityReviewed: false) 的区别见 _mapGitHubItemToResult 注释。
        securityReviewed: true,
        source: "local",
        installed: true,
      });
    }
  }

  // 2. GitHub 话题搜索（ClawHub 市场）
  let cached = _loadClawHubCache();
  if (!cached) {
    cached = await _searchClawHubFromGitHub("", limit * 2);
    _saveClawHubCache(cached);
  }

  for (const skill of cached) {
    if (!lowerQuery ||
        skill.name.toLowerCase().includes(lowerQuery) ||
        skill.slug.toLowerCase().includes(lowerQuery) ||
        (skill.description || "").toLowerCase().includes(lowerQuery) ||
        (skill.tags || []).some(function(t) { return t.toLowerCase().includes(lowerQuery); })) {
      if (!results.find(function(r) { return r.slug === skill.slug; })) {
        skill.installed = isSkillInstalled(skill.slug);
        results.push(skill);
      }
    }
  }

  return {
    success: true,
    skills: results.slice(0, limit),
    total: results.length,
  };
}

async function installFromClawHub(skillSlug, options) {
  const cached = _loadClawHubCache();
  var skill = cached ? cached.find(function(s) { return s.slug === skillSlug; }) : null;
  if (skill && skill.repo) {
    return installFromGitHub(skill.repo, options || {});
  }
  try {
    const results = await _searchClawHubFromGitHub(skillSlug, 5);
    var found = results.find(function(s) { return s.slug === skillSlug; });
    if (found && found.repo) {
      return installFromGitHub(found.repo, options || {});
    }
  } catch (_) { console.warn('[skill-market] ClawHub 搜索失败:', _.message); }
  return { success: false, error: "技能 " + skillSlug + " 未在 ClawHub 中找到" };
}

async function getClawHubSkillInfo(skillSlug) {
  var cached = _loadClawHubCache();
  var found = cached ? cached.find(function(s) { return s.slug === skillSlug; }) : null;
  if (found) return { success: true, skill: found };
  try {
    var results = await _searchClawHubFromGitHub(skillSlug, 5);
    var match = results.find(function(s) { return s.slug === skillSlug; });
    if (match) return { success: true, skill: match };
  } catch (_) { console.warn('[skill-market] 获取 ClawHub 技能信息失败:', _.message); }
  return { success: false, error: "技能 " + skillSlug + " 不存在" };
}

// ============================================================
// 导出
// ============================================================

module.exports = {
  searchSkills,
  searchGitHubTopics,
  installFromRegistry,
  installFromGitHub,
  installFromUrl,
  listInstalledSkills,
  getSkillDetail,
  uninstallSkill,
  isSkillInstalled,
  getMarketStatus,
  BUILTIN_MARKETPLACE,

  // ClawHub API — 基于 GitHub 注册表的技能市场
  searchClawHub,
  getClawHubSkillInfo,
  installFromClawHub,
  updateSkill: async () => ({ success: false, error: '功能开发中' }),

  // 纯函数导出（单测用）: GitHub 条目 → 市场条目映射
  _mapGitHubItemToResult,

  // 发布 S-2a SSRF: URL 安装目标校验（协议白名单 + 私网/环回阻断）+ fetchUrl 供重定向校验单测
  fetchUrl,
  isAllowedSkillSourceUrl,
  _isBlockedIp,
};
