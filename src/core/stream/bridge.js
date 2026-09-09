/**
 * StreamBridge - SSE 流桥接
 * 
 * 基于 Deer-Flow 的流桥接设计，提供:
 * 1. 生产者/消费者解耦
 * 2. SSE 事件流
 * 3. 心跳机制
 * 4. 重连支持
 * 5. 延迟清理
 */

const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');

const STREAM_EVENTS = {
  METADATA: 'metadata',
  UPDATES: 'updates',
  EVENTS: 'events',
  ERROR: 'error',
  END: 'end',
  HEARTBEAT: '__heartbeat__'
};

class StreamEvent {
  constructor(id, event, data) {
    this.id = id;
    this.event = event;
    this.data = data;
  }

  toSSE() {
    const lines = [];
    
    if (this.id) {
      lines.push(`id: ${this.id}`);
    }
    
    if (this.event) {
      lines.push(`event: ${this.event}`);
    }
    
    if (this.data !== undefined && this.data !== null) {
      const dataStr = typeof this.data === 'string' 
        ? this.data 
        : JSON.stringify(this.data);
      
      for (const line of dataStr.split('\n')) {
        lines.push(`data: ${line}`);
      }
    }
    
    lines.push('', '');
    
    return lines.join('\n');
  }
}

const HEARTBEAT_SENTINEL = new StreamEvent('', STREAM_EVENTS.HEARTBEAT, null);
const END_SENTINEL = new StreamEvent('', STREAM_EVENTS.END, null);

class StreamBuffer {
  constructor(maxSize = 1000) {
    this._events = [];
    this._maxSize = maxSize;
    this._eventIndex = new Map();
    this._nextId = 1;
  }

  append(event, data) {
    const id = (this._nextId++).toString();
    const streamEvent = new StreamEvent(id, event, data);
    
    this._events.push(streamEvent);
    this._eventIndex.set(id, streamEvent);
    
    if (this._events.length > this._maxSize) {
      const removed = this._events.shift();
      this._eventIndex.delete(removed.id);
    }
    
    return streamEvent;
  }

  getSince(lastEventId) {
    if (!lastEventId) {
      return [...this._events];
    }
    
    const index = this._events.findIndex(e => e.id === lastEventId);
    if (index === -1) {
      return [...this._events];
    }
    
    return this._events.slice(index + 1);
  }

  get(id) {
    return this._eventIndex.get(id);
  }

  clear() {
    this._events = [];
    this._eventIndex.clear();
    this._nextId = 1;
  }

  get size() {
    return this._events.length;
  }
}

