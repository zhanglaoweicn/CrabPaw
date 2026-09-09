const crypto = require('crypto');
/**
 * 工具编排引擎 - 多工具协作、流水线编排、智能调度
 *
 * 核心能力：
 *   1. 工具流水线 - 多工具按序执行，前一个输出作为后一个输入
 *   2. 并行执行 - 无依赖的工具并行执行
 *   3. 条件分支 - 根据执行结果选择不同路径
 *   4. 错误恢复 - 自动重试、降级、回滚
 *   5. 编排模板 - 预定义常用编排模板
 *
 * 活动流集成：
 *   - executeTool 广播 tool:preparing / tool:executing / tool:result / tool:error 事件
 *   - 通过全局 EventBus 和 ActivityStream 消费，实现实时状态显示
 */

const { EventEmitter } = require('events');
const fs = require('fs').promises;
const path = require('path');
const config = require('./config');
const { DoomLoopDetector } = require('./doom-loop-detector');
const correlationId = require('./correlation-id');

let _doomDetector = null;
function _getDoomDetector() {
  if (!_doomDetector) {
    _doomDetector = new DoomLoopDetector({
      minOccurrences: 3,
      timeWindowMs: 30000,
      confidenceThreshold: 0.7,
    });
    _doomDetector.on('doom_detected', (info) => {
      console.warn('[DoomLoopDetector] Detected loop:', info.pattern, 'confidence:', info.confidence.toFixed(2));
    });
    _doomDetector.on('abort_triggered', (info) => {
      console.warn('[DoomLoopDetector] Abort triggered:', info.pattern);
    });
  }
  return _doomDetector;
}

// ── 活动流集成（懒加载，避免循环依赖） ──
let _activityStream = null;
function _getActivityStream() {
  if (!_activityStream) {
    try {
      _activityStream = require('./activity-stream').globalActivityStream;
    } catch (e) {

      // activity-stream 不可用时静默降级

      console.warn('[tool-orchestrator.js] 空 catch 补日志:', e && e.message);
    }

  }
  return _activityStream;
}
let _activityState = null;
function _getActivityState() {
      if (!_activityState) {
      try {
      _activityState = require('./activity-state').globalActivityState;
      } catch (e) {
        /* noop */
        console.warn('[tool-orchestrator.js] 空 catch 补日志:', e && e.message);
      }
    }
  return _activityState;
}

const ORCHESTRATION_PATH = path.join(config.DATA_DIR, 'tool-orchestration.json');

// 编排状态
const PIPELINE_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
};

// 节点类型
const NODE_TYPES = {
  TOOL: 'tool',           // 工具调用
  PARALLEL: 'parallel',   // 并行执行
  CONDITION: 'condition', // 条件分支
  TRANSFORM: 'transform', // 数据转换
  MERGE: 'merge'          // 合并结果
};

