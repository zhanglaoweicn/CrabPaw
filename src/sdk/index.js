const coreTypes = require('./coreTypes');
const runtimeTypes = require('./runtimeTypes');

const { HOOK_EVENTS, EXIT_REASONS, SUBAGENT_TYPES, MESSAGE_TYPES, SESSION_STATES, TOOL_PERMISSIONS } = coreTypes;

const {
  createSDKMessage,
  createSDKResultMessage,
  createSDKUserMessage,
  createSDKSession,
  createSubAgentConfig,
  createToolPermissionContext,
  createHookContext,
  generateUUID,
  SDKSession
} = runtimeTypes;

class AbortError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AbortError';
  }
}

async function query(params) {
  // eslint-disable-next-line no-unused-vars
  const { prompt, options = {} } = params;
  
  if (typeof prompt !== 'string' && !(Symbol.asyncIterator in prompt)) {
    throw new Error('prompt must be a string or AsyncIterable');
  }
  
  throw new Error('query is not implemented in the SDK');
}

// eslint-disable-next-line no-unused-vars
async function unstable_v2_createSession(options = {}) {
  throw new Error('unstable_v2_createSession is not implemented in the SDK');
}

// eslint-disable-next-line no-unused-vars
async function unstable_v2_resumeSession(sessionId, options = {}) {
  throw new Error('unstable_v2_resumeSession is not implemented in the SDK');
}

// eslint-disable-next-line no-unused-vars
async function unstable_v2_prompt(message, options = {}) {
  throw new Error('unstable_v2_prompt is not implemented in the SDK');
}

// eslint-disable-next-line no-unused-vars
async function getSessionMessages(sessionId, options = {}) {
  throw new Error('getSessionMessages is not implemented in the SDK');
}

// eslint-disable-next-line no-unused-vars
async function listSessions(options = {}) {
  throw new Error('listSessions is not implemented in the SDK');
}

// eslint-disable-next-line no-unused-vars
async function getSessionInfo(sessionId, options = {}) {
  throw new Error('getSessionInfo is not implemented in the SDK');
}

// eslint-disable-next-line no-unused-vars
async function renameSession(sessionId, title, options = {}) {
  throw new Error('renameSession is not implemented in the SDK');
}

// eslint-disable-next-line no-unused-vars
async function tagSession(sessionId, tag, options = {}) {
  throw new Error('tagSession is not implemented in the SDK');
}

// eslint-disable-next-line no-unused-vars
async function forkSession(sessionId, options = {}) {
  throw new Error('forkSession is not implemented in the SDK');
}

module.exports = {
  HOOK_EVENTS,
  EXIT_REASONS,
  SUBAGENT_TYPES,
  MESSAGE_TYPES,
  SESSION_STATES,
  TOOL_PERMISSIONS,
  
  createSDKMessage,
  createSDKResultMessage,
  createSDKUserMessage,
  createSDKSession,
  createSubAgentConfig,
  createToolPermissionContext,
  createHookContext,
  generateUUID,
  SDKSession,
  
  AbortError,
  
  query,
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  unstable_v2_prompt,
  getSessionMessages,
  listSessions,
  getSessionInfo,
  renameSession,
  tagSession,
  forkSession
};
