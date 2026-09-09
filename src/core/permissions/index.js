/**
 * Permission Decision System - 统一权限决策模式
 *
 * 参考 Multica 的权限设计：
 * - 所有权限函数返回 Decision 对象而非 boolean
 * - Decision 包含 { allowed, code, reason } 结构
 * - 前端可直接使用 decision.allowed 控制禁用状态
 * - decision.reason 用于 tooltip 或错误提示
 *
 * 使用方式：
 *   const { canEditSkill, ALLOW, deny } = require('./permissions');
 *   const decision = canEditSkill(skill, { userId: '123', role: 'admin' });
 *   if (!decision.allowed) {
 *     console.log(decision.reason); // "仅创建者和管理员可编辑"
 *   }
 */

// ============================================================================
// Decision 类型定义
// ============================================================================

/**
 * 允许决策 - 静态常量，避免重复创建对象
 */
const ALLOW = Object.freeze({ allowed: true, code: null, reason: null });

/**
 * 拒绝决策工厂函数
 * @param {string} code - 错误代码，用于程序化识别
 * @param {string} reason - 人类可读的原因，用于 UI 展示
 * @returns {Decision}
 */
function deny(code, reason) {
  return { allowed: false, code, reason };
}

/**
 * Decision 类型定义
 * @typedef {Object} Decision
 * @property {boolean} allowed - 是否允许
 * @property {string|null} code - 错误代码（拒绝时）
 * @property {string|null} reason - 拒绝原因（拒绝时）
 */

// ============================================================================
// 角色定义
// ============================================================================

const ROLES = {
  GUEST: 'guest',
  MEMBER: 'member',
  ADMIN: 'admin',
  OWNER: 'owner',
  SYSTEM: 'system',
};

/**
 * 角色权限等级
 */
const ROLE_LEVELS = {
  [ROLES.GUEST]: 0,
  [ROLES.MEMBER]: 1,
  [ROLES.ADMIN]: 2,
  [ROLES.OWNER]: 3,
  [ROLES.SYSTEM]: 4,
};

/**
 * 检查角色是否为管理员或更高
 * @param {string} role
 * @returns {boolean}
 */
function isAdminLike(role) {
  return ROLE_LEVELS[role] >= ROLE_LEVELS[ROLES.ADMIN];
}

/**
 * 检查角色是否为所有者或更高
 * @param {string} role
 * @returns {boolean}
 */
function isOwnerLike(role) {
  return ROLE_LEVELS[role] >= ROLE_LEVELS[ROLES.OWNER];
}

// ============================================================================
// 权限上下文
// ============================================================================

/**
 * 创建权限上下文
 * @param {Object} options
 * @param {string|null} options.userId - 当前用户 ID
 * @param {string} options.role - 当前用户角色
 * @param {string|null} options.workspaceId - 当前工作区 ID
 * @returns {PermissionContext}
 */
function createPermissionContext(options = {}) {
  return {
    userId: options.userId || null,
    role: options.role || ROLES.GUEST,
    workspaceId: options.workspaceId || null,
    timestamp: Date.now(),
  };
}

// ============================================================================
// 技能权限规则
// ============================================================================

/**
 * 检查是否可编辑技能
 * @param {Object} skill - 技能对象
 * @param {PermissionContext} ctx - 权限上下文
 * @returns {Decision}
 */
function canEditSkill(skill, ctx) {
  // 未认证
  if (!ctx.userId) {
    return deny('not_authenticated', '请登录后编辑技能');
  }

  // 管理员可编辑所有
  if (isAdminLike(ctx.role)) {
    return ALLOW;
  }

  // 创建者可编辑
  if (skill.createdBy && skill.createdBy === ctx.userId) {
    return ALLOW;
  }

  return deny('not_owner', '仅创建者和管理员可编辑此技能');
}

/**
 * 检查是否可执行技能
 * @param {Object} skill - 技能对象
 * @param {PermissionContext} ctx - 权限上下文
 * @returns {Decision}
 */
function canExecuteSkill(skill, ctx) {
  // 技能已停用
  if (skill.active === false) {
    return deny('skill_inactive', '技能已停用，无法执行');
  }

  // 技能不可见（私有且非创建者/管理员）
  if (skill.visibility === 'private') {
    if (!ctx.userId) {
      return deny('not_authenticated', '请登录后执行私有技能');
    }
    if (!isAdminLike(ctx.role) && skill.createdBy !== ctx.userId) {
      return deny('not_accessible', '无权执行此私有技能');
    }
  }

  return ALLOW;
}

/**
 * 检查是否可删除技能
 * @param {Object} skill - 技能对象
 * @param {PermissionContext} ctx - 权限上下文
 * @returns {Decision}
 */
function canDeleteSkill(skill, ctx) {
  // 未认证
  if (!ctx.userId) {
    return deny('not_authenticated', '请登录后删除技能');
  }

  // 管理员可删除所有
  if (isAdminLike(ctx.role)) {
    return ALLOW;
  }

  // 创建者可删除
  if (skill.createdBy && skill.createdBy === ctx.userId) {
    return ALLOW;
  }

  return deny('not_owner', '仅创建者和管理员可删除此技能');
}

// ============================================================================
// 任务权限规则
// ============================================================================

