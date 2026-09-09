/**
 * 数据源 factory（contributes.dataSources.handler 指向）
 * 委托现有 getStockDataSourceManager——A 股/港股/美股多源冗余链零改写。
 */
const { getStockDataSourceManager } = require('../../src/core/stock-data-source-manager');
module.exports = (params = {}) => {
  return getStockDataSourceManager().fetchWithRedundancy(params.code, params.capabilities || ['quote']);
};
