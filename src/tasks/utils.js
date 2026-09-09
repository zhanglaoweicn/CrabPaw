/**
 * Task Utilities
 * 
 * 任务系统工具函数
 * 独立文件避免循环依赖
 */

const { randomBytes } = require('crypto')
const { TASK_ID_PREFIXES, TASK_STATUS } = require('./constants')

const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

function generateTaskId(type) {
  const prefix = TASK_ID_PREFIXES[type] || 'x'
  const bytes = randomBytes(8)
  let id = prefix
  for (let i = 0; i < 8; i++) {
    id += TASK_ID_ALPHABET[bytes[i] % TASK_ID_ALPHABET.length]
  }
  return id
}

function createTaskStateBase(id, type, description, toolUseId) {
  return {
    id,
    type,
    status: TASK_STATUS.PENDING,
    description,
    toolUseId,
    startTime: Date.now(),
    outputFile: null,
    outputOffset: 0,
    notified: false,
  }
}

module.exports = {
  generateTaskId,
  createTaskStateBase,
}
