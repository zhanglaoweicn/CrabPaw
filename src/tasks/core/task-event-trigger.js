const { EventEmitter } = require('events');

const EVENT_TYPES = {
  TASK_STARTED: 'task_started',
  TASK_COMPLETED: 'task_completed',
  TASK_FAILED: 'task_failed',
  TASK_CANCELLED: 'task_cancelled',
  FILE_CHANGED: 'file_changed',
  API_CALLED: 'api_called',
  SCHEDULE_TRIGGERED: 'schedule_triggered',
  USER_ACTION: 'user_action',
  SYSTEM_EVENT: 'system_event',
  CUSTOM_EVENT: 'custom_event'
};

const TRIGGER_CONDITIONS = {
  EQUALS: 'equals',
  NOT_EQUALS: 'not_equals',
  CONTAINS: 'contains',
  NOT_CONTAINS: 'not_contains',
  GREATER_THAN: 'greater_than',
  LESS_THAN: 'less_than',
  REGEX: 'regex',
  EXISTS: 'exists',
  NOT_EXISTS: 'not_exists'
};

class TaskEventTrigger extends EventEmitter {
  constructor() {
    super();
    
    this.eventListeners = new Map();
    this.eventHistory = [];
    this.maxHistorySize = 1000;
    this.triggerRules = new Map();
    
    this.setupBuiltInEvents();
    
    console.log('🎯 任务事件触发器已初始化');
  }
  
  setupBuiltInEvents() {
    this.on(EVENT_TYPES.TASK_STARTED, (data) => {
      this.recordEvent(EVENT_TYPES.TASK_STARTED, data);
    });
    
    this.on(EVENT_TYPES.TASK_COMPLETED, (data) => {
      this.recordEvent(EVENT_TYPES.TASK_COMPLETED, data);
      this.checkTriggers(EVENT_TYPES.TASK_COMPLETED, data);
    });
    
    this.on(EVENT_TYPES.TASK_FAILED, (data) => {
      this.recordEvent(EVENT_TYPES.TASK_FAILED, data);
      this.checkTriggers(EVENT_TYPES.TASK_FAILED, data);
    });
    
    this.on(EVENT_TYPES.TASK_CANCELLED, (data) => {
      this.recordEvent(EVENT_TYPES.TASK_CANCELLED, data);
      this.checkTriggers(EVENT_TYPES.TASK_CANCELLED, data);
    });
  }
  
  registerTrigger(triggerId, config) {
    const {
      name,
      description,
      eventType,
      conditions = [],
      targetTaskId,
      targetTaskConfig = {},
      enabled = true,
      priority = 0,
      cooldown = 0,
      maxExecutions = null
    } = config;
    
    if (!eventType || !targetTaskId) {
      return {
        success: false,
        error: 'eventType 和 targetTaskId 是必需的'
      };
    }
    
    const trigger = {
      id: triggerId,
      name: name || `触发器 ${triggerId}`,
      description: description || '',
      eventType,
      conditions,
      targetTaskId,
      targetTaskConfig,
      enabled,
      priority,
      cooldown,
      maxExecutions,
      executionCount: 0,
      lastTriggeredAt: null,
      createdAt: Date.now()
    };
    
    this.triggerRules.set(triggerId, trigger);
    
    console.log(`🎯 注册事件触发器: ${trigger.name} (${eventType} -> ${targetTaskId})`);
    
    return {
      success: true,
      trigger
    };
  }
  
  unregisterTrigger(triggerId) {
    const trigger = this.triggerRules.get(triggerId);
    
    if (!trigger) {
      return {
        success: false,
        error: '触发器不存在'
      };
    }
    
    this.triggerRules.delete(triggerId);
    
    console.log(`🗑️ 注销事件触发器: ${trigger.name}`);
    
    return {
      success: true,
      message: '触发器已注销'
    };
  }
  
  enableTrigger(triggerId) {
    const trigger = this.triggerRules.get(triggerId);
    if (trigger) {
      trigger.enabled = true;
      return { success: true };
    }
    return { success: false, error: '触发器不存在' };
  }
  
  disableTrigger(triggerId) {
    const trigger = this.triggerRules.get(triggerId);
    if (trigger) {
      trigger.enabled = false;
      return { success: true };
    }
    return { success: false, error: '触发器不存在' };
  }
  
  async checkTriggers(eventType, eventData) {
    const matchingTriggers = [];
    
    // eslint-disable-next-line no-unused-vars
    for (const [triggerId, trigger] of this.triggerRules) {
      if (!trigger.enabled) continue;
      if (trigger.eventType !== eventType) continue;
      
      if (trigger.maxExecutions && trigger.executionCount >= trigger.maxExecutions) {
        continue;
      }
      
      if (trigger.cooldown > 0 && trigger.lastTriggeredAt) {
        const elapsed = Date.now() - trigger.lastTriggeredAt;
        if (elapsed < trigger.cooldown) {
          continue;
        }
      }
      
      const conditionsMet = await this.evaluateConditions(trigger.conditions, eventData);
      
      if (conditionsMet) {
        matchingTriggers.push(trigger);
      }
    }
    
    matchingTriggers.sort((a, b) => b.priority - a.priority);
    
    for (const trigger of matchingTriggers) {
      await this.executeTrigger(trigger, eventData);
    }
    
    return matchingTriggers.length;
  }
  
