/**
 * AI 流式输出模块 - 从 ai.js 提取
 *
 * 包含流式聊天、SSE 事件推送等逻辑
 */

// eslint-disable-next-line no-unused-vars
const { sseBroadcastEvent } = require('../sse-broadcast');

/**
 * 流式聊天状态管理
 */
class StreamStateManager {
  constructor() {
    this._activeStreams = new Map();
  }

  startStream(streamId, metadata = {}) {
    this._activeStreams.set(streamId, {
      id: streamId,
      startedAt: Date.now(),
      ...metadata,
    });
  }

  endStream(streamId) {
    const stream = this._activeStreams.get(streamId);
    if (stream) {
      stream.endedAt = Date.now();
      stream.duration = stream.endedAt - stream.startedAt;
      this._activeStreams.delete(streamId);
    }
    return stream;
  }

  getActiveStream(streamId) {
    return this._activeStreams.get(streamId);
  }

  getActiveStreamCount() {
    return this._activeStreams.size;
  }

  isStreamActive(streamId) {
    return this._activeStreams.has(streamId);
  }
}

const globalStreamStateManager = new StreamStateManager();

/**
 * 格式化 SSE 数据块
 */
function formatSSEChunk(data, event = 'message') {
  if (typeof data !== 'string') {
    data = JSON.stringify(data);
  }
  return `event: ${event}\ndata: ${data}\n\n`;
}

/**
 * 创建流式响应写入器
 */
function createStreamWriter(res, options = {}) {
  const { heartbeatInterval = 15000 } = options;
  let heartbeatTimer = null;

  return {
    start() {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();

      if (heartbeatInterval > 0) {
        heartbeatTimer = setInterval(() => {
          if (!res.writableEnded) {
            res.write(':heartbeat\n\n');
          }
        }, heartbeatInterval);
        heartbeatTimer.unref();
      }
    },

    write(data, event = 'message') {
      if (!res.writableEnded) {
        res.write(formatSSEChunk(data, event));
      }
    },

    writeDelta(delta, metadata = {}) {
      this.write({
        choices: [{
          delta: { content: delta },
          ...metadata,
        }],
      }, 'delta');
    },

    end(data) {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (data) {
        this.write(data, 'done');
      }
      if (!res.writableEnded) {
        res.write('event: done\ndata: [DONE]\n\n');
        res.end();
      }
    },

    error(err) {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      this.write({ error: err.message || 'Stream error' }, 'error');
      if (!res.writableEnded) {
        res.end();
      }
    },
  };
}

module.exports = {
  StreamStateManager,
  globalStreamStateManager,
  formatSSEChunk,
  createStreamWriter,
};
