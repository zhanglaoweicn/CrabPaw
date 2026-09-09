/**
 * convert-agency-agents.js — 将 agency-agents-zh 的 .md 专家文件
 * 转换为 CrabPaw ExpertDetail JSON 格式。
 *
 * 用法: node scripts/convert-agency-agents.js
 * 输出: data/experts-from-agency-agents.json (约 266 个专家)
 */

const fs = require('fs');
const path = require('path');

const AGENCY_DIR = path.resolve('D:/Down/agency-agents-zh/agency-agents-zh-main');
const OUTPUT = path.resolve('data/experts-from-agency-agents.json');

// 排除的非 Agent 目录
const SKIP_DIRS = new Set(['assets', 'scripts', 'examples', 'integrations', '.github', 'strategy']);

// 排除的非 Agent 文件
const SKIP_FILES = new Set(['README.md', 'CATALOG.md', 'AGENT-LIST.md', 'CONTRIBUTING.md', 'LICENSE', 'UPSTREAM.md', 'package.json']);

// agency-agents 分类 → CrabPaw 分类映射
const CATEGORY_MAP = {
  academic: 'academic',
  design: 'creative',
  engineering: 'development',
  finance: 'analysis',
  'game-development': 'creative',
  gis: 'development',
  hr: 'life',
  legal: 'analysis',
  marketing: 'creative',
  'paid-media': 'analysis',
  product: 'analysis',
  'project-management': 'development',
  sales: 'life',
  security: 'development',
  'spatial-computing': 'development',
  specialized: 'analysis',
  'supply-chain': 'analysis',
  support: 'life',
  testing: 'development',
};

// Emoji → lucide icon 映射（保留 emoji 作为 icon，前端可渲染）
// 直接用 emoji 字符串

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]+?)\n---\n?/);
  if (!match) return { frontmatter: {}, body: content };
  const raw = match[1];
  const frontmatter = {};
  for (const line of raw.split('\n')) {
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    let value = line.slice(sep + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    frontmatter[key] = value;
  }
  const body = content.slice(match[0].length);
  return { frontmatter, body };
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'agent';
}

function buildExpert(filePath, relativeDir) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const { frontmatter, body } = parseFrontmatter(content);

  const name = frontmatter.name || path.basename(filePath, '.md');
  const description = frontmatter.description || '';
  const emoji = frontmatter.emoji || '🤖';
  const toolsStr = frontmatter.tools || '';

  // category from directory
  const dirName = path.basename(relativeDir);
  const category = CATEGORY_MAP[dirName] || 'analysis';

  // id from filename
  const basename = path.basename(filePath, '.md');
  const id = basename.replace(/^[^a-zA-Z0-9]+/, '').replace(/[^a-zA-Z0-9\u4e00-\u9fff-]/g, '-') || `expert-${Date.now()}`;

  // tags from name and dir
  const tags = [dirName];
  if (frontmatter.color) tags.push(frontmatter.color);

  // routing keywords from name + description
  const routingKeywords = [
    name,
    ...description.replace(/[，。！？、；：""''（）【】《》\s]/g, ' ').split(/\s+/).filter(w => w.length > 1),
  ].filter(Boolean);

  // capabilities from tools field
  const capabilities = toolsStr
    ? toolsStr.split(',').map(t => t.trim()).filter(Boolean)
    : [];

  // full body as system prompt
  const systemPrompt = body.trim();

  return {
    id,
    name,
    title: name,
    description: description.slice(0, 200),
    icon: emoji,
    category,
    tags: [...new Set(tags)],
    capabilities: [...new Set(capabilities)],
    routingKeywords: [...new Set(routingKeywords)],
    systemPrompt: systemPrompt.slice(0, 10000), // cap at 10k chars
    promptTemplate: null,
    collaborationChain: [],
    builtin: true,
    source: 'agency-agents',
  };
}

function walk(dir) {
  const experts = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return experts; }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        experts.push(...walk(fullPath));
      }
    } else if (entry.isFile() && entry.name.endsWith('.md') && !SKIP_FILES.has(entry.name)) {
      const expert = buildExpert(fullPath, dir);
      experts.push(expert);
    }
  }
  return experts;
}

function main() {
  console.log('🔍 Scanning agency-agents-zh...');
  const experts = walk(AGENCY_DIR);
  console.log(`📦 Found ${experts.length} experts`);

  // Deduplicate by id
  const seen = new Map();
  for (const e of experts) {
    if (seen.has(e.id)) {
      seen.get(e.id).push(e);
    } else {
      seen.set(e.id, [e]);
    }
  }
  const deduped = [];
  for (const [id, list] of seen) {
    if (list.length > 1) {
      // Keep first, rename duplicates with suffix
      deduped.push(list[0]);
      for (let i = 1; i < list.length; i++) {
        list[i].id = `${id}-${i}`;
        deduped.push(list[i]);
      }
    } else {
      deduped.push(list[0]);
    }
  }

  console.log(`✅ After dedup: ${deduped.length} experts`);

  // Stats by category
  const byCat = {};
  for (const e of deduped) {
    byCat[e.category] = (byCat[e.category] || 0) + 1;
  }
  for (const [cat, count] of Object.entries(byCat)) {
    console.log(`   ${cat}: ${count}`);
  }

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(deduped, null, 2), 'utf-8');
  console.log(`💾 Written to ${OUTPUT}`);
}

main();