  async evaluateConditions(conditions, eventData) {
    if (!conditions || conditions.length === 0) {
      return true;
    }
    
    for (const condition of conditions) {
      const result = await this.evaluateCondition(condition, eventData);
      if (!result) {
        return false;
      }
    }
    
    return true;
  }
  
  async evaluateCondition(condition, eventData) {
    const { field, operator, value } = condition;
    
    const fieldValue = this.getNestedValue(eventData, field);
    
    switch (operator) {
      case TRIGGER_CONDITIONS.EQUALS:
        return fieldValue === value;
      
      case TRIGGER_CONDITIONS.NOT_EQUALS:
        return fieldValue !== value;
      
      case TRIGGER_CONDITIONS.CONTAINS:
        return String(fieldValue).includes(value);
      
      case TRIGGER_CONDITIONS.NOT_CONTAINS:
        return !String(fieldValue).includes(value);
      
      case TRIGGER_CONDITIONS.GREATER_THAN:
        return Number(fieldValue) > Number(value);
      
      case TRIGGER_CONDITIONS.LESS_THAN:
        return Number(fieldValue) < Number(value);
      
      case TRIGGER_CONDITIONS.REGEX:
        try {
          const regex = new RegExp(value);
          return regex.test(String(fieldValue));
        } catch (e) {
          return false;
        }
      
      case TRIGGER_CONDITIONS.EXISTS:
        return fieldValue !== undefined && fieldValue !== null;
      
      case TRIGGER_CONDITIONS.NOT_EXISTS:
        return fieldValue === undefined || fieldValue === null;
      
      default:
        return false;
    }
  }
  
  getNestedValue(obj, path) {
    if (!path) return obj;
    
    const keys = path.split('.');
    let current = obj;
    
    for (const key of keys) {
      if (current === undefined || current === null) {
        return undefined;
      }
      current = current[key];
    }
    
    return current;
  }
  
  async executeTrigger(trigger, eventData) {
    trigger.executionCount++;
    trigger.lastTriggeredAt = Date.now();
    
    console.log(`🎯 执行触发器: ${trigger.name} -> 任务 ${trigger.targetTaskId}`);
    
    this.emit('trigger_executed', {
      triggerId: trigger.id,
      triggerName: trigger.name,
      targetTaskId: trigger.targetTaskId,
      eventData,
      executedAt: trigger.lastTriggeredAt
    });
    
    return {
      success: true,
      triggerId: trigger.id,
      targetTaskId: trigger.targetTaskId,
      targetTaskConfig: trigger.targetTaskConfig
    };
  }
  
  emitEvent(eventType, eventData) {
    this.emit(eventType, eventData);
    this.recordEvent(eventType, eventData);
    
    if (!Object.values(EVENT_TYPES).includes(eventType)) {
      this.checkTriggers(eventType, eventData);
    }
  }
  
  recordEvent(eventType, data) {
    this.eventHistory.push({
      type: eventType,
      data,
      timestamp: Date.now()
    });
    
    if (this.eventHistory.length > this.maxHistorySize) {
      this.eventHistory = this.eventHistory.slice(-this.maxHistorySize);
    }
  }
  
  getEventHistory(limit = 100, eventType = null) {
    let history = this.eventHistory;
    
    if (eventType) {
      history = history.filter(e => e.type === eventType);
    }
    
    return history.slice(-limit);
  }
  
  getTrigger(triggerId) {
    return this.triggerRules.get(triggerId);
  }
  
  listTriggers(options = {}) {
    const { eventType, enabled, targetTaskId } = options;
    
    let triggers = Array.from(this.triggerRules.values());
    
    if (eventType) {
      triggers = triggers.filter(t => t.eventType === eventType);
    }
    
    if (enabled !== undefined) {
      triggers = triggers.filter(t => t.enabled === enabled);
    }
    
    if (targetTaskId) {
      triggers = triggers.filter(t => t.targetTaskId === targetTaskId);
    }
    
    return triggers.sort((a, b) => b.priority - a.priority);
  }
  
  getStatistics() {
    const stats = {
      totalTriggers: this.triggerRules.size,
      enabledTriggers: 0,
      disabledTriggers: 0,
      totalExecutions: 0,
      byEventType: {}
    };
    
    for (const trigger of this.triggerRules.values()) {
      if (trigger.enabled) {
        stats.enabledTriggers++;
      } else {
        stats.disabledTriggers++;
      }
      
      stats.totalExecutions += trigger.executionCount;
      
      stats.byEventType[trigger.eventType] = 
        (stats.byEventType[trigger.eventType] || 0) + 1;
    }
    
    return stats;
  }
  
  clearEventHistory() {
    this.eventHistory = [];
  }
  
  resetTriggerStats(triggerId) {
    const trigger = this.triggerRules.get(triggerId);
    if (trigger) {
      trigger.executionCount = 0;
      trigger.lastTriggeredAt = null;
      return { success: true };
    }
    return { success: false, error: '触发器不存在' };
  }
}

let instance = null;

function getTaskEventTrigger() {
  if (!instance) {
    instance = new TaskEventTrigger();
  }
  return instance;
}

module.exports = {
  TaskEventTrigger,
  getTaskEventTrigger,
  EVENT_TYPES,
  TRIGGER_CONDITIONS
};
