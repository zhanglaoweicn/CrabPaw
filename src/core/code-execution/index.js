/**
 * 代码执行模块入口
 *
 * 提供 execute_code 工具，允许 Agent 编写脚本调用 CrabPaw 工具，
 * 将多步骤工作流压缩为单次 LLM 调用。
 */

const { executeCodeTool, CodeExecutor, _sanitizeEnv, DEFAULTS, SANDBOX_TOOLS } = require('./execute-code');
const { IPCBridge, IPCClient } = require('./ipc-bridge');
const { generateToolStub, createToolDispatcher } = require('./tool-bridge');

module.exports = {
  executeCodeTool,
  CodeExecutor,
  IPCBridge,
  IPCClient,
  generateToolStub,
  createToolDispatcher,
  _sanitizeEnv,
  DEFAULTS,
  SANDBOX_TOOLS,
};
