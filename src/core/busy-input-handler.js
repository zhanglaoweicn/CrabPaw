const BUSY_WINDOW_MS = 5000;
const MAX_QUEUED_INPUTS = 10;

class BusyInputHandler {
  constructor(options = {}) {
    this.busyWindowMs = options.busyWindowMs || BUSY_WINDOW_MS;
    this.maxQueuedInputs = options.maxQueuedInputs || MAX_QUEUED_INPUTS;
    this._processing = false;
    this._lastProcessStart = 0;
    this._queue = [];
    this._onProcessCallback = null;
    this._mergeStrategy = options.mergeStrategy || 'concat';
  }

  setProcessCallback(callback) {
    this._onProcessCallback = callback;
  }

  isBusy() {
    return this._processing;
  }

  async processInput(input, metadata = {}) {
    if (!this._processing) {
      return this._executeProcessing(input, metadata);
    }

    if (this._queue.length >= this.maxQueuedInputs) {
      this._queue.shift();
    }

    this._queue.push({ input, metadata, timestamp: Date.now() });
    return { queued: true, queuePosition: this._queue.length };
  }

  async _executeProcessing(input, metadata) {
    this._processing = true;
    this._lastProcessStart = Date.now();

    try {
      if (this._onProcessCallback) {
        return await this._onProcessCallback(input, metadata);
      }
      return null;
    } finally {
      this._processing = false;
      await this._drainQueue();
    }
  }

  async _drainQueue() {
    if (this._queue.length === 0) return;

    const merged = this._mergeQueue();
    if (!merged) return;

    this._queue = [];
    await this._executeProcessing(merged.input, merged.metadata);
  }

  _mergeQueue() {
    if (this._queue.length === 0) return null;

    if (this._queue.length === 1) {
      return this._queue[0];
    }

    const inputs = this._queue.map(item => item.input);
    const metadata = {
      mergedFrom: this._queue.length,
      timestamps: this._queue.map(item => item.timestamp),
      sources: this._queue.map(item => item.metadata.source || 'unknown'),
    };

    let mergedInput;
    switch (this._mergeStrategy) {
      case 'latest':
        mergedInput = inputs[inputs.length - 1];
        break;
      case 'concat':
        mergedInput = inputs.join('\n\n---\n\n');
        break;
      case 'smart':
        mergedInput = this._smartMerge(inputs);
        break;
      default:
        mergedInput = inputs.join('\n\n');
    }

    return { input: mergedInput, metadata };
  }

  _smartMerge(inputs) {
    if (inputs.length <= 1) return inputs[0] || '';

    const topics = new Map();
    for (const input of inputs) {
      const key = this._extractTopic(input);
      if (!topics.has(key)) {
        topics.set(key, []);
      }
      topics.get(key).push(input);
    }

    const parts = [];
    for (const [topic, items] of topics) {
      if (items.length === 1) {
        parts.push(items[0]);
      } else {
        parts.push(`[关于"${topic}"的多个请求合并]:\n${items.join('\n')}`);
      }
    }

    return parts.join('\n\n');
  }

  _extractTopic(input) {
    if (!input || typeof input !== 'string') return 'general';

    const trimmed = input.trim().slice(0, 100);
    const keywords = [
      '搜索', '查找', '查询', '分析', '创建', '写', '编辑', '修改',
      '删除', '发送', '通知', '日程', '任务', '文档', '表格',
      '股票', '天气', '新闻', '资讯', '报告',
      'search', 'find', 'query', 'analyze', 'create', 'write', 'edit',
      'delete', 'send', 'notify', 'schedule', 'task', 'document',
    ];

    for (const kw of keywords) {
      if (trimmed.includes(kw)) return kw;
    }

    return trimmed.slice(0, 20);
  }

  getQueueStatus() {
    return {
      isBusy: this._processing,
      queueLength: this._queue.length,
      lastProcessStart: this._lastProcessStart,
      oldestQueuedItem: this._queue.length > 0 ? this._queue[0].timestamp : null,
    };
  }

  clearQueue() {
    this._queue = [];
  }
}

const globalBusyInputHandler = new BusyInputHandler();

module.exports = { BusyInputHandler, globalBusyInputHandler };
