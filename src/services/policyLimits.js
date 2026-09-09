/**
 * Policy Limits Service
 */
const DEFAULT_LIMITS = {
  maxTokensPerTurn: 100000,
  maxTokensPerSession: 1000000,
  maxToolCallsPerTurn: 20,
  maxConcurrentTasks: 5,
};

class PolicyLimitsService {
  constructor() {
    this._initialized = false;
    this._limits = { ...DEFAULT_LIMITS };
  }

  async initialize({ configDir } = {}) {
    this._configDir = configDir;
    this._initialized = true;
  }

  getLimit(name) { return this._limits[name] ?? null; }
  setLimit(name, value) { this._limits[name] = value; }
  getAllLimits() { return { ...this._limits }; }

  check(name, currentValue) {
    const limit = this._limits[name];
    if (limit == null) return { allowed: true };
    return { allowed: currentValue <= limit, limit, current: currentValue };
  }

  shutdown() { this._initialized = false; }
}

const policyLimitsService = new PolicyLimitsService();
module.exports = { policyLimitsService, PolicyLimitsService };
