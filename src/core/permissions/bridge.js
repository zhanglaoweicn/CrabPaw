/**
 * Permission Bridge - 旧权限系统适配器
 *
 * 将现有的 PermissionSystem 和 OwnerAccess 桥接到新的 Decision 模式
 * 保持向后兼容，渐进式迁移
 */

const {
  ALLOW,
  deny,
  createPermissionContext,
  isAdminLike,
} = require('./index');

// ============================================================================
// PermissionSystem 桥接
// ============================================================================

/**
 * 将 PermissionSystem.checkPermission 结果转换为 Decision
 * @param {Object} checkResult - PermissionSystem.checkPermission 返回值
 * @returns {Decision}
 */
function fromPermissionSystemResult(checkResult) {
  if (!checkResult) {
    return ALLOW;
  }

  if (checkResult.behavior === 'allow') {
    return ALLOW;
  }

  if (checkResult.behavior === 'deny') {
    return deny(
      checkResult.ruleId || 'permission_denied',
      checkResult.reason || '权限拒绝'
    );
  }

  // ask 行为视为需要确认
  if (checkResult.behavior === 'ask') {
    return { allowed: true, code: 'confirmation_required', reason: '需要用户确认' };
  }

  return ALLOW;
}

/**
 * 包装 PermissionSystem 的 checkPermission 方法
 * @param {PermissionSystem} permSystem - PermissionSystem 实例
 * @param {string} toolName - 工具名称
 * @param {Object} input - 工具输入
 * @param {Object} context - 执行上下文
 * @returns {Promise<Decision>}
 */
async function checkToolPermission(permSystem, toolName, input, context) {
  try {
    const result = await permSystem.checkPermission(toolName, input, context);
    return fromPermissionSystemResult(result);
  } catch (error) {
    return deny('permission_check_error', error.message);
  }
}

// ============================================================================
// OwnerAccess 桥接
// ============================================================================

/**
 * 将 OwnerAccess.assertTaskOwner 转换为 Decision
 * @param {OwnerAccess} ownerAccess - OwnerAccess 实例
 * @param {string} taskId - 任务 ID
 * @param {string} ownerKey - 所有者密钥
 * @param {Object} options - 选项
 * @returns {Promise<Decision>}
 */
async function checkTaskOwnerAccess(ownerAccess, taskId, ownerKey, options = {}) {
  try {
    await ownerAccess.assertTaskOwner(taskId, ownerKey, options);
    return ALLOW;
  } catch (error) {
    if (error.name === 'PermissionError') {
      return deny(error.code || 'permission_denied', error.message);
    }
    return deny('access_check_error', error.message);
  }
}

/**
 * 将 OwnerAccess.assertFlowOwner 转换为 Decision
 * @param {OwnerAccess} ownerAccess - OwnerAccess 实例
 * @param {string} flowId - 流程 ID
 * @param {string} ownerKey - 所有者密钥
 * @param {Object} options - 选项
 * @returns {Promise<Decision>}
 */
async function checkFlowOwnerAccess(ownerAccess, flowId, ownerKey, options = {}) {
  try {
    await ownerAccess.assertFlowOwner(flowId, ownerKey, options);
    return ALLOW;
  } catch (error) {
    if (error.name === 'PermissionError') {
      return deny(error.code || 'permission_denied', error.message);
    }
    return deny('access_check_error', error.message);
  }
}

// ============================================================================
// HTTP 中间件桥接
// ============================================================================

/**
 * 创建权限检查中间件
 * @param {Function} checkFn - 权限检查函数 (req) => Decision
 * @returns {Function} Express 中间件
 */
function createPermissionMiddleware(checkFn) {
  return async (req, res, next) => {
    try {
      const decision = await checkFn(req);

      if (!decision.allowed) {
        res.status(403).json({
          error: decision.code,
          message: decision.reason,
        });
        return;
      }

      // 将 decision 附加到 request
      req.permissionDecision = decision;
      next();
    } catch (error) {
      res.status(500).json({
        error: 'permission_check_error',
        message: error.message,
      });
    }
  };
}

/**
 * 要求管理员权限的中间件
 */
function requireAdmin(req, res, next) {
  const ctx = createPermissionContext({
    userId: req.userId || null,
    role: req.userRole || 'guest',
  });

  if (!ctx.userId) {
    res.status(401).json({ error: 'not_authenticated', message: '请登录' });
    return;
  }

  if (!isAdminLike(ctx.role)) {
    res.status(403).json({ error: 'admin_required', message: '需要管理员权限' });
    return;
  }

  next();
}

/**
 * 要求认证的中间件
 */
function requireAuth(req, res, next) {
  const ctx = createPermissionContext({
    userId: req.userId || null,
    role: req.userRole || 'guest',
  });

  if (!ctx.userId) {
    res.status(401).json({ error: 'not_authenticated', message: '请登录' });
    return;
  }

  next();
}

// ============================================================================
// 导出
// ============================================================================

module.exports = {
  // PermissionSystem 桥接
  fromPermissionSystemResult,
  checkToolPermission,

  // OwnerAccess 桥接
  checkTaskOwnerAccess,
  checkFlowOwnerAccess,

  // 中间件
  createPermissionMiddleware,
  requireAdmin,
  requireAuth,
};
