/** 经营数据源 factory——委托 business-data-registry（与 builtin 同款签名） */
const { listTables } = require('../../src/core/business-data-registry');
module.exports = () => Promise.resolve({ tables: listTables() });