// 预定义编排模板
const ORCHESTRATION_TEMPLATES = {
  // 研究模板：搜索→ 提取 → 分析 \u2192 \u751f\u6210\u62a5\u544a
  research: {
    name: '研究分析',
    description: '搜索信息并生成分析报告',
    nodes: [
      { id: 'search', type: NODE_TYPES.TOOL, tool: 'WebSearch', input: { query: '{{topic}}' } },
      { id: 'fetch', type: NODE_TYPES.TOOL, tool: 'WebFetch', input: { url: '{{search.result.url}}' }, depends: ['search'] },
      { id: 'analyze', type: NODE_TYPES.TRANSFORM, transform: 'extract_key_points', depends: ['fetch'] },
      { id: 'report', type: NODE_TYPES.TOOL, tool: 'Write', input: { content: '{{analyze.result}}' }, depends: ['analyze'] }
    ]
  },

  // 文档处理模板：读取→ 转换 → 写入
  document: {
    name: '文档处理',
    description: '读取文档并转换格式',
    nodes: [
      { id: 'read', type: NODE_TYPES.TOOL, tool: 'Read', input: { path: '{{filePath}}' } },
      { id: 'convert', type: NODE_TYPES.TOOL, tool: 'MarkdownToWord', input: { content: '{{read.result}}' }, depends: ['read'] },
      { id: 'send', type: NODE_TYPES.TOOL, tool: 'SendWecomFile', input: { file: '{{convert.result}}' }, depends: ['convert'] }
    ]
  },

  // 数据查询模板：查询 → 分析 → 可视化
  dataQuery: {
    name: '数据查询分析',
    description: '查询数据并生成分析结果',
    nodes: [
      { id: 'query', type: NODE_TYPES.TOOL, tool: '{{queryTool}}', input: '{{queryInput}}' },
      { id: 'analyze', type: NODE_TYPES.TRANSFORM, transform: 'analyze_data', depends: ['query'] },
      { id: 'write', type: NODE_TYPES.TOOL, tool: 'Write', input: { content: '{{analyze.result}}' }, depends: ['analyze'] }
    ]
  },

  // 飞书集成模板
  larkWorkflow: {
    name: '飞书工作流',    description: '飞书多维表格查询 — 创建文档 → 通知',
    nodes: [
      { id: 'query', type: NODE_TYPES.TOOL, tool: 'LarkQueryBitable', input: '{{queryInput}}' },
      { id: 'createDoc', type: NODE_TYPES.TOOL, tool: 'LarkCreateDocument', input: { content: '{{query.result}}' }, depends: ['query'] },
      { id: 'createRecord', type: NODE_TYPES.TOOL, tool: 'LarkCreateBitableRecord', input: { data: '{{query.result}}' }, depends: ['query'] }
    ]
  },

  // 企业微信集成模板
  wecomWorkflow: {
    name: '企业微信工作流',
    description: '查询数据 — 生成文件 → 发送到企业微信',
    nodes: [
      { id: 'query', type: NODE_TYPES.TOOL, tool: '{{queryTool}}', input: '{{queryInput}}' },
      { id: 'generate', type: NODE_TYPES.TOOL, tool: 'MarkdownToWord', input: { content: '{{query.result}}' }, depends: ['query'] },
      { id: 'send', type: NODE_TYPES.TOOL, tool: 'SendWecomFile', input: { file: '{{generate.result}}' }, depends: ['generate'] }
    ]
  },

  // 多源聚合模板：并行搜索→ 合并 \u2192 \u5206\u6790
  multiSourceResearch: {
    name: '多源聚合研究',
    description: '并行搜索多个来源，合并结果后分析',
    nodes: [
      { id: 'parallel_search', type: NODE_TYPES.PARALLEL, branches: [
        { id: 'web_search', type: NODE_TYPES.TOOL, tool: 'WebSearch', input: { query: '{{topic}}' } },
        { id: 'doc_search', type: NODE_TYPES.TOOL, tool: 'MemorySearch', input: { query: '{{topic}}' } },
      ]},
      { id: 'merge', type: NODE_TYPES.MERGE, depends: ['parallel_search'] },
      { id: 'analyze', type: NODE_TYPES.TRANSFORM, transform: 'synthesize_findings', depends: ['merge'] },
      { id: 'report', type: NODE_TYPES.TOOL, tool: 'Write', input: { content: '{{analyze.result}}' }, depends: ['analyze'] }
    ]
  },

  // 条件路由模板：分析后根据结果走不同路径
  conditionalRoute: {
    name: '条件路由处理',
    description: '根据分析结果选择不同的处理路径',
    nodes: [
      { id: 'analyze', type: NODE_TYPES.TOOL, tool: '{{analyzeTool}}', input: '{{analyzeInput}}' },
      { id: 'route', type: NODE_TYPES.CONDITION, condition: '{{analyze.result.type}}', depends: ['analyze'], branches: {
        'urgent': [
          { id: 'notify', type: NODE_TYPES.TOOL, tool: 'SendMessage', input: { message: '{{analyze.result}}', priority: 'high' } },
        ],
        'normal': [
          { id: 'queue', type: NODE_TYPES.TOOL, tool: 'Write', input: { content: '{{analyze.result}}' } },
        ],
        'ignore': []
      }}
    ]
  },

  // 错误恢复模板：主流程失败时降级
  resilientPipeline: {
    name: '弹性流水线',
    description: '主流程失败时自动降级到备选方案',
    nodes: [
      { id: 'primary', type: NODE_TYPES.TOOL, tool: '{{primaryTool}}', input: '{{primaryInput}}' },
      { id: 'check', type: NODE_TYPES.CONDITION, condition: '{{primary.status}}', depends: ['primary'], branches: {
        'completed': [
          { id: 'finalize', type: NODE_TYPES.TOOL, tool: 'Write', input: { content: '{{primary.result}}' } }
        ],
        'failed': [
          { id: 'fallback', type: NODE_TYPES.TOOL, tool: '{{fallbackTool}}', input: '{{fallbackInput}}' },
          { id: 'finalize_fallback', type: NODE_TYPES.TOOL, tool: 'Write', input: { content: '{{fallback.result}}' }, depends: ['fallback'] }
        ]
      }}
    ]
  }
};

