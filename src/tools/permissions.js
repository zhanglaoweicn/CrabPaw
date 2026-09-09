/**
 * Tool Permission System
 * 
 * 借鉴 Claude Code 的权限系统设计
 * - 细粒度权限控制
 * - 规则匹配引擎
 * - 权限缓存
 */

const EventEmitter = require('events')

const DANGEROUS_PATTERNS = [
  { regex: /\brm\s+(-[rf]+\s+)*\/\*/i, desc: 'rm -rf /* 删除根目录' },
  { regex: /\brm\s+(-[rf]+\s+)*\//i, desc: 'rm -rf / 删除根目录' },
  { regex: /\bdd\s+.*of=\/dev\/[sh]d/i, desc: 'dd 写入磁盘设备' },
  { regex: /\bmkfs\.\w+\s+\/dev\//i, desc: '格式化磁盘' },
  { regex: /:\(\)\{\s*:\|:\s*&\s*\};\s*:/i, desc: 'fork bomb' },
  { regex: />\s*\/dev\/[sh]d/i, desc: '写入磁盘设备' },
  { regex: /chmod\s+(-R\s+)?000\s+\//i, desc: '锁定根目录' },
  { regex: /chown\s+(-R\s+)?\S+\s+\//i, desc: '更改根目录所有者' },
]

class PermissionSystem extends EventEmitter {
  constructor() {
    super()
    this.rules = new Map()
    this.cache = new Map()
    this._cacheTTL = 5 * 60 * 1000; // 缓存5分钟过期
    this.decisions = []
  }

  /**
   * 添加权限规则
   */
  addRule(rule) {
    const {
      id = `rule-${Date.now()}`,
      toolPattern,
      inputPattern,
      behavior,
      source,
      priority = 0,
    } = rule

    if (!behavior || !['allow', 'deny', 'ask'].includes(behavior)) {
      console.warn('⚠️ [permissions] 无效的权限行为:', behavior);
      return false;
    }

    if (toolPattern && typeof toolPattern === 'string') {
      if (toolPattern.length > 200) {
        console.warn('⚠️ [permissions] 工具模式过长:', toolPattern.length);
        return false;
      }
      if (toolPattern === '*' && !source?.includes('system')) {
        console.warn('⚠️ [permissions] 检测到通配符工具模式，请确认意图');
      }
    }

    if (inputPattern && typeof inputPattern === 'string') {
      if (inputPattern.length > 500) {
        console.warn('⚠️ [permissions] 输入模式过长:', inputPattern.length);
        return false;
      }
      const dangerousPatterns = /[{}()[\]]/;
      if (dangerousPatterns.test(inputPattern) && source !== 'system') {
        console.warn('⚠️ [permissions] 输入模式包含特殊字符，已拒绝');
        return false;
      }
    }

    this.rules.set(id, {
      id,
      toolPattern: toolPattern || '*',
      inputPattern,
      behavior,
      source: source || 'user',
      priority,
      createdAt: Date.now(),
    })

    this.clearCache()
    this.emit('rule:added', { id, rule })
    return true;
  }

  /**
   * 移除权限规则
   */
  removeRule(id) {
    if (this.rules.has(id)) {
      this.rules.delete(id)
      this.clearCache()
      this.emit('rule:removed', { id })
    }
  }

  /**
   * 获取所有规则
   */
  getRules() {
    return Array.from(this.rules.values()).sort((a, b) => b.priority - a.priority)
  }

  /**
   * 检查权限
   */
  async checkPermission(toolName, input, _context) {
    const cacheKey = this.getCacheKey(toolName, input)
    
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey)
      if (Date.now() - cached._cachedAt < this._cacheTTL) {
        return cached
      }
      this.cache.delete(cacheKey) // 过期清除
    }

    if (toolName === 'Bash') {
      const dangerCheck = this.checkDangerousCommand(input)
      if (dangerCheck.dangerous) {
        const decision = {
          behavior: 'deny',
          updatedInput: input,
          ruleId: 'dangerous-command-detected',
          source: 'system',
          reason: dangerCheck.reason,
          _cachedAt: Date.now()
        }
        this.cache.set(cacheKey, decision)
        this.recordDecision(toolName, input, decision)
        return decision
      }
    }

    const rules = this.getRules()
    let decision = { behavior: 'allow', updatedInput: input, _cachedAt: Date.now() }

    for (const rule of rules) {
      if (this.matchesRule(rule, toolName, input)) {
        decision = {
          behavior: rule.behavior,
          updatedInput: input,
          ruleId: rule.id,
          source: rule.source,
          _cachedAt: Date.now()
        }
        
        if (rule.behavior === 'deny') {
          break
        }
      }
    }

    this.cache.set(cacheKey, decision)
    this.recordDecision(toolName, input, decision)
    
    return decision
  }

  /**
   * 检查危险命令
   */
  checkDangerousCommand(input) {
    const cmd = typeof input === 'string' ? input : (input.command || JSON.stringify(input))
    
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.regex.test(cmd)) {
        return { dangerous: true, reason: pattern.desc }
      }
    }
    
    return { dangerous: false, reason: null }
  }

  /**
   * 匹配规则
   */
  matchesRule(rule, toolName, input) {
    if (rule.toolPattern) {
      if (!this.matchPattern(rule.toolPattern, toolName)) {
        return false
      }
    }

    if (rule.inputPattern) {
      const inputStr = JSON.stringify(input)
      if (!this.matchPattern(rule.inputPattern, inputStr)) {
        return false
      }
    }

    return true
  }

  /**
   * 模式匹配
   */
  matchPattern(pattern, value) {
    if (pattern === '*') {
      return true
    }

    if (pattern.startsWith('*') && pattern.endsWith('*')) {
      const substr = pattern.slice(1, -1)
      return value.includes(substr)
    }

    if (pattern.startsWith('*')) {
      const suffix = pattern.slice(1)
      return value.endsWith(suffix)
    }

    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1)
      return value.startsWith(prefix)
    }

    return pattern === value
  }

  /**
   * 获取缓存键
   */
  getCacheKey(toolName, input) {
    return `${toolName}:${JSON.stringify(input)}`
  }

  /**
   * 清除缓存
   */
  clearCache() {
    this.cache.clear()
  }

  /**
   * 记录决策
   */
  recordDecision(toolName, input, decision) {
    this.decisions.push({
      toolName,
      input,
      decision,
      timestamp: Date.now(),
    })

    if (this.decisions.length > 1000) {
      this.decisions = this.decisions.slice(-500)
    }
  }

  /**
   * 获取决策历史
   */
  getDecisionHistory(limit = 100) {
    return this.decisions.slice(-limit)
  }

  /**
   * 导出规则
   */
  exportRules() {
    return Array.from(this.rules.values())
  }

  /**
   * 导入规则
   */
  importRules(rules) {
    for (const rule of rules) {
      this.addRule(rule)
    }
  }

  /**
   * 获取统计信息
   */
  getStats() {
    const byBehavior = { allow: 0, deny: 0, ask: 0 }
    
    for (const decision of this.decisions) {
      byBehavior[decision.decision.behavior]++
    }

    return {
      totalRules: this.rules.size,
      totalDecisions: this.decisions.length,
      cacheSize: this.cache.size,
      byBehavior,
    }
  }
}

