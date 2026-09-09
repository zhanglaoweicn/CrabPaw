// T7 分部三：TOOL_CONTRACTS snake_case 主键 → PascalCase（一次性脚本，可复查）。
// 规则：键名 `TOOL_CONTRACTS.<snake> = ` → `TOOL_CONTRACTS.<Pascal> = `；
// snake_case 原名进 LEGACY_SNAKE_ALIASES 别名表指向同一契约对象。
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'src', 'core', 'tool-contract.js');

const RENAMES = {
  skill_manage: 'SkillManage',
  skill_generate: 'SkillGenerate',
  doc_read: 'DocRead',
  doc_to_markdown: 'DocToMarkdown',
  pdf_extract: 'PdfExtract',
  xlsx_query: 'XlsxQuery',
  email_list: 'EmailList',
  email_read: 'EmailRead',
  email_search: 'EmailSearch',
  email_send: 'EmailSend',
  taskflow: 'Taskflow',
  todo: 'Todo',
  hot_search: 'HotSearch',
  platform_keys_status: 'PlatformKeysStatus',
  wechat_mp_draft: 'WechatMpDraft',
  wechat_mp_publish: 'WechatMpPublish',
  docx_generate: 'DocxGenerate',
  xlsx_generate: 'XlsxGenerate',
  pptx_generate: 'PptxGenerate',
  pdf_generate: 'PdfGenerate',
  html_generate: 'HtmlGenerate',
  hotspot_mode: 'HotspotMode',
  meeting_mode: 'MeetingMode',
  person_card_mode: 'PersonCardMode',
  worldcup_mode: 'WorldcupMode',
  focus_banner: 'FocusBanner',
  voice_retire: 'VoiceRetire',
};

const ALIAS_ENTRIES = Object.entries(RENAMES)
  .map(([snake, pascal]) => `  ${snake}: '${pascal}',`)
  .join('\n');

const NEW_ALIAS_BLOCK = `// ── snake_case 历史名别名（向后兼容）─────────────
// 2026-08-15 T7: HARNESS.md v2.4.0 契约主名统一 PascalCase。
// 以下 snake_case 原名保留为别名指向同一契约对象，确保旧引用
// （getToolContract('skill_manage') 等）与历史 LLM 工具调用不中断。
const LEGACY_SNAKE_ALIASES = {
${ALIAS_ENTRIES}
};
for (const [snakeName, pascalName] of Object.entries(LEGACY_SNAKE_ALIASES)) {
  if (TOOL_CONTRACTS[pascalName] && !TOOL_CONTRACTS[snakeName]) {
    TOOL_CONTRACTS[snakeName] = TOOL_CONTRACTS[pascalName];
  }
}`;

let src = fs.readFileSync(FILE, 'utf-8');

// 1) 键名重命名（仅匹配 `TOOL_CONTRACTS.<snake> = ` 形式，不改文案/注释/别名表）
let renamed = 0;
for (const [snake, pascal] of Object.entries(RENAMES)) {
  const pattern = `TOOL_CONTRACTS.${snake} = `;
  const replacement = `TOOL_CONTRACTS.${pascal} = `;
  const before = src;
  src = src.split(pattern).join(replacement);
  if (src !== before) renamed++;
}

// 2) 替换旧 PASCAL_ALIASES 块（按行定位，兼容 mixed EOL）
const lines = src.split(/\n/);
let commentStart = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('// ── PascalCase 别名')) { commentStart = i; break; }
}
if (commentStart < 0) throw new Error('未找到 PascalCase 别名注释起始行');
let forIdx = -1;
for (let i = commentStart; i < lines.length; i++) {
  if (lines[i].includes('for (const [pascalName, snakeName] of Object.entries(PASCAL_ALIASES))')) { forIdx = i; break; }
}
if (forIdx < 0) throw new Error('未找到 PASCAL_ALIASES for 循环');
// for 循环共 5 行（for / if / 赋值 / } / }）
const replacementLines = NEW_ALIAS_BLOCK.split('\n');
lines.splice(commentStart, (forIdx + 5) - commentStart, ...replacementLines);
src = lines.join('\n');

// 3) exports 补充 LEGACY_SNAKE_ALIASES
if (!src.includes('LEGACY_SNAKE_ALIASES,ajv')) {
  src = src.replace(
    'module.exports={TOOL_CONTRACTS,getToolContract,validateToolInput,getAllContracts,registerToolContract,registerIntoRegistry,generateCoverageReport,getContractsByRiskLevel,ajv};',
    'module.exports={TOOL_CONTRACTS,getToolContract,validateToolInput,getAllContracts,registerToolContract,registerIntoRegistry,generateCoverageReport,getContractsByRiskLevel,LEGACY_SNAKE_ALIASES,ajv};'
  );
}

fs.writeFileSync(FILE, src);
console.log(`renamed keys: ${renamed}/${Object.keys(RENAMES).length}`);
console.log('alias block replaced:', src.includes('LEGACY_SNAKE_ALIASES'));
console.log('exports updated:', src.includes('LEGACY_SNAKE_ALIASES,ajv'));
