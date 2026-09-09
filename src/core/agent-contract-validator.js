/**
 * Agent Contract Validator - validates sub-agent execution contracts
 * 
 * Responsibilities:
 * 1. Validate sub-agent input/output contracts before spawning
 * 2. Enforce capability requirements for spawned agents
 * 3. Track sub-agent execution results for quality scoring
 */

const Ajv = require('ajv');
const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false });

class AgentContractValidator {
  constructor() {
    this._contracts = new Map();
    this._compiledInputValidators = new Map();
    this._compiledOutputValidators = new Map();
    this._executionHistory = [];
    this._maxHistory = 500;
  }

  /**
   * Define a contract for a sub-agent type.
   * @param {string} agentType - e.g. "coder", "researcher", "analyst"
   * @param {object} spec
   *   - requiredCapabilities: string[] - must-have capabilities
   *   - recommendedTools: string[] - tools this agent type should have
   *   - inputSchema: object - JSON Schema for expected input
   *   - outputSchema: object - JSON Schema for expected output  
   *   - maxBudgetTokens: number - token budget limit
   *   - maxIterations: number - max loops before forced return
   *   - timeout: number - execution timeout in ms
   */
  defineContract(agentType, spec) {
    this._contracts.set(agentType, {
      agentType,
      requiredCapabilities: spec.requiredCapabilities || [],
      recommendedTools: spec.recommendedTools || [],
      inputSchema: spec.inputSchema || { type: "object", properties: {}, required: [] },
      outputSchema: spec.outputSchema || { type: "object", properties: {}, required: [] },
      maxBudgetTokens: spec.maxBudgetTokens || 8000,
      maxIterations: spec.maxIterations || 10,
      timeout: spec.timeout || 120000,
    });
    // Pre-compile validators for performance
    this._compiledInputValidators.set(agentType, ajv.compile(spec.inputSchema || { type: "object", properties: {}, required: [] }));
    this._compiledOutputValidators.set(agentType, ajv.compile(spec.outputSchema || { type: "object", properties: {}, required: [] }));
  }