const permissionSystem = new PermissionSystem()

permissionSystem.addRule({
  id: 'allow-read-operations',
  toolPattern: 'Read',
  inputPattern: '*',
  behavior: 'allow',
  source: 'system',
  priority: 50,
})

// R16: Write 从 ask 改为 allow——Write 已受沙箱 validateWrite 保护(拦截 blockedPaths/
// 超大小),ask→审批对"写文章/生成文件"等高频操作体验过重且曾致"系统拦截"。
// 真正危险操作(Bash 执行/敏感路径)由沙箱 + 命令审批保护,Write 无需再叠加人工审批。
permissionSystem.addRule({
  id: 'allow-write-operations',
  toolPattern: 'Write',
  inputPattern: '*',
  behavior: 'allow',
  source: 'system',
  priority: 50,
})

module.exports = {
  PermissionSystem,
  permissionSystem,
}

// 2026-08-01: 适配 ToolRegistry.setPolicyManager 接口（此前 PermissionSystem 未接线）。
// 挂在原型上，避免改动既有模块结构的类定义。
PermissionSystem.prototype.isToolAllowed = async function isToolAllowed(toolName, toolset, context = {}) {
  try {
    const decision = await this.checkPermission(toolName, context.input || {}, context);
    if (!decision) return { allowed: true };
    if (decision.behavior === 'deny') {
      return { allowed: false, reason: decision.reason || '权限策略拒绝' };
    }
    // S6: ask 行为不再静默放行——标记 needsApproval,由 registry 消费方触发人工审批
    // （ApprovalHost 消费 approval_requested）。旧实现把 ask 当 allow,Write 等
    // 需确认的操作实际直接放行,违反"写操作要确认"的规则意图。
    if (decision.behavior === 'ask') {
      return { allowed: true, needsApproval: true, reason: decision.reason || '此操作需要人工确认' };
    }
    return { allowed: true };
  } catch (e) {
    // A2(Runtime差距分析): fail-open → fail-closed——此前策略系统故障时放行所有工具
    // ("不阻塞主流程"),权限检查形同虚设。安全决策点必须 fail-closed: 故障时拒绝并
    // 给出明确原因,由上层把错误回灌给模型(不崩进程)。
    console.warn('[permissions] isToolAllowed failed(fail-closed):', e.message);
    return { allowed: false, reason: '权限策略系统异常，已安全拦截本次工具调用' };
  }
}
