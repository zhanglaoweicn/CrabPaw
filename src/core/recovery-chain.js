const crypto = require('crypto');
const { EventEmitter } = require('events');
const { classifyApiError, getRecoveryAction, FailoverReason, RetryScheduler } = require('./error-classifier');

const RECOVERY_CHAINS = {
  [FailoverReason.CONTEXT_OVERFLOW]: [
    { step: 'compress_context', description: '压缩上下文' },
    { step: 'strip_thinking', description: '移除thinking块' },
    { step: 'shrink_images', description: '压缩图片' },
    { step: 'fallback_model_larger', description: '切换到更大上下文窗口的模型' },
  ],
  [FailoverReason.RATE_LIMIT]: [
    { step: 'backoff', description: '退避等待' },
    { step: 'rotate_credential', description: '轮换凭据' },
    { step: 'fallback_provider', description: '切换供应商' },
  ],
  [FailoverReason.AUTH]: [
    { step: 'rotate_credential', description: '轮换凭据' },
    { step: 'fallback_provider', description: '切换供应商' },
    { step: 'abort', description: '终止' },
  ],
  [FailoverReason.IMAGE_TOO_LARGE]: [
    { step: 'shrink_image', description: '压缩图片尺寸' },
    { step: 'strip_image', description: '移除图片使用文本描述' },
    { step: 'fallback_model_vision', description: '切换支持大图的模型' },
  ],
  [FailoverReason.THINKING_SIGNATURE]: [
    { step: 'strip_thinking_param', description: '移除thinking参数' },
    { step: 'fallback_model', description: '切换模型' },
  ],
  [FailoverReason.PROVIDER_POLICY_BLOCKED]: [
    { step: 'fallback_provider', description: '切换供应商' },
    { step: 'modify_request', description: '修改请求内容' },
  ],
  [FailoverReason.MULTIMODAL_TOOL_CONTENT]: [
    { step: 'text_only_fallback', description: '纯文本回退' },
    { step: 'strip_tool_images', description: '移除工具结果中的图片' },
  ],
  [FailoverReason.TIMEOUT]: [
    { step: 'retry', description: '重试' },
    { step: 'reduce_payload', description: '减少请求负载' },
    { step: 'fallback_provider', description: '切换供应商' },
  ],
  [FailoverReason.OVERLOADED]: [
    { step: 'backoff', description: '退避等待' },
    { step: 'fallback_provider', description: '切换供应商' },
  ],
  [FailoverReason.SERVER_ERROR]: [
    { step: 'retry', description: '重试' },
    { step: 'backoff', description: '退避等待' },
    { step: 'fallback_provider', description: '切换供应商' },
  ],
};

const STEP_HANDLERS = {
  async compress_context(context) {
    if (context.compressFn) {
      const result = await context.compressFn();
      return { success: !!result, data: result };
    }
    return { success: false, data: null };
  },
  async strip_thinking(context) {
    if (context.messages) {
      let modified = false;
      for (const msg of context.messages) {
        if (typeof msg.content === 'string') {
          const stripped = msg.content.replace(/<REASONING_SCRATCHPAD>[\s\S]*?<\/REASONING_SCRATCHPAD>/g, '')
            .replace(/<reasoning>[\s\S]*?<\/reasoning>/g, '');
          if (stripped !== msg.content) {
            msg.content = stripped;
            modified = true;
          }
        }
      }
      return { success: modified };
    }
    return { success: false };
  },
  async shrink_images(context) {
    if (context.shrinkImagesFn) {
      const result = await context.shrinkImagesFn();
      return { success: !!result, data: result };
    }
    return { success: false };
  },
  async fallback_model_larger(context) {
    if (context.getLargerModel) {
      const model = context.getLargerModel();
      return { success: !!model, data: { model } };
    }
    return { success: false };
  },
  async backoff(context) {
    const delay = context.backoffDelay || 2000;
    await new Promise(r => setTimeout(r, delay));
    return { success: true };
  },
  async rotate_credential(context) {
    if (context.rotateCredentialFn) {
      const result = await context.rotateCredentialFn();
      return { success: !!result, data: result };
    }
    return { success: false };
  },
  async fallback_provider(context) {
    if (context.fallbackProviderFn) {
      const provider = await context.fallbackProviderFn();
      return { success: !!provider, data: { provider } };
    }
    return { success: false };
  },
  async fallback_model(context) {
    if (context.fallbackModelFn) {
      const model = await context.fallbackModelFn();
      return { success: !!model, data: { model } };
    }
    return { success: false };
  },
  async shrink_image(context) {
    if (context.shrinkImageFn) {
      const result = await context.shrinkImageFn();
      return { success: !!result, data: result };
    }
    return { success: false };
  },
  async strip_image(context) {
    if (context.messages) {
      let stripped = 0;
      for (const msg of context.messages) {
        if (Array.isArray(msg.content)) {
          msg.content = msg.content.filter(part => part.type !== 'image');
          stripped++;
        }
      }
      return { success: stripped > 0, data: { stripped } };
    }
    return { success: false };
  },
  async fallback_model_vision(context) {
    return STEP_HANDLERS.fallback_model(context);
  },
  async strip_thinking_param(context) {
    if (context.requestParams) {
      delete context.requestParams.thinking;
      delete context.requestParams.thinking_budget;
      return { success: true };
    }
    return { success: false };
  },
  async modify_request(_context) {
    return { success: false };
  },
  async text_only_fallback(context) {
    if (context.messages) {
      let converted = 0;
      for (const msg of context.messages) {
        if (Array.isArray(msg.content)) {
          const textParts = msg.content.filter(p => p.type === 'text');
          if (textParts.length > 0) {
            msg.content = textParts.map(p => p.text).join('\n');
            converted++;
          }
        }
      }
      return { success: converted > 0 };
    }
    return { success: false };
  },
  async strip_tool_images(context) {
    return STEP_HANDLERS.strip_image(context);
  },
  async retry(_context) {
    return { success: true };
  },
  async reduce_payload(context) {
    if (context.messages && context.messages.length > 4) {
      const keep = Math.ceil(context.messages.length * 0.7);
      context.messages.splice(1, context.messages.length - keep);
      return { success: true };
    }
    return { success: false };
  },
  async abort(_context) {
    return { success: false, abort: true };
  },
};

