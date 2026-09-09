/** 台风数据源 factory——委托 globalTyphoonPanel（与 builtin 同款签名） */
const { globalTyphoonPanel } = require('../../src/core/panels/typhoon');
module.exports = (params = {}) => globalTyphoonPanel.getTyphoon(params);
