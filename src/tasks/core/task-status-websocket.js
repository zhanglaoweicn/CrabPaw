const crypto = require('crypto');
const WebSocket = require('ws');
const { EventEmitter } = require('events');
const { verifyApiToken } = require('../../core/http-middleware');

class TaskStatusWebSocket extends EventEmitter {
  constructor(server, options = {}) {
    super();
    const { apiKey = '', ...wsOptions } = options;

    this.server = server;
    this.wss = new WebSocket.Server({
      noServer: true,
      ...wsOptions,
    });

    this._upgradeHandler = (req, socket, head) => {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname !== '/ws/tasks') return;
      if (!verifyApiToken(req, apiKey)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    };
    server.on('upgrade', this._upgradeHandler);
    
    this.clients = new Map();
    this.taskSubscriptions = new Map();
    
    // 心跳检测配置
    this._heartbeatInterval = options.heartbeatInterval || 30000; // 30 秒
    this._heartbeatTimeout = options.heartbeatTimeout || 10000;   // 10 秒无响应视为断开
    this._heartbeatTimer = null;
    
    this.setupWebSocket();
    this._startHeartbeat();
    console.log('🔌 任务状态 WebSocket 服务已启动（心跳检测已启用）');
  }
  
  setupWebSocket() {
    this.wss.on('connection', (ws, _req) => {
      const clientId = `client_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 8)}`;
      
      console.log(`📱 WebSocket 客户端连接: ${clientId}`);
      
      const clientInfo = {
        id: clientId,
        ws,
        subscribedTasks: new Set(),
        subscribedAll: false,
        connectedAt: Date.now(),
        isAlive: true,        // 心跳存活标记
        lastPingAt: Date.now(), // 上次心跳时间
      };
      
      this.clients.set(clientId, clientInfo);
      
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(clientId, message);
        } catch (e) {
          console.error('WebSocket 消息解析失败:', e.message);
        }
      });
      
      ws.on('close', () => {
        console.log(`📱 WebSocket 客户端断开: ${clientId}`);
        this.clients.delete(clientId);
        
        // eslint-disable-next-line no-unused-vars -- 数组解构的 taskId 未使用（遍历仅需 subscribers 清理）
        for (const [taskId, subscribers] of this.taskSubscriptions) {
          subscribers.delete(clientId);
        }
      });
      
      ws.on('error', (error) => {
        console.error(`WebSocket 错误 (${clientId}):`, error.message);
      });
      