class RecoveryChainOrchestrator extends EventEmitter {
  constructor(config = {}) {
    super();
    this._scheduler = config.scheduler || new RetryScheduler(config);
    this._maxStepsPerChain = config.maxStepsPerChain || 4;
    this._history = [];
    this._maxHistory = config.maxHistory || 200;
  }

  async executeRecoveryChain(error, context = {}) {
    const classified = classifyApiError(error);
    const recoveryAction = getRecoveryAction(classified);
    const chain = RECOVERY_CHAINS[classified.reason] || [
      { step: recoveryAction.action, description: recoveryAction.description },
    ];

    const executionId = `rc_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 6)}`;
    const result = {
      executionId,
      error: error.message || String(error),
      classified,
      recoveryAction,
      steps: [],
      finalStatus: 'pending',
    };

    this.emit('chain_start', { executionId, reason: classified.reason });

    for (let i = 0; i < Math.min(chain.length, this._maxStepsPerChain); i++) {
      const step = chain[i];
      const handler = STEP_HANDLERS[step.step];

      if (!handler) {
        result.steps.push({ step: step.step, description: step.description, status: 'skipped', reason: 'no_handler' });
        continue;
      }

      try {
        const stepResult = await handler(context);

        result.steps.push({
          step: step.step,
          description: step.description,
          status: stepResult.success ? 'success' : 'failed',
          data: stepResult.data || null,
        });

        this.emit('step_complete', { executionId, step: step.step, success: stepResult.success });

        if (stepResult.success) {
          result.finalStatus = 'recovered';
          result.recoveryStep = step.step;
          break;
        }

        if (stepResult.abort) {
          result.finalStatus = 'aborted';
          break;
        }
      } catch (e) {
        result.steps.push({
          step: step.step,
          description: step.description,
          status: 'error',
          error: e.message,
        });
        this.emit('step_error', { executionId, step: step.step, error: e.message });
      }
    }

    if (result.finalStatus === 'pending') {
      result.finalStatus = 'exhausted';
    }

    this._history.push(result);
    if (this._history.length > this._maxHistory) {
      this._history = this._history.slice(-this._maxHistory);
    }

    this.emit('chain_complete', { executionId, status: result.finalStatus });
    return result;
  }

  getHistory(limit = 20) {
    return this._history.slice(-limit);
  }

  getStats() {
    const total = this._history.length;
    const recovered = this._history.filter(h => h.finalStatus === 'recovered').length;
    const byReason = {};
    const byStep = {};
    for (const h of this._history) {
      byReason[h.classified.reason] = (byReason[h.classified.reason] || 0) + 1;
      for (const s of h.steps) {
        if (s.status === 'success') {
          byStep[s.step] = (byStep[s.step] || 0) + 1;
        }
      }
    }
    return {
      total,
      recovered,
      recoveryRate: total > 0 ? (recovered / total).toFixed(3) : '0.000',
      byReason,
      byStep,
    };
  }
}

module.exports = {
  RecoveryChainOrchestrator,
  RECOVERY_CHAINS,
  STEP_HANDLERS,
};