class PipelineNode {
  constructor(config) {
    this.id = config.id;
    this.type = config.type;
    this.tool = config.tool;
    this.input = config.input || {};
    this.depends = config.depends || [];
    this.transform = config.transform;
    this.condition = config.condition;
    // 2026-08-15 P2-5: 分支形状字段此前未随配置拷贝 → CONDITION 执行器读不到
    // 内置模板(conditionalRoute/resilientPipeline)的 branches 与旧式 onTrue/onFalse。
    this.branches = config.branches;
    this.onTrue = config.onTrue;
    this.onFalse = config.onFalse;
    // 2026-08-15 P2-5: _dualStageReview 引用 n.retryCount 但构造器无此字段
    // → 所有节点 retryCount 恒 undefined(>0 比较恒 false)。补 0 初始化。
    this.retryCount = 0;
    this.status = PIPELINE_STATUS.PENDING;
    this.result = null;
    this.error = null;
    this.startTime = null;
    this.endTime = null;
  }

  get duration() {
    if (!this.startTime) return 0;
    return (this.endTime || Date.now()) - this.startTime;
  }
}

class Pipeline {
  constructor(id, config, context = {}) {
    this.id = id;
    this.name = config.name || id;
    this.description = config.description || '';
    this.nodes = (config.nodes || []).map(n => new PipelineNode(n));
    this.context = context;
    this.status = PIPELINE_STATUS.PENDING;
    this.results = {};
    this.startTime = null;
    this.endTime = null;
    this.maxRetries = config.maxRetries || 2;
    this.retryDelay = config.retryDelay || 1000;
  }

  get duration() {
    if (!this.startTime) return 0;
    return (this.endTime || Date.now()) - this.startTime;
  }

  getNode(id) {
    return this.nodes.find(n => n.id === id);
  }

  getReadyNodes() {
    return this.nodes.filter(n => {
      if (n.status !== PIPELINE_STATUS.PENDING) return false;
      return n.depends.every(depId => {
        const dep = this.getNode(depId);
        return dep && dep.status === PIPELINE_STATUS.COMPLETED;
      });
    });
  }

  getParallelGroups() {
    const groups = [];
    const processed = new Set();
    
    while (processed.size < this.nodes.length) {
      const group = this.nodes.filter(n => {
        if (processed.has(n.id)) return false;
        return n.depends.every(d => processed.has(d));
      });
      if (group.length === 0) break;
      groups.push(group);
      group.forEach(n => processed.add(n.id));
    }
    return groups;
  }
}

class ToolOrchestrator extends EventEmitter {
  constructor() {
    super();
    this.pipelines = new Map();
    this.templates = { ...ORCHESTRATION_TEMPLATES };
    this.toolRegistry = null;
    this.data = null;
  }

  async init(toolRegistry) {
    this.toolRegistry = toolRegistry;
    try {
      const raw = await fs.readFile(ORCHESTRATION_PATH, 'utf-8');
      this.data = JSON.parse(raw);
    } catch (e) {
      // 2026-08-15 T7(累积C): 空 catch 补日志——读取失败用默认空数据，属预期降级路径。
      console.warn('[tool-orchestrator] 编排数据读取失败,使用默认空数据:', e?.message || e);
      this.data = { history: [], stats: { totalPipelines: 0, completed: 0, failed: 0, avgDuration: 0 } };
      await this.saveData();
    }
    console.log('🔀 工具编排引擎已初始化');
  }

  async saveData() {
    await fs.writeFile(ORCHESTRATION_PATH, JSON.stringify(this.data, null, 2));
  }

  /**
   * 从模板创建流水线
   */
  createPipelineFromTemplate(templateName, context = {}) {
    const template = this.templates[templateName];
    if (!template) throw new Error(`未知的编排模板? ${templateName}`);
    return this.createPipeline(template, context);
  }

