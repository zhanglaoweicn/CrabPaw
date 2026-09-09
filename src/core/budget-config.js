const DEFAULT_RESULT_SIZE_CHARS = 100_000;
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
