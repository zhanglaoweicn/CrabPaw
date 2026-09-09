// T7 分部三：CRLF 文件的 snake_case 工具名引用收敛（\r\n 容忍正则替换）。
const fs = require('fs');
const path = require('path');

function apply(file, replacements) {
  const p = path.join(__dirname, '..', file);
  let src = fs.readFileSync(p, 'utf-8');
  let applied = 0;
  for (const { pattern, flags, to } of replacements) {
    const re = new RegExp(pattern, flags || '');
    if (!re.test(src)) {
      console.warn(`  [warn] ${file}: 未找到: ${pattern.slice(0, 70)}...`);
      continue;
    }
    src = src.replace(re, to);
    applied++;
  }
  fs.writeFileSync(p, src);
  console.log(`  ${file}: applied ${applied}/${replacements.length}`);
  return applied;
}

// 1) compressor.js — 补 PascalCase summarizer 键（skill_manage/todo）
apply('src/core/context/compressor.js', [
  {
    // 现有 skill_manage 条目块整体替换（含标签文案更新）+ 追加 SkillManage 同构条目
    pattern: String.raw`  skill_manage: \(args, content\) => \{[\s\S]*?return \`\[skill_manage\] 技能管理\`; \}\s*\},`,
    to: `  skill_manage: (args, content) => {
    try {
      const a = typeof args === 'string' ? JSON.parse(args) : args || {};
      return \`[SkillManage] \${a.action || '?'} name=\${a.name || '?'} (\${(content||'').length.toLocaleString()} 字符)\`;
    } catch { return \`[SkillManage] 技能管理\`; }
  },
  // 2026-08-15 T7: 注册主名已收敛 PascalCase——新旧名共用同一 summarizer（别名兼容）。
  SkillManage: (args, content) => {
    try {
      const a = typeof args === 'string' ? JSON.parse(args) : args || {};
      return \`[SkillManage] \${a.action || '?'} name=\${a.name || '?'} (\${(content||'').length.toLocaleString()} 字符)\`;
    } catch { return \`[SkillManage] 技能管理\`; }
  },`,
  },
  {
    // todo 条目：标签改 Todo + 追加 Todo 键
    pattern: String.raw`// eslint-disable-next-line no-unused-vars\r?\n  todo: \(_args, content\) => \`\[todo\] 更新任务列表\`,`,
    to: `// eslint-disable-next-line no-unused-vars
  todo: (_args, content) => \`[Todo] 更新任务列表\`,
  // 2026-08-15 T7: 注册主名已收敛 PascalCase——新旧名共用同一 summarizer（别名兼容）。
  // eslint-disable-next-line no-unused-vars
  Todo: (_args, content) => \`[Todo] 更新任务列表\`,`,
  },
]);

// 2) tool-name-map.js — identity 映射改规范主名
apply('src/core/tool-name-map.js', [
  {
    pattern: String.raw`  skill_generate: 'skill_generate', skill_manage: 'skill_manage',\r?\n  skill_view: 'skill_view', skills_list: 'skills_list',\r?\n  taskflow: 'taskflow',`,
    to: `  // 2026-08-15 T7: 注册主名已收敛 PascalCase（registry 别名双向解析，旧名调用仍可用）
  skill_generate: 'SkillGenerate', skill_manage: 'SkillManage',
  skill_view: 'SkillView', skills_list: 'SkillsList',
  taskflow: 'Taskflow',`,
  },
]);

console.log('done');
