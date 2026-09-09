/**
 * Batch add capabilities to all SKILL.md files — v2
 * Run: node tools/add-capabilities.js
 */
const fs = require('fs');
const path = require('path');

const SKILLS_DIR = path.join(__dirname, '..', 'skills');

const CAP_MAP = {
  'code-review': 'code_review', 'git-ops': 'git_operations',
  'api-tester': 'shell_command', 'prompt-engineering-expert': 'prompt_design',
  'skill-creator': 'prompt_design', 'systematic-debugging': 'code_review',
  'test-driven-development': 'code_review', 'writing-plans': 'document_generation',
  'subagent-driven-dev': 'code_review', 'workflow-automator': 'scheduling',
  'desktop-control': 'desktop_automation', 'browser-use': 'browser_automation',
  'agent-browser': 'browser_automation', 'windows-ui-automation': 'desktop_automation',
  'multi-search-engine': 'web_search', 'web-search-pro': 'web_search',
  'wechat-article-search': 'web_search', 'deep-research': 'web_search',
  'hot-now': 'trend_monitoring', 'trending-monitor': 'trend_monitoring',
  'pdf-generator': 'document_generation', 'html-generator': 'document_generation',
  'powerpoint-pptx': 'document_generation', 'word-docx': 'document_generation',
  'report-generator': 'document_generation', 'diagram-generator': 'document_generation',
  'chart-generator': 'data_visualization', 'excel-xlsx': 'data_analysis',
  'ui-ux-pro-max': 'document_generation', 'pdf-to-word-docx': 'document_conversion',
  'markdown-converter': 'document_conversion', 'doc-processor': 'document_conversion',
  'summarize-pro': 'content_summarization', 'meeting-summary': 'meeting_summary',
  'email-assistant': 'email_management', 'file-manager': 'file_management',
  'file-organizer': 'file_organization', 'scheduled-task': 'scheduling',
  'wecom-daily-news': 'notification', 'knowledge-base': 'knowledge_management',
  'self-improving-agent': 'self_improvement',
  'article-writer': 'article_writing', 'content-planner': 'content_writing',
  'review-analyzer': 'review_analysis',
  'listing-optimizer': 'marketing', 'promo-planner': 'marketing',
  'product-research': 'product_research', 'price-monitor': 'price_monitoring',
  'healthcheck': 'system_monitoring', 'system-info': 'system_info',
  'shell-enhance': 'shell_command', 'weather': 'weather_query',
  'image-analyze': 'image_analysis', 'image-editor': 'desktop_automation',
  'brainstorming': 'prompt_design', 'audio-transcribe': 'content_summarization',
  'huo15-flow-chart': 'document_generation',
};

function fixLineEndings(content) {
  return content.replace(/\r\n/g, '\n');
}

function addCapabilities(skillMdPath) {
  let content = fs.readFileSync(skillMdPath, 'utf-8');
  content = fixLineEndings(content);
  const name = path.basename(path.dirname(skillMdPath));

  if (content.includes('capabilities:')) {
    console.log(`  SKIP ${name} (already has capabilities)`);
    return;
  }

  const cap = CAP_MAP[name];
  if (!cap) {
    console.log(`  SKIP ${name} (no mapping)`);
    return;
  }

  // Case 1: Has metadata.crabpaw with category line → insert after category
  const r1 = /( {4}category: \w+\n)/;
  if (r1.test(content)) {
    content = content.replace(r1, `$1    capabilities: [${cap}]\n`);
    fs.writeFileSync(skillMdPath, content, 'utf-8');
    console.log(`  ✅ ${name} → after category`);
    return;
  }

  // Case 2: Has metadata.crabpaw block but no category → add category + capabilities
  const r2 = /(  crabpaw:\n)/;
  if (r2.test(content)) {
    content = content.replace(r2, `$1    category: general\n    capabilities: [${cap}]\n`);
    fs.writeFileSync(skillMdPath, content, 'utf-8');
    console.log(`  ✅ ${name} → new crabpaw entry`);
    return;
  }

  // Case 3: Has metadata.openclaw but no crabpaw → add crabpaw block
  const r3 = /(metadata:\n)/;
  if (r3.test(content)) {
    content = content.replace(r3, `$1  crabpaw:\n    category: general\n    capabilities: [${cap}]\n`);
    fs.writeFileSync(skillMdPath, content, 'utf-8');
    console.log(`  ✅ ${name} → new crabpaw block`);
    return;
  }

  // Case 4: No metadata at all → add after description line
  const r4 = /^(description:.*)\n/m;
  if (r4.test(content)) {
    content = content.replace(r4, `$1\nmetadata:\n  crabpaw:\n    category: general\n    capabilities: [${cap}]\n`);
    fs.writeFileSync(skillMdPath, content, 'utf-8');
    console.log(`  ✅ ${name} → new metadata block`);
    return;
  }

  console.log(`  ❌ ${name} - no matching pattern`);
}

function scanDir(dir) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const skillMd = path.join(fullPath, 'SKILL.md');
      if (fs.existsSync(skillMd)) {
        addCapabilities(skillMd);
      } else {
        scanDir(fullPath);
      }
    }
  }
}

console.log('=== Adding capabilities to SKILL.md ===');
scanDir(SKILLS_DIR);
console.log('=== Done ===');
