class BaseScheduleAdapter {
  constructor(options = {}) {
    this.name = options.name || 'base';
    this.enabled = options.enabled !== false;
    this.timeout = options.timeout || 30000;
    this.retryCount = options.retryCount || 3;
    this.retryDelay = options.retryDelay || 1000;
  }

  async create(_event) {
    throw new Error('create 方法必须由子类实现');
  }

  // eslint-disable-next-line no-unused-vars
  async update(_externalId, event) {
    throw new Error('update 方法必须由子类实现');
  }

  async delete(_externalId) {
    throw new Error('delete 方法必须由子类实现');
  }

  async get(_externalId) {
    throw new Error('get 方法必须由子类实现');
  }

  // eslint-disable-next-line no-unused-vars
  async list(options = {}) {
    throw new Error('list 方法必须由子类实现');
  }

  async checkConnection() {
    return { connected: false, reason: 'checkConnection 方法必须由子类实现' };
  }

  async withRetry(operation, operationName) {
    let lastError = null;

    for (let attempt = 1; attempt <= this.retryCount; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        console.warn(`⚠️ ${this.name} ${operationName} 失败 (尝试 ${attempt}/${this.retryCount}):`, error.message);

        if (attempt < this.retryCount) {
          await this.delay(this.retryDelay * attempt);
        }
      }
    }

    return {
      success: false,
      error: lastError?.message || '操作失败'
    };
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  transformToLocal(_externalEvent) {
    throw new Error('transformToLocal 方法必须由子类实现');
  }

  transformToExternal(_localEvent) {
    throw new Error('transformToExternal 方法必须由子类实现');
  }

  isEnabled() {
    return this.enabled;
  }

  enable() {
    this.enabled = true;
  }

  disable() {
    this.enabled = false;
  }
}

module.exports = { BaseScheduleAdapter };
