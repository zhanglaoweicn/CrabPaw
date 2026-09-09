'use strict';
const { assertPluginContract, ALLOWED_CONTRIBUTE_KEYS } = require('../sdk/plugin-sdk');

describe('plugin-sdk contributes.dataSources', () => {
  test('dataSources 是标准贡献点（运行时支持/门禁口径一致）', () => {
    const r = assertPluginContract({
      name: 'stock-data-source', version: '1.0.0',
      contributes: { dataSources: [{ name: 'stock', handler: 'datasource.js' }] },
    });
    expect(r.valid).toBe(true);
    expect([...ALLOWED_CONTRIBUTE_KEYS]).toContain('dataSources');
  });
});
