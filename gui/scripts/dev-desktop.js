/**
 * dev-desktop — 开发版 Electron 启动器（跨平台）
 *
 * 背景：宿主环境（如某些终端/Agent 会话）可能设置了 ELECTRON_RUN_AS_NODE=1，
 * 导致 Electron 以 Node 模式运行（require('electron') 返回二进制路径、
 * ipcMain undefined、启动即崩溃）。此启动器在派生 vite 前清除该变量。
 *
 * 用法：npm run dev:desktop  （等价于 npm run dev，但环境安全）
 */
'use strict'

const { spawn } = require('child_process')

// 清除影响 Electron 运行模式的变量（宿主环境残留）
delete process.env.ELECTRON_RUN_AS_NODE

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const child = spawn(npmCmd, ['run', 'dev'], {
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32',
})

child.on('exit', (code) => process.exit(code ?? 0))
