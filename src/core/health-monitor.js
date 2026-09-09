/**
 * HealthMonitor — 7×24 服务健康监控 + 自动恢复
 *
 * 适配 CRABPAW 现有 process-watchdog / gateway-recovery：
 *  - 周期性 HTTP 探活各服务端口
 *  - 连续失败 N 次后触发自动重启
 *  - 记录健康历史到磁盘，支持 /api/health/history 查询
 *  - 失败恢复时调用 /api/services/:id/start
 */

const fs = require('fs')
const path = require('path')
const http = require('http')
const { EventEmitter } = require('events')
const { DATA_DIR } = require('./config')

const HEALTH_DIR = path.join(DATA_DIR, 'health')
const HISTORY_FILE = path.join(HEALTH_DIR, 'history.json')
const MAX_HISTORY = 500

function ensureDir() {
  if (!fs.existsSync(HEALTH_DIR)) fs.mkdirSync(HEALTH_DIR, { recursive: true })
}

function loadHistory() {
  ensureDir()
  if (!fs.existsSync(HISTORY_FILE)) return []
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'))
  } catch (e) {
    return []
  }
}

function saveHistory(history) {
  ensureDir()
  const trimmed = history.slice(-MAX_HISTORY)
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2))
}

class HealthMonitor extends EventEmitter {
  /**
   * @param {object} options
   * @param {Array<{id:string,name:string,host:string,port:number,path?:string}>} options.targets
   * @param {number} [options.intervalMs=30000] 检查间隔
   * @param {number} [options.failureThreshold=3] 连续失败次数触发恢复
   * @param {Function} [options.onRecover] 恢复回调 (target) => Promise<void>
   */
  constructor(options = {}) {
    super()
    this.targets = options.targets || []
    this.intervalMs = options.intervalMs || 30000
    this.failureThreshold = options.failureThreshold || 3
    this.onRecover = options.onRecover
    /** @type {Map<string, {failures:number, lastStatus:string, lastCheck:number}>} */
    this._states = new Map()
    this._timer = null
    this._history = loadHistory()
    this._running = false
  }

  start() {
    if (this._running) return
    this._running = true
    this._tick() // 立即跑一次
    this._timer = setInterval(() => this._tick(), this.intervalMs)
    this.emit('started')
  }

  stop() {
    this._running = false
    if (this._timer) clearInterval(this._timer)
    this._timer = null
    this.emit('stopped')
  }

  async _tick() {
    for (const target of this.targets) {
      const ok = await this._probe(target)
      const state = this._states.get(target.id) || { failures: 0, lastStatus: 'unknown', lastCheck: 0 }
      if (ok) {
        // 成功：重置失败计数
        if (state.failures > 0) {
          this.emit('recovered', { target, previousFailures: state.failures })
        }
        state.failures = 0
        state.lastStatus = 'healthy'
      } else {
        state.failures += 1
        state.lastStatus = state.failures >= this.failureThreshold ? 'down' : 'degraded'
        this.emit('failed', { target, failures: state.failures })
        // 触发自动恢复
        if (state.failures === this.failureThreshold && this.onRecover) {
          try {
            await this.onRecover(target)
            this.emit('auto-restarted', { target })
          } catch (e) {
            this.emit('auto-restart-failed', { target, error: e.message })
          }
        }
      }
      state.lastCheck = Date.now()
      this._states.set(target.id, state)

      // 记录历史
      this._history.push({
        ts: Date.now(),
        targetId: target.id,
        ok,
        failures: state.failures,
        status: state.lastStatus,
      })
    }
    saveHistory(this._history)
    this.emit('tick', this.getStatus())
  }

  _probe(target) {
    return new Promise((resolve) => {
      const req = http.request(
        {
          host: target.host || '127.0.0.1',
          port: target.port,
          path: target.path || '/',
          method: 'GET',
          timeout: 5000,
        },
        (res) => {
          // 2xx / 3xx 视为健康
          resolve(res.statusCode >= 200 && res.statusCode < 400)
          res.resume() // 释放连接
        }
      )
      req.on('error', () => resolve(false))
      req.on('timeout', () => {
        req.destroy()
        resolve(false)
      })
      req.end()
    })
  }

  /**
   * 会话级心跳登记（HARNESS §9.2/9.3）：写健康历史 + 更新目标状态
   * @param {object} [opts]
   * @param {string} [opts.targetId='app']
   * @param {boolean} [opts.ok=true]
   * @param {string} [opts.status] 'healthy' | 'degraded' | 'down'
   * @param {string} [opts.detail]
   */
  checkIn({ targetId = 'app', ok = true, status, detail } = {}) {
    const state = this._states.get(targetId) || { failures: 0, lastStatus: 'unknown', lastCheck: 0 }
    if (ok) {
      state.failures = 0
      state.lastStatus = status || 'healthy'
    } else {
      state.failures += 1
      state.lastStatus = status || (state.failures >= this.failureThreshold ? 'down' : 'degraded')
    }
    state.lastCheck = Date.now()
    this._states.set(targetId, state)
    this._history.push({
      ts: state.lastCheck,
      targetId,
      ok,
      failures: state.failures,
      status: state.lastStatus,
      detail: detail || undefined,
    })
    this.emit('checkin', { targetId, ok, status: state.lastStatus })
    return state
  }

  getStatus() {
    const result = []
    for (const target of this.targets) {
      const state = this._states.get(target.id) || { failures: 0, lastStatus: 'unknown', lastCheck: 0 }
      result.push({
        id: target.id,
        name: target.name,
        host: target.host,
        port: target.port,
        ...state,
      })
    }
    return result
  }

  getHistory(limit = 100) {
    return this._history.slice(-limit)
  }
}

let _globalHealthMonitor = null
function getGlobalHealthMonitor() {
  if (!_globalHealthMonitor) _globalHealthMonitor = new HealthMonitor()
  return _globalHealthMonitor
}

module.exports = { HealthMonitor, getGlobalHealthMonitor, HEALTH_DIR, HISTORY_FILE }