class StreamBridge extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.heartbeatInterval = config.heartbeatInterval || 15000;
    this.cleanupDelay = config.cleanupDelay || 30000;
    this.maxBufferSize = config.maxBufferSize || 1000;
    
    this._streams = new Map();
    this._buffers = new Map();
    this._heartbeatTimers = new Map();
    this._cleanupTimers = new Map();
  }

  async publish(runId, event, data) {
    let buffer = this._buffers.get(runId);
    if (!buffer) {
      buffer = new StreamBuffer(this.maxBufferSize);
      this._buffers.set(runId, buffer);
    }
    
    const streamEvent = buffer.append(event, data);
    
    const stream = this._streams.get(runId);
    if (stream) {
      stream.push(streamEvent);
      this.emit('event', runId, streamEvent);
    }
    
    return streamEvent;
  }

  async publishEnd(runId) {
    const buffer = this._buffers.get(runId);
    if (buffer) {
      buffer.append(STREAM_EVENTS.END, null);
    }
    
    const stream = this._streams.get(runId);
    if (stream) {
      stream.push(END_SENTINEL);
      stream.push(null);
    }
    
    this.emit('end', runId);
  }

  subscribe(runId, options = {}) {
    const { lastEventId, heartbeatInterval } = options;
    
    let buffer = this._buffers.get(runId);
    if (!buffer) {
      buffer = new StreamBuffer(this.maxBufferSize);
      this._buffers.set(runId, buffer);
    }
    
    const stream = {
      id: uuidv4(),
      runId,
      queue: [],
      closed: false,
      createdAt: Date.now()
    };
    
    this._streams.set(runId, stream);
    
    const missedEvents = buffer.getSince(lastEventId);
    for (const event of missedEvents) {
      stream.queue.push(event);
    }
    
    this._startHeartbeat(runId, heartbeatInterval || this.heartbeatInterval);
    
    this.emit('subscribe', runId, stream);
    
    return this._createAsyncIterator(stream, runId);
  }

  async *_createAsyncIterator(stream, runId) {
    try {
      while (!stream.closed) {
        while (stream.queue.length > 0) {
          const event = stream.queue.shift();
          
          if (event === END_SENTINEL || event === null) {
            return;
          }
          
          yield event;
        }
        
        await new Promise(resolve => {
          const check = () => {
            if (stream.queue.length > 0 || stream.closed) {
              resolve();
            } else {
              setTimeout(check, 10);
            }
          };
          check();
        });
      }
    } finally {
      this._cleanupStream(runId);
    }
  }

  _startHeartbeat(runId, interval) {
    if (this._heartbeatTimers.has(runId)) {
      clearInterval(this._heartbeatTimers.get(runId));
    }
    
    const timer = setInterval(() => {
      const stream = this._streams.get(runId);
      if (stream && !stream.closed) {
        stream.queue.push(HEARTBEAT_SENTINEL);
      } else {
        clearInterval(timer);
        this._heartbeatTimers.delete(runId);
      }
    }, interval);
    
    this._heartbeatTimers.set(runId, timer);
  }

  _cleanupStream(runId) {
    const stream = this._streams.get(runId);
    if (stream) {
      stream.closed = true;
      this._streams.delete(runId);
    }
    
    const heartbeatTimer = this._heartbeatTimers.get(runId);
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      this._heartbeatTimers.delete(runId);
    }
    
    this.emit('unsubscribe', runId);
  }

  async cleanup(runId, delay = 0) {
    if (delay > 0) {
      if (this._cleanupTimers.has(runId)) {
        clearTimeout(this._cleanupTimers.get(runId));
      }
      
      const timer = setTimeout(() => {
        this._doCleanup(runId);
        this._cleanupTimers.delete(runId);
      }, delay);
      
      this._cleanupTimers.set(runId, timer);
    } else {
      this._doCleanup(runId);
    }
  }

  _doCleanup(runId) {
    this._cleanupStream(runId);
    
    this._buffers.delete(runId);
    
    this.emit('cleanup', runId);
  }

  async close() {
    for (const timer of this._heartbeatTimers.values()) {
      clearInterval(timer);
    }
    this._heartbeatTimers.clear();
    
    for (const timer of this._cleanupTimers.values()) {
      clearTimeout(timer);
    }
    this._cleanupTimers.clear();
    
    for (const stream of this._streams.values()) {
      stream.closed = true;
      stream.queue.push(null);
    }
    this._streams.clear();
    
    this.emit('close');
  }

  getStats() {
    return {
      activeStreams: this._streams.size,
      buffers: this._buffers.size,
      totalEvents: Array.from(this._buffers.values())
        .reduce((sum, b) => sum + b.size, 0)
    };
  }

  getBufferStats(runId) {
    const buffer = this._buffers.get(runId);
    return buffer ? { size: buffer.size } : null;
  }
}

function createSSEHandler(streamBridge) {
  return async (req, res) => {
    const runId = req.params.runId || req.query.runId;
    const lastEventId = req.headers['last-event-id'] || req.query.lastEventId;
    
    if (!runId) {
      res.status(400).json({ error: 'runId is required' });
      return;
    }
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    
    res.flushHeaders?.();
    
    try {
      const eventStream = streamBridge.subscribe(runId, { lastEventId });
      
      for await (const event of eventStream) {
        if (event.event === STREAM_EVENTS.HEARTBEAT) {
          res.write(': heartbeat\n\n');
        } else {
          res.write(event.toSSE());
        }
        
        if (res.flush) {
          res.flush();
        }
      }
    } catch (error) {
      console.error('[StreamBridge] SSE error:', error.message);
    } finally {
      res.end();
    }
  };
}

module.exports = {
  StreamBridge,
  StreamEvent,
  StreamBuffer,
  HEARTBEAT_SENTINEL,
  END_SENTINEL,
  STREAM_EVENTS,
  createSSEHandler
};