  /**
   * Validate input data against the agent type's input schema.
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validateInput(agentType, input) {
    const validate = this._compiledInputValidators.get(agentType);
    if (!validate) return { valid: true, errors: [] };
    const ok = validate(input || {});
    if (ok) return { valid: true, errors: [] };
    return { valid: false, errors: validate.errors.map(e => `${e.instancePath} ${e.message}`) };
  }

  /**
   * Validate output data against the agent type's output schema.
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validateOutput(agentType, output) {
    const validate = this._compiledOutputValidators.get(agentType);
    if (!validate) return { valid: true, errors: [] };
    const ok = validate(output || {});
    if (ok) return { valid: true, errors: [] };
    return { valid: false, errors: validate.errors.map(e => `${e.instancePath} ${e.message}`) };
  }

  /**
   * Validate a sub-agent spawn request against its contract.
   * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
   */
  validateSpawn(agentType, agentDef, input) {
    const contract = this._contracts.get(agentType);
    const errors = [];
    const warnings = [];

    if (!contract) {
      warnings.push("No contract defined for agent type: " + agentType + " (unvalidated)");
      return { valid: true, errors, warnings };
    }

    // Check required capabilities
    if (contract.requiredCapabilities.length > 0) {
      const agentCaps = agentDef.capabilities || [];
      for (const cap of contract.requiredCapabilities) {
        if (!agentCaps.includes(cap)) {
          errors.push("Missing capability: " + cap);
        }
      }
    }

    // Check recommended tools
    if (contract.recommendedTools.length > 0) {
      const agentTools = agentDef.tools || [];
      for (const tool of contract.recommendedTools) {
        if (!agentTools.includes(tool)) {
          warnings.push("Missing recommended tool: " + tool);
        }
      }
    }

    // Check budget limits
    if (agentDef.budgetTokens && agentDef.budgetTokens > contract.maxBudgetTokens) {
      warnings.push(
        "Token budget " + agentDef.budgetTokens + " exceeds contract max " + contract.maxBudgetTokens
      );
    }

    // Check iteration limit
    if (agentDef.maxIterations && agentDef.maxIterations > contract.maxIterations) {
      warnings.push(
        "Iterations " + agentDef.maxIterations + " exceeds contract max " + contract.maxIterations
      );
    }

    // Check timeout limit
    if (agentDef.timeout && agentDef.timeout > contract.timeout) {
      warnings.push(
        "Timeout " + agentDef.timeout + "ms exceeds contract max " + contract.timeout + "ms"
      );
    }

    // Validate input against input schema
    const inputValidation = this.validateInput(agentType, input);
    if (!inputValidation.valid) {
      errors.push("Input schema violation: " + inputValidation.errors.join("; "));
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  /**
   * Enforce a sub-agent spawn request - throws on failure.
   * @returns {{ valid: true, contract: object }} on success
   * @throws {Error} on validation failure
   */
  enforceSpawn(agentType, agentDef, input) {
    const contract = this._contracts.get(agentType);
    if (!contract) {
      throw new Error(`No contract defined for agent type: ${agentType}`);
    }

    const result = this.validateSpawn(agentType, agentDef, input);
    if (!result.valid) {
      throw new Error(
        `Agent contract enforcement failed for "${agentType}": ${result.errors.join("; ")}`
      );
    }
    return { valid: true, contract };
  }

  /**
   * Record a sub-agent execution result.
   */
  recordExecution(agentType, agentId, input, result) {
    const entry = {
      agentType,
      agentId,
      inputKeys: Object.keys(input || {}),
      success: result?.success !== false,
      duration: result?.duration || 0,
      iterations: result?.iterations || 0,
      tokensUsed: result?.tokensUsed || 0,
      errors: result?.errors || [],
      timestamp: Date.now(),
    };
    this._executionHistory.push(entry);
    if (this._executionHistory.length > this._maxHistory) {
      this._executionHistory.shift();
    }
    return entry;
  }

  /**
   * Get quality score for an agent type based on execution history.
   */
  getQualityScore(agentType) {
    const entries = this._executionHistory.filter(e => e.agentType === agentType);
    if (entries.length === 0) return null;
    const successRate = entries.filter(e => e.success).length / entries.length;
    const avgDuration = entries.reduce((s, e) => s + e.duration, 0) / entries.length;
    const avgTokens = entries.reduce((s, e) => s + e.tokensUsed, 0) / entries.length;
    return {
      agentType,
      executions: entries.length,
      successRate: (successRate * 100).toFixed(1) + "%",
      avgDuration,
      avgTokens,
      lastExecution: entries[entries.length - 1]?.timestamp || 0,
    };
  }

  /**
   * Get all defined contracts.
   */
  getContracts() {
    return Object.fromEntries(this._contracts);
  }

  /**
   * Get execution stats summary.
   */
  getStats() {
    const types = [...new Set(this._executionHistory.map(e => e.agentType))];
    const byType = {};
    for (const t of types) {
      byType[t] = this.getQualityScore(t);
    }
    return {
      totalExecutions: this._executionHistory.length,
      definedContracts: this._contracts.size,
      byType,
    };
  }

  /**
   * Register built-in agent contracts (coder, researcher, planner, analyst).
   */
  registerDefaults() {
    this.defineContract("coder", {
      requiredCapabilities: ["code_generation", "file_editing"],
      recommendedTools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "ApplyPatch"],
      maxBudgetTokens: 16000,
      maxIterations: 25,
      timeout: 300000,
    });

    this.defineContract("researcher", {
      requiredCapabilities: ["web_search", "content_extraction"],
      recommendedTools: ["WebSearch", "WebFetch", "WebExtract", "Read"],
      maxBudgetTokens: 12000,
      maxIterations: 15,
      timeout: 180000,
    });

    this.defineContract("planner", {
      requiredCapabilities: ["planning", "task_decomposition"],
      recommendedTools: ["TodoWrite", "TodoRead", "Read", "Write"],
      maxBudgetTokens: 8000,
      maxIterations: 10,
      timeout: 120000,
    });

    this.defineContract("analyst", {
      requiredCapabilities: ["data_analysis", "reasoning"],
      recommendedTools: ["Read", "Write", "Bash", "Grep"],
      maxBudgetTokens: 12000,
      maxIterations: 15,
      timeout: 180000,
    });
    
    this.defineContract("communicator", {
      requiredCapabilities: ["message_generation", "scheduling"],
      recommendedTools: ["LarkSendText", "WeComSendText", "LarkSendCard", "LarkCreateDocument"],
      maxBudgetTokens: 8000,
      maxIterations: 10,
      timeout: 120000,
    });


    // D1(Runtime差距分析): requiredCapabilities 回填——spawn 时 capabilities 由
    // agent/capability-map.deriveSubagentCapabilities 从该类型的工具白名单派生
    // (subagent-enhanced.js 与 subagent.js 两个消费点已接线),契约校验因此有了
    // 真实输入。取值为两条 spawn 链白名单派生结果的交集:任一链的工具集漂移
    // (如 implement 被移除 exec)都会在此报 Missing capability,强制重新评审。
    this.defineContract("research", {
      requiredCapabilities: ["file_read", "web_search", "web_fetch"],
      recommendedTools: ["read", "web_search", "web_fetch", "memory_search"],
      maxBudgetTokens: 12000, maxIterations: 30, timeout: 300000,
    });
    this.defineContract("implement", {
      requiredCapabilities: ["file_read", "file_write", "code_execution"],
      recommendedTools: ["read", "write", "edit", "exec", "web_search"],
      maxBudgetTokens: 16000, maxIterations: 30, timeout: 300000,
    });
    this.defineContract("verify", {
      requiredCapabilities: ["file_read", "code_execution"],
      recommendedTools: ["read", "exec", "web_search"],
      maxBudgetTokens: 12000, maxIterations: 30, timeout: 300000,
    });
    this.defineContract("analyze", {
      requiredCapabilities: ["file_read"],
      recommendedTools: ["read", "web_search", "memory_search"],
      maxBudgetTokens: 12000, maxIterations: 30, timeout: 300000,
    });
    this.defineContract("coordinator", {
      requiredCapabilities: ["file_read", "subagent_spawn"],
      recommendedTools: ["read", "sessions_spawn", "sessions_send"],
      maxBudgetTokens: 12000, maxIterations: 30, timeout: 300000,
    });
    this.defineContract("worker", {
      requiredCapabilities: ["file_read", "file_write", "code_execution"],
      recommendedTools: ["read", "write", "edit", "exec"],
      maxBudgetTokens: 16000, maxIterations: 30, timeout: 300000,
    });

    console.log("[agent-contract] Default contracts registered: coder, researcher, planner, analyst, communicator + research, implement, verify, analyze, coordinator, worker");
  }
}

const globalAgentContractValidator = new AgentContractValidator();
globalAgentContractValidator.registerDefaults();

module.exports = { AgentContractValidator, globalAgentContractValidator };
