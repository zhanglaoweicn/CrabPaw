const { HOOK_EVENTS, SUBAGENT_TYPES, MESSAGE_TYPES, SESSION_STATES, TOOL_PERMISSIONS } = require('./coreTypes');

function createSDKMessage(type, content, options = {}) {
  return {
    type,
    content,
    role: type === MESSAGE_TYPES.USER ? 'user' : 'assistant',
    timestamp: Date.now(),
    uuid: generateUUID(),
    ...options
  };
}

function createSDKResultMessage(result, options = {}) {
  return {
    type: MESSAGE_TYPES.ASSISTANT,
    result,
    timestamp: Date.now(),
    uuid: generateUUID(),
    ...options
  };
}

function createSDKUserMessage(content, options = {}) {
  return createSDKMessage(MESSAGE_TYPES.USER, content, options);
}

function createSDKSession(options = {}) {
  return {
    id: generateUUID(),
    state: SESSION_STATES.INITIALIZING,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    messageCount: 0,
    metadata: {},
    ...options
  };
}

function createSubAgentConfig(type, description, prompt, options = {}) {
  if (!Object.values(SUBAGENT_TYPES).includes(type)) {
    throw new Error(`Invalid subagent type: ${type}`);
  }
  
  return {
    type,
    description,
    prompt,
    timeout: options.timeout || 300000,
    tools: options.tools || [],
    parentAgentId: options.parentAgentId,
    metadata: options.metadata || {}
  };
}

function createToolPermissionContext(permissions = {}) {
  return {
    permissions: {
      read: permissions.read || TOOL_PERMISSIONS.ASK,
      write: permissions.write || TOOL_PERMISSIONS.ASK,
      execute: permissions.execute || TOOL_PERMISSIONS.ASK,
      network: permissions.network || TOOL_PERMISSIONS.ASK
    },
    allowedPaths: permissions.allowedPaths || [],
    deniedPaths: permissions.deniedPaths || []
  };
}

function createHookContext(event, data = {}) {
  if (!HOOK_EVENTS.includes(event)) {
    throw new Error(`Invalid hook event: ${event}`);
  }
  
  return {
    event,
    data,
    timestamp: Date.now(),
    handled: false
  };
}

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

class SDKSession {
  constructor(options = {}) {
    this.session = createSDKSession(options);
    this.messages = [];
    this.hooks = new Map();
  }
  
  getId() {
    return this.session.id;
  }
  
  getState() {
    return this.session.state;
  }
  
  setState(state) {
    if (!Object.values(SESSION_STATES).includes(state)) {
      throw new Error(`Invalid session state: ${state}`);
    }
    this.session.state = state;
    this.session.lastActivityAt = Date.now();
  }
  
  addMessage(message) {
    this.messages.push(message);
    this.session.messageCount++;
    this.session.lastActivityAt = Date.now();
  }
  
  getMessages() {
    return [...this.messages];
  }
  
  registerHook(event, handler) {
    if (!this.hooks.has(event)) {
      this.hooks.set(event, []);
    }
    this.hooks.get(event).push(handler);
  }
  
  async triggerHook(event, data) {
    const handlers = this.hooks.get(event) || [];
    const context = createHookContext(event, data);
    
    for (const handler of handlers) {
      try {
        await handler(context);
      } catch (error) {
        console.error(`Hook handler error for ${event}:`, error.message);
      }
    }
    
    return context;
  }
  
  toJSON() {
    return {
      session: this.session,
      messageCount: this.messages.length
    };
  }
}

module.exports = {
  createSDKMessage,
  createSDKResultMessage,
  createSDKUserMessage,
  createSDKSession,
  createSubAgentConfig,
  createToolPermissionContext,
  createHookContext,
  generateUUID,
  SDKSession,
  HOOK_EVENTS,
  SUBAGENT_TYPES,
  MESSAGE_TYPES,
  SESSION_STATES,
  TOOL_PERMISSIONS
};
