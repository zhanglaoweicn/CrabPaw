const { validateToolInput, registerToolContract, getToolContract } = require('../../src/core/tool-contract');

// P1-4: 补齐的 6 个契约（契约存在 + 四要素 + schema 校验行为）
const P14_CONTRACTS = [
  {
    name: 'HoldingAdd',
    riskLevel: 'medium',
    validInput: { code: '600519', shares: 100, cost: 1200 },
    invalidInput: { code: '600519' },
  },
  {
    name: 'HoldingList',
    riskLevel: 'low',
    validInput: {},
    invalidInput: { unexpected: true },
  },
  {
    name: 'HoldingRemove',
    riskLevel: 'medium',
    validInput: { code: '600519' },
    invalidInput: {},
  },
  {
    name: 'ImportDataFile',
    riskLevel: 'medium',
    validInput: { filePath: 'report.csv' },
    invalidInput: { filePath: 'report.csv', mode: 'not-a-mode' },
  },
  {
    name: 'ProactiveSpeak',
    riskLevel: 'low',
    validInput: { text: '老板，文档已生成' },
    invalidInput: {},
  },
  {
    name: 'TyphoonQuery',
    riskLevel: 'low',
    validInput: { query: '浪卡' },
    invalidInput: { unexpected: true },
  },
];

module.exports = {
  name: 'Tool Contracts',
  cases: [
    {
      id: 'tc_001',
      name: 'read tool enforces required file_path',
      category: 'tool_contract',
      run: () => { const r = validateToolInput('Read', {}); return !r.valid; },
    },
    {
      id: 'tc_002',
      name: 'read tool accepts valid input',
      category: 'tool_contract',
      run: () => { const r = validateToolInput('Read', { file_path: 'test.js' }); return r.valid; },
    },
    {
      id: 'tc_003',
      name: 'Bash tool rejects unknown properties',
      category: 'tool_contract',
      run: () => { const r = validateToolInput('Bash', { command: 'ls', extraProp: 'bad' }); return !r.valid; },
    },
    {
      id: 'tc_004',
      name: 'Write tool requires content',
      category: 'tool_contract',
      run: () => { const r = validateToolInput('Write', { file_path: 'test.js' }); return !r.valid; },
    },
    {
      id: 'tc_005',
      name: 'Dynamic contract registration',
      category: 'tool_contract',
      run: () => {
        registerToolContract('eval_test_tool', {
          description: 'Eval test tool',
          schema: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
        });
        const valid = validateToolInput('eval_test_tool', { input: 'hello' });
        const invalid = validateToolInput('eval_test_tool', {});
        return valid.valid && !invalid.valid;
      },
    },
    {
      id: 'tc_006',
      name: 'Unknown tool passes with warning',
      category: 'tool_contract',
      run: () => { const r = validateToolInput('nonexistent_tool', { anything: true }); return !!(r.valid && typeof r.warning === 'string'); },
    },
    {
      id: 'tc_007',
      name: 'P1-4: 6 contracts exist with four required elements',
      category: 'tool_contract',
      run: () => P14_CONTRACTS.every(({ name, riskLevel }) => {
        const c = getToolContract(name);
        return !!c
          && typeof c.description === 'string' && c.description.length > 0
          && !!c.whenNotToUse
          && !!c.schema && typeof c.schema === 'object'
          && c.riskLevel === riskLevel
          && typeof c.validate === 'function';
      }),
    },
    {
      id: 'tc_008',
      name: 'P1-4: 6 contracts enforce schema validation',
      category: 'tool_contract',
      run: () => P14_CONTRACTS.every(({ name, validInput, invalidInput }) =>
        validateToolInput(name, validInput).valid && !validateToolInput(name, invalidInput).valid),
    },
    {
      id: 'tc_009',
      name: 'P1-4: ImageEdit rotate/watermark_text and BrowserControl ref have real constraints',
      category: 'tool_contract',
      run: () => {
        const img = getToolContract('ImageEdit');
        const bc = getToolContract('BrowserControl');
        const rotateOk = img.schema.properties.rotate
          && (img.schema.properties.rotate.type || img.schema.properties.rotate.anyOf);
        const wmOk = img.schema.properties.watermark_text
          && (img.schema.properties.watermark_text.type || img.schema.properties.watermark_text.anyOf);
        const refOk = bc.schema.properties.ref && bc.schema.properties.ref.type === 'string';
        return !!(rotateOk && wmOk && refOk);
      },
    },
  ],
};
