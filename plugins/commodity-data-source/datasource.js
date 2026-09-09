/** 商品数据源 factory——委托 commodity-service（与 builtin 同款签名） */
const { commoditySearch } = require('../../src/core/commodity/commodity-service');
module.exports = (p = {}) => commoditySearch(p.query || '', p);