  /**
   * 创建流水线   */
  createPipeline(config, context = {}) {
    const id = `pipeline_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 8)}`;
    const mergedContext = { correlationId: correlationId.getCorrelationId(), ...context };
    const pipeline = new Pipeline(id, config, mergedContext);
    this.pipelines.set(id, pipeline);
    this.emit('pipeline:created', { id, name: pipeline.name });
    return pipeline;
  }

  /**
   * 执行流水线   */
  async executePipeline(pipelineId) {
    const pipeline = this.pipelines.get(pipelineId);
    if (!pipeline) throw new Error(`流水线不存在: ${pipelineId}`);

    pipeline.status = PIPELINE_STATUS.RUNNING;
    pipeline.startTime = Date.now();
    this.emit('pipeline:started', { id: pipelineId });

    try {
      // 按并行分组执行
      const groups = pipeline.getParallelGroups();
      for (const group of groups) {
        // 并行执行同组节点
        const results = await Promise.allSettled(
          group.map(node => this.executeNode(pipeline, node))
        );

        // 检查是否有失败
        const failures = results.filter(r => r.status === 'rejected');
        if (failures.length > 0) {
          // 尝试重试
          for (let i = 0; i < group.length; i++) {
            if (results[i].status === 'rejected') {
              const node = group[i];
              let retried = false;
              for (let retry = 0; retry < pipeline.maxRetries; retry++) {
                try {
                  await new Promise(r => setTimeout(r, pipeline.retryDelay * (retry + 1)));
                  await this.executeNode(pipeline, node);
                  retried = true;
                  break;
                } catch (retryErr) {
                  console.error('[tool-orchestrator] Pipeline retry failed:', {
                    nodeId: node.id,
                    retry: retry + 1,
                    maxRetries: pipeline.maxRetries,
                    error: retryErr.message,
                    stack: retryErr.stack?.split('\n').slice(0, 3).join('\n'),
                  });
                  this.emit('pipeline:retry_failed', {
                    pipelineId,
                    nodeId: node.id,
                    attempt: retry + 1,
                    error: retryErr.message,
                  });
                }
              }
              if (!retried) {
                pipeline.status = PIPELINE_STATUS.FAILED;
                pipeline.endTime = Date.now();
                this.data.stats.failed++;
                this.emit('pipeline:failed', { id: pipelineId, error: results[i].reason });
                await this.saveData();
                return { success: false, error: results[i].reason?.message };
              }
            }
          }
        }
      }

      pipeline.status = PIPELINE_STATUS.COMPLETED;
      pipeline.endTime = Date.now();
      this.data.stats.completed++;
      this.data.stats.totalPipelines++;
      this.data.stats.avgDuration = 
        (this.data.stats.avgDuration * (this.data.stats.completed - 1) + pipeline.duration) / this.data.stats.completed;
      
      // 双阶段审查（参照 Superpowers SDD 模式）
      // 阶段1: 规格合规审查 — 检查执行结果是否符合预期规范
      // 阶段2: 质量审查 — 检查输出质量、错误处理、边界情况
      const reviewResult = await this._dualStageReview(pipeline);
      if (reviewResult.hasIssues) {
        console.warn(`[双阶段审查] 流水线 ${pipelineId} 存在问题: ${reviewResult.summary}`);
        // 不阻断完成，但记录审查结果供上层决策
        pipeline.reviewResult = reviewResult;
      }
      
      this.emit('pipeline:completed', { id: pipelineId, duration: pipeline.duration, reviewResult });
      await this.saveData();

      return {
        success: true,
        results: pipeline.nodes.reduce((acc, n) => ({ ...acc, [n.id]: n.result }), {}),
        duration: pipeline.duration
      };
    } catch (err) {
      pipeline.status = PIPELINE_STATUS.FAILED;
      pipeline.endTime = Date.now();
      this.data.stats.failed++;
      this.emit('pipeline:failed', { id: pipelineId, error: err });
      await this.saveData();
      return { success: false, error: err.message };
    }
  }

