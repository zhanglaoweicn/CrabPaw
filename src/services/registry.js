/**
 * Service Registry
 * 
 * 服务注册中心，管理所有服务的生命周期
 * 借鉴 Claude Code 的服务管理模式
 */

const { EventEmitter } = require('events');

class ServiceRegistry extends EventEmitter {
  constructor() {
    super();
    this.services = new Map();
    this.initialized = false;
    this.shuttingDown = false;
  }

  register(name, service, options = {}) {
    if (this.services.has(name)) {
      throw new Error(`Service ${name} already registered`);
    }
    this.services.set(name, {
      instance: service,
      status: 'registered',
      initialized: false,
      // 2026-08-25 Cordis Stage1：来源标记（插件反注册完备性）。无 source 的
      // 核心服务不受 unregisterBySource 影响。
      source: options.source || null,
    });
    this.emit('service:registered', { name });
  }

  /**
   * 按来源批量注销（插件禁用时原子回滚其 services 贡献）。
   * Cordis 纪律：只删自己来源注册的服务，绝不碰其他来源（含内置 core）。
   */
  unregisterBySource(source) {
    if (!source) return 0;
    let count = 0;
    for (const [name, entry] of this.services) {
      if (entry.source === source) {
        this.services.delete(name);
        count++;
        this.emit('service:unregistered', { name, source });
      }
    }
    return count;
  }

  get(name) {
    const entry = this.services.get(name);
    if (!entry) {
      return null;
    }
    return entry.instance;
  }

  async initializeAll() {
    if (this.initialized) {
      return;
    }

    const initPromises = [];
    for (const [name, entry] of this.services) {
      if (entry.instance.initialize && !entry.initialized) {
        initPromises.push(
          this.initializeService(name, entry)
        );
      }
    }

    await Promise.all(initPromises);
    this.initialized = true;
    this.emit('registry:initialized');
  }

  async initializeService(name, entry) {
    try {
      entry.status = 'initializing';
      this.emit('service:initializing', { name });
      
      await entry.instance.initialize();
      
      entry.status = 'ready';
      entry.initialized = true;
      this.emit('service:ready', { name });
    } catch (error) {
      entry.status = 'error';
      this.emit('service:error', { name, error });
      throw error;
    }
  }

  async shutdownAll() {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;

    const shutdownPromises = [];
    for (const [name, entry] of this.services) {
      if (entry.instance.shutdown && entry.initialized) {
        shutdownPromises.push(
          this.shutdownService(name, entry)
        );
      }
    }

    await Promise.all(shutdownPromises);
    this.initialized = false;
    this.shuttingDown = false;
    this.emit('registry:shutdown');
  }

  async shutdownService(name, entry) {
    try {
      entry.status = 'shutting_down';
      this.emit('service:shutting_down', { name });
      
      await entry.instance.shutdown();
      
      entry.status = 'shutdown';
      entry.initialized = false;
      this.emit('service:shutdown', { name });
    } catch (error) {
      this.emit('service:error', { name, error });
      throw error;
    }
  }

  getStatus() {
    const status = {};
    for (const [name, entry] of this.services) {
      status[name] = {
        status: entry.status,
        initialized: entry.initialized,
      };
    }
    return status;
  }

  isReady(name) {
    const entry = this.services.get(name);
    return entry && entry.status === 'ready';
  }
}

const serviceRegistry = new ServiceRegistry();

module.exports = {
  ServiceRegistry,
  serviceRegistry,
};
