/**
 * Flow Contribution Pattern - 流程贡献模式
 */

class FlowSystem {
  constructor() {
    this.contributions = new Map();
    this.surfaces = new Set(['auth-choice', 'health', 'model-picker', 'setup', 'channel-setup']);
  }

  registerContribution(contribution) {
    if (!contribution.id || !contribution.kind || !contribution.surface || !contribution.option) {
      throw new Error('Invalid contribution: missing required fields');
    }

    const surface = contribution.surface;
    if (!this.contributions.has(surface)) {
      this.contributions.set(surface, []);
    }

    this.contributions.get(surface).push(contribution);
    return this;
  }

  getContributions(surface) {
    const contributions = this.contributions.get(surface) || [];
    return this.sortByPriority(contributions);
  }

  mergeContributions(primary, fallbacks = []) {
    const byValue = new Map();
    
    for (const c of primary) {
      byValue.set(c.option.value, c);
    }
    
    for (const c of fallbacks) {
      if (!byValue.has(c.option.value)) {
        byValue.set(c.option.value, c);
      }
    }
    
    return [...byValue.values()];
  }

  sortByPriority(contributions) {
    return [...contributions].sort((a, b) => {
      const priorityOrder = { provider: 1, channel: 2, core: 3, search: 4 };
      const aPriority = priorityOrder[a.kind] || 99;
      const bPriority = priorityOrder[b.kind] || 99;
      
      if (aPriority !== bPriority) return aPriority - bPriority;
      
      return a.option.label.localeCompare(b.option.label);
    });
  }

  clear() {
    this.contributions.clear();
  }
}

class FlowBuilder {
  constructor(flowSystem) {
    this.flowSystem = flowSystem;
    this.steps = [];
  }

  addStep(step) {
    this.steps.push(step);
    return this;
  }

  async run(context = {}) {
    const results = [];
    
    for (const step of this.steps) {
      try {
        const result = await step.execute(context);
        results.push(result);
        
        if (result.cancelled) {
          return { cancelled: true, results };
        }
        
        context = { ...context, ...result.data };
      } catch (error) {
        console.error(`Flow step failed: ${step.name}`, error);
        throw error;
      }
    }
    
    return { cancelled: false, results, context };
  }
}

class FlowStep {
  constructor(name, execute) {
    this.name = name;
    this.execute = execute;
  }
}

const flowSystem = new FlowSystem();

function registerProviderFlow(contributions) {
  for (const contribution of contributions) {
    flowSystem.registerContribution({
      id: `provider:${contribution.surface}:${contribution.option.value}`,
      kind: 'provider',
      surface: contribution.surface,
      option: contribution.option,
      source: 'manifest',
    });
  }
}

function registerChannelFlow(contributions) {
  for (const contribution of contributions) {
    flowSystem.registerContribution({
      id: `channel:${contribution.surface}:${contribution.option.value}`,
      kind: 'channel',
      surface: contribution.surface,
      option: contribution.option,
      source: 'runtime',
    });
  }
}

module.exports = {
  FlowSystem,
  FlowBuilder,
  FlowStep,
  flowSystem,
  registerProviderFlow,
  registerChannelFlow,
};
