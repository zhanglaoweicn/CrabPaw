const { EventEmitter } = require('events');

const CONTEXT_LEVELS = {
  L1_ENTERPRISE: 'l1_enterprise',
  L2_TASK: 'l2_task',
  L3_RESULT: 'l3_result',
};

const FORK_STRATEGIES = {
  FULL_COPY: 'full_copy',
  SELECTIVE: 'selective',
  SUMMARIZED: 'summarized',
  MINIMAL: 'minimal',
};

class ContextForkStrategy extends EventEmitter {
  constructor(config = {}) {
    super();
    this._maxL1Size = config.maxL1Size || 2000;
    this._maxL2Size = config.maxL2Size || 4000;
    this._maxL3Size = config.maxL3Size || 8000;
    this._defaultStrategy = config.defaultStrategy || FORK_STRATEGIES.SELECTIVE;
    this._forkHistory = [];
    this._maxHistory = config.maxHistory || 100;
  }

  fork(parentContext, targetAgent, options = {}) {
    const strategy = options.strategy || this._determineStrategy(targetAgent, parentContext);

    const forkedContext = this._applyStrategy(strategy, parentContext, targetAgent, options);

    const record = {
      timestamp: Date.now(),
      strategy,
      targetAgent: targetAgent.id || targetAgent,
      parentContextSize: this._estimateSize(parentContext),
      forkedContextSize: this._estimateSize(forkedContext),
    };

    this._forkHistory.push(record);
    if (this._forkHistory.length > this._maxHistory) {
      this._forkHistory = this._forkHistory.slice(-this._maxHistory);
    }

    this.emit('context:forked', record);
    return forkedContext;
  }

  // eslint-disable-next-line no-unused-vars
  merge(childResults, parentContext, options = {}) {
    const merged = {
      ...parentContext,
    };

    if (!merged._childResults) {
      merged._childResults = [];
    }

    for (const result of childResults) {
      merged._childResults.push({
        agentId: result.agentId,
        domainId: result.domainId,
        capabilityId: result.capabilityId,
        summary: result.summary || this._summarizeResult(result.result),
        success: result.success !== false,
        timestamp: Date.now(),
      });
    }

    if (merged._childResults.length > 10) {
      merged._childResults = merged._childResults.slice(-10);
    }

    this.emit('context:merged', {
      childCount: childResults.length,
      totalResults: merged._childResults.length,
    });

    return merged;
  }

  buildTieredContext(enterpriseProfile, taskContext, resultContext) {
    const l1 = this._buildL1Context(enterpriseProfile);
    const l2 = this._buildL2Context(taskContext);
    const l3 = this._buildL3Context(resultContext);

    const totalSize = this._estimateSize({ l1, l2, l3 });

    if (totalSize > this._maxL1Size + this._maxL2Size + this._maxL3Size) {
      return this._compressTieredContext(l1, l2, l3);
    }

    return { l1, l2, l3, totalSize };
  }

  _determineStrategy(targetAgent, context) {
    const contextSize = this._estimateSize(context);

    if (contextSize > this._maxL2Size * 2) {
      return FORK_STRATEGIES.SUMMARIZED;
    }

    if (targetAgent.tier === 'chat') {
      return FORK_STRATEGIES.MINIMAL;
    }

    if (targetAgent.tier === 'reasoning') {
      return FORK_STRATEGIES.SELECTIVE;
    }

    if (targetAgent.tier === 'worker') {
      return FORK_STRATEGIES.FULL_COPY;
    }

    return this._defaultStrategy;
  }

  _applyStrategy(strategy, parentContext, targetAgent, _options) {
    switch (strategy) {
      case FORK_STRATEGIES.FULL_COPY:
        return { ...parentContext };

      case FORK_STRATEGIES.SELECTIVE:
        return this._selectiveCopy(parentContext, targetAgent);

      case FORK_STRATEGIES.SUMMARIZED:
        return this._summarizedCopy(parentContext, targetAgent);

      case FORK_STRATEGIES.MINIMAL:
        return this._minimalCopy(parentContext, targetAgent);

      default:
        return { ...parentContext };
    }
  }

