/**
 * 股票工具契约-参数单源化对齐测试（2026-08-17）
 *
 * 实机 bug："无法查询股票"。
 * 根因链（日志 11:31:21-25 实锤）：
 *   - StockQuery 契约手写 required:["symbol"]+additionalProperties:false，而工具
 *     schema（stock-tools.js）是 query 必需 → 模型按工具 schema 传 {"query":"贵州茅台"}
 *     被契约拒 ("should have required property 'symbol'")；传 {"symbol":"600519"} 过
 *     校验但 handleStockQuery 不读 symbol → 假成功（"请提供股票名称或代码"）。
 *   - ShowStock 契约/工具 schema 参数是 queries（复数），模型传单数 query → 契约拒
 *     ("should NOT have additional properties")。
 *   两次失败后兜底 WebSearch → 回复无实时行情 → 用户看到"无法查询股票"。
 *
 * 修复：StockQuery 契约对齐工具 query 必需；handleStockQuery 兼容 symbol；
 *       ShowStock 契约+工具 schema+handler 三端补 query 单数别名。
 * 本测试守契约与 registry 单源一致，防再错位。
 */

const { validateToolInput, getToolContract } = require('../core/tool-contract');
const { registry } = require('../tools/registry');

process.env.NODE_ENV = 'test';
require('../tools');

describe('StockQuery 契约对齐（registry 单源化）', () => {
  test('契约放行 query 参数（工具 schema 的必需参数）', () => {
    const r = validateToolInput('StockQuery', { query: '贵州茅台' });
    expect(r.valid).toBe(true);
  });

  test('契约放行 stocks 别名（实机 20:08:42 模型传 stocks 被拒）', () => {
    const r = validateToolInput('StockQuery', { stocks: '贵州茅台' });
    expect(r.valid).toBe(true);
  });

  test('契约放行 symbols 别名（实机 10:49:22 模型传 symbols 被拒→面板不弹）', () => {
    expect(validateToolInput('StockQuery', { symbols: '688836' }).valid).toBe(true);
  });

  test('契约放行 queries 别名（实机 10:49:58 模型传 queries 被拒）', () => {
    expect(validateToolInput('StockQuery', { queries: '宇树科技' }).valid).toBe(true);
  });

  test('契约放行 stock 别名（实机 11:13:13 模型传 stock 被拒）', () => {
    expect(validateToolInput('StockQuery', { stock: '宇树科技' }).valid).toBe(true);
  });

  test('契约 required 与 registry 工具 schema 完全一致', () => {
    const contract = getToolContract('StockQuery');
    const tool = registry.get('StockQuery');
    const regSchema = tool.schema.parameters || tool.schema;
    expect(contract.schema.required).toEqual(regSchema.required);
    expect(contract.schema.anyOf).toEqual(regSchema.anyOf);
    expect(Object.keys(contract.schema.properties).sort())
      .toEqual(Object.keys(regSchema.properties).sort());
    for (const p of Object.keys(regSchema.properties)) {
      expect(contract.schema.properties[p]).toBeTruthy();
    }
  });
});

describe('ShowStock 契约对齐（query 单数别名）', () => {
  test('契约放行 query 别名、queries 原参数、action=hide', () => {
    expect(validateToolInput('ShowStock', { query: '贵州茅台' }).valid).toBe(true);
    expect(validateToolInput('ShowStock', { queries: '贵州茅台' }).valid).toBe(true);
    expect(validateToolInput('ShowStock', { query: '贵州茅台,宁德时代', period: 'week' }).valid).toBe(true);
    expect(validateToolInput('ShowStock', { action: 'hide' }).valid).toBe(true);
  });

  test('契约放行 symbols 别名（实机 10:49:18 模型传 symbols 被拒→面板不弹）', () => {
    expect(validateToolInput('ShowStock', { symbols: '688836' }).valid).toBe(true);
    expect(validateToolInput('ShowStock', { symbols: '688836', period: 'week' }).valid).toBe(true);
  });

  test('工具 schema 与契约双端都声明 query 与 symbols', () => {
    const tool = registry.get('ShowStock');
    const regProps = tool.schema.properties || {};
    const contractProps = getToolContract('ShowStock').schema.properties;
    expect(regProps.query).toBeTruthy();
    expect(contractProps.query).toBeTruthy();
    expect(regProps.symbols).toBeTruthy();
    expect(contractProps.symbols).toBeTruthy();
  });
});
