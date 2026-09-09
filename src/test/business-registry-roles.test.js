/**
 * 业务角色识别扩展回归测试（P0.5/P0.6）：
 *   - 采购/应付/供应商/客户/商品角色，采购金额不得再误标 revenue
 *   - 维度列（供应商/客户/商品）不参与表角色投票
 *   - 表级方向推断（进/销是表的属性，列级判不出）
 *   - 列别名 canonical 精确映射（不猜）
 *   - registerTable 落库 direction + canonical，导入留档写 semantic_type
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { detectColumnRole, detectCanonicalName, detectTableRole, inferTableDirection } = require('../core/business-data-registry');

describe('detectColumnRole（顺序敏感）', () => {
  test('采购金额 → purchase，不再是 revenue', () => {
    expect(detectColumnRole('采购金额')).toBe('purchase');
  });
  test('进货价/procurement → purchase', () => {
    expect(detectColumnRole('进货价')).toBe('purchase');
    expect(detectColumnRole('procurement_amount')).toBe('purchase');
  });
  test('应付金额 → payable，先于 revenue 的金额', () => {
    expect(detectColumnRole('应付金额')).toBe('payable');
  });
  test('销售额/金额 → revenue', () => {
    expect(detectColumnRole('销售额')).toBe('revenue');
    expect(detectColumnRole('金额')).toBe('revenue');
  });
  test('客户 → customer，不再吃进 receivable', () => {
    expect(detectColumnRole('客户')).toBe('customer');
    expect(detectColumnRole('应收金额')).toBe('receivable');
  });
  test('供应商/商品 → 维度角色', () => {
    expect(detectColumnRole('供应商')).toBe('supplier');
    expect(detectColumnRole('商品名称')).toBe('product');
  });
});

describe('detectTableRole（动态投票，维度列不投票）', () => {
  test('采购表 → purchase（供应商列不投票）', () => {
    const role = detectTableRole([
      { name: '商品名称' }, { name: '供应商' }, { name: '采购金额' }, { name: '日期' },
    ]);
    expect(role).toBe('purchase');
  });
  test('销售表 → revenue（客户列不投票）', () => {
    const role = detectTableRole([
      { name: '客户' }, { name: '商品名称' }, { name: '销售额' }, { name: '日期' },
    ]);
    expect(role).toBe('revenue');
  });
  test('库存表 → inventory', () => {
    const role = detectTableRole([{ name: '商品名称' }, { name: '库存数量' }]);
    expect(role).toBe('inventory');
  });
  test('只有维度列的表 → null', () => {
    const role = detectTableRole([{ name: '供应商' }, { name: '客户' }]);
    expect(role).toBeNull();
  });
});

describe('inferTableDirection（表级方向）', () => {
  test('含供应商列 → purchase', () => {
    expect(inferTableDirection([{ name: '供应商' }, { name: '金额' }, { name: '日期' }])).toBe('purchase');
  });
  test('仅采购列 → purchase', () => {
    expect(inferTableDirection([{ name: '采购金额' }, { name: '日期' }])).toBe('purchase');
  });
  test('含客户列 → sales', () => {
    expect(inferTableDirection([{ name: '客户' }, { name: '金额' }])).toBe('sales');
  });
  test('无进/销信号 → null', () => {
    expect(inferTableDirection([{ name: '库存数量' }, { name: '日期' }])).toBeNull();
  });
});

describe('detectCanonicalName（精确别名，不猜）', () => {
  test.each([
    ['销售额', 'revenue'],
    ['营收金额', 'revenue'],
    ['Amount', 'revenue'],
    ['采购金额', 'purchase'],
    ['客户名称', 'customer'],
    ['供应商', 'supplier'],
    ['安全库存', 'inventory'],
  ])('%s → %s', (name, expected) => {
    expect(detectCanonicalName(name)).toBe(expected);
  });
  test('近似但不完全相同的列名不猜', () => {
    expect(detectCanonicalName('销售金额（元）')).toBeNull();
    expect(detectCanonicalName('客户所在城市')).toBeNull();
  });
});

describe('registerTable 落库 direction/canonical + 导入留档 semantic_type', () => {
  function makeIsolatedDataDir() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'biz-reg-'));
    return tmp;
  }

  test('导入采购 CSV → role=purchase, direction=purchase, canonical 对齐, semantic_type 写入', async () => {
    const tmp = makeIsolatedDataDir();
    const oldEnv = process.env.CRABPAW_DATA_DIR;
    process.env.CRABPAW_DATA_DIR = tmp;
    const workspaceDir = tmp;
    try {
      let importPromise = null;
      let regFresh = null;
      jest.isolateModules(() => {
        const { handleImportDataFile } = require('../tools/data-import-tools');
        // 隔离块内取注册表实例——绑定隔离 DATA_DIR；块外 require 会拿到绑定
        // 真实数据目录的顶层缓存实例
        regFresh = require('../core/business-data-registry');
        const csv = '日期,商品,供应商,采购金额\n2024/01/15,螺丝,杭州标准件厂,1200\n2024/02/20,铝板,宁波铝业,8600\n';
        const csvPath = path.join(tmp, 'purchase-2024.csv');
        fs.writeFileSync(csvPath, csv, 'utf8');
        importPromise = handleImportDataFile({ filePath: csvPath, tableName: 'purchase_test', mode: 'replace' }, { workspaceDir });
      });
      const importResult = await importPromise;
      if (!importResult) throw new Error('导入未完成');

      expect(importResult.success).toBe(true);
      expect(importResult.role).toBe('purchase');
      expect(importResult.direction).toBe('purchase');

      const entry = regFresh.getTable('purchase_test');
      expect(entry.direction).toBe('purchase');
      const amountCol = entry.columns.find((c) => c.name === '采购金额');
      expect(amountCol.role).toBe('purchase');
      expect(amountCol.canonical).toBe('purchase');
      const supplierCol = entry.columns.find((c) => c.name === '供应商');
      expect(supplierCol.canonical).toBe('supplier');
      const dateCol = entry.columns.find((c) => c.name === '日期');
      expect(dateCol.canonical).toBe('date');

      const hist = regFresh.listDataPoints('purchase_test');
      expect(hist.rows.length).toBeGreaterThan(0);
      expect(hist.rows[0].semantic_type).toBe('purchase');
    } finally {
      if (oldEnv === undefined) delete process.env.CRABPAW_DATA_DIR;
      else process.env.CRABPAW_DATA_DIR = oldEnv;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
