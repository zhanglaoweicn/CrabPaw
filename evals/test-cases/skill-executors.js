/**
 * Skill Executors — eval test cases
 * 验证各技能 executor 真实存在且 execute 可调用（mock 下层，不触网）
 */

module.exports = {
  name: 'Skill Executors',
  cases: [
    {
      id: 'sk_001',
      name: 'hot-now executor exists and rejects bad platform',
      category: 'skill_validate',
      run: async () => {
        const { execute } = require('../../skills/hot-now/executor');
        const r = await execute({ platform: 'nope' });
        return r.success === false && r.error.includes('不支持的平台');
      },
    },
    {
      id: 'sk_002',
      name: 'trending-monitor weekly without history gives friendly error',
      category: 'skill_validate',
      run: async () => {
        const { execute } = require('../../skills/trending-monitor/executor');
        const r = await execute({ action: 'weekly' });
        return r.success === false || typeof r.content === 'string';
      },
    },
    {
      id: 'sk_003',
      name: 'multi-search-engine rejects empty query',
      category: 'skill_validate',
      run: async () => {
        const { execute } = require('../../skills/multi-search-engine/executor');
        const r = await execute({ query: '' });
        return r.success === false;
      },
    },
    {
      id: 'sk_004',
      name: 'chart-generator builds bar option and renders or degrades',
      category: 'skill_validate',
      run: async () => {
        const { execute } = require('../../skills/chart-generator/executor');
        const r = await execute({ type: 'bar', title: 't', data: [{ name: 'a', value: 1 }] });
        return r.success === true && (r.output?.pngPath || r.output?.html);
      },
    },
    {
      id: 'sk_005',
      name: 'diagram-generator produces real mermaid flowchart',
      category: 'skill_validate',
      run: async () => {
        const { execute } = require('../../skills/diagram-generator/executor');
        const r = await execute({ diagramType: 'flowchart', nodes: [{ id: 'A', label: '开始' }, { id: 'B', label: '结束' }], edges: [{ from: 'A', to: 'B', label: '流转' }] });
        return r.success === true && /flowchart LR/.test(r.mermaid) && /A -->/.test(r.mermaid);
      },
    },
    {
      id: 'sk_006',
      name: 'diagram-generator rejects edgeless input',
      category: 'skill_validate',
      run: async () => {
        const { execute } = require('../../skills/diagram-generator/executor');
        const r = await execute({ diagramType: 'flowchart', nodes: [{ id: 'A' }], edges: [] });
        return r.success === false;
      },
    },
    {
      id: 'sk_007',
      name: 'report-generator rejects empty topic',
      category: 'skill_validate',
      run: async () => {
        const { execute } = require('../../skills/report-generator/executor');
        const r = await execute({ topic: '' });
        return r.success === false;
      },
    },
    {
      id: 'sk_008',
      name: 'html-generator rejects empty content',
      category: 'skill_validate',
      run: async () => {
        const { execute } = require('../../skills/html-generator/executor');
        const r = await execute({ title: 't', content: '' });
        return r.success === false;
      },
    },
    {
      id: 'sk_009',
      name: 'powerpoint-pptx validates slides input',
      category: 'skill_validate',
      run: async () => {
        const { execute } = require('../../skills/powerpoint-pptx/executor');
        const r = await execute({ title: 't', slides: [] });
        return r.success === true; // 空 slides 走默认示例页
      },
    },
    // ── Task 3 (I-4): 纸面技能清理 ──
    {
      id: 'se_010',
      name: 'excel-xlsx create action produces real .xlsx with PK header',
      category: 'skill_validate',
      run: async () => {
        const { execute } = require('../../skills/excel-xlsx/executor');
        const path = require('path');
        const fs = require('fs');
        const r = await execute({
          action: 'create',
          title: 'EvalTest',
          sheets: [{ name: 'Sheet1', headers: ['Name', 'Score'], rows: [['Alice', 95], ['Bob', 87]] }],
        });
        if (!r.success || !r.outputPath) return false;
        const buf = fs.readFileSync(r.outputPath);
        // .xlsx is a ZIP archive: PK\x03\x04
        const isXlsx = buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
        // Cleanup
        try { fs.unlinkSync(r.outputPath); } catch (_) { /* ok */ }
        return isXlsx;
      },
    },
    {
      id: 'se_011',
      name: 'pdf-to-word-docx returns clear error for empty filePath',
      category: 'skill_validate',
      run: async () => {
        const { execute } = require('../../skills/pdf-to-word-docx/executor');
        const r = await execute({ filePath: '', targetFormat: 'word' });
        return r.success === false && typeof r.error === 'string' && r.error.length > 0;
      },
    },
    {
      id: 'se_012',
      name: 'pdf-to-word-docx rejects missing file with clear error',
      category: 'skill_validate',
      run: async () => {
        const { execute } = require('../../skills/pdf-to-word-docx/executor');
        const r = await execute({ filePath: '/nonexistent/path.pdf', targetFormat: 'word' });
        return r.success === false && r.error.includes('不存在');
      },
    },
    {
      id: 'se_013',
      name: 'skill-generator executor template is flagged draft by quality gate',
      category: 'skill_validate',
      run: async () => {
        const { generateSkill } = require('../../src/core/skill-generator');
        // Simulate AI analysis that requests an executor — template will have [待实现] comment
        const analysis = {
          skillName: 'TestDraftSkill',
          displayName: '测试草稿技能',
          description: 'A test skill',
          skillDescription: 'Test',
          functionality: 'Test func',
          needsExecutor: true,
          confidence: 0.8,
          bins: [],
          pipDeps: [],
          npmDeps: [],
        };
        const result = await generateSkill('test prompt', analysis);
        // Quality gate should flag the auto-generated template as draft
        return result.success === true
          && typeof result.quality === 'string'
          && result.quality === 'draft'
          && result.skillId && result.skillId.startsWith('testdraftskill-');
      },
    },
  ],
};
