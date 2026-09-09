/** 数据源健康检查（可选——供电站页"hasHealth"标记） */
const { getStockDataSourceManager } = require('../../src/core/stock-data-source-manager');
module.exports = () => getStockDataSourceManager().healthCheck();
