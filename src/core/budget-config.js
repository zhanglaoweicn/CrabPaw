// 2026-09-18 会话膨胀治理层1b: 100K→24K——此前工具结果要超 100KB 才落档,
// 一条 60KB 的读取/搜索结果就带 ~15K tokens 进当轮上下文,是膨胀主源之一。
// 24K 字符 ≈ 6K tokens,常见文件编辑仍能拿到全文;超限走既有落档+预览+引用模式。
const DEFAULT_RESULT_SIZE_CHARS = 24_000;
const DEFAULT_TURN_BUDGET_CHARS = 200_000;
const DEFAULT_PREVIEW_SIZE_CHARS = 1500;

const PINNED_THRESHOLDS = {
  read_file: Infinity,
  search_files: Infinity,
};

class BudgetConfig {
  constructor(opts = {}) {
    this.defaultResultSize = opts.defaultResultSize || DEFAULT_RESULT_SIZE_CHARS;
    this.turnBudget = opts.turnBudget || DEFAULT_TURN_BUDGET_CHARS;
    this.previewSize = opts.previewSize || DEFAULT_PREVIEW_SIZE_CHARS;
    this.toolOverrides = opts.toolOverrides || {};
  }

  resolveThreshold(toolName) {
    if (toolName in PINNED_THRESHOLDS) {
      return PINNED_THRESHOLDS[toolName];
    }
    if (toolName in this.toolOverrides) {
      return this.toolOverrides[toolName];
    }
    return this.defaultResultSize;
  }
}

const DEFAULT_BUDGET = new BudgetConfig();

module.exports = {
  BudgetConfig,
  DEFAULT_BUDGET,
  DEFAULT_RESULT_SIZE_CHARS,
  DEFAULT_TURN_BUDGET_CHARS,
  DEFAULT_PREVIEW_SIZE_CHARS,
  PINNED_THRESHOLDS,
};