  /**
   * 执行单个节点
   */
  async executeNode(pipeline, node) {
    node.status = PIPELINE_STATUS.RUNNING;
    node.startTime = Date.now();

    try {
      // 解析输入（支持模板变量）
      const input = this.resolveInput(node.input, pipeline);

      switch (node.type) {
        case NODE_TYPES.TOOL:
          node.result = await this.executeTool(node.tool, input);
          break;

        case NODE_TYPES.PARALLEL: {
          // S6: PARALLEL 分支此前只读 node.tools 而模板并行节点用 node.branches
          // → node.tools 恒空 → 并行节点实际不执行任何工具(research 模板多源搜索失效)。
          // 优先 branches,回退 tools(兼容旧格式)。
          const branches = Array.isArray(node.branches) && node.branches.length > 0
            ? node.branches
            : (node.tools || []);
          node.result = await Promise.all(
            branches.map(t => this.executeTool(t.tool, this.resolveInput(t.input, pipeline)))
          );
          break;
        }

        case NODE_TYPES.CONDITION: {
          // 2026-08-15 P2-5: 此前只读 node.onTrue/onFalse,而内置模板
          // conditionalRoute/resilientPipeline 用 branches(键=条件值)→ 分支永不执行。
          // 现兼容两种形状: branches(键=条件值/true/false → 节点配置或数组) 与
          // onTrue/onFalse(布尔分支,单节点配置)。{{...}} 模板条件先解析为条件值,
          // 其余按布尔表达式求值(旧行为)。
          const rawCondition = node.condition;
          let condValue;
          if (typeof rawCondition === 'string' && rawCondition.includes('{{')) {
            condValue = this.resolveTemplate(rawCondition, pipeline);
            if (condValue === 'true') condValue = true;
            if (condValue === 'false') condValue = false;
          } else {
            condValue = this.evaluateCondition(rawCondition, pipeline);
          }
          const branchKey = condValue === true ? 'true' : condValue === false ? 'false' : String(condValue);
          const branchNodes = node.branches
            ? (node.branches[branchKey] || node.branches[condValue])
            : (condValue ? node.onTrue : node.onFalse);
          if (branchNodes) {
            const list = Array.isArray(branchNodes) ? branchNodes : [branchNodes];
            node.result = await this._executeBranchNodes(list, pipeline);
          } else {
            node.result = condValue;
          }
          break;
        }

        case NODE_TYPES.TRANSFORM:
          node.result = this.applyTransform(node.transform, pipeline);
          break;

        case NODE_TYPES.MERGE:
          node.result = this.mergeResults(node.depends, pipeline);
          break;

        default:
          throw new Error(`未知的节点类型? ${node.type}`);
      }

      node.status = PIPELINE_STATUS.COMPLETED;
      node.endTime = Date.now();
      pipeline.results[node.id] = node.result;
      this.emit('node:completed', { pipelineId: pipeline.id, nodeId: node.id, duration: node.duration });
      return node.result;
    } catch (err) {
      node.status = PIPELINE_STATUS.FAILED;
      node.error = err.message;
      node.endTime = Date.now();
      this.emit('node:failed', { pipelineId: pipeline.id, nodeId: node.id, error: err.message });
      throw err;
    }
  }

  /**
   * 2026-08-15 P2-5: 执行条件分支节点序列。
   * 内置模板 branches 值为节点配置数组(如 conditionalRoute.urgent → [notify])。
   * 按数组顺序执行(模板内 depends 均为先行后置,顺序执行即满足依赖),
   * 每个分支节点结果写入 pipeline.results[id] 供后续 {{id.result}} 模板解析。
   * 分支节点失败与普通节点一致:抛出 → 上层重试/失败。
   * @param {Array<object>} branchNodeConfigs
   * @param {Pipeline} pipeline
   */
  async _executeBranchNodes(branchNodeConfigs, pipeline) {
    let lastResult = null;
    for (const cfg of branchNodeConfigs) {
      const branchNode = new PipelineNode(cfg);
      lastResult = await this.executeNode(pipeline, branchNode);
    }
    return lastResult;
  }

