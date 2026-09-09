const crypto = require('crypto');
const { EventEmitter } = require('events');
const {
  TASKFLOW_SUB_AGENT_STATUS
} = require('./taskflow-types');
const {
  SubAgentRpcBridge,
  IsolatedTerminal,
  // eslint-disable-next-line no-unused-vars
  RPC_METHOD
} = require('./sub-agent-rpc');
const { FlowEngine } = require('../core/agent/flow-engine');
const { AgentComposer } = require('../core/agent/agent-composer');

const SUB_AGENT_TIMEOUT_MS = 120000;
const MAX_CONCURRENT_SUB_AGENTS = 5;
const MAX_RECURSION_DEPTH = 3;

class SubAgentOrchestrator extends EventEmitter {
  constructor(runtime, store, rpcConfig = {}) {
    super();
    this._runtime = runtime;
    this._store = store;
    this._activeAgents = new Map();
    this._agentResults = new Map();
    this._maxConcurrent = MAX_CONCURRENT_SUB_AGENTS;
    this._maxDepth = MAX_RECURSION_DEPTH;
    this._rpcEnabled = rpcConfig.enabled !== false;
    this._rpcConfig = rpcConfig;
    this._rpcBridge = null;
    this._terminals = new Map();
    this._flowEngine = rpcConfig.flowEngine || new FlowEngine();
    this._composer = rpcConfig.composer || new AgentComposer();
  }

  get flowEngine() {
    return this._flowEngine;
  }

  get composer() {
    return this._composer;
  }

  async initRpc() {
    if (!this._rpcEnabled) return;
    this._rpcBridge = new SubAgentRpcBridge(this, this._rpcConfig);
    await this._rpcBridge.start();

    this._rpcBridge.on('agent_registered', ({ agentId }) => {
      this.emit('rpc_agent_registered', { agentId, timestamp: Date.now() });
    });

    this._rpcBridge.on('agent_disconnected', ({ agentId }) => {
      const agent = this._activeAgents.get(agentId);
      if (agent && agent.status === TASKFLOW_SUB_AGENT_STATUS.RUNNING) {
        agent.status = TASKFLOW_SUB_AGENT_STATUS.FAILED;
        agent.error = 'RPC 连接断开';
        agent.completedAt = Date.now();
        this._activeAgents.delete(agentId);
        this.emit('agent_failed', {
          agentId,
          error: 'RPC 连接断开',
          timestamp: Date.now()
        });
      }
    });
  }

  async shutdownRpc() {
    if (this._rpcBridge) {
      await this._rpcBridge.stop();
      this._rpcBridge = null;
    }
    for (const [, terminal] of this._terminals) {
      terminal.stop();
    }
    this._terminals.clear();
  }

  getRpcBridge() {
    return this._rpcBridge;
  }

  async spawnAgent(config) {
    const currentDepth = config.depth || 0;
    if (currentDepth >= this._maxDepth) {
      throw new Error(`子代理递归深度已达上限 (${this._maxDepth})，拒绝创建`);
    }

    const agentId = this._generateAgentId();

    const agent = {
      agentId,
      parentFlowId: config.parentFlowId,
      parentStepId: config.parentStepId,
      goal: config.goal,
      skills: config.skills || [],
      context: config.context || {},
      status: TASKFLOW_SUB_AGENT_STATUS.SPAWNED,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
      timeoutMs: config.timeoutMs || SUB_AGENT_TIMEOUT_MS,
      metadata: config.metadata || {},
      depth: currentDepth
    };

    this._activeAgents.set(agentId, agent);

    if (config.isolatedTerminal) {
      const terminal = new IsolatedTerminal(agentId, {
        cwd: config.workingDir,
        env: config.env,
        shell: config.shell
      });
      this._terminals.set(agentId, terminal);
      terminal.start();

      terminal.on('output', ({ stream, data }) => {
        this.emit('agent_terminal_output', {
          agentId,
          stream,
          data,
          timestamp: Date.now()
        });
      });

      terminal.on('exit', ({ code }) => {
        this._terminals.delete(agentId);
        this.emit('agent_terminal_exited', { agentId, code, timestamp: Date.now() });
      });
    }

    this.emit('agent_spawned', {
      agentId,
      parentFlowId: config.parentFlowId,
      goal: config.goal,
      timestamp: Date.now()
    });

    try {
      agent.status = TASKFLOW_SUB_AGENT_STATUS.RUNNING;
      agent.startedAt = Date.now();

      const result = await this._executeAgent(agent);

      agent.status = TASKFLOW_SUB_AGENT_STATUS.COMPLETED;
      agent.completedAt = Date.now();
      agent.result = result;

      this._agentResults.set(agentId, result);
      this._activeAgents.delete(agentId);
      this._cleanupTerminal(agentId);

      this.emit('agent_completed', {
        agentId,
        parentFlowId: agent.parentFlowId,
        result,
        duration: agent.completedAt - agent.startedAt,
        timestamp: Date.now()
      });

      return { agentId, status: 'completed', result };
    } catch (error) {
      agent.status = TASKFLOW_SUB_AGENT_STATUS.FAILED;
      agent.completedAt = Date.now();
      agent.error = error.message;

      this._activeAgents.delete(agentId);
      this._cleanupTerminal(agentId);

      this.emit('agent_failed', {
        agentId,
        parentFlowId: agent.parentFlowId,
        error: error.message,
        timestamp: Date.now()
      });

      return { agentId, status: 'failed', error: error.message };
    }
  }

