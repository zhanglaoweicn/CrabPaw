const product = require('./product');
const files = require('./files');
const figures = require('./figures');
const spinnerVerbs = require('./spinnerVerbs');
const xml = require('./xml');
const messages = require('./messages');
const apiLimits = require('./apiLimits');
const errorIds = require('./errorIds');
const common = require('./common');

module.exports = {
  ...product,
  ...files,
  ...figures,
  ...spinnerVerbs,
  ...xml,
  ...messages,
  ...apiLimits,
  ...errorIds,
  ...common
};