  /**
   * 执行工具
   * @param {string} toolName
   * @param {object} input
   * @param {{roundId?: string}} [opts] 2026-08-15 T7(累积G): 可选显式 roundId——
   *   编排流水线当前运行在聊天回合之外(无 roundId 可得)，传 null 时
   *   activity-stream 会打 debug 回退标记；未来接入回合上下文时在此传入。
   */
 async executeTool(toolName, input, opts = {}) {
    // 0. Doom Loop Detection - check before executing
    try {
      const doomDetector = _getDoomDetector();
      const argsHash = require('crypto').createHash('sha1').update(JSON.stringify(input || {})).digest('hex');
      doomDetector.recordToolCall(toolName, argsHash);
      
      if (doomDetector.shouldAbort()) {
        const doomInfo = doomDetector.checkDoomLoop();
        return {
          success: false,
          error: `[Doom Loop Detected] Tool execution aborted due to detected loop pattern: ${doomInfo.pattern}`,
          abortReason: 'doom_loop',
          doomPattern: doomInfo.pattern,
          confidence: doomInfo.confidence,
        };
      }
      
      const doomCheck = doomDetector.checkDoomLoop();
      if (doomCheck.detected && doomCheck.confidence > 0.45) {
        console.warn(`[DoomLoopDetector] Warning: ${toolName} - ${doomCheck.pattern} (confidence: ${doomCheck.confidence.toFixed(2)})`);
      }
    } catch (doomErr) {
      console.debug('[ToolOrchestrator] Doom check error (non-fatal):', doomErr.message);
    }

    // 1. Tool Contract validation
    try {
      const { validateToolInput, getToolContract } = require('./tool-contract');
      const contract = getToolContract(toolName);
      if (contract) {
        const validation = validateToolInput(toolName, input);
        if (!validation.valid) {
          return {
            success: false,
            error: `[Tool Contract Violation] ${toolName}: ${validation.errors.join('; ')}`,
            contractErrors: validation.errors,
          };
        }
      }
    } catch (e) { console.error('[ToolOrchestrator] Contract validation error:', e?.message); }

    // 2. PreToolUse hooks
    let currentInput = input;
    try {
      const { globalHooks } = require('./harness-hooks');
      const preResult = await globalHooks.triggerPreToolUse(toolName, input, {});
      if (!preResult.allowed) {
        return {
          success: false,
          error: preResult.blockReason || '[Hooks] Tool execution blocked',
          blockedBy: 'hooks',
        };
      }
      if (preResult.params) {
        currentInput = preResult.params;
      }
    } catch (e) { console.error('[ToolOrchestrator] PreToolUse hook error:', e?.message); }

    // ── 活动流广播：工具准备开始 ──
    // 2026-08-15 T7(累积G): roundId 显式透传(当前无回合上下文 → null,回退 debug 标记在 activity-stream)
    const roundId = opts.roundId || null;
    const as = (() => { try { return require('./activity-stream').globalActivityStream; } catch (e) { console.debug('[tool-orchestrator] activity-stream 加载失败(降级,不广播):', e?.message || e); return null; } })();
    const asv = (() => { try { return require('./activity-state').globalActivityState; } catch (e) { console.debug('[tool-orchestrator] activity-state 加载失败(降级,不广播):', e?.message || e); return null; } })();
    if (as) {
      const desc = typeof currentInput === 'object' && currentInput
        ? Object.keys(currentInput).slice(0, 3).join(', ')
        : String(currentInput || '').slice(0, 60);
      as.recordToolEvent('preparing', toolName, { summary: `${toolName}: ${desc}`, roundId });
    }
    if (asv) asv.consume('tool:preparing', { toolName });

    if (!this.toolRegistry) throw new Error('工具注册表未初始化');
    // 优先通过 registry.execute 执行，确保 preExecuteHooks/postExecuteHooks/执行日志/策略管理器生效
    const reg = this.toolRegistry.registry || this.toolRegistry;
    let result, execError;
    const execStart = Date.now();
    const toolExecContext = { correlationId: correlationId.getCorrelationId() };
    try {
      if (reg && typeof reg.execute === 'function') {
        if (as) as.recordToolEvent('executing', toolName, { roundId });
        if (asv) asv.consume('tool:executing', { toolName });
        const execResult = await reg.execute(toolName, currentInput, toolExecContext);
        if (!execResult.success) {
          throw new Error(execResult.error || `工具执行失败: ${toolName}`);
        }
        result = execResult.data;
      } else {
        // 降级：直接调用 tool.execute（旧路径，不推荐）
        const tool = this.toolRegistry.getTool ? this.toolRegistry.getTool(toolName) : this.toolRegistry[toolName];
        if (!tool) throw new Error(`工具不存在: ${toolName}`);
        if (as) as.recordToolEvent('executing', toolName, { roundId });
        if (asv) asv.consume('tool:executing', { toolName });
        result = await tool.handler(currentInput, toolExecContext);
      }
    } catch (e) {
      // eslint-disable-next-line no-unused-vars
      execError = e;
      if (as) as.recordToolEvent('error', toolName, {
        summary: `工具失败: ${toolName}`,
        detail: e.message,
        duration: Date.now() - execStart,
        roundId,
      });
      if (asv) asv.consume('tool:error', { toolName, message: e.message });
      throw e;
    }
    const execDuration = Date.now() - execStart;

    // ── 活动流广播：工具完成 ──
    if (as) as.recordToolEvent('result', toolName, { duration: execDuration, silent: true, roundId });
    if (asv) asv.consume('tool:result', { toolName });

    // 3. PostToolUse hooks
    try {
      const { globalHooks } = require('./harness-hooks');
      await globalHooks.triggerPostToolUse(toolName, currentInput, result, {});
    } catch (e) { console.error('[ToolOrchestrator] PostToolUse hook error:', e?.message); }
    return result;

  }

  /**
   * 双阶段审查（参照 Superpowers SDD 模式）   * 
   * 阶段1: 规格合规审查 (Spec Compliance) — 检查执行结果是否符合预）   * 阶段2: 质量审查 (Code Quality) \u2014 \u68c0\u67e5\u8f93\u51fa质量、错误处理、边界情）   * 
   * @param {object} pipeline - 已完成的流水线）   * @returns {{ hasIssues: boolean, specCompliance: object, qualityReview: object, summary: string }}
   */
  async _dualStageReview(pipeline) {
    const issues = [];
    const specResult = { passed: true, details: [] };
    const qualityResult = { passed: true, details: [] };

    // 阶段1: 规格合规审查
    for (const node of pipeline.nodes) {
      if (node.status !== PIPELINE_STATUS.COMPLETED) {
        specResult.passed = false;
        specResult.details.push({ nodeId: node.id, issue: `节点未完成? ${node.status}` });
        issues.push(`节点 ${node.id} 未完成`);
        continue;
      }

      // 检查结果是否为空或错误
      if (node.result === null || node.result === undefined) {
        specResult.passed = false;
        specResult.details.push({ nodeId: node.id, issue: '结果为空' });
        issues.push(`节点 ${node.id} 结果为空`);
      }

      // 检查结果是否包含错误标记
      if (node.result && typeof node.result === 'object' && node.result.error) {
        specResult.passed = false;
        specResult.details.push({ nodeId: node.id, issue: `结果包含错误: ${node.result.error}` });
        issues.push(`节点 ${node.id} 结果错误: ${node.result.error}`);
      }

      // 检查写入类工具的输出是否有效
      if (node.tool && ['Write', 'Edit', 'CreateDirectory'].includes(node.tool)) {
        if (node.result && typeof node.result === 'string' && node.result.includes('失败')) {
          specResult.passed = false;
          specResult.details.push({ nodeId: node.id, issue: '写入操作失败' });
          issues.push(`节点 ${node.id} 写入失败`);
        }
      }
    }

    // 阶段2: 质量审查
    // 检查流水线整体执行时间是否异常
    if (pipeline.duration > 60000) {
      qualityResult.details.push({ issue: `执行时间过长: ${pipeline.duration}ms` });
    }

    // 检查重试次数
    const retriedNodes = pipeline.nodes.filter(n => n.retryCount > 0);
    if (retriedNodes.length > 0) {
      qualityResult.details.push({
        issue: `${retriedNodes.length} 个节点需要重试`,
        nodes: retriedNodes.map(n => n.id),
      });
    }

    // 检查并行节点的执行效率
    const parallelNodes = pipeline.nodes.filter(n => n.type === NODE_TYPES.PARALLEL);
    if (parallelNodes.length > 0) {
      for (const pNode of parallelNodes) {
        if (pNode.result && Array.isArray(pNode.result)) {
          const failedItems = pNode.result.filter(r => r && r.error);
          if (failedItems.length > 0) {
            qualityResult.passed = false;
            qualityResult.details.push({
              nodeId: pNode.id,
              issue: `并行执行中?${failedItems.length}/${pNode.result.length} 项失败`,
            });
          }
        }
      }
    }

    const hasIssues = !specResult.passed || !qualityResult.passed;
    const summary = hasIssues
      ? issues.length > 0 ? issues.join('; ') : '质量审查发现问题'
      : '审查通过';

    return { hasIssues, specCompliance: specResult, qualityReview: qualityResult, summary };
  }

  /**
   * 解析输入模板变量
   */
  resolveInput(input, pipeline) {
    if (typeof input === 'string') {
      return this.resolveTemplate(input, pipeline);
    }
    if (typeof input !== 'object' || input === null) return input;
    
    const resolved = {};
    for (const [key, value] of Object.entries(input)) {
      resolved[key] = this.resolveInput(value, pipeline);
    }
    return resolved;
  }

