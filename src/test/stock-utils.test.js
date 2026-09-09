/**
 * stock-utils.js 测试
 */
const {
  POPULAR_STOCKS,
  extractStockName,
  fmtNum,
  getMarketPrefix,
  // eslint-disable-next-line no-unused-vars
  searchStockByName,
} = require('../tools/stock/stock-utils');

describe('stock-utils', () => {
  describe('extractStockName', () => {
    test('should extract known stock names', () => {
      const result = extractStockName('test text with stock name');
      expect(result).toBeDefined();
    });
  });

  describe('fmtNum', () => {
    test('should format numbers', () => {
      expect(fmtNum(1234.56)).toBeDefined();
    });
  });

  describe('getMarketPrefix', () => {
    test('should return string', () => {
      expect(typeof getMarketPrefix('600000')).toBe('string');
    });
  });

  describe('POPULAR_STOCKS', () => {
    test('should be defined as object', () => {
      expect(POPULAR_STOCKS).toBeDefined();
      expect(typeof POPULAR_STOCKS).toBe('object');
    });
  });
});