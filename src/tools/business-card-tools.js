/**
 * business-card-tools.js — 业务卡 P0 三件（应收账款/合同到期/经营简报）
 * 模式对齐 ShowBusinessReport（show/hide + surface + panel-state 三件套）。
 * 数据引擎 = morning-briefing-service（语义视图 v_* 优先，逐表正则回退）
 * + business-data-registry（导入表清单/角色）。
 *
 * 面板键 2026-09-05 注册于 panel-registry（receivable/contractExpiry/businessBriefing），
 * GUI 侧 SceneShell KIND_REGISTRY 按 surface.data 渲染卡片。
 */
const { registry } = require('./registry');

/** 默认业务库路径（与 data-import-tools 一致） */
function defaultDbPath() {
  const { BUSINESS_DIR } = require('../core/business-data-registry');
  return require('path').join(BUSINESS_DIR, 'business.db');
}

/** 三件套公共动作：surface upsert/remove + panel-state 开关 */
function surfaceAction(surfaceId, kind, panelKey, action, data) {
  const { getSceneStore } = require('../core/scene/scene-store');
  const { setPanelState } = require('../core/panel-state');
  if (action === 'hide') {
    try { getSceneStore().removeSurface(surfaceId); } catch (e) { console.warn(`[${panelKey}] 移除 surface 失败:`, e.message); }
    setPanelState(panelKey, 'closed');
    return true;
  }
  getSceneStore().upsertSurface(surfaceId, { kind, data, intent: 'inform' });
  setPanelState(panelKey, 'open');
  return false;
}

/** 是否有任何导入的经营数据（空态提示用） */
function hasBusinessTables() {
  const { listTables } = require('../core/business-data-registry');
  return listTables().filter((t) => !t.superseded).length > 0;
}

function fmtMoney(n) {
  return n == null ? '—' : Number(n).toLocaleString('zh-CN');
}

// ── 应收账款卡 ─────────────────────────────────────────────
async function handleShowReceivablePanel(params) {
  try {
    const action = params.action || 'show';
    if (action === 'hide') {
      surfaceAction('receivable-panel', 'receivable', 'receivable', 'hide');
      return { success: true, content: '应收账款卡已关闭。' };
    }
    const { listOverdueReceivables, scanBusinessRisks } = require('../core/proactive/morning-briefing-service');
    const dbPath = defaultDbPath();
    const today = new Date().toISOString().slice(0, 10);
    const customers = listOverdueReceivables(dbPath, { today, overdueDays: 30, limit: 10 });
    const scan = scanBusinessRisks(dbPath, { today });
    const data = {
      overdueCount: scan.receivableOverdue || customers.length,
      totalOverdue: scan.totalReceivable,
      customers,
      generatedAt: Date.now(),
    };
    surfaceAction('receivable-panel', 'receivable', 'receivable', 'show', data);
    const hint = hasBusinessTables() ? '' : '（尚无导入数据：请先发送 CSV/Excel 报表导入）';
    return {
      success: true,
      content: data.overdueCount
        ? `应收账款卡已打开：逾期 ${data.overdueCount} 笔，合计约 ${fmtMoney(data.totalOverdue)} 元，欠款最多的是 ${customers.slice(0, 3).map((c) => c.customer).join('、')}。${hint}`
        : `应收账款卡已打开：当前无逾期应收。${hint}`,
    };
  } catch (e) {
    console.error('[ShowReceivablePanel] 失败:', e.message || e);
    return { success: false, error: e.message || '应收账款卡打开失败' };
  }
}

// ── 合同到期卡 ─────────────────────────────────────────────
async function handleShowContractExpiryPanel(params) {
  try {
    const action = params.action || 'show';
    if (action === 'hide') {
      surfaceAction('contract-expiry-panel', 'contractExpiry', 'contractExpiry', 'hide');
      return { success: true, content: '合同到期卡已关闭。' };
    }
    const { listExpiringContracts } = require('../core/proactive/morning-briefing-service');
    const dbPath = defaultDbPath();
    const today = new Date().toISOString().slice(0, 10);
    const windowDays = Number(params.windowDays) > 0 ? Number(params.windowDays) : 30;
    const contracts = listExpiringContracts(dbPath, { today, days: windowDays, limit: 20 });
    const data = { windowDays, contracts, generatedAt: Date.now() };
    surfaceAction('contract-expiry-panel', 'contractExpiry', 'contractExpiry', 'show', data);
    const hint = hasBusinessTables() ? '' : '（尚无导入数据：请先发送 CSV/Excel 报表导入）';
    return {
      success: true,
      content: contracts.length
        ? `合同到期卡已打开：未来 ${windowDays} 天内 ${contracts.length} 份合同到期，最近的是 ${contracts[0].expireDate}${contracts[0].customer ? `（${contracts[0].customer}）` : ''}。${hint}`
        : `合同到期卡已打开：未来 ${windowDays} 天内无到期合同。${hint}`,
    };
  } catch (e) {
    console.error('[ShowContractExpiryPanel] 失败:', e.message || e);
    return { success: false, error: e.message || '合同到期卡打开失败' };
  }
}

// ── 经营简报卡 ─────────────────────────────────────────────
async function handleShowBusinessBriefingPanel(params) {
  try {
    const action = params.action || 'show';
    if (action === 'hide') {
      surfaceAction('business-briefing-panel', 'businessBriefing', 'businessBriefing', 'hide');
      return { success: true, content: '经营简报卡已关闭。' };
    }
    const { buildBriefingSnapshot } = require('../core/proactive/morning-briefing-service');
    const data = buildBriefingSnapshot(defaultDbPath());
    surfaceAction('business-briefing-panel', 'businessBriefing', 'businessBriefing', 'show', data);
    const hint = hasBusinessTables() ? '' : '（尚无导入数据：请先发送 CSV/Excel 报表导入）';
    const rev = data.revenue;
    const monthText = rev.month != null ? `本月营收 ${fmtMoney(rev.month)} 元` : '本月营收暂无数据';
    const deltaText = rev.deltaPct != null ? `，环比 ${rev.deltaPct >= 0 ? '+' : ''}${rev.deltaPct}%` : '';
    const riskText = data.risks.receivableOverdue ? `；注意：${data.risks.receivableOverdue} 笔应收逾期` : '';
    return {
      success: true,
      content: `经营简报卡已打开：${monthText}${deltaText}${riskText}。${hint}`,
    };
  } catch (e) {
    console.error('[ShowBusinessBriefingPanel] 失败:', e.message || e);
    return { success: false, error: e.message || '经营简报卡打开失败' };
  }
}

// ── 审批待办卡 ─────────────────────────────────────────────
function getGate() {
  const { getApprovalGate, getTaskFlowStore } = require('../taskflow');
  // 与 TaskFlowRuntime 同 store：先到先初始化也不丢持久化
  return getApprovalGate(getTaskFlowStore());
}

async function handleShowApprovalsPanel(params) {
  try {
    const action = params.action || 'show';
    if (action === 'hide') {
      surfaceAction('approvals-panel', 'approvals', 'approvals', 'hide');
      return { success: true, content: '审批待办卡已关闭。' };
    }
    const gate = getGate();
    const pending = (gate.listPendingApprovals() || []).map((a) => ({
      approvalId: a.approvalId,
      flowId: a.flowId,
      message: a.message,
      createdAt: a.createdAt,
      expiresAt: a.expiresAt,
    }));
    const data = { approvals: pending, generatedAt: Date.now() };
    surfaceAction('approvals-panel', 'approvals', 'approvals', 'show', data);
    return {
      success: true,
      content: pending.length
        ? `审批待办卡已打开：${pending.length} 笔待审批（点卡片按钮或说"批准/驳回第 X 项"）。`
        : '审批待办卡已打开：当前没有待审批事项。',
    };
  } catch (e) {
    console.error('[ShowApprovalsPanel] 失败:', e.message || e);
    return { success: false, error: e.message || '审批待办卡打开失败' };
  }
}

async function handleResolveApproval(params) {
  try {
    const { approvalId, approved, result } = params;
    if (!approvalId || typeof approved !== 'boolean') {
      return { success: false, error: '缺少 approvalId 或 approved(true/false)' };
    }
    const gate = getGate();
    const resolution = await gate.resolveApproval(approvalId, approved, result);
    return {
      success: true,
      content: `审批 ${approvalId} 已${approved ? '批准' : '驳回'}。`,
      data: resolution,
    };
  } catch (e) {
    console.error('[ResolveApproval] 失败:', e.message || e);
    return { success: false, error: e.message || '审批操作失败' };
  }
}

// ── 库存预警卡 ─────────────────────────────────────────────
async function handleShowStockAlertPanel(params) {
  try {
    const action = params.action || 'show';
    if (action === 'hide') {
      surfaceAction('stock-alert-panel', 'stockAlert', 'stockAlert', 'hide');
      return { success: true, content: '库存预警卡已关闭。' };
    }
    const { listStockAlerts } = require('../core/business/card-queries');
    const alerts = listStockAlerts(defaultDbPath(), { limit: 20 });
    const data = { alerts, generatedAt: Date.now() };
    surfaceAction('stock-alert-panel', 'stockAlert', 'stockAlert', 'show', data);
    const hint = hasBusinessTables() ? '' : '（尚无导入数据：请先发送 CSV/Excel 报表导入）';
    return {
      success: true,
      content: alerts.length
        ? `库存预警卡已打开：${alerts.length} 项低于安全库存，缺口最大的是 ${alerts[0].product || '(未标注商品)'}（差 ${alerts[0].gap}）。${hint}`
        : `库存预警卡已打开：当前无低于安全库存的商品。${hint}`,
    };
  } catch (e) {
    console.error('[ShowStockAlertPanel] 失败:', e.message || e);
    return { success: false, error: e.message || '库存预警卡打开失败' };
  }
}

// ── 客户跟进卡（过渡版） ───────────────────────────────────
async function handleShowCustomerPanel(params) {
  try {
    const action = params.action || 'show';
    if (action === 'hide') {
      surfaceAction('customer-panel', 'customerView', 'customerView', 'hide');
      return { success: true, content: '客户跟进卡已关闭。' };
    }
    const { summarizeCustomers } = require('../core/business/card-queries');
    const customers = summarizeCustomers(defaultDbPath(), { limit: 20 });
    const data = { customers, generatedAt: Date.now() };
    surfaceAction('customer-panel', 'customerView', 'customerView', 'show', data);
    const hint = hasBusinessTables() ? '' : '（尚无导入数据：请先发送 CSV/Excel 报表导入）';
    return {
      success: true,
      content: customers.length
        ? `客户跟进卡已打开：共 ${customers.length} 个客户，销售额最高的是 ${customers[0].customer}。${hint}`
        : `客户跟进卡已打开：暂无客户交易数据。${hint}`,
    };
  } catch (e) {
    console.error('[ShowCustomerPanel] 失败:', e.message || e);
    return { success: false, error: e.message || '客户跟进卡打开失败' };
  }
}

// ── 供应商档案卡 ───────────────────────────────────────────
async function handleShowSupplierPanel(params) {
  try {
    const action = params.action || 'show';
    if (action === 'hide') {
      surfaceAction('supplier-panel', 'supplierProfile', 'supplierProfile', 'hide');
      return { success: true, content: '供应商档案卡已关闭。' };
    }
    const { summarizeSuppliers } = require('../core/business/card-queries');
    const dbPath = defaultDbPath();
    const supplier = (params.supplier || '').trim() || null;
    const purchases = summarizeSuppliers(dbPath, { supplier, limit: 20 });
    const data = { supplier, purchases, enterprise: null, contacts: null, larkConfigured: false, generatedAt: Date.now() };
    const notes = [];

    // 工商信息区块（重）：可选触发，走既有 EnterpriseQuery（自带 7 天缓存与降级链），
    // 结构化企业卡会另经 'enterprise-card' surface 推送
    if (supplier && params.withEnterprise) {
      try {
        const { handleEnterpriseQuery } = require('./enterprise-tools');
        const er = await handleEnterpriseQuery({ query: supplier });
        data.enterprise = { queried: true, success: !!er.success };
        notes.push(er.success ? '工商信息已另发企业信息卡。' : `工商查询未成功：${er.error || '无结果'}`);
      } catch (e) {
        data.enterprise = { queried: true, success: false };
        notes.push(`工商查询失败：${e.message}`);
      }
    }

    // Bitable 联系人区块（可选）：需飞书已配置 + appToken/tableId
    try {
      const dsRegistry = require('../core/data-sources/registry');
      // 惰性装机：本工具可能在 cordis boot 之前被调用
      if (!dsRegistry.getSource('lark-bitable')) dsRegistry.installBuiltinSources();
      const lark = await dsRegistry.fetchFromSource('lark-bitable', { appToken: params.appToken, tableId: params.tableId, pageSize: 20 });
      const items = (lark && lark.data && Array.isArray(lark.data.items)) ? lark.data.items : (Array.isArray(lark && lark.items) ? lark.items : []);
      data.contacts = { source: 'lark-bitable', count: items.length, items: items.slice(0, 10) };
      data.larkConfigured = true;
    } catch (e) {
      data.larkConfigured = require('../tools/lark-tools').getLarkClient().isConfigured;
      notes.push(`Bitable 联系人未拉取：${e.message}`);
    }

    surfaceAction('supplier-panel', 'supplierProfile', 'supplierProfile', 'show', data);
    const hint = hasBusinessTables() ? '' : '（尚无导入数据：请先发送采购报表 CSV/Excel 导入）';
    return {
      success: true,
      content: supplier
        ? `供应商档案卡已打开：${supplier}（采购记录 ${purchases.length ? `累计 ${fmtMoney(purchases[0].totalPurchase)} 元 / ${purchases[0].orderCount} 单` : '暂无'}）。${notes.join(' ')}${hint}`
        : `供应商档案卡已打开：共 ${purchases.length} 家供应商。${notes.join(' ')}${hint}`,
    };
  } catch (e) {
    console.error('[ShowSupplierPanel] 失败:', e.message || e);
    return { success: false, error: e.message || '供应商档案卡打开失败' };
  }
}

// ── 契约（PascalCase, 双端对齐 tool-contract.js）──
const PANEL_ACTION_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['show', 'hide'],
      description: 'show=展示卡片(默认)，hide=关闭卡片',
      default: 'show',
    },
  },
  required: ['action'],
  additionalProperties: false,
};

const RECEIVABLE_CONTRACT = {
  name: 'ShowReceivablePanel',
  toolset: 'panel',
  category: 'information',
  description: '展示应收账款卡：逾期应收总额/笔数/按客户聚合的逾期明细（金额降序），用于"应收账款/回款/谁欠我钱"类请求。数据来自导入的经营报表（语义视图优先，自动回退）。无逾期时如实说明。会以可视卡片形式展示。',
  schema: PANEL_ACTION_SCHEMA,
  whenNotToUse: ['非应收/回款场景（经营总览用 ShowBusinessReport 或 ShowBusinessBriefingPanel）', '库存/合同场景用各自卡片'],
  riskLevel: 'low',
};

const CONTRACT_EXPIRY_CONTRACT = {
  name: 'ShowContractExpiryPanel',
  toolset: 'panel',
  category: 'information',
  description: '展示合同到期卡：指定窗口期内到期的合同列表（到期日升序/客户/金额/剩余天数），用于"合同到期/续约提醒"类请求。数据来自导入的经营报表（语义视图优先，自动回退）。会以可视卡片形式展示。',
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['show', 'hide'], description: 'show=展示卡片(默认)，hide=关闭卡片', default: 'show' },
      windowDays: { type: 'number', description: '到期窗口天数（默认 30）' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  whenNotToUse: ['非合同场景（应收/经营总览用各自卡片）'],
  riskLevel: 'low',
};

const BUSINESS_BRIEFING_CONTRACT = {
  name: 'ShowBusinessBriefingPanel',
  toolset: 'panel',
  category: 'information',
  description: '展示经营简报卡：本月/上月/昨日营收 + 环比 + 应收逾期与合同临期风险摘要，用于"经营简报/今天经营怎么样/营收概况"类请求。数据来自导入的经营报表（语义视图优先，自动回退）。会以可视卡片形式展示。',
  schema: PANEL_ACTION_SCHEMA,
  whenNotToUse: ['查看数据表清单用 ShowBusinessReport', '单笔明细查询用 DatabaseQuery/NL2SQL'],
  riskLevel: 'low',
};

const APPROVALS_CONTRACT = {
  name: 'ShowApprovalsPanel',
  toolset: 'panel',
  category: 'information',
  description: '展示审批待办卡：当前待审批事项列表（流程/事项说明/创建时间）。用户点卡片上的批准/驳回按钮后，意图会在下一轮进入你的上下文，此时用 ResolveApproval 工具落地。',
  schema: PANEL_ACTION_SCHEMA,
  whenNotToUse: ['非审批场景'],
  riskLevel: 'low',
};

const RESOLVE_APPROVAL_CONTRACT = {
  name: 'ResolveApproval',
  toolset: 'panel',
  category: 'taskflow',
  description: '落地一个审批决定（批准/驳回）。审批待办卡上的用户点击会以意图进入对话上下文，你据此调用本工具；approvalId 必须来自 ShowApprovalsPanel 列出的待办，不要凭空编造。',
  schema: {
    type: 'object',
    properties: {
      approvalId: { type: 'string', description: '审批单 ID（来自审批待办卡/ShowApprovalsPanel）' },
      approved: { type: 'boolean', description: 'true=批准，false=驳回' },
      result: { type: 'string', description: '审批备注（可选）' },
    },
    required: ['approvalId', 'approved'],
    additionalProperties: false,
  },
  whenNotToUse: ['approvalId 不在待审批列表中时', '用户未明确表达批准/驳回意愿时（先确认）'],
  riskLevel: 'medium',
};

const STOCK_ALERT_CONTRACT = {
  name: 'ShowStockAlertPanel',
  toolset: 'panel',
  category: 'information',
  description: '展示库存预警卡：当前库存低于安全库存的商品列表（缺口降序，含当前量/安全线/缺口）。要求导入的库存表含"安全库存"列。会以可视卡片形式展示。',
  schema: PANEL_ACTION_SCHEMA,
  whenNotToUse: ['非库存场景', '导入表无安全库存列时如实说明并提示补列'],
  riskLevel: 'low',
};

const CUSTOMER_VIEW_CONTRACT = {
  name: 'ShowCustomerPanel',
  toolset: 'panel',
  category: 'information',
  description: '展示客户跟进卡（过渡版）：按客户聚合的累计销售额/最近成交日/当前应收，用于"客户情况/客户排名/老客户分析"类请求。数据来自导入的经营报表（语义视图优先）。会以可视卡片形式展示。',
  schema: PANEL_ACTION_SCHEMA,
  whenNotToUse: ['单客户的详细流水查询用 DatabaseQuery/NL2SQL'],
  riskLevel: 'low',
};

const SUPPLIER_CONTRACT = {
  name: 'ShowSupplierPanel',
  toolset: 'panel',
  category: 'information',
  description: '展示供应商档案卡：按供应商聚合的采购总额/单数/最近采购日（数据来自导入的采购报表，语义视图优先）；指定 supplier 且 withEnterprise=true 时另发企业工商信息卡（网络查询较慢）；appToken/tableId 提供时附带 Lark Bitable 联系人区块。',
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['show', 'hide'], description: 'show=展示卡片(默认)，hide=关闭卡片', default: 'show' },
      supplier: { type: 'string', description: '供应商名称（可选；缺省展示采购汇总榜）' },
      withEnterprise: { type: 'boolean', description: '是否联网查该供应商工商信息（较慢，默认 false）' },
      appToken: { type: 'string', description: 'Lark Bitable app token（可选，联系人区块）' },
      tableId: { type: 'string', description: 'Lark Bitable table id（可选，联系人区块）' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  whenNotToUse: ['非供应商/采购场景', '仅查工商信息可直接用 EnterpriseQuery'],
  riskLevel: 'low',
};

for (const [C, handler, readOnly] of [
  [RECEIVABLE_CONTRACT, handleShowReceivablePanel, true],
  [CONTRACT_EXPIRY_CONTRACT, handleShowContractExpiryPanel, true],
  [BUSINESS_BRIEFING_CONTRACT, handleShowBusinessBriefingPanel, true],
  [APPROVALS_CONTRACT, handleShowApprovalsPanel, true],
  [RESOLVE_APPROVAL_CONTRACT, handleResolveApproval, false],
  [STOCK_ALERT_CONTRACT, handleShowStockAlertPanel, true],
  [CUSTOMER_VIEW_CONTRACT, handleShowCustomerPanel, true],
  [SUPPLIER_CONTRACT, handleShowSupplierPanel, true],
]) {
  registry.register({
    name: C.name,
    handler,
    category: C.category,
    description: C.description,
    schema: C.schema,
    toolset: C.toolset,
    whenNotToUse: C.whenNotToUse,
    riskLevel: C.riskLevel,
    isReadOnly: readOnly,
    isDangerous: false,
    source: 'builtin:business',
  });
}

module.exports = {
  handleShowReceivablePanel,
  handleShowContractExpiryPanel,
  handleShowBusinessBriefingPanel,
  handleShowApprovalsPanel,
  handleResolveApproval,
  handleShowStockAlertPanel,
  handleShowCustomerPanel,
  handleShowSupplierPanel,
  RECEIVABLE_CONTRACT,
  CONTRACT_EXPIRY_CONTRACT,
  BUSINESS_BRIEFING_CONTRACT,
  APPROVALS_CONTRACT,
  RESOLVE_APPROVAL_CONTRACT,
  STOCK_ALERT_CONTRACT,
  CUSTOMER_VIEW_CONTRACT,
  SUPPLIER_CONTRACT,
};