/**
 * 检查是否可访问任务
 * @param {Object} task - 任务对象
 * @param {PermissionContext} ctx - 权限上下文
 * @param {Object} options - 额外选项
 * @returns {Decision}
 */
function canAccessTask(task, ctx, options = {}) {
  const { allowSystemScope = true, allowSuperOwner = true } = options;

  // 未认证
  if (!ctx.userId) {
    return deny('not_authenticated', '请登录后访问任务');
  }

  // 超级所有者
  if (allowSuperOwner && isOwnerLike(ctx.role)) {
    return ALLOW;
  }

  // 任务不存在
  if (!task) {
    return deny('task_not_found', '任务不存在');
  }

  // 系统范围任务
  if (allowSystemScope && task.scopeKind === 'system') {
    return ALLOW;
  }

  // 任务所有者
  if (task.ownerKey && task.ownerKey === ctx.userId) {
    return ALLOW;
  }

  return deny('not_task_owner', '无权访问此任务');
}

/**
 * 检查是否可取消任务
 * @param {Object} task - 任务对象
 * @param {PermissionContext} ctx - 权限上下文
 * @returns {Decision}
 */
function canCancelTask(task, ctx) {
  // 先检查访问权限
  const accessDecision = canAccessTask(task, ctx);
  if (!accessDecision.allowed) {
    return accessDecision;
  }

  // 任务状态检查
  const cancellableStates = ['queued', 'dispatched', 'running'];
  if (!cancellableStates.includes(task.status)) {
    return deny('not_cancellable', `任务状态为 ${task.status}，无法取消`);
  }

  return ALLOW;
}

// ============================================================================
// 配置权限规则
// ============================================================================

/**
 * 检查是否可修改配置
 * @param {PermissionContext} ctx - 权限上下文
 * @param {string} configKey - 配置键
 * @returns {Decision}
 */
function canModifyConfig(ctx, configKey) {
  // 未认证
  if (!ctx.userId) {
    return deny('not_authenticated', '请登录后修改配置');
  }

  // 敏感配置仅管理员可修改
  const sensitiveKeys = ['apiKeys', 'secrets', 'webhooks', 'security'];
  if (sensitiveKeys.some(k => configKey.includes(k))) {
    if (!isAdminLike(ctx.role)) {
      return deny('admin_required', '仅管理员可修改敏感配置');
    }
  }

  // 普通配置成员可修改
  if (ctx.role === ROLES.MEMBER || isAdminLike(ctx.role)) {
    return ALLOW;
  }

  return deny('insufficient_role', '权限不足');
}

/**
 * 检查是否可访问管理接口
 * @param {PermissionContext} ctx - 权限上下文
 * @returns {Decision}
 */
function canAccessAdmin(ctx) {
  if (!ctx.userId) {
    return deny('not_authenticated', '请登录后访问管理接口');
  }

  if (!isAdminLike(ctx.role)) {
    return deny('admin_required', '仅管理员可访问此接口');
  }

  return ALLOW;
}

// ============================================================================
// 工具权限规则
// ============================================================================

/**
 * 检查是否可执行工具
 * @param {string} toolName - 工具名称
 * @param {Object} input - 工具输入
 * @param {PermissionContext} ctx - 权限上下文
 * @returns {Decision}
 */
function canExecuteTool(toolName, input, ctx) {
  // 危险工具检查
  const dangerousTools = ['Bash', 'Write', 'Delete'];
  if (dangerousTools.includes(toolName)) {
    if (!ctx.userId) {
      return deny('not_authenticated', `请登录后使用 ${toolName} 工具`);
    }

    // 非管理员使用危险工具需要额外确认
    if (!isAdminLike(ctx.role)) {
      // 这里返回 ask 而非 deny，表示需要用户确认
      return { allowed: true, code: 'confirmation_required', reason: `使用 ${toolName} 工具需要确认` };
    }
  }

  return ALLOW;
}

// ============================================================================
// 组合权限检查
// ============================================================================

/**
 * 组合多个权限决策（全部允许才允许）
 * @param  {...Decision} decisions
 * @returns {Decision}
 */
function all(...decisions) {
  for (const decision of decisions) {
    if (!decision.allowed) {
      return decision; // 返回第一个拒绝
    }
  }
  return ALLOW;
}

/**
 * 组合多个权限决策（任一允许即允许）
 * @param  {...Decision} decisions
 * @returns {Decision}
 */
function any(...decisions) {
  for (const decision of decisions) {
    if (decision.allowed) {
      return ALLOW;
    }
  }
  // 返回第一个拒绝的原因
  return decisions.find(d => !d.allowed) || ALLOW;
}

// ============================================================================
// 导出
// ============================================================================

module.exports = {
  // Decision 工厂
  ALLOW,
  deny,

  // 角色工具
  ROLES,
  ROLE_LEVELS,
  isAdminLike,
  isOwnerLike,

  // 上下文
  createPermissionContext,

  // 技能权限
  canEditSkill,
  canExecuteSkill,
  canDeleteSkill,

  // 任务权限
  canAccessTask,
  canCancelTask,

  // 配置权限
  canModifyConfig,
  canAccessAdmin,

  // 工具权限
  canExecuteTool,

  // 组合器
  all,
  any,
};