  async spawnParallelAgents(agents, parentFlowId, parentStepId) {
    const available = this._maxConcurrent - this._activeAgents.size;
    if (available <= 0) {
      throw new Error(`已达到最大并发子代理数 (${this._maxConcurrent})`);
    }

    const batch = agents.slice(0, available);
    const promises = batch.map(config =>
      this.spawnAgent({
        ...config,
        parentFlowId,
        parentStepId
      })
    );

    const results = await Promise.allSettled(promises);

    return results.map((r, i) => {
      if (r.status === 'fulfilled') {
        return r.value;
      }
      return {
        agentId: null,
        status: 'failed',
        error: r.reason?.message || 'Unknown error',
        goal: batch[i].goal
      };
    });
  }

  getAgentStatus(agentId) {
    const agent = this._activeAgents.get(agentId);
    if (!agent) {
      const result = this._agentResults.get(agentId);
      if (result) {
        return {
          agentId,
          status: TASKFLOW_SUB_AGENT_STATUS.COMPLETED,
          result
        };
      }
      return null;
    }

    return {
      agentId: agent.agentId,
      parentFlowId: agent.parentFlowId,
      goal: agent.goal,
      status: agent.status,
      startedAt: agent.startedAt,
      elapsed: agent.startedAt ? Date.now() - agent.startedAt : 0,
      timeoutMs: agent.timeoutMs
    };
  }

  getActiveAgentCount() {
    return this._activeAgents.size;
  }

