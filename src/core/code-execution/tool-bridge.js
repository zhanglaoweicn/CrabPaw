/**
 * 工具调用桥接
 *
 * 生成 crabpaw_tools.js 模块存根，供脚本 `require('crabpaw_tools')` 使用- ? * 桥接层负责：
 * - 生成包含 RPC 函数的模块存- ? * - 将脚本中的工具调用通过 IPC 转发到主进程
 * - 主进程通过标准工具分发器执- ? * - 结果通过 IPC 返回脚本
 *
 * 可用工具：search, read_file, write_file, search_files, terminal（仅前台模式- ? */

const fs = require('fs');
const path = require('path');
const os = require('os');

// 沙箱中可用的工具列表
const SANDBOX_TOOLS = {
  search: {
    description: '搜索代码',
    inputSchema: { query: 'string', limit: 'number' },
  },
  read_file: {
    description: '读取文件内容',
    inputSchema: { file_path: 'string', limit: 'number', offset: 'number' },
  },
  write_file: {
    description: '写入文件',
    inputSchema: { file_path: 'string', content: 'string' },
  },
  search_files: {
    description: '按模式搜索文件',
    inputSchema: { pattern: 'string', path: 'string', file_glob: 'string', limit: 'number' },
  },
  terminal: {
    description: '执行终端命令（仅前台模式）',
    inputSchema: { command: 'string', timeout: 'number', cwd: 'string' },
    restrictions: ['不支持 background/pty/check_interval 参数'],
  },
  web_search: {
    description: '搜索网络',
    inputSchema: { query: 'string', limit: 'number' },
  },
  web_extract: {
    description: '提取网页内容',
    inputSchema: { urls: 'array' },
  },
};

/**
 * 生成 crabpaw_tools.js 模块存根
 *
 * @param {object} config
 * @param {number} config.port IPC 服务器端- ? * @param {string} config.host IPC 服务器主- ? * @param {string[]} config.tools 允许的工具列- ? * @param {number} config.timeout 单次工具调用超时（毫秒）
 * @returns {{ modulePath: string, cleanup: Function }}
 */
function generateToolStub(config = {}) {
  const port = config.port;
  const host = config.host || '127.0.0.1';
  const tools = config.tools || Object.keys(SANDBOX_TOOLS);
  const timeout = config.timeout || 30000;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crabpaw-tools-'));
  const modulePath = path.join(tmpDir, 'crabpaw_tools.js');

  // 生成每个工具的函数定义
  const toolFunctions = tools.map(toolName => {
    const toolInfo = SANDBOX_TOOLS[toolName];
    if (!toolInfo) return '';

    const params = toolInfo.inputSchema
      ? Object.entries(toolInfo.inputSchema).map(([k, _v]) => `${k} = undefined`).join(', ')
      : '';

    const inputObj = toolInfo.inputSchema
      ? '{ ' + Object.keys(toolInfo.inputSchema).map(k => `"${k}": ${k}`).join(', ') + ' }'
      : '{}';

    const restrictions = toolInfo.restrictions
      ? `\n  // 限制: ${toolInfo.restrictions.join(', ')}`
      : '';

    return `
/**
 * ${toolInfo.description}${restrictions}
 */
async function ${toolName}(${params}) {
  return _callTool("${toolName}", ${inputObj});
}`;
  }).join('\n');

  const stubCode = `/**
 * CrabPaw 工具桥接模块（自动生成）
 *
 * 此模块在 execute_code 沙箱中运行，通过 IPC 调用主进程的工具- ? * 只有 print() 输出会返回给 LLM，中间工具结果不进入上下文窗口- ? *
 * 可用工具: ${tools.join(', ')}
 */

const net = require('net');

let _socket = null;
let _requestId = 0;
let _pendingRequests = new Map();
let _buffer = '';
let _connected = false;

async function _connect() {
  return new Promise((resolve, reject) => {
    _socket = net.createConnection({ host: '${host}', port: ${port} }, () => {
      _connected = true;
      resolve();
    });

    _socket.on('data', (data) => {
      _buffer += data.toString();
      const lines = _buffer.split('\\n');
      _buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          _handleResponse(msg);
        } catch { console.warn('[tool-bridge] silent catch, error swallowed'); }
      }
    });

    _socket.on('error', (err) => {
      if (!_connected) reject(err);
    });

    _socket.on('close', () => { _connected = false; });
  });
}

function _handleResponse(msg) {
  const pending = _pendingRequests.get(msg.id);
  if (!pending) return;
  _pendingRequests.delete(msg.id);
  clearTimeout(pending.timer);
  if (msg.error) {
    pending.reject(new Error(msg.error.message || 'RPC error'));
  } else {
    pending.resolve(msg.result);
  }
}

async function _callTool(toolName, input = {}) {
  if (!_connected) throw new Error('IPC 未连接?);

  const id = ++_requestId;
  const request = {
    jsonrpc: '2.0',
    id,
    method: 'tool_call',
    params: { tool: toolName, input }
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _pendingRequests.delete(id);
      reject(new Error('工具调用超时: ' + toolName + ' (${timeout}ms)'));
    }, ${timeout});

    _pendingRequests.set(id, { resolve, reject, timer });
    _socket.write(JSON.stringify(request) + '\\n');
  });
}

async function _disconnect() {
  if (_socket) {
    _socket.destroy();
    _socket = null;
    _connected = false;
  }
}

// ─── 工具函数 ────────────────────────────────────────────
${toolFunctions}

// ─── 模块导出 ────────────────────────────────────────────
const _ready = _connect().catch(err => {
  process.stderr.write('[crabpaw_tools] 连接失败: ' + err.message + '\\n');
  process.exit(1);
});

// 脚本执行完毕后自动断开连接，让进程自然退出?process.on('beforeExit', () => {
  if (_socket) {
    try { _socket.destroy(); } catch { console.warn('[tool-bridge] silent catch, error swallowed'); }
    _socket = null;
    _connected = false;
  }
});

module.exports = {
  _connect,
  _disconnect,
  _ready,
${tools.map(t => `  ${t},`).join('\n')}
};
`;

  fs.writeFileSync(modulePath, stubCode, 'utf8');

  const cleanup = () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { console.warn('[tool-bridge] silent catch, error swallowed'); }
  };

  return { modulePath, tmpDir, cleanup };
}

/**
 * 创建工具分发器函- ? *
 * @param {DeferredToolRegistry} toolRegistry 工具注册- ? * @returns {Function} (toolName, input) => result
 */
function createToolDispatcher(toolRegistry) {
  return async function dispatch(toolName, input) {
    // 映射沙箱工具名到实际工具
    const toolNameMap = {
      'search': 'search',
      'read_file': 'read_file',
      'write_file': 'write_file',
      'search_files': 'search_files',
      'terminal': 'run_command',
      'web_search': 'web_search',
      'web_extract': 'web_extract',
    };

    const actualName = toolNameMap[toolName] || toolName;
    const tool = toolRegistry.get(actualName);

    if (!tool) {
      throw new Error(`工具不存在? ${toolName} (mapped: ${actualName})`);
    }

    // terminal 工具限制：仅前台模式
    if (toolName === 'terminal' && input) {
      delete input.background;
      delete input.pty;
      delete input.check_interval;
    }

    return await tool.execute(input);
  };
}

module.exports = { generateToolStub, createToolDispatcher, SANDBOX_TOOLS };