  resolveTemplate(template, pipeline) {
    return template.replace(/\{\{(\w+)\.result\.?(\w*)\}\}/g, (match, nodeId, field) => {
      const result = pipeline.results[nodeId];
      if (!result) return match;
      if (field) return result[field] !== undefined ? result[field] : match;
      return typeof result === 'string' ? result : JSON.stringify(result);
    }).replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return pipeline.context[key] !== undefined ? pipeline.context[key] : match;
    });
  }

  /**
   * 安全条件解析器（替代 new Function()，仅支持安全的比较和逻辑运算）
   * 支持格式: "results.a.success === true", "results.a.count > 0", "!results.a.failed"
   *
   * @deprecated 2026-08-15 P2-4: 求值器已收敛到 security/safe-expression.js
   * (全库唯一实现)。保留本方法签名(results 根前缀)兼容旧调用点,
   * 内部委托 _safeEval。语法子集差异(旧实现左到右无优先级)以 safe-expression
   * 的优先级语义为准——现有模板/测试无依赖旧求值顺序的表达式。
   */
  _safeEvaluate(expr, results) {
    try {
      const { _safeEval } = require('./security/safe-expression');
      return _safeEval(expr, { results });
    } catch (e) {
      console.warn('[tool-orchestrator] 条件求值失败:', e?.message || e, '| expr:', String(expr).slice(0, 120));
      return false;
    }
  }

  /**
   * 评估条件
   */
  evaluateCondition(condition, pipeline) {
    if (typeof condition === 'function') return condition(pipeline.results);
    if (typeof condition === 'string') {
      try {
        return this._safeEvaluate(condition, pipeline.results);
      } catch (e) {
        console.warn('[tool-orchestrator] evaluateCondition 失败:', e?.message || e, '| condition:', String(condition).slice(0, 120));
        return false;
      }
    }
    return !!condition;
  }

  /**
   * 应用数据转换
   */
  applyTransform(transform, pipeline) {
    switch (transform) {
      case 'extract_key_points':
        return this.extractKeyPoints(pipeline.results);
      case 'analyze_data':
        return this.analyzeData(pipeline.results);
      case 'summarize':
        return this.summarize(pipeline.results);
      default:
        return pipeline.results;
    }
  }

  extractKeyPoints(results) {
    // 从结果中提取关键内容
    const content = typeof results === 'string' ? results : JSON.stringify(results);
    return { keyPoints: content.slice(0, 2000), source: 'auto_extract' };
  }

  analyzeData(results) {
    return { analysis: results, timestamp: new Date().toISOString() };
  }

  summarize(results) {
    const content = typeof results === 'string' ? results : JSON.stringify(results);
    return { summary: content.slice(0, 1000), timestamp: new Date().toISOString() };
  }

  /**
   * 合并多个节点的结果   */
  mergeResults(depends, pipeline) {
    const merged = {};
    for (const depId of depends) {
      const node = pipeline.getNode(depId);
      if (node && node.result) {
        merged[depId] = node.result;
      }
    }
    return merged;
  }

  /**
   * 获取编排模板列表
   */
  getTemplates() {
    return Object.entries(this.templates).map(([key, tpl]) => ({
      id: key,
      name: tpl.name,
      description: tpl.description,
      nodeCount: tpl.nodes.length
    }));
  }

  /**
   * 注册自定义模板   */
  registerTemplate(name, template) {
    this.templates[name] = template;
    this.emit('template:registered', { name });
  }

  /**
   * 获取编排统计
   */
  getStats() {
    return {
      ...this.data.stats,
      activePipelines: Array.from(this.pipelines.values()).filter(p => p.status === PIPELINE_STATUS.RUNNING).length,
      templates: Object.keys(this.templates).length
    };
  }
}

let orchestrator = null;
async function getToolOrchestrator(toolRegistry) {
  if (!orchestrator) {
    orchestrator = new ToolOrchestrator();
    await orchestrator.init(toolRegistry);
  }
  return orchestrator;
}

module.exports = {
  ToolOrchestrator,
  Pipeline,
  PipelineNode,
  NODE_TYPES,
  PIPELINE_STATUS,
  ORCHESTRATION_TEMPLATES,
  getToolOrchestrator
};