  _selectiveCopy(parentContext, targetAgent) {
    const forked = {};

    const alwaysInclude = ['sessionId', 'userId', 'enterpriseProfile', 'domainId', 'capabilityId'];
    for (const key of alwaysInclude) {
      if (parentContext[key] !== undefined) {
        forked[key] = parentContext[key];
      }
    }

    if (targetAgent.domainId && parentContext.domainContexts) {
      forked.domainContext = parentContext.domainContexts[targetAgent.domainId];
    }

    if (parentContext._childResults) {
      forked.previousResults = parentContext._childResults.slice(-3);
    }

    if (parentContext.goal) {
      forked.goal = parentContext.goal;
    }

    return forked;
  }

  _summarizedCopy(parentContext, _targetAgent) {
    const forked = {};

    forked.sessionId = parentContext.sessionId;
    forked.userId = parentContext.userId;
    forked.goal = parentContext.goal;

    if (parentContext.enterpriseProfile) {
      forked.enterpriseType = {
        businessType: parentContext.enterpriseProfile.businessType,
        industry: parentContext.enterpriseProfile.industry,
        scale: parentContext.enterpriseProfile.scale,
      };
    }

    if (parentContext._childResults && parentContext._childResults.length > 0) {
      forked.previousSummary = parentContext._childResults
        .slice(-5)
        .map(r => `${r.agentId}: ${r.summary}`)
        .join('; ');
    }

    return forked;
  }

  _minimalCopy(parentContext, targetAgent) {
    return {
      sessionId: parentContext.sessionId,
      goal: parentContext.goal,
      domainId: targetAgent.domainId || parentContext.domainId,
    };
  }

  _buildL1Context(enterpriseProfile) {
    if (!enterpriseProfile) return {};

    return {
      businessType: enterpriseProfile.businessType,
      industry: enterpriseProfile.industry,
      scale: enterpriseProfile.scale,
      activatedDomains: enterpriseProfile.activatedDomains || [],
      defaultCapabilities: enterpriseProfile.defaultCapabilities || [],
    };
  }

  _buildL2Context(taskContext) {
    if (!taskContext) return {};

    return {
      goal: taskContext.goal,
      domainId: taskContext.domainId,
      capabilityId: taskContext.capabilityId,
      flowId: taskContext.flowId,
      constraints: taskContext.constraints,
    };
  }

  _buildL3Context(resultContext) {
    if (!resultContext) return {};

    return {
      summaries: resultContext.summaries || [],
      keyFindings: resultContext.keyFindings || [],
      artifacts: resultContext.artifacts || [],
    };
  }

  _compressTieredContext(l1, l2, l3) {
    if (JSON.stringify(l3).length > this._maxL3Size) {
      l3.summaries = l3.summaries?.slice(-3);
      l3.keyFindings = l3.keyFindings?.slice(-5);
      l3.artifacts = l3.artifacts?.slice(-3);
    }

    if (JSON.stringify(l2).length > this._maxL2Size) {
      l2.constraints = undefined;
    }

    return { l1, l2, l3, totalSize: this._estimateSize({ l1, l2, l3 }) };
  }

  _summarizeResult(result) {
    if (!result) return '';
    if (typeof result === 'string') return result.slice(0, 200);
    if (result.summary) return result.summary.slice(0, 200);
    return JSON.stringify(result).slice(0, 200);
  }

  _estimateSize(context) {
    try {
      return JSON.stringify(context).length;
    } catch {
      return 0;
    }
  }

  getForkStats() {
    if (this._forkHistory.length === 0) {
      return { totalForks: 0, avgCompressionRatio: 0, strategyDistribution: {} };
    }

    const strategyDist = {};
    let totalCompression = 0;

    for (const record of this._forkHistory) {
      strategyDist[record.strategy] = (strategyDist[record.strategy] || 0) + 1;
      if (record.parentContextSize > 0) {
        totalCompression += record.forkedContextSize / record.parentContextSize;
      }
    }

    return {
      totalForks: this._forkHistory.length,
      avgCompressionRatio: totalCompression / this._forkHistory.length,
      strategyDistribution: strategyDist,
    };
  }
}

module.exports = { ContextForkStrategy, CONTEXT_LEVELS, FORK_STRATEGIES };
