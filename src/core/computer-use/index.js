// eslint-disable-next-line no-unused-vars
const { ComputerUseBackend } = require('./backend');

let _backend = null;

function getComputerUseBackend(config = {}) {
  if (_backend) return _backend;

  const platform = process.platform;
  if (platform === 'win32') {
    const { WindowsBackend } = require('./windows-backend');
    _backend = new WindowsBackend(config);
  } else {
    throw new Error(`Computer use not supported on platform: ${platform}`);
  }

  return _backend;
}

async function initializeComputerUse(config = {}) {
  const backend = getComputerUseBackend(config);
  await backend.initialize();
  return backend;
}

module.exports = { getComputerUseBackend, initializeComputerUse };
