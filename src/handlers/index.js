const configHandler = require('./config-handler');
const taskHandler = require('./task-handler');
const taskHandlerEnhanced = require('../tasks/core/task-handler-enhanced');
const skillHandler = require('./skill-handler');
const chatHandler = require('./chat-handler');
const evolutionHandler = require('./evolution-handler');
const memoryHandler = require('./memory-handler');
const flowHandler = require('./flow-handler');
const uploadHandler = require('./upload-handler');
const backupHandler = require('./backup-handler');
const usageHandler = require('./usage-handler');
const auditHandler = require('./audit-handler');
const calendarHandler = require('./calendar-handler');
const voiceEvolutionHandler = require('./voice-evolution-handler');
const fileHandler = require('./file-handler');

const commodityHandler = require('./local-handlers/commodity');
const posterHandler = require('./local-handlers/poster');

module.exports = {
  ...commodityHandler,
  ...posterHandler,
  ...configHandler,
  ...taskHandler,
  ...taskHandlerEnhanced,
  ...skillHandler,
  ...chatHandler,
  ...evolutionHandler,
  ...memoryHandler,
  ...flowHandler,
  ...uploadHandler,
  ...backupHandler,
  ...usageHandler,
  ...auditHandler,
  ...calendarHandler,
  ...voiceEvolutionHandler,
  ...fileHandler,
};
