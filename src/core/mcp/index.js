/**
 * MCP 模块入口
 */

const { MCPServer, MCPClient, MCPTool, MCPResource, MCPPrompt, MCPError, ERROR_CODES, TRANSPORT_TYPES, createMCPServer } = require('./protocol');
const { MCPManager, getMCPManager } = require('./mcp-manager');
const { StdioTransport } = require('./stdio-transport');
const { HttpTransport } = require('./http-transport');
const { createCrabPawMCPServer, handleMCPServerRequest } = require('./mcp-server-mode');

module.exports = {
  // 协议层
  MCPServer,
  MCPClient,
  MCPTool,
  MCPResource,
  MCPPrompt,
  MCPError,
  ERROR_CODES,
  TRANSPORT_TYPES,
  createMCPServer,
  // 管理器
  MCPManager,
  getMCPManager,
  // 传输层
  StdioTransport,
  HttpTransport,
  // 服务器模式
  createCrabPawMCPServer,
  handleMCPServerRequest,
};