      ws.send(JSON.stringify({
        type: 'connected',
        clientId,
        timestamp: Date.now()
      }));
    });
  }
  
  handleMessage(clientId, message) {
    const client = this.clients.get(clientId);
    if (!client) return;
    
    switch (message.type) {
      case 'subscribe':
        this.subscribeToTask(clientId, message.taskId);
        break;
      
      case 'unsubscribe':
        this.unsubscribeFromTask(clientId, message.taskId);
        break;
      
      case 'subscribe_all':
        client.subscribedAll = true;
        this.sendToClient(clientId, {
          type: 'subscribed_all',
          timestamp: Date.now()
        });
        break;
      
      case 'unsubscribe_all':
        client.subscribedAll = false;
        this.sendToClient(clientId, {
          type: 'unsubscribed_all',
          timestamp: Date.now()
        });
        break;
      
      case 'ping':
        // 客户端主动 ping，标记存活并回复 pong
        client.isAlive = true;
        client.lastPingAt = Date.now();
        this.sendToClient(clientId, {
          type: 'pong',
          timestamp: Date.now()
        });
        break;
      
      case 'pong':
        // 服务端心跳 pong 响应，标记存活
        client.isAlive = true;
        client.lastPingAt = Date.now();
        break;
      
      default:
        console.warn(`未知的 WebSocket 消息类型: ${message.type}`);
    }
  }
  
  subscribeToTask(clientId, taskId) {
    const client = this.clients.get(clientId);
    if (!client) return;
    
    client.subscribedTasks.add(taskId);
    
    if (!this.taskSubscriptions.has(taskId)) {
      this.taskSubscriptions.set(taskId, new Set());
    }
    this.taskSubscriptions.get(taskId).add(clientId);
    
    this.sendToClient(clientId, {
      type: 'subscribed',
      taskId,
      timestamp: Date.now()
    });
    
    console.log(`📥 客户端 ${clientId} 订阅任务: ${taskId}`);
  }
  
  unsubscribeFromTask(clientId, taskId) {
    const client = this.clients.get(clientId);
    if (!client) return;
    
    client.subscribedTasks.delete(taskId);
    
    const subscribers = this.taskSubscriptions.get(taskId);
    if (subscribers) {
      subscribers.delete(clientId);
    }
    
    this.sendToClient(clientId, {
      type: 'unsubscribed',
      taskId,
      timestamp: Date.now()
    });
  }
  
  broadcastTaskStatus(taskId, status, data = {}) {
    const message = {
      type: 'task_status',
      taskId,
      status,
      timestamp: Date.now(),
      ...data
    };
    
    const subscribers = this.taskSubscriptions.get(taskId);
    if (subscribers) {
      for (const clientId of subscribers) {
        this.sendToClient(clientId, message);
      }
    }
    
    for (const [clientId, client] of this.clients) {
      if (client.subscribedAll) {
        this.sendToClient(clientId, message);
      }
    }
    
    this.emit('status_broadcast', { taskId, status, data });
  }
  
  broadcastTaskProgress(taskId, progress, data = {}) {
    const message = {
      type: 'task_progress',
      taskId,
      progress,
      timestamp: Date.now(),
      ...data
    };
    
    const subscribers = this.taskSubscriptions.get(taskId);
    if (subscribers) {
      for (const clientId of subscribers) {
        this.sendToClient(clientId, message);
      }
    }
    
    for (const [clientId, client] of this.clients) {
      if (client.subscribedAll) {
        this.sendToClient(clientId, message);
      }
    }
  }
  
  broadcastTaskError(taskId, error, data = {}) {
    const message = {
      type: 'task_error',
      taskId,
      error: this.sanitizeError(error),
      timestamp: Date.now(),
      ...data
    };
    
    const subscribers = this.taskSubscriptions.get(taskId);
    if (subscribers) {
      for (const clientId of subscribers) {
        this.sendToClient(clientId, message);
      }
    }
    
    for (const [clientId, client] of this.clients) {
      if (client.subscribedAll) {
        this.sendToClient(clientId, message);
      }
    }
    
    this.emit('error_broadcast', { taskId, error, data });
  }
  
  broadcastTaskResult(taskId, result, data = {}) {
    const message = {
      type: 'task_result',
      taskId,
      result: this.sanitizeResult(result),
      timestamp: Date.now(),
      ...data
    };
    
    const subscribers = this.taskSubscriptions.get(taskId);
    if (subscribers) {
      for (const clientId of subscribers) {
        this.sendToClient(clientId, message);
      }
    }
    
    for (const [clientId, client] of this.clients) {
      if (client.subscribedAll) {
        this.sendToClient(clientId, message);
      }
    }
  }
  
  sendToClient(clientId, message) {
    const client = this.clients.get(clientId);
    if (!client || client.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    
    try {
      client.ws.send(JSON.stringify(message));
      return true;
    } catch (e) {
      console.error(`发送消息到客户端 ${clientId} 失败:`, e.message);
      return false;
    }
  }
  
  broadcast(message) {
    const data = JSON.stringify(message);
    
    for (const [clientId, client] of this.clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        try {
          client.ws.send(data);
        } catch (e) {
          console.error(`广播消息到客户端 ${clientId} 失败:`, e.message);
        }
      }
    }
  }
  
  sanitizeError(error) {
    if (!error) return null;
    
    if (typeof error === 'string') {
      return {
        message: error,
        code: 'UNKNOWN'
      };
    }
    
    if (error instanceof Error) {
      return {
        message: error.message,
        code: error.code || 'ERROR',
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      };
    }
    
    return {
      message: String(error),
      code: 'UNKNOWN'
    };
  }
  
  sanitizeResult(result) {
    if (!result) return null;
    
    if (typeof result === 'string') {
      return { message: result };
    }
    
    if (typeof result === 'object') {
      const sanitized = { ...result };
      
      const sensitiveKeys = ['password', 'token', 'secret', 'apiKey', 'apiSecret', 'credential'];
      for (const key of Object.keys(sanitized)) {
        if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk))) {
          sanitized[key] = '***REDACTED***';
        }
      }
      
      return sanitized;
    }
    
    return result;
  }
  
  getStats() {
    return {
      totalClients: this.clients.size,
      totalSubscriptions: this.taskSubscriptions.size,
      clients: Array.from(this.clients.values()).map(c => ({
        id: c.id,
        subscribedTasks: c.subscribedTasks.size,
        subscribedAll: c.subscribedAll,
        connectedAt: c.connectedAt
      }))
    };
  }
  
  /**
   * 启动服务端心跳检测
   * 定期向客户端发送 ping，超时未响应的连接将被终止
   */
  _startHeartbeat() {
    this._heartbeatTimer = setInterval(() => {
      const now = Date.now();
      const deadClients = [];

      for (const [clientId, client] of this.clients) {
        if (!client.isAlive) {
          // 上一轮 ping 未收到 pong，视为断开
          deadClients.push(clientId);
          continue;
        }

        // 标记为待确认，发送服务端 ping
        client.isAlive = false;
        try {
          if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify({ type: 'server_ping', timestamp: now }));
          }
        } catch (e) {
          deadClients.push(clientId);
        }
      }

      // 清理死亡连接
      for (const clientId of deadClients) {
        const client = this.clients.get(clientId);
        if (client) {
          console.log(`💔 WebSocket 心跳超时，终止连接: ${clientId}`);
          try {
            client.ws.terminate();
          } catch (e) {

            // ignore

            console.warn('[task-status-websocket.js] 空 catch 补日志:', e && e.message);
          }

          this.clients.delete(clientId);
          // eslint-disable-next-line no-unused-vars -- 数组解构的 taskId 未使用（遍历仅需 subscribers 清理）
          for (const [taskId, subscribers] of this.taskSubscriptions) {
            subscribers.delete(clientId);
          }
        }
      }
    }, this._heartbeatInterval);
  }

  /**
   * 停止心跳检测
   */
  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  close() {
    this._stopHeartbeat();
    if (this.server && this._upgradeHandler) {
      this.server.removeListener('upgrade', this._upgradeHandler);
    }
    if (this.wss) {
      this.wss.close(() => {
        console.log('🔌 任务状态 WebSocket 服务已关闭');
      });
    }
  }
}

let instance = null;

function createTaskStatusWebSocket(server, options) {
  if (!instance) {
    instance = new TaskStatusWebSocket(server, options);
  }
  return instance;
}

function getTaskStatusWebSocket() {
  return instance;
}

module.exports = {
  TaskStatusWebSocket,
  createTaskStatusWebSocket,
  getTaskStatusWebSocket
};