  async _executeAgent(agent) {
    const execute = async () => {
      const flowConfig = {
        goal: agent.goal,
        steps: this._buildAgentSteps(agent),
        context: {
          ...agent.context,
          _subAgentId: agent.agentId,
          _parentFlowId: agent.parentFlowId,
          _subAgentDepth: agent.depth + 1
        }
      };

      if (this._runtime) {
        const flowId = await this._runtime.createFlow(flowConfig);

        this.emit('agent_flow_created', {
          agentId: agent.agentId,
          flowId,
          timestamp: Date.now()
        });

        return await this._runtime.runFlow(flowId);
      }

      if (agent.skills.length > 0) {
        return {
          goal: agent.goal,
          executed: agent.skills.map(s => s.id || s),
          status: 'simulated'
        };
      }

      return { goal: agent.goal, status: 'no_skills' };
    };

    return Promise.race([
      execute(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`子代理超时 (${agent.timeoutMs}ms): ${agent.goal}`)), agent.timeoutMs)
      )
    ]);
  }

  _buildAgentSteps(agent) {
    const steps = [];

    for (const skill of agent.skills) {
      if (typeof skill === 'string') {
        steps.push({
          id: `${agent.agentId}_${skill}`,
          type: 'skill',
          skillId: skill,
          input: agent.context
        });
      } else if (skill && typeof skill === 'object') {
        steps.push({
          id: `${agent.agentId}_${skill.id || steps.length}`,
          type: skill.type || 'skill',
          skillId: skill.id || skill.skillId,
          input: skill.input || agent.context,
          ...skill
        });
      }
    }

    if (steps.length === 0) {
      steps.push({
        id: `${agent.agentId}_default`,
        type: 'skill',
        skillId: 'general',
        input: { goal: agent.goal, ...agent.context }
      });
    }

    return steps;
  }

  async spawnFlowAgents(flowId, context = {}) {
    const flow = this._flowEngine.get(flowId);
    if (!flow) {
      throw new Error(`Flow template not found: ${flowId}`);
    }

    const results = [];
    const sortedSteps = [...(flow.steps || [])].sort((a, b) => (a.order || 0) - (b.order || 0));

    for (const step of sortedSteps) {
      const domainId = step.domainId || context.defaultDomain || 'tech';
      const capabilityId = step.capabilityId || 'researcher';
      const composedAgent = this._composer.compose(capabilityId, domainId);

      if (!composedAgent) {
        results.push({
          stepName: step.name,
          stepOrder: step.order,
          status: 'skipped',
          reason: `Cannot compose agent: ${capabilityId} × ${domainId}`,
        });
        continue;
      }

      const agentConfig = {
        goal: `${step.name}: ${context.goal || flow.description}`,
        skills: [],
        context: {
          ...context,
          flowId,
          stepName: step.name,
          stepOrder: step.order,
          domainId,
          capabilityId,
          composedAgentId: composedAgent.id,
        },
        metadata: {
          flowId,
          stepName: step.name,
          stepOrder: step.order,
          composedAgentId: composedAgent.id,
        },
      };

      try {
        const result = await this.spawnAgent(agentConfig);
        results.push({
          stepName: step.name,
          stepOrder: step.order,
          agentId: result.agentId,
          status: result.status,
          result: result.result,
          error: result.error,
        });
      } catch (e) {
        results.push({
          stepName: step.name,
          stepOrder: step.order,
          status: 'failed',
          error: e.message,
        });
      }
    }

    this.emit('flow_completed', { flowId, results, timestamp: Date.now() });
    return { flowId, flowName: flow.name, results };
  }

  _generateAgentId() {
    return `sa_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex").slice(0, 8)}`;
  }

  _cleanupTerminal(agentId) {
    const terminal = this._terminals.get(agentId);
    if (terminal) {
      terminal.stop();
      this._terminals.delete(agentId);
    }
  }

  getTerminal(agentId) {
    return this._terminals.get(agentId) || null;
  }

  getTerminalOutput(agentId, lines = 50) {
    const terminal = this._terminals.get(agentId);
    return terminal ? terminal.getRecentOutput(lines) : [];
  }

  sendTerminalInput(agentId, input) {
    const terminal = this._terminals.get(agentId);
    if (terminal && terminal.isRunning()) {
      terminal.write(input);
      return true;
    }
    return false;
  }

  executeTerminalCommand(agentId, command) {
    const terminal = this._terminals.get(agentId);
    if (terminal && terminal.isRunning()) {
      terminal.executeCommand(command);
      return true;
    }
    return false;
  }

  getActiveTerminals() {
    return [...this._terminals.entries()].map(([id, t]) => ({
      agentId: id,
      running: t.isRunning(),
      shell: t.shell,
      cwd: t.cwd
    }));
  }

  async rpcCall(agentId, method, params, timeout) {
    if (!this._rpcBridge) {
      throw new Error('RPC 桥接未初始化');
    }

    const connId = [...this._rpcBridge._agentConnMap.entries()]
      .find(([, aid]) => aid === agentId)?.[0];

    if (!connId) {
      throw new Error(`代理 ${agentId} 无 RPC 连接`);
    }

    return this._rpcBridge.transport.sendRequest(connId, method, params, timeout);
  }

  async rpcBroadcast(method, params) {
    if (!this._rpcBridge) {
      throw new Error('RPC 桥接未初始化');
    }
    this._rpcBridge.transport.broadcast(method, params);
  }
}

module.exports = {
  SubAgentOrchestrator
};
