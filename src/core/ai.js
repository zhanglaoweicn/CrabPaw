const history = require('./history-index');
const path = require('path');
// 2026-08-15 P2-7: 执行验证门(幻觉防护)状态从模块级移入 chatStream 局部——
// 模块级共享会让 A 用户的验证门触发强制 B 用户 tool_choice='required'(跨请求竞态)。
const { WORKSPACE_DIR } = require('./config');
const { memoryManager, addMessage: unifiedAddMessage } = require('./unified-memory');
const { registry, addConfirmedPattern } = require('../tools');
const { loadSkills, buildSkillsPrompt, buildSkillsPromptScoped } = require('./skills');
const { smartExtractArguments, substituteArguments } = require('../skills/argument-substitution');
const lifecycleManager = require('./lifecycle-manager');
const { buildSystemPrompt, buildLayeredSystemPrompt, buildRuntimeInfo } = require('./system-prompt');
const { enhancedTaskExecutor } = require('../services/enhanced-task-executor');
const { createModelRouter, getModelRouter } = require('./model-router');
const { optimizeCacheBreakpoints, estimateCacheSavings } = require('./caching/prompt-cache');
const { recordUsage } = require('./usage-stats');
const { contextCache } = require('./context-cache');
// getMaxToolCallsPerTurn / getToolsetManager 已移至 ./ai/tool-definitions.js（由子模块内部使用）
const { loadSmartContext, buildCompactMemoryPrompt } = require('./memory-smart-loader');
const { ToolCallGuardrail, ToolGuardrailDecision, buildAuditedSyntheticResult, appendGuardrailGuidance } = require('./tool-guardrails');
// 2026-09-04 P3: 激活专家的工具面(enforcement 数据源)——岗位=人设+工具面三元组
const { getActiveExpertToolsets } = require('./expert-context');
const { getCircuitBreakerRegistry } = require('./tool-circuit-breaker');
const ContextCompressor = require('./context/compressor');
const { estimateMessagesTokens } = require('./context/compressor');
const { sanitizeToolDefinitions: _sanitizeToolDefinitions } = require('./schema-sanitizer');
const { getMediaNotifier } = require('./file-notifier');
const { broadcastEvent: sseBroadcastEvent } = require('./sse-broadcast');
const { usageTracker } = require('./skill-usage-tracker');
const { StreamingContextScrubber } = require('./streaming-context-scrubber');
const { PromptInjectionDetector } = require('./security/prompt-injection-detector');
const advancedInjectionDetector = new PromptInjectionDetector({ enabled: true, blockOnDetection: true, warnLevel: 'high' });
// checkpoint-manager 已在孤儿模块清理中删除（globalCheckpointManager/autoCheckpoint 未被使用）
const { classifyApiError, getRecoveryAction, FailoverReason } = require('./error-classifier');
const { StreamingThinkScrubber, stripThinkBlocks } = require('./think-scrubber');
const { StreamingDSMLScrubber } = require('./ai/dsml-stream-scrubber');
const { isEmptyInvalidReply } = require('./ai-utils');
const { checkPromptInjection } = require('./context-scanner');
const { globalTrajectorySaver } = require('./trajectory');
// getTieredSubAgentRunner / AGENT_TIERS 已移至 ./ai/agent-router.js（由 _executeMultiAgentTask 内部使用）
// getSkillEvolution / persistToolResult 已移至 ./ai/tool-call-processor.js（由 createToolExecutor 内部使用）
const { SubdirectoryHintTracker } = require('./context/subdirectory-hints');
const { globalOnboarding } = require('./onboarding');
const { globalBusyInputHandler } = require('./busy-input-handler');
const { preprocessContextReferences } = require('./context/context-references');
const { isRateLimited, recordRateLimit } = require('./rate-limit-guard');
const { DEFAULT_BUDGET } = require('./budget-config');
// getAuxiliaryClient / TASK_TYPES 未使用（auxiliary-client 暂无调用方）
const { isWriteDenied } = require('./file-safety');
// getStreamConsumerManager / StreamConsumer / StreamConsumerConfig 未使用
// preprocessSkillContent / substituteTemplateVars / expandInlineShell 未使用
const { getShellHooksBridge } = require('./shell-hooks');
const { DeliveryRouter } = require('./delivery-router');
// mirrorToSession / mirrorCronOutput 未使用
const { getContextEngineRegistry } = require('./context-engine');
// decideImageInputMode / routeImages / estimateImageTokens 未使用
const { getWebhookAnomalyTracker } = require('./webhook-anomaly');
// getCachedDescription / cacheStickerDescription 未使用
const { globalCommitmentTracker } = require('./commitment/commitment-tracker');
const { globalContextWindowGuard } = require('./context-window-guard');
const { globalKeyRotationManager, executeWithApiKeyRotation, collectProviderApiKeysForExecution } = require('./api-key-rotation');
const { sanitizeToolCallsForProvider, sanitizeMessagesForProvider, validateToolCallIds, repairToolCallIds, repairToolCallArguments } = require('./tool-call-id');
// InboundDebouncer / getChannelDebouncer / resolveChannelDebounceMs 未使用
const { globalHeartbeatPatrol } = require('./heartbeat-patrol');
const { globalDiagnosticCustodian } = require('./diagnostic-custodian');
const { globalToolResultMiddleware } = require('./tool-result-middleware');
const { AGENT_LOOP_CONTRACT } = require('./agent/loop-contract');
const { LoopDetectionMiddleware, RepeatFailureGuard, hashToolCall, DEFAULT_WARN_THRESHOLD, DEFAULT_HARD_LIMIT, DEFAULT_WINDOW_SIZE } = require('./middleware/loop-detection');
// sanitizeImageInput / getProviderImageLimits / buildImageContentBlocks 未使用
const { globalHumanDelay } = require('./human-delay');
const { globalToolDisplay } = require('./tool-display');
const { globalTimeAwareness } = require('./time-awareness');
const { globalConsoleSanitizer, globalAnnouncementManager, globalAgentDeleteSafety } = require('./console-safety');
const { globalStrategyOptimizer } = require('./perception/strategy-optimizer');

// ── Harness Lifecycle ──
const { globalHarnessLifecycle } = require('./harness-lifecycle');

// ── ACI 模式学习（Phase 3） ──
// 把每次成功执行的工具名累积到一个 in-memory buffer，chat 结束时一次性写入
// PatternLearner，这样就能识别"今日早报" → [get_weather, get_hotspot, read_calendar, ...] 这类模式。
const { getPatternLearner } = require('./aci/pattern-learner');
const { buildToolDefinitions, collectEnvironmentIssues: _collectEnvironmentIssues, executeToolCallsConcurrent } = require('./ai/tool-definitions');
const { summarize: _summarizeImpl } = require('./ai-summarizer');
const { parseSkillCall, parseToolCall: _parseToolCallImpl } = require('./ai-parsers');
const { _evaluateAgentRoute, _executeMultiAgentTask: _executeMultiAgentTaskImpl, buildMultiPhasePrompt } = require('./ai/agent-router');
const { createToolExecutor, persistToolResultContent } = require('./ai/tool-call-processor');
const { prepareAndCompressContext } = require('./ai/context-processor');
// detectMessageIntent 已在文件下方声明（line 248 附近），这里直接复用
const _aciBuffer = new Map(); // userId -> { intent, tools: [], startTs }
function _aciBufferReset(userId, intent) {
 _aciBuffer.set(userId, { intent: intent || 'general', tools: [], startTs: Date.now() });
}
function _aciBufferPush(userId, toolName) {
 const buf = _aciBuffer.get(userId);
 if (!buf) return;
 buf.tools.push(toolName);
}
function _aciBufferFlush(userId) {
 const buf = _aciBuffer.get(userId);
 if (!buf || buf.tools.length === 0) { _aciBuffer.delete(userId); return; }
 try {
 const learner = getPatternLearner();
 const elapsed = Date.now() - buf.startTs;
 learner.recordSequence(buf.intent, buf.tools, elapsed);
 } catch (e) { console.warn('[ai] ACI pattern 记录失败:', e?.message || e); }
 _aciBuffer.delete(userId);
}

// 初始化上下文缓存
contextCache.initialize();
contextCache.on('skills-dir-changed', () => {
 console.log('🔄 技能目录变更，重新加载技能定义');
 invalidateSkillsCache();
});

// ── Harness Lifecycle 初始化 ──
// 测试环境下跳过延迟初始化，避免 Jest teardown 后异步泄漏
if (process.env.NODE_ENV !== 'test') {
 setTimeout(() => {
 try { globalHarnessLifecycle.initialize({ maxConsecutiveFailures: 5 }); }
 catch (e) { console.warn('[harness] Lifecycle init failed:', e.message); }
 }, 500);
}

/**
 * 条件性激活过滤
 * 根据当前可用工具列表过滤技能：
 * - requiresTools: 列表中的任一工具不可用时，隐藏该技能
 * - fallbackForTools: 列表中的任一工具可用时，隐藏该技能（它是备选）
 * - platforms: 平台不匹配的技能已在加载时标记
 */

// 从子模块导入（渐进式拆分 - 子模块提供独立可测试版本）
// aiStreaming / toolExec / aiContext 暂未在 ai.js 中直接使用（子模块独立可测）

function filterSkillsByContext(skills, toolNames) {
 return skills.filter(skill => {
 if (skill.platformMismatch) return false;
 if (skill.available === false) return false;

 if (skill.requiresTools && skill.requiresTools.length > 0) {
 const hasAllRequired = skill.requiresTools.every(rt => toolNames.includes(rt));
 if (!hasAllRequired) return false;
 }

 if (skill.fallbackForTools && skill.fallbackForTools.length > 0) {
 const hasPreferred = skill.fallbackForTools.some(ft => toolNames.includes(ft));
 if (hasPreferred) return false;
 }

 return true;
 });
}

let toolCallCallback = null;
let subAgentCallback = null;
let _currentChannel = 'none'; // 跟踪当前对话通道，供工具 context 使用
let _currentUserId = ''; // 跟踪当前用户ID，供工具 context 使用

function setToolCallCallback(callback) {
 toolCallCallback = callback;
}

function setSubAgentCallback(callback) {
 subAgentCallback = callback;
}

const contextCompressor = new ContextCompressor({ maxTokens: 128000 });
const toolGuardrail = new ToolCallGuardrail({ hardStopEnabled: true });
const thinkScrubber = new StreamingThinkScrubber();
const contextScrubber = new StreamingContextScrubber({ scrubMemoryContent: true, scrubInstructionLeaks: true, scrubSensitiveData: true });
const dsmlScrubber = new StreamingDSMLScrubber();
// 2026-08-15 P2-8: 循环检测阈值收敛为单一来源——loop-detection.js 的 DEFAULT
// (3/5/20, 由 evals/test-cases/loop-detection.js 锁定)。此前本地 (2/3/15) 与
// middleware 默认值不一致(双实例阈值漂移: 中间件链 3/5/20, ai 主循环 2/3/15)。
const globalLoopDetector = new LoopDetectionMiddleware({ warnThreshold: DEFAULT_WARN_THRESHOLD, hardLimit: DEFAULT_HARD_LIMIT, windowSize: DEFAULT_WINDOW_SIZE });
// 2026-08-15 P1-5: RepeatFailureGuard 按 userId 隔离——模块级单例让用户 A 的
// 连续失败计数影响并发用户 B 的 forceFinalAnswer 判定。executeToolCall 经
// _currentUserId 取 guard(chat/chatStream 均设置), chatStream 入口对本轮清零。
const _failureGuardByUser = new Map(); // userId -> RepeatFailureGuard
function _getFailureGuard(userId) {
 const key = userId || 'default';
 let guard = _failureGuardByUser.get(key);
 if (!guard) {
   guard = new RepeatFailureGuard();
   _failureGuardByUser.set(key, guard);
   if (_failureGuardByUser.size > 200) {
     _failureGuardByUser.delete(_failureGuardByUser.keys().next().value);
   }
 }
 return guard;
}
const globalFailureGuard = {
 record(tool, argsSig, success, result) { return _getFailureGuard(_currentUserId).record(tool, argsSig, success, result); },
 // 2026-08-15 审查返工 Minor-8: reset() 门面无调用方(死代码)已删——本轮清零
 // 由 chatStream 入口 _getFailureGuard(userId).reset() 完成(P1-5)。
 get consecutive() { return _getFailureGuard(_currentUserId).consecutive; },
};
const sessionImageGenerateSuccess = lifecycleManager.registerMap('sessionImageGenerateSuccess', 1000);
const sessionVideoGenerateSuccess = lifecycleManager.registerMap('sessionVideoGenerateSuccess', 1000);
const subdirectoryHints = new SubdirectoryHintTracker(WORKSPACE_DIR);
const deliveryRouter = new DeliveryRouter();
const shellHooksBridge = getShellHooksBridge();
const contextEngineRegistry = getContextEngineRegistry();
const webhookAnomalyTracker = getWebhookAnomalyTracker();

shellHooksBridge.discoverAndLoad();

if (process.env.NODE_ENV !== 'test') {
  globalHeartbeatPatrol.start();
}
globalHeartbeatPatrol.registerAlert((alert) => {
 console.warn(`💓 [巡检告警] ${alert.name}: ${alert.detail}`);
 if (alert.severity === 'critical') {
 webhookAnomalyTracker.trackAnomaly('heartbeat_critical', alert);
 }
});

globalBusyInputHandler.setProcessCallback(async (input, _metadata) => {
 return chat(input.config, input.skills, input.userId, input.message);
});

const {
 sleep,
 fetchWithRetry,
} = require('./ai/http-helpers');

const lastLarkCard = { card: null, timestamp: 0 };

function getLastLarkCard() {
 const now = Date.now();
 if (now - lastLarkCard.timestamp < 60000) {
 return lastLarkCard.card;
 }
 return null;
}

function clearLastLarkCard() {
 lastLarkCard.card = null;
 lastLarkCard.timestamp = 0;
}

let _loadedSkills = null;
function getLoadedSkills() {
 if (!_loadedSkills) {
 _loadedSkills = loadSkills();
 console.log('📚 已加载技能:', _loadedSkills.length, '个');
 _loadedSkills.forEach(skill => {
 const args = skill.arguments && skill.arguments.length > 0 
 ? ` (参数: ${skill.arguments.join(', ')})` 
 : '';
 console.log(` - ${skill.name}: ${skill.description}${args}`);
 });
 }
 return _loadedSkills;
}

function invalidateSkillsCache() {
 _loadedSkills = null;
}

const pendingConfirmations = lifecycleManager.registerMap('pendingConfirmations', 500, (key, value) => {
 // 淘汰时标记为过期
 if (value) { value.expired = true; value.expiredReason = 'evicted'; }
});
const CONFIRMATION_TTL = 5 * 60 * 1000;

// 使用生命周期管理器注册定时器（lifecycleManager 已在文件顶部导入）
lifecycleManager.registerInterval('pendingConfirmations-cleanup', () => {
 const now = Date.now();
 let cleaned = 0;
 for (const [userId, pending] of pendingConfirmations) {
 if (now - pending.timestamp > CONFIRMATION_TTL) {
 // 审批超时默认拒绝（安全优先）
 pending.expired = true;
 pending.expiredReason = 'confirmation_timeout';
 pendingConfirmations.delete(userId);
 cleaned++;
 }
 }
 if (cleaned > 0) {
 console.log(`🧹 清理了 ${cleaned} 个过期的待确认请求（已自动拒绝）`);
 }
}, 60 * 1000);

// Memory helpers merged into unified-memory.js
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const toolSystem = registry;

// Harness v2: Tool Contract + Hooks integration
const { registerIntoRegistry: registerToolContracts } = require('./tool-contract');
const { globalHooks, HookManager } = require('./harness-hooks');

registerToolContracts(toolSystem);

for (const hook of HookManager.createSafetyHooks()) {
 globalHooks.registerPreToolUse(hook);
}

// ── Harness v2: 权限模式接线 (2026-08-15 P1-1) ──
// PathRuleEngine + createPathPermissionHooks 此前零运行时调用者,config-faq 却宣称
// 支持三模式。现真实接线: DEFAULT 保持接线前现状(见 permissions/path-rules.js),
// PLAN 拦截全部写入, FULL_AUTO 全放行。模式由 config.permissions.mode 驱动
// (默认 DEFAULT,启动时一次性读取;配置热更新不在本任务范围)。钩子内部异常由
// triggerPreToolUse 统一捕获降级 console.warn(Harness 规范)。
const { PathRuleEngine, setPermissionMode } = require('./permissions/path-rules');
try {
 // 直读 config.json 的 permissions.mode(启动时一次性生效;不调用 loadConfig(),
 // 避免在模块加载期引入 fs.watch 持久句柄导致脚本/测试进程无法自然退出)。
 const fs = require('fs');
 const { CONFIG_PATH } = require('./config');
 const rawCfg = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};
 const rawMode = (rawCfg && rawCfg.permissions && rawCfg.permissions.mode) || 'default';
 const mode = String(rawMode).toLowerCase();
 if (mode === 'default' || mode === 'plan' || mode === 'full_auto') {
 setPermissionMode(mode);
 console.log(`🔐 权限模式: ${mode}`);
 } else {
 console.warn(`[ai] 未知权限模式 "${rawMode}",保持 DEFAULT`);
 }
} catch (e) {
 console.warn('[ai] 权限模式初始化失败,保持 DEFAULT:', e?.message || e);
}
const pathRuleEngine = new PathRuleEngine({ workspaceRoot: PROJECT_ROOT });
for (const hook of HookManager.createPathPermissionHooks(pathRuleEngine)) {
 globalHooks.registerPreToolUse(hook);
}

globalHooks.registerIntoRegistry(toolSystem);

const detectMessageIntent = require('./ai/intents').detectMessageIntent;
const CHANNEL_TOOL_EXCLUSIONS = require('./ai/intents').CHANNEL_TOOL_EXCLUSIONS;
const filterToolsByChannel = require('./ai/intents').filterToolsByChannel;
// selectToolsForContext 已移至 ./ai/tool-definitions.js（由 buildToolDefinitions 内部使用）

// buildToolDefinitions 已移至 ./ai/tool-definitions.js（顶部已 import）

// TOOL_TIMEOUTS / getToolTimeout 已移至 ./ai-utils.js 和 ./ai/tool-exec.js（ai.js 内无调用）

// CONCURRENT_SAFE_TOOLS / SEQUENTIAL_AFTER_TOOLS 已移至 ./ai-utils.js (groupToolCallsForConcurrency)
// _collectEnvironmentIssues 已移至 ./ai/tool-definitions.js (collectEnvironmentIssues，顶部已 import)

/**
 * 根据工具名和意图推断请求类别（用于 Category Budget）
 * 用于 budgetEnforcer.checkRequest() 和 budgetEnforcer.recordUsage()
 * 的 category 参数分类。无法推断时返回 null，保持向后兼容。
 *
 * @param {string} [toolName] - 工具名称
 * @param {string} [intent] - 意图提示（可选）
 * @returns {string|null} category 或 null
 */
function _classifyRequestCategory(toolName, _intent) {
 if (!toolName) return null;
 const name = toolName.toLowerCase();
 // 记忆/检索操作
 if (name.includes('memory') || name.includes('recall') || name.includes('remember') || name.includes('retrieve')) return 'memory';
 // 工具契约校验相关
 if (name.includes('contract') || name.includes('validate') || name.includes('verify') || name.includes('guardrail')) return 'tool_validation';
 // 可观测性相关
 if (name.includes('metric') || name.includes('observe') || name.includes('monitor') || name.includes('trace') || name.includes('log') || name.includes('diagnos') || name.includes('health')) return 'observability';
 // 流式输出相关
 if (name.includes('stream') || name.includes('sse')) return 'streaming';
 // 默认工具调用
 return 'tool_call';
}

// 检测当前会话模式（基于消息内容判断）
function _detectSessionMode(message, toolResults) {
 if (!message) return 'discover';
 const msg = message.toLowerCase();
 // 如果上一轮有工具执行成功，切换到 confirm
 if (toolResults && toolResults.some(r => r.success)) return 'confirm';
 // 执行类意图关键词
 const executeKeywords = ['执行', '运行', '创建', '修改', '删除', '安装', '写入', '发送', '买入', '卖出', '提交', '部署', 'run', 'execute', 'create', 'delete', 'install', 'write', 'send'];
 if (executeKeywords.some(k => msg.includes(k))) return 'execute';
 // 默认为信息收集
 return 'discover';
}

// _groupToolCallsForConcurrency 已移至 ./ai-utils.js (groupToolCallsForConcurrency)
// executeToolCallsConcurrent 已移至 ./ai/tool-definitions.js（顶部已 import）

// 2026-08-17: 文件生成流程四步可视化（①资料搜集→②大纲→③内容撰写→④文档生成）。
// 生成意图判定与执行验证门同口径——请求开始即开任务（面板滑入，资料搜集可见），
// Write/转换插桩经 filegen.ensureFileGenTask 复用推进后续阶段。
// 2026-08-22: 文章类词（与 isFileGenIntent 文件词表一致）——命中的生成意图
// 占位 format 用 docx（autoDocx 标记），Write 插桩自动同步生成 Word 文档
// （用户业务场景: "写一篇关于 harness 的介绍性文章"→ 面板 + 同步 WORD）。
// 不加裸词「介绍」——"写一首歌的介绍"会误判。
const ARTICLE_DOCX_RE = /文章|稿件|讲稿|稿子|文案|作文|介绍文|读后|报告|总结|汇报/;

// 2026-09-06: 系统注入片段剥离（isFileGenIntent/maybeStartFileGenTask/继续类判定
// 共用——原 isFileGenIntent 与 maybeStartFileGenTask 两处内联重复，改单源）。
// 剥离后只看用户真实意图文本，防"创建/生成/文件"类注入词污染判定。
function stripSystemInjected(message) {
  return String(message || '')
    .replace(/\[系统提示[:：][^\]]*\]/g, '')
    .replace(/\[用户上传了以下文件:[^\]]*\]/g, '')
    .replace(/文件路径:\s*\n[^\n]*/g, '')
    .replace(/你可以使用 DocRead 工具读取这些文件的内容（参数 path 传入文件路径）。/g, '');
}

function isFileGenIntent(message) {
  if (typeof message !== 'string') return false;
  // 2026-08-20: 剥离系统注入片段——chat-handler 会把工作流建议/附件说明/语音提示
  // 拼进消息尾部，其中"创建/生成/文件"类词会污染判定（实机：上传 .docx + "分析该
  // 文档" → intentAnalyzer 误判 complex_workflow → 注入"此任务可能需要创建工作流"
  // → 与用户消息"文档"双命中 → FileGenPanel 误弹）。判定只看用户真实意图文本；
  // 真实生成意图（"帮我生成一份报告"）不含这些片段，不受影响。
  const userPart = stripSystemInjected(message);
  // 2026-09-07 实机修复: 过去式/回溯引用与查找意图不是新的生成任务——企微实测
  // "之前已经生成了一个html报告，你能找到吗"（生成+html 双命中）误开新任务弹卡。
  // 否决条件：①回溯标记（已经/之前/刚才/刚刚/先前 + 生成|创建|写|做|制作）；
  // ②明确的查找意图（找到|找一下|在哪）。但"重新生成/再做一份"是合法再生成
  // 请求，含再生成祈使词时不否决。
  const hasRegenImperative = /重新(生成|创建|写|做|制作)|再(生成|做|写)|另(存|生成|做)|帮我(生成|创建|写|做|制作)/.test(userPart);
  if (!hasRegenImperative
      && (/((已经|之前|刚才|刚刚|先前)[^。；;]{0,8}(生成|创建|写|做|制作))|(找到|找一下|在哪)/.test(userPart))) {
    return false;
  }
  // 2026-08-22: 文件词表补文章类词——"写一篇介绍性文章"此前不命中, 面板不弹,
  // 生成过程不可见(用户实机观察: 四步指示器缺闭环)。
  // 「写」负向环视排除聊天语境("写得不错/写完了/写作手法"——词表含「文章」后
  // "这篇文章写得不错"会双命中误判弹面板, 实测负例暴露)。
  // 2026-08-23 实机修复: 裸「做」缺位——"做一份PPT/做一份表格"不命中, 面板不弹、
  // 无生成引导、模型自由发挥（e2e 实测零 filegen 事件）。「做」负向环视排除
  // 完成/评价语境(做好/做完/做得/做错/做工精细)。
  return /生成|创建|写(?![得好完了错作])|做(?![得好完了错工])|制作|导出|转换/.test(userPart)
    && /报告|网页|html|文档|文件|word|excel|ppt|pdf|md|文章|稿件|讲稿|稿子|文案|作文|介绍文|读后|总结|汇报|合同|协议|条款|契约|报价单|规范|章程|细则/i.test(userPart);
}

/** 生成意图请求开始 → 惰性开启文件生成任务（①资料搜集）。失败不阻塞请求。
 *  2026-08-22: 返回是否命中——调用处据此注入 FILEGEN_TASK_HINT 事前引导。
 *  2026-09-06: ①网页/HTML 意图占位 format 用 html（卡片起步即网页四步形态，
 *  治"首 Write 是 css 时卡片形态中途漂移"）；②fresh 通道——复用窗口内命中
 *  时清 sources/file、更新 title（治复用残留）；③携带原始消息（error 态重试用）。 */
const FILEGEN_HTML_RE = /网页|html|主页|官网|landing/i;

function maybeStartFileGenTask(message, userId) {
  if (!isFileGenIntent(message)) return false;
  try {
    const filegen = require('./filegen-events');
    const userPart = stripSystemInjected(message);
    // 2026-08-22: 文章类意图 → 占位 docx + autoDocx——Write 写 md 后自动同步
    // 生成 Word（用户场景: 写文章不主动提 WORD 也要出 WORD 文档）。
    // 非文章类保持 md 占位, 由 Write/转换插桩采纳实际格式覆盖。
    const isArticle = ARTICLE_DOCX_RE.test(userPart);
    const isHtml = FILEGEN_HTML_RE.test(userPart);
    // 2026-09-06: 执笔专家署名——激活专家时人设已注入每轮对话（内容按专家视角
    // 撰写），署名随任务进卡片头，让"专家介入"在文档卡上可见。
    // userId 显式传入（chat 路径此刻 _currentUserId 尚未更新，取上一请求的残留值）。
    let expertName = null;
    try {
      const { getActiveExpert } = require('./expert-context');
      const active = getActiveExpert((typeof userId === 'string' && userId) || _currentUserId || '');
      if (active && active.name) expertName = String(active.name);
    } catch { /* 专家上下文不可用不署名 */ }
    filegen.ensureFileGenTask({
      title: message.replace(/\s+/g, ' ').trim().slice(0, 40),
      // 意图启动占位——实际产物格式由 Write/转换插桩采纳覆盖。
      // 文章类词优先（"写一篇介绍 html 的文章"是文章不是网页），其次网页
      format: isArticle ? 'docx' : (isHtml ? 'html' : 'md'),
      phase: 'collect',
      label: '正在搜集资料…',
      autoDocx: isArticle || undefined,
      fresh: true,
      originalMessage: message,
      expertName,
    });
    return true;
  } catch (e) {
    console.warn('[filegen] 生成意图任务启动失败(不阻塞):', e.message);
    return false;
  }
}

// 2026-09-06 恢复链路: 继续类消息判定——治"未完成任务恢复后模型把全文直吐对话"。
// 场景（实机）：网页生成任务中断 → 用户说"保留当前对话/继续" → isFileGenIntent
// 不命中（无"生成/写/做"动作词）→ 不开卡不注引导；模型凭上下文把整页内容当文本
// 输出，反直出闸门（shouldForceWriteRetry）同样因消息措辞不命中 FILEGEN_ACTION_RE
// 而放行 → 长文本直进对话窗口。恢复三件套：
//   a) isFileGenResumeMessage 识别继续类表述（短指令直接认，长消息需带任务指代词，
//      防"继续给我讲讲AI资讯"误入）；
//   b) maybeResumeFileGenTask 复活暂停任务 + 注入 FILEGEN_RESUME_HINT（卡片重开）；
//   c) shouldForceWriteRetry 增加 liveFileGenTask 分支（见该函数）。
const FILEGEN_RESUME_RE = /继续|接着|恢复|没做完|未完成|做完它|完成它/;
const FILEGEN_RESUME_TASK_RE = /任务|生成|网页|报告|文档|文章|表格|ppt|excel|word|pdf|md|之前|刚才|上次|那个/i;

function isFileGenResumeMessage(message) {
  const userPart = stripSystemInjected(message).trim();
  if (!userPart || !FILEGEN_RESUME_RE.test(userPart)) return false;
  if (userPart.length <= 8) return true; // "继续" / "继续吧" / "接着做完"——短指令即认
  return FILEGEN_RESUME_TASK_RE.test(userPart);
}

/** 继续类消息 + 存在可恢复任务 → 复活任务（paused→collect、重开复用窗口、重播
 *  surface 让卡片回归）并返回任务上下文供 hint 文案；否则返回 null。失败不阻塞。 */
function maybeResumeFileGenTask(message) {
  if (!isFileGenResumeMessage(message)) return null;
  try {
    const filegen = require('./filegen-events');
    if (!filegen.hasResumableTask()) return null;
    return filegen.resumeFileGenTask();
  } catch (e) {
    console.warn('[filegen] 恢复任务失败(不阻塞):', e.message);
    return null;
  }
}

/** 闸门用: 是否存在未终态生成任务——模块级辅助（chatStreamImpl 内无 filegen
 *  作用域，验证门调用点经此取值）；失败按无任务处理（闸门退回旧判定）。 */
function hasLiveFileGenTask() {
  try {
    return !!require('./filegen-events').hasResumableTask();
  } catch {
    return false;
  }
}

// 2026-09-07 实测修复: 收答保底轮注入文案——"分析表格+生成HTML"任务在深度 6 被强制
// tool_choice=none 收答时, HTML 还没写盘, 模型只能把代码当文本直吐给用户("一堆代码")。
const FILEGEN_GRACE_NUDGE = '⚠️ [收答保底] 本轮对话预算即将用尽，而用户要的产物文件还没有生成。本轮只开放文件生成类工具（Write/Edit/各 Generate，分析类工具已禁用）——请立即调用 Write，把已有分析结论/HTML 写入 data/workspace/ 目录下的文件完成交付（禁止把文件内容当作文字直接输出到对话）；写完后用一两句话向用户交代产物路径与核心结论。';

function fileGenResumeHintFor(task) {
  const what = task.format === 'html' ? '网页' : task.format === 'md' ? '文档' : String(task.format || '文件').toUpperCase();
  return `[文件生成任务·继续] 用户要继续之前未完成的${what}生成任务《${task.title}》。请直接从中断处继续：需要资料就先 WebSearch（结果显示在文件生成面板的资料区），然后用 Write 工具把完整内容写入 data/workspace/ 目录下的文件。禁止把${what}全文直接输出到对话——文件生成面板会展示过程与预览，对话窗口只需 1-2 句话说明进度。`;
}

// 2026-09-06 追问回答链路: paused 任务等待补充需求（典型：引导词"生成一个网页"→
// 模型追问主题→用户回答）。回答往往不含文件词（"做关于智能家居的"），
// isFileGenIntent/isFileGenResumeMessage 均不命中 → 此前该轮无任何生成引导，
// 语音 brevityHint 诱导全文直吐。注入条件 hint 让模型自行分流：是补充需求→继续
// 文件流程；是别的事→正常回答。10 分钟窗口——追问后回答的合理时长，防长期挂起
// 的任务给后续无关聊天注入提示噪声。
const FILEGEN_ANSWER_WINDOW_MS = 10 * 60 * 1000;

function maybePausedFileGenTask() {
  try {
    const t = require('./filegen-events').getPausedTask();
    if (!t) return null;
    if (t.pausedAt && Date.now() - t.pausedAt > FILEGEN_ANSWER_WINDOW_MS) return null;
    return t;
  } catch {
    return null;
  }
}

/** 闸门用: 10 分钟窗口内是否存在 paused 任务（追问回答轮的幻觉兜底判定） */
function hasPausedFileGenTask() {
  return !!maybePausedFileGenTask();
}

function fileGenPausedAnswerHintFor(task) {
  const what = task.format === 'html' ? '网页' : task.format === 'md' ? '文档' : String(task.format || '文件').toUpperCase();
  return `[文件生成任务·等待需求] 此前有一个${what}生成任务《${task.title}》已暂停，等待用户补充需求。如果用户这条消息是在补充它的需求（主题/受众/要点等），请直接继续该任务：需要资料先 WebSearch（结果显示在文件生成面板的资料区），然后用 Write 工具把完整内容写入 data/workspace/ 目录下的文件，禁止把${what}全文直接输出到对话。如果用户在说别的事，请正常回答，不要启动生成。`;
}

// 2026-08-22: 执行验证门判定抽为纯函数（原内联正则词表与 isFileGenIntent 的
// ARTICLE_DOCX_RE 漂移——「写一份演讲稿」连声称完成都不拦）。触发条件：
//   - 生成类请求（动作词 + 文件/文章类词，词表与意图判定统一）
//   - 本轮零工具调用
//   - 回复「声称完成」（已生成/已写好/已完成…）或「长文本直出全文」
//     （≥300 字且 ≥2 个 markdown 标题——模型直接输出文档本体而非调 Write。
//     本次实机：语音模式写演讲稿 → 全文直出对话窗口，卡片卡「搜集资料」，
//     模型说「我先把它写出来给你看」无完成词，旧门不触发）
const FILEGEN_ACTION_RE = /生成|创建|写|做(?![得好完了错工])|制作|导出|转换/;
const FILEGEN_TARGET_RE = /报告|网页|html|文档|文件|word|excel|ppt|pdf|md|文章|稿件|讲稿|稿子|文案|作文|介绍文|读后|总结|汇报/i;
const FILEGEN_CLAIMED_DONE_RE = /已生成|已创建|已写好|已完成|写入成功|文件已|生成好了|\.html|\.md/;
const FILEGEN_TEXT_DUMP_MIN_CHARS = 300;
const FILEGEN_TEXT_DUMP_MIN_HEADINGS = 2;

function shouldForceWriteRetry({ depth, streamTotalToolCalls, message, fullContent, liveFileGenTask, pausedFileGenTask }) {
  if (typeof message !== 'string' || !message || depth >= 3 || streamTotalToolCalls !== 0) return false;
  const content = String(fullContent || '');
  const claimedDone = FILEGEN_CLAIMED_DONE_RE.test(content);
  // 2026-08-23 实机: deepseek 演讲稿直出用 **加粗** 行 + --- 分隔线排版（无 # 标题），
  // 旧 textDump 只看 # 标题 → 门放行（「给你备好了，直接可用——**智能体时代…**」全文直出）。
  // 结构标记 = # 标题行 或 整行加粗（^**…**$）——聊天回复的零星加粗（列表项/强调）不成
  // 结构，需 ≥2 个标记才判长文本直出；纯 # 标题≥2 维持原判定。
  const headings = (content.match(/^#{1,6}\s/gm) || []).length;
  const boldLines = (content.match(/^\*\*[^*\n]+\*\*[^*\n]*$/gm) || []).length;
  const textDump = content.length >= FILEGEN_TEXT_DUMP_MIN_CHARS
    && headings + boldLines >= FILEGEN_TEXT_DUMP_MIN_HEADINGS;
  if (!claimedDone && !textDump) return false;
  // 2026-09-06 恢复链路: 存在未终态生成任务 + 继续类消息 + 模型直吐全文/声称完成 →
  // 同样强制回 Write。"继续"不命中 FILEGEN_ACTION_RE，旧判定放行（实机：网页任务
  // 中断后用户说"保留当前对话"，模型把整页 HTML 当文本吐进对话窗口）。
  if (liveFileGenTask && isFileGenResumeMessage(message)) return true;
  // 2026-09-06 追问回答轮: paused 任务 + 声称完成（"网页已生成"）→ 拦（幻觉兜底）。
  // 只拦 claimedDone 不拦 textDump——回答轮消息往往无文件词，普通长回复误伤面大。
  if (pausedFileGenTask && claimedDone) return true;
  if (!FILEGEN_ACTION_RE.test(message)) return false;
  if (!FILEGEN_TARGET_RE.test(message)) return false;
  return true;
}

// 2026-08-22: 文件生成任务引导提示——意图命中时注入（chat/chatStream）。
// 覆盖语音 brevityHint（chat-handler「1-2 句口语化短句回复，避免标题列表」）
// 对生成任务的文本直出诱导——模型第一轮即走 Write 卡片流程，对话窗口只简短确认。
// 2026-08-23: 分档升级（用户确认「轻量搜索 + 深度才研究」）——
//   轻量文章（演讲稿/介绍性文章）→ 先 WebSearch 2-3 次 → 大纲 → Write；
//   命中深度研究词表 → 走 deep-research 5 步（子问题分解→联邦搜索→提取发现→
//   缺口检测→综合报告，对应 skills/deep-research/SKILL.md）。两者都要求把
//   搜索到的资料与来源展示在文件生成面板（后端已插桩 WebSearch → filegen:source）。
const DEEP_RESEARCH_RE = /深度研究|全面调研|行业报告|竞品分析|技术调研|学术综述|调研报告|深入调研|市场分析|研究报告/;

const FILEGEN_TASK_HINT = '[文件生成任务] 本请求是文件生成任务，请按以下流程执行：\n' +
  '0. 前提判断：若请求缺少主题或内容要求（如只说"生成一个网页/写一份报告"而无任何主题），先用 1-2 句话向用户追问关键信息（主题、受众、要点偏好），此时不要调用搜索或写文件工具，等用户补充后再继续流程；\n' +
  '1. 先使用 WebSearch 工具搜索 2-3 次（不同关键词），搜集与主题相关的资料——每次搜索后从结果中提取关键信息与来源（标题+链接）；（检索过程会实时显示在文件生成面板的「收集资料」区；若跳过检索直接生成，面板将无可展示的检索过程，用户会误以为卡死。除非主题无需外部资料，否则先检索。）；\n' +
  '2. 基于搜集到的资料整理写作大纲（简短列出要点即可，不要输出到对话）；\n' +
  '3. 根据目标格式选择生成路径（禁止用 Bash/ShellExec 运行 Python 脚本来生成文件——脚本生成的文件没有 filegen 插桩，不会在桌面端弹出文件卡片，用户看不到产物，视为失败）：\n' +
  '   - 文章/报告/网页：使用 Write 工具将完整内容写入 data/workspace/ 目录下的文件（.md/.html）；\n' +
  '   - PPT 演示文稿：优先直接用 PptxGenerate 工具（slides 结构化数据）生成 .pptx。内容要求（用户反馈 PPT 内容单薄，务必执行）：每页要点 4-6 条，每条必须是「观点+支撑」完整句（30 字左右，至少含 1 个具体例子、数据或细节），禁止一句话要点；两列对比页左右两列各 3-5 条同样充实；9-12 页结构：封面/背景/原理/应用/对比/挑战/未来/总结；\n' +
  '   - EXCEL 表格：直接用 XlsxGenerate 工具（sheets 结构化数据，顶层传 sheets 数组，不要把 sheets 包在 data 字段里）生成 .xlsx；\n' +
  '   - PDF 文档：直接用 PdfGenerate 工具（content 文本）生成 .pdf。\n' +
  '文件生成面板会实时显示写作过程、资料与预览。\n' +
  '不要将文章全文直接输出到对话中——对话窗口只需 1-2 句简短告知用户当前进度或已完成即可。\n' +
  '4. 文档内容由「文件生成面板」专项文档卡片统一呈现（单栏文档流/产物视图）；不要再生成 document/contract 分页场景预览卡（已停用）。';

const FILEGEN_TASK_HINT_DEEP = '[深度研究任务] 本请求属于深度研究类文件生成任务（报告/调研/综述/竞品分析），请按深度研究五步流程执行：\n' +
  '1. 子问题分解：将研究主题拆解为 3-5 个子问题；\n' +
  '2. 联邦搜索：针对每个子问题使用 WebSearch 搜索，收集多源资料（每次搜索后提取来源标题+链接，供文件生成面板展示）；\n' +
  '3. 提取发现：从搜索结果中提取关键发现，标注来源；\n' +
  '4. 缺口检测：检查资料缺口，必要时补充搜索；\n' +
  '5. 综合报告：将发现综合成完整报告，使用 Write 工具写入 data/workspace/ 目录下的文件（文件生成面板会实时显示过程与预览）。\n' +
  '不要将报告全文直接输出到对话中——对话窗口只需 1-2 句简短告知进度或已完成即可。';

function fileGenHintFor(message) {
  return DEEP_RESEARCH_RE.test(String(message || '')) ? FILEGEN_TASK_HINT_DEEP : FILEGEN_TASK_HINT;
}

// 2026-09-04 Loop 第二刀: 工具前置关卡抽入 agent/tool-gate——参数解析/护栏/熔断/
// 存在性/写保护/preToolHook 六道关卡, 依赖显式注入(agent 层零模块级可变状态)
const { createToolGate } = require('./agent/tool-gate');
const toolGate = createToolGate({
  toolGuardrail,
  globalFailureGuard,
  getCircuitBreakerRegistry,
  toolSystem,
  isWriteDenied,
  shellHooksBridge,
  WORKSPACE_DIR,
  getUserId: () => _currentUserId,
});

// 2026-09-07 实测修复: 模型偶发自带的元信息注解键(description/note 等)在严格契约
// (additionalProperties:false)下会把整次调用拒掉——"分析+HTML"轮实测 ShellExec 带
// description 被误拒("[Tool Contract] / should NOT have additional properties"),
// 白烧一轮工具额度。执行闸前剥离这些无害键(已核实全库 248 契约无一以其为合法参数),
// 契约严格性不变。
const HARMLESS_META_PARAM_KEYS = new Set(['description', 'note', 'reason', 'comment', 'explanation', '_meta']);

function stripHarmlessMetaParams(toolCall) {
  try {
    const raw = toolCall?.function?.arguments;
    if (typeof raw !== 'string' || !raw) return;
    const args = JSON.parse(raw);
    if (!args || typeof args !== 'object' || Array.isArray(args)) return;
    let stripped = false;
    for (const key of Object.keys(args)) {
      if (HARMLESS_META_PARAM_KEYS.has(key)) { delete args[key]; stripped = true; }
    }
    if (stripped) toolCall.function.arguments = JSON.stringify(args);
  } catch { /* 参数非合法 JSON 时保持原样, 交由契约校验兜底 */ }
}

async function executeToolCall(toolCall) {
 stripHarmlessMetaParams(toolCall);
 const gate = await toolGate.gateToolCall(toolCall);
 if (!gate.pass) return gate.result;
 const name = gate.name;
 const params = gate.params;
 const tool = gate.tool;
 const breaker = gate.breaker; // 2026-09-04 Loop 第二刀: 熔断器实例随关卡放行(执行段成败记录用)

 console.log('🔧 执行工具:', name, JSON.stringify(params));
 
 const dirHints = subdirectoryHints.checkToolCall(name, params);
 globalOnboarding.recordToolCall();
 
 try {
 const context = {
 projectRoot: PROJECT_ROOT,
 workspaceDir: WORKSPACE_DIR,
 channel: _currentChannel || 'none',
 userId: _currentUserId || '',
 };

 if (tool.validateInput) {
 const validation = await tool.validateInput(params, context);
 if (!validation.result) {
   const afterDecision = toolGuardrail.afterCall(name, params, { success: false, error: validation.message }, true);
   if (afterDecision.shouldHalt) {
   return { error: buildAuditedSyntheticResult(afterDecision, { phase: 'input_validation' }) };
   }
 return { 
 error: `输入验证失败: ${validation.message}`,
 errorCode: validation.errorCode 
 };
 }
 }

 if (tool.checkPermissions) {
 const permission = await tool.checkPermissions(params, context);
 
 if (permission.behavior === 'deny') {
 return { error: `权限拒绝: ${permission.message}` };
 }
 
 if (permission.behavior === 'ask') {
 return { 
 needsConfirmation: true,
 message: permission.message,
 suggestions: permission.suggestions,
 toolName: name,
 params
 };
 }
 
 if (permission.updatedInput) {
 Object.assign(params, permission.updatedInput);
 }
 }

 // 通过 registry.execute 执行，确保 preExecuteHooks/postExecuteHooks/执行日志/策略管理器生效
 // 2026-09-03 回归修复: runId 注入曾裸引用 globalActivityStream——该标识符在本作用域
 // 未导入(全库惯例为函数内懒加载),ReferenceError 使流式路径所有工具调用报
 // "globalActivityStream is not defined" 全面失败。改为懒加载 + 失败置 null。
 let _runIdForCtx = null;
 try {
  const { globalActivityStream } = require('./activity-stream');
  if (globalActivityStream && typeof globalActivityStream.getCurrentRoundId === 'function') {
   _runIdForCtx = globalActivityStream.getCurrentRoundId();
  }
 } catch (e) { console.warn('[ai] 读取当前 roundId 失败(降级 null):', e?.message || e); }
 const execContext = {
 projectRoot: PROJECT_ROOT,
 workspaceDir: WORKSPACE_DIR,
 channel: _currentChannel || 'none',
 userId: _currentUserId || '',
 // B2/C2/C4(Runtime差距分析): run 上下文穿透到工具层——registry 审批挂起状态更新
 // (waiting_approval)、审计条目 runId 关联都依赖它。无活跃回合(纯 CLI/cron 场景
 // 无 recordLLMEvent('start'))时为 null,下游按 no-op 处理。
 runId: _runIdForCtx,
 };

 let execResult;
 // ── 工具进化指标（2026-08-01 接线：此前 recordToolExecution 从未从主路径调用）──
 const toolStartTime = Date.now();
 const recordToolMetric = (success, error) => {
   try {
     const { getToolEvolutionBridge } = require('./tool-evolution-bridge');
     getToolEvolutionBridge().recordToolExecution(name, {
       success,
       durationMs: Date.now() - toolStartTime,
       error: error ? String(error.message || error) : undefined,
       metadata: { channel: _currentChannel || 'none' },
     });
   } catch (e) { console.warn('[ai] 工具指标记录失败(best-effort):', e?.message || e); }
 };
 // ── Harness: 工具调用开始 ──
 try { globalHarnessLifecycle.onToolCallStart(name); } catch (e) { console.warn('[ai] Harness onToolCallStart failed:', e.message); }
 try {
 execResult = await registry.execute(name, params, execContext);
 } catch (execErr) {
 // ── Harness: 工具调用异常（未返回 execResult）──
 try { globalHarnessLifecycle.onToolCallFailure(name, execErr); } catch (e) { console.warn('[ai] Harness onToolCallFailure failed:', e.message); }
 recordToolMetric(false, execErr);
 // registry.execute 对工具不存在/参数检查失败抛异常，统一处理
 const afterDecision = toolGuardrail.afterCall(name, params, { success: false, error: execErr.message }, true);
 if (afterDecision.shouldHalt) {
 return { error: buildAuditedSyntheticResult(afterDecision, { phase: 'exec_exception' }) };
 }
 try { breaker._onFailure(execErr); } catch (e) { console.warn('[ai] Breaker _onFailure (pre-exec):', e.message); }
 const failureMsg = globalFailureGuard.record(name, hashToolCall({ name, arguments: params }).hash, false, execErr.message);
 if (failureMsg) return { error: failureMsg, circuitBreaker: true };
 return { error: `工具执行失败: ${execErr.message}` };
 }

 // registry.execute 返回 { success, data?, error? }
 // 发布 P1-2: Bash 非零退出——handler 内层已标 success:false,外层 registry 包装恒 success:true。
 // 老板语义「命令失败=工具失败」: 遥测判定以内层为准(不改模型回环/熔断行为,breaker 衡量的
 // 是循环健康而非命令退出码)。
 const bashInnerFailed = name === 'Bash'
   && execResult.data
   && typeof execResult.data.success === 'boolean'
   && execResult.data.success === false;
 if (!execResult.success) {
 // 工具执行失败
 try { globalHarnessLifecycle.onToolCallFailure(name, new Error(execResult.error || '未知错误')); } catch (e) { console.warn('[ai] Harness onToolCallFailure (execResult):', e.message); }
 recordToolMetric(false, execResult.error);
 const errMsg = execResult.error || '未知错误';
 const afterDecision = toolGuardrail.afterCall(name, params, { success: false, error: errMsg }, true);
 if (afterDecision.shouldHalt) {
 return { error: buildAuditedSyntheticResult(afterDecision, { phase: 'exec_failed' }) };
 }
 try { usageTracker.recordCall(name, false); } catch (e) { console.warn('[ai] UsageTracker recordCall failed:', e.message); }
 try { breaker._onFailure(new Error(errMsg)); } catch (e) { console.warn('[ai] Breaker _onFailure (exec error):', e.message); }
 const failureMsg = globalFailureGuard.record(name, hashToolCall({ name, arguments: params }).hash, false, errMsg);
 if (failureMsg) return { error: failureMsg, circuitBreaker: true };
 const isTimeout = errMsg.includes('超时');
 return { error: isTimeout ? errMsg : `工具执行失败: ${errMsg}`, timeout: isTimeout || undefined };
 }

 // 工具执行成功
 const result = execResult.data;
 // ── 2026-08-23: 文件生成研究阶段资料来源插桩 ──
 // WebSearch/WebFetch 命中且存在活跃生成任务 → filegen:source 广播（面板「资料」区：
 // 🔍 关键词 → 来源标题+链接）。无活跃任务（普通聊天搜索）不广播；失败不阻塞工具结果。
 if (name === 'WebSearch' || name === 'WebFetch') {
   try {
     const { sourceFileGen } = require('./filegen-events');
     if (name === 'WebSearch') {
       sourceFileGen(params.query, result.results);
     } else {
       // WebFetch: 单个来源（标题取 url 兜底）
       sourceFileGen(params.url, [{ title: params.url, url: params.url }]);
     }
   } catch (e) { console.warn('[ai] 资料来源插桩失败(不阻塞):', e.message); }
 }
 // ── Harness: 工具调用成功 ──
 try { globalHarnessLifecycle.onToolCallSuccess(name); } catch (e) { console.warn('[ai] Harness onToolCallSuccess failed:', e.message); }
 // 发布 P1-2: 工具进化指标同样以 Bash 内层成功判定为准（qualityScore/successRate 双指标对齐）
 recordToolMetric(!bashInnerFailed);
 const larkCard = result?._lark_card || null;
 let contentResult = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

 // ── 反口播引导：工具结果已通过界面卡片直接展示给用户时，防止 LLM 复述卡片内容 ──
 // scene 工具返回 display 字段表明卡片已实时呈现，复述卡片正文/进度会形成双份通知。
 try {
   const { withAntiNarrationHint } = require('./anti-narration');
   contentResult = withAntiNarrationHint(contentResult, result);
 } catch (e) { console.warn('[ai] anti-narration 模块不可用:', e?.message || e); }

 if (larkCard) {
 lastLarkCard.card = larkCard;
 lastLarkCard.timestamp = Date.now();
 console.log('📋 捕获到 Lark 卡片:', JSON.stringify(larkCard));
 }

 const persistResult = contextCompressor.maybePersistToolResult(
 contentResult, name, toolCall.id
 );
 if (persistResult.persisted) {
 contentResult = persistResult.content;
 console.log(`💾 工具结果已持久化: ${persistResult.filePath}`);
 }

 const afterDecision = toolGuardrail.afterCall(name, params, { success: true }, false);
 if (afterDecision.action === 'warn' && afterDecision.message) {
 contentResult = appendGuardrailGuidance(contentResult, afterDecision);
 }

 // 遥测成功判定加 Bash 内层修正：非零退出按真实失败记录（发布 P1-2）
 try { usageTracker.recordCall(name, !bashInnerFailed); } catch (e) { console.warn('[ai] UsageTracker recordCall (success):', e.message); }
 try { breaker._onSuccess(); } catch (e) { console.warn('[ai] Breaker _onSuccess:', e.message); }
 globalFailureGuard.record(name, hashToolCall({ name, arguments: params }).hash, true, '');

 // ── ACI Phase 3：模式学习 ──
 // 每次工具成功 → push 到当前意图的 chain
 if (_currentUserId) {
 try { _aciBufferPush(_currentUserId, name); } catch (e) { console.warn('[ai] ACI buffer push 失败:', e?.message || e); }
 }

 await shellHooksBridge.invokeHook('post_tool_call', {
 toolName: name,
 toolInput: params,
 // 2026-08-15 P1-6: 同 pre_tool_call——sessionId 按会话归属(此前恒 '')
 sessionId: _currentUserId || '',
 cwd: WORKSPACE_DIR,
 extra: { success: true },
 });

 if (name === 'MusicSearch') {
 try {
 sseBroadcastEvent('music_search', { query: params.query });
 console.log('🎵 [MusicSearch] 已广播音乐搜索事件:', params.query);
 } catch (e) {
 console.warn('[ai] 广播 music_search 事件失败:', e.message);
 }
 }

 if (dirHints) {
 contentResult += dirHints;
 }

 return {
 success: true,
 content: contentResult,
 _lark_card: larkCard
 };
 } catch (error) {
 // 兜底：registry.execute 内部超时等未预期异常
 const isTimeout = error.message && error.message.includes('超时');

 const afterDecision = toolGuardrail.afterCall(name, params, { success: false, error: error.message }, true);
 if (afterDecision.shouldHalt) {
 return { error: buildAuditedSyntheticResult(afterDecision, { phase: 'unexpected_exception' }) };
 }

 try { usageTracker.recordCall(name, false); } catch (e) { console.warn('[ai] UsageTracker recordCall (fallback):', e.message); }

 if (isTimeout) {
 console.error(`⏰ 工具 ${name} 执行超时`);
 try { breaker._onFailure(error); } catch (e) { console.warn('[ai] Breaker _onFailure (timeout):', e.message); }
 const failureMsg = globalFailureGuard.record(name, hashToolCall({ name, arguments: params }).hash, false, error.message);
 if (failureMsg) return { error: failureMsg, circuitBreaker: true };
 return { error: error.message, timeout: true };
 }
 try { breaker._onFailure(error); } catch (e) { console.warn('[ai] Breaker _onFailure (general):', e.message); }
 const failureMsg = globalFailureGuard.record(name, hashToolCall({ name, arguments: params }).hash, false, error.message);
 if (failureMsg) return { error: failureMsg, circuitBreaker: true };

 return { error: `工具执行失败: ${error.message}` };
 }
}

const { parseDSMLToolCalls, stripDSMLTags } = require('./ai/dsml');

function processSkillArguments(skills, userMessage) {
 return skills.map(skill => {
 if (!skill.arguments || skill.arguments.length === 0) {
 return skill
 }

 const params = smartExtractArguments(userMessage, skill.arguments)
 
 if (Object.keys(params).length === 0) {
 return skill
 }

 const processedInstructions = substituteArguments(skill.instructions, params)
 
 console.log(`🔧 技能 ${skill.name} 参数替换:`, params)
 
 return {
 ...skill,
 instructions: processedInstructions,
 extractedParams: params
 }
 })
}

// ── Bootstrap 注入优化（已提取到 bootstrap-injector.js） ──────────────────
const { buildBootstrapBookmark, buildBootstrapDetail } = require('./bootstrap-injector');

// buildBootstrapBookmark, buildBootstrapDetail, injectBootstrapIntoMessages
// 已提取到 bootstrap-injector.js，此处仅保留引用（上方已导入）

// buildBootstrapDetail 已提取到 bootstrap-injector.js

// injectBootstrapIntoMessages 已提取到 bootstrap-injector.js

// buildVolatileContext 已提取到 context-builder.js
const { buildVolatileContext } = require('./context-builder');

// buildVolatileContext 原始实现已迁移，以下保留接口兼容

async function prepareChatContext(config, userId, message, options = {}) {
 const startTime = Date.now();
 const { isStream = false, historyLimit = 20, enableGatewayPreCheck = false, onCompressed = null, onMemoryPrompt = null, enableShouldBlockLog = false, sessionId = null } = options;

 globalLoopDetector.reset(userId);

 // 2026-09-07 实测修复: 注入检测只扫用户原文(rawUserMessage)——message 在
 // chat-handler 会被拼接上传说明/工作流提示/专家人设等系统脚手架，扫描拼接后
 // 全文会把专家人设文本误判为注入攻击(实测"让财务分析师分析"整轮被拦, 用户
 // 看到"出错了, 请重试")。未提供原文时退回旧行为(兼容 CLI/其他调用方)。
 const injectionScanText = (typeof options.rawUserMessage === 'string' && options.rawUserMessage)
 ? options.rawUserMessage
 : message;

 const injectionCheck = checkPromptInjection(injectionScanText);
 if (injectionCheck.injected) {
 console.warn(`⚠️ [${isStream ? '流式' : ''}] 检测到潜在提示注入攻击:`, injectionCheck.findings);
 const blocked = `⚠️ 您的输入被安全扫描拦截。检测到潜在提示注入模式: ${injectionCheck.findings.join(', ')}。请重新表述您的问题。`;
 return { error: blocked, injected: true };
 }

 const advancedCheck = advancedInjectionDetector.detect(injectionScanText);
 if (advancedCheck.detected && advancedCheck.blocked) {
 console.warn(`⚠️ [${isStream ? '流式' : ''}] 高级注入检测拦截:`, advancedCheck.summary);
 const blocked = `⚠️ 您的输入被安全扫描拦截。${advancedCheck.summary}。请重新表述您的问题。`;
 return { error: blocked, injected: true };
 }
 
 let router = getModelRouter();
 if (!router) {
 createModelRouter(config);
 router = getModelRouter();
 }
 
 const routeResult = router.route(message);
 if (routeResult.error) {
 return { error: routeResult.error, routeFailed: true };
 }
 
 const { provider, model, baseUrl, apiKey, reason } = routeResult;
 console.log(`🎯 [${isStream ? '流式' : ''}] 模型路由: ${provider}/${model} (${reason})`);

 try {
 const costRule = globalStrategyOptimizer.getBestRule('cost_control', { dailyCost: 0 });
 if (costRule && costRule.action === 'force_cheapest_model') {
 console.log(`⚙️ [策略] 成本控制策略触发: ${costRule.id} → ${costRule.action}`);
 globalStrategyOptimizer.recordRuleExecution('cost_control', costRule.id, true);
 } else if (costRule && costRule.action === 'enable_cache_priority') {
 globalStrategyOptimizer.recordRuleExecution('cost_control', costRule.id, true);
 }
 } catch (e) { console.warn('⚠️ 成本控制策略执行异常:', e.message); }

 try {
 const modelRule = globalStrategyOptimizer.getBestRule('model_selection', { tokenEstimate: message.length });
 if (modelRule) {
 globalStrategyOptimizer.recordRuleExecution('model_selection', modelRule.id, true);
 }
 } catch (e) { console.warn('⚠️ 模型选择策略执行异常:', e.message); }
 
 if (!apiKey) {
 const noKeyMsg = '请先配置 AI API Key';
 return { error: noKeyMsg, noApiKey: true };
 }
 
 const processedSkills = contextCache.getSkills(
 () => processSkillArguments(getLoadedSkills(), message)
 );
 
 const csChannel = Array.isArray(config.chatChannel) ? config.chatChannel[0] : (config.chatChannel || 'gui');
 const allToolsRaw = contextCache.getToolDefinitions(() => toolSystem.getAll());
 const tools = allToolsRaw.filter(t => {
 // 2026-08-06: chatChannel=none(未接企微/飞书,默认GUI语音)时，同时应用 gui 通道排除——
 // VoiceShell 是主界面，gui 禁 Bash(语音无法审批)必须生效。实测 none 通道漏禁 Bash 一次。
 const channels = Array.isArray(config.chatChannel)
   ? (config.chatChannel.includes('none') ? [...config.chatChannel, 'gui'] : config.chatChannel)
   : [csChannel];
 const exclusions = channels.flatMap(ch => CHANNEL_TOOL_EXCLUSIONS[ch] || []);
 const uniqueExclusions = [...new Set(exclusions)];
 return !uniqueExclusions.includes(t.name);
 });
 const toolNames = tools.map(t => t.name);

 const filteredSkills = filterSkillsByContext(processedSkills, toolNames);
 // P1-4: 技能清单按需注入（无命中自动全量回退，能力零回退）
 const skillPrompt = buildSkillsPromptScoped(message, filteredSkills);

 const memoryContext = await loadSmartContext(userId, message);
 let memoryPrompt = await buildCompactMemoryPrompt(memoryContext);

 // onMemoryPrompt 钩子：允许调用方修改 memoryPrompt（如 ACI 预取缓存注入）
 if (onMemoryPrompt) {
 try {
 const modified = onMemoryPrompt(memoryPrompt);
 if (typeof modified === 'string') memoryPrompt = modified;
 } catch (e) { console.warn('⚠️ onMemoryPrompt 回调异常:', e.message); }
 }

 const toolSummaries = {};
 tools.forEach(t => { toolSummaries[t.name] = t.description; });
 
 const runtimeInfo = buildRuntimeInfo(config);
 const sessionMode = _detectSessionMode(message);
 const environmentIssues = _collectEnvironmentIssues();
 // 注入本机环境信息（systemEnvironment, ）
 let systemEnvironmentText = '';
 try {
 const { getSystemEnvironment } = require('./system-environment');
 systemEnvironmentText = await getSystemEnvironment().formatForPrompt({ maxLength: 600 });
 } catch (e) { console.warn('[ai] 系统环境获取失败(降级):', e?.message || e); }
 // 注入自我画像（自我感知层）
 let selfAwarenessText = '';
 try {
 const { getSelfAwareness } = require('./self-awareness');
 selfAwarenessText = await getSelfAwareness().perceiveLite();
 } catch (e) { console.warn('[ai] 自我画像获取失败(降级):', e?.message || e); }
 const agentScope = {};
 try {
 const { getBudgetEnforcer } = require('./budget-enforcer');
 agentScope.budgetContext = getBudgetEnforcer().getBudgetContext('prompt');
 } catch (e) { console.warn('[ai] budgetContext 获取失败:', e?.message || e); }
 const systemPrompt = contextCache.getSystemPrompt(config, {
 toolNames,
 skillsPrompt: skillPrompt,
 memoryPrompt: memoryPrompt,
 runtimeInfo,
 sessionMode,
 environmentIssues,
 systemEnvironmentText,
 selfAwarenessText,
 agentScope,
 }, () => buildSystemPrompt(config, {
 toolNames,
 toolSummaries,
 skillsPrompt: skillPrompt,
 memoryPrompt: memoryPrompt,
 runtimeInfo,
 sessionMode,
 environmentIssues,
 systemEnvironmentText,
 selfAwarenessText,
 agentScope,
 }));

 // 2026-08-13 P2-4: sessionId 非空时复合缓存键 + 按会话过滤历史
 const historyCacheKey = sessionId ? `${userId}:${sessionId}` : userId;
 const userHistory = await contextCache.getHistory(
 historyCacheKey,
 () => history.getRecentMessages(userId, historyLimit, sessionId)
 );
 
 let timeContext = `\n\n${globalTimeAwareness.buildTimePrompt()}`;
 if (!isStream && userHistory.length > 0) {
 const firstMsg = userHistory[0];
 if (firstMsg.timestamp) {
 const firstTime = new Date(firstMsg.timestamp).toLocaleString('zh-CN', {
 timeZone: 'Asia/Shanghai',
 year: 'numeric', month: '2-digit', day: '2-digit',
 hour: '2-digit', minute: '2-digit', hour12: false
 });
 const lastMsg = userHistory[userHistory.length - 1];
 const lastTime = new Date(lastMsg.timestamp).toLocaleString('zh-CN', {
 timeZone: 'Asia/Shanghai',
 year: 'numeric', month: '2-digit', day: '2-digit',
 hour: '2-digit', minute: '2-digit', hour12: false
 });
 timeContext += `\n[对话时间线: 首次对话 ${firstTime}, 最近对话 ${lastTime}]`;
 }
 }
 const timeStyleHint = globalTimeAwareness.getResponseStyleHint();
 if (timeStyleHint) {
 timeContext += `\n[时段提示: ${timeStyleHint}]`;
 }
 
 const onboardingPrompt = globalOnboarding.buildOnboardingPrompt();
 
 let enhancedMessage = message;
 try {
 const refResult = await preprocessContextReferences(message, {
 cwd: WORKSPACE_DIR,
 allowedRoot: WORKSPACE_DIR,
 });
 if (refResult.injectedTokens > 0) {
 enhancedMessage = refResult.enhancedMessage;
 console.log(`📎 @-引用注入: ${refResult.injectedTokens} tokens`);
 }
 } catch (e) {
 console.warn('📎 @-引用处理失败:', e.message);
 }

 // ── 浏览器数据源路由决策 ────────────────────────────────────
 try {
 const { getBrowserDataSourceManager } = require('./browser-data-sources');
 const dsManager = getBrowserDataSourceManager();
 const channel = Array.isArray(config.chatChannel) ? config.chatChannel[0] : (config.chatChannel || 'gui');
 const routingDirective = dsManager.buildRoutingDirective(message, { channel });
 if (routingDirective && routingDirective.length > 0) {
 const directiveText = routingDirective.join('\n');
 enhancedMessage = directiveText + '\n\n---\n\n' + enhancedMessage;
 const topMatch = dsManager.matchByTrigger(message)[0];
 if (topMatch) {
 console.log(`🔀 数据源路由: ${topMatch.source.name} (${topMatch.source.type}, 匹配度:${topMatch.score}, 渠道:${channel})`);
 }
 }
 } catch (e) {
 console.warn('[ai] Browser data source routing failed:', e.message);
 }

 const layeredPrompt = contextCache.getLayeredSystemPrompt(config, {
 toolNames,
 toolSummaries,
 skillsPrompt: skillPrompt,
 memoryPrompt: memoryPrompt,
 runtimeInfo,
 sessionMode,
 environmentIssues,
 }, ({ cachedStable, cachedContext }) => buildLayeredSystemPrompt(config, {
 toolNames,
 toolSummaries,
 skillsPrompt: skillPrompt,
 memoryPrompt: memoryPrompt,
 runtimeInfo,
 sessionMode,
 environmentIssues,
 cachedStable,
 cachedContext,
 }));

 const systemMessages = [];
 if (layeredPrompt.stable) {
 systemMessages.push({ role: 'system', content: layeredPrompt.stable, cache_control: { type: 'ephemeral' } });
 }

 // 构建 bootstrap 内容（Progressive Disclosure：书签层始终注入，详细层按需加载）
 const bookmarkContent = buildBootstrapBookmark(memoryPrompt);
 const bootstrapContent = buildBootstrapDetail(memoryPrompt);

 // 构建 volatile 上下文（每轮变化：时间、onboarding、主动提示）
 const { volatileParts, proactiveHints } = await buildVolatileContext(
 userId, message, config, timeContext, onboardingPrompt, layeredPrompt
 );
 // 2026-08-25 缓存优化: volatile(当前时间/提示, 逐轮变化)不再占用第二个 system
 // 段——原先位于 stable 之后: 每轮都在前缀中部 break, 其后的大段历史全部 miss
 // (DeepSeek 自动 context cache 按连续前缀匹配)。移至最后一条 user 之前,
 // stable→历史→(volatile)→user 中, 头部字节稳定即大段命中。
 const volatileContent = volatileParts.some(Boolean) ? volatileParts.filter(Boolean).join('\n') : null;

 const messages = [
 ...systemMessages,
 ...userHistory.map(m => ({ role: m.role, content: m.content })),
 ...(volatileContent ? [{ role: 'system', content: volatileContent }] : []),
 { role: 'user', content: enhancedMessage }
 ];

 // Progressive Disclosure 注入 + 压缩 + todo/承诺注入 + 窗口守卫（已提取到 context-processor.js）
 let { compressedMessages, estimatedTokens, contextMaxTokens, compressPersist } = await prepareAndCompressContext({
 messages,
 bookmarkContent,
 bootstrapContent,
 contextCompressor,
 focusTopic: message,
 userId,
 provider,
 model,
 isStream,
 enableGatewayPreCheck,
 userHistory: enableGatewayPreCheck ? userHistory : [],
 onCompressed,
 enableShouldBlockLog,
 });

 // P2-1(2026-08-25) 压缩写回摘要：压缩替换了中段历史时同步落库（删除被替换消息+写摘要行），
 // 下一轮从「原始历史重建」变为「摘要+尾部重建」——结构性消除每轮压缩振荡。
 if (compressPersist && compressPersist.removedIds && compressPersist.removedIds.length > 0) {
   try {
     await history.replaceWithSummary(userId, typeof sessionId === 'string' ? sessionId : null, compressPersist);
   } catch (e) { console.warn('[history] 压缩摘要写回失败:', e.message); }
 }
 // 主动压缩提示：当上下文使用率 > 80% 时，提示模型主动总结
 const usageRatio = estimatedTokens / contextMaxTokens;
 if (usageRatio > 0.8 && usageRatio <= 0.85 && compressedMessages.length > 0) {
 const lastIdx = compressedMessages.length - 1;
 const compressHint = `\n\n[系统提示] 当前上下文使用率约 ${Math.round(usageRatio * 100)}%，接近上限。请在回复末尾主动总结关键信息，以便后续对话可以压缩历史。`;
 compressedMessages[lastIdx] = {
 ...compressedMessages[lastIdx],
 content: compressedMessages[lastIdx].content + compressHint,
 };
 console.log(`📊 [主动压缩提示] 上下文使用率 ${Math.round(usageRatio * 100)}%，已注入压缩提示`);
 }
 
 const idIssues = validateToolCallIds(compressedMessages);
 if (idIssues.length > 0) {
 compressedMessages = repairToolCallIds(compressedMessages);
 }
 compressedMessages = sanitizeMessagesForProvider(compressedMessages, provider);
 
 const rlCheck = isRateLimited({ provider, model });
 if (rlCheck.limited) {
 const waitSec = Math.ceil(rlCheck.remainingMs / 1000);
 const msg = `⏳ 当前模型 ${provider}/${model} 正在限流中，请 ${waitSec} 秒后重试。`;
 return { error: msg, rateLimited: true };
 }
 
 return {
 success: true,
 provider,
 model,
 baseUrl,
 apiKey,
 messages: compressedMessages,
 tools,
 toolNames,
 toolSummaries,
 startTime,
 enhancedMessage,
 userHistory,
 proactiveHints,
 router,
 processedSkills,
 systemPrompt
 };
}

/**
 * S1: 技能自动触发——skill-router 分类器命中时向首轮注入技能推荐。
 *
 * 此前 skill-router 的 16 类任务分类器/40+ 意图正则完全未接入 ai.js 主决策链,
 * LLM 必须自发想起调用 SkillsList→SkillView→executeSkill 三步渐进式披露,
 * 老板说"帮我做个 PPT/融资分析/周报"等高频任务不会自动路由到技能。
 * 本函数: 命中高置信度分类且有可用技能 → 向 system prompt 追加推荐指引,
 * 引导 LLM 首轮主动调用对应技能。覆盖 chat()(文本)与 chatStream()(语音主路径)双入口。
 * 返回 true 表示已注入(供日志)。
 */
function injectSkillGuidance(messages, userMessage) {
  try {
    const { globalSkillRouter } = require('./skill-router');
    // 防御: router 可能未初始化 registry(服务启动未调 skill-system.initialize)
    if (!globalSkillRouter.skillRegistry) {
      try {
        const { getRegistry } = require('./skill-system');
        const reg = getRegistry();
        if (reg) globalSkillRouter.setSkillRegistry(reg);
      } catch (e) { console.warn('[ai] skill-system 不可用:', e?.message || e); }
    }
    // 2026-08-25 修复: minScore 0.6 与「无 executor 技能降权 0.15」(R18 skill-router)
    // 语义冲突——强意图命中也被滤掉,知识注入链实际断路(实测 bilibili 强命中仅 0.142,
    // eval skp_009 必失败)。0.15 降权只用于技能间竞争排序,不应阻断知识注入。
    const recs = globalSkillRouter.getRecommendedSkills(userMessage, { maxResults: 2, minScore: 0.1, userId: _currentUserId });
    if (!recs || recs.length === 0) return false;
    const top = recs[0];

    // R18: 知识库型技能(SKILL.md)直接注入知识,而非引导 LLM 调 executeSkillAdvanced。
    // 大量技能(marketing/multi-search-engine 等)只有 SKILL.md 无 executor,execute 必报
    // "No executor found" → 技能卡黑箱无结果。正确做法: 读 SKILL.md 关键内容注入
    // system prompt,让 LLM 基于专业知识直接产出(写文章/分析等)。
    let skillKnowledge = '';
    try {
      // R18: 从 skill-registry 读 SKILL.md(技能有 filePath)——lifecycle 的 getSkillDetail
      // 对无 executor 技能返回 undefined。读前 3000 字符作为知识注入。
      const reg = globalSkillRouter.skillRegistry;
      const skill = reg && reg[top.name];
      const skPath = skill && (skill.filePath || (skill.baseDir ? require('path').join(skill.baseDir, 'SKILL.md') : ''));
      if (skPath && require('fs').existsSync(skPath)) {
        const md = require('fs').readFileSync(skPath, 'utf-8').slice(0, 3000);
        if (md.trim()) skillKnowledge = md;
      }
    } catch (e) { console.warn('[skill-auto] 读取技能知识失败:', e.message); }

    const guidance = skillKnowledge
      ? `[系统提示] 检测到当前请求属于「${top.category || '任务'}」类型，已加载「${top.name}」专业知识供参考。请基于以下知识,直接完成用户的请求(写文章/分析/方案等),产出完整可交付内容。
========== ${top.name} 知识 ==========
${skillKnowledge}
========== 知识结束 ==========`
      : `[系统提示] 检测到当前请求可能属于「${top.category || '任务'}」类型，建议优先使用专项技能处理以获得更专业的结果。
可用技能: ${recs.map(r => r.name).join('、')}（推荐「${top.name}」）。
请用 SkillsList 查看技能列表、用 SkillView 加载「${top.name}」的 SKILL.md 详情参考。`;

    // 2026-08-25 缓存优化(用户后台 DeepSeek 命中率低): 技能建议此前追加到
    // messages[0].content 尾部——它随上下文每轮变化 → 稳定 system 段失效 →
    // provider 前缀缓存全 miss(DeepSeek 自动 prefix cache)。改插入最后一条
    // user 前(尾置段): 头部 system+tools+历史前缀保持字节稳定, 仅尾部段 miss。
    if (Array.isArray(messages) && messages.length > 0) {
      const lastIdx = messages.length - 1;
      if (messages[lastIdx] && messages[lastIdx].role === 'user') {
        messages.splice(lastIdx, 0, { role: 'system', content: guidance });
      } else {
        messages.push({ role: 'system', content: guidance });
      }
    } else if (Array.isArray(messages)) {
      messages.unshift({ role: 'system', content: guidance });
    } else {
      return false;
    }
    console.log(`[skill-auto] 注入技能知识: ${top.name} (score=${top.score.toFixed(2)}, knowledge=${skillKnowledge ? skillKnowledge.length + '字符' : '无'})`);
    return true;
  } catch (e) {
    console.warn('[skill-auto] 技能推荐注入失败:', e.message);
    return false;
  }
}

// 2026-09-06: 回合收敛包装——chat/chatStream 是文件生成任务的唯一回合边界。
// 包装器在入口调 filegen.beginTurn()（记录回合锚点），在返回/中断/异常的
// finally 里调 settleTurn()：意图开卡但零实质活动 → paused（不再永卡"搜集资料"）；
// 有产物无终态 → 收敛 done（治 done-per-Write 震荡后缺终态）。silent 内部任务
// （记忆提取等）不参与，避免并发时误暂停用户任务。实现体改名 chatImpl/chatStreamImpl。
async function chat(config, skills, userId, message, options = {}) {
  const filegen = require('./filegen-events');
  const isSilent = !!(options && options.silent);
  if (!isSilent) { try { filegen.beginTurn(); } catch (e) { /* 不阻塞 */ } }
  try {
    return await chatImpl(config, skills, userId, message, options);
  } finally {
    if (!isSilent) { try { filegen.settleTurn(); } catch (e) { /* 不阻塞 */ } }
  }
}

async function chatImpl(config, skills, userId, message, options = {}) {
 const startTime = Date.now();
 // 2026-08-17: silent 模式——内部任务（记忆提取等）不写入对话历史。
 // 根因：auto-dream resolveLLMCall 把提取 prompt 当 message 传 chat()，
 // 每次对话后写入主历史 → 历史被 "Extract key info..." 指令污染 →
 // 模型把用户消息当提取任务 → 驴唇不对马嘴。silent 请求无副作用。
 const { silent = false } = options || {};
 console.log('⏱️ [性能] 开始处理请求' + (silent ? ' (silent 内部任务)' : ''));
 globalLoopDetector.reset(userId);

 // ── ACI Phase 3：模式学习 - 开启新的工具链 buffer ──
 try {
 const intent = detectMessageIntent ? (detectMessageIntent(message) || 'general') : 'general';
 _aciBufferReset(userId, intent);
 } catch (e) { console.warn('[ai] ACI buffer reset 失败:', e?.message || e); }

 // ── Harness v2: Dry-Run mode — inspect system health, skip execution ──
 if (config && config.dryRun) {
 const { dryRunInspector } = require('./dry-run-inspector');
 const report = dryRunInspector.inspect();
 console.log('[dry-run] Inspection complete:', report.readiness);
 return JSON.stringify(report, null, 2);
 }
 // ── End Dry-Run ──

 // ── 多智能体管线：复杂工程任务走子智能体协作 ──
 const agentRoute = _evaluateAgentRoute(message);
 // 路由决策事件 — 让前端展示任务分流信息（chat() 无 onChunk，静默跳过）
 if (agentRoute.useMultiAgent) {
 console.log(`🤖 [多智能体] 任务路由: ${agentRoute.archetype} (${agentRoute.reason})`);
 try {
 let router = getModelRouter();
 if (!router) { createModelRouter(config); }
 const agentResult = await _executeMultiAgentTask(config, userId, message, agentRoute);
 if (agentResult) {
 if (!silent) unifiedAddMessage(userId, 'user', message);
 if (!silent) unifiedAddMessage(userId, 'assistant', agentResult);
 contextCache.invalidateHistory(userId);
 globalRequestInterrupt.unregister(userId);
 console.log(`⏱️ [性能] 多智能体总耗时: ${Date.now() - startTime}ms`);
 return agentResult;
 }
 } catch (e) {
 console.warn('⚠️ [多智能体] 执行失败，降级到单智能体模式:', e.message);
 }
 }
 // ── End 多智能体管线 ──

 // ── Task Mode Detection → Auto-execute TaskFlow ──
 const { detectTaskMode } = require('./task-mode-detector');
 const taskDetection = detectTaskMode(message);
 if (taskDetection.isTask && taskDetection.confidence > 0.25) {
 console.log('[task-mode] Task detected (confidence: ' + taskDetection.confidence.toFixed(2) + ')', taskDetection.reasoning.join(', '));
 try {
 const { matchIntentWorkflow } = require('./task-mode-detector');
 const workflow = matchIntentWorkflow(message);
 if (workflow) {
 console.log('[task-mode] Workflow matched:', workflow.workflowId, workflow.plan ? '(dynamic plan)' : '');

 const { taskflowBridge } = require('./taskflow-bridge');
 const { getConversationIntegration } = require('./taskflow-conversation-integration');
 const { globalProgressReporter } = require('./progress-reporter');
 const ci = getConversationIntegration();
 if (ci) {
 globalProgressReporter.bindToConversationIntegration(ci);
 await ci.initialize();
 }

 // Dynamic planner plan or template-based
 const isDynamic = workflow.plan && workflow.plan.steps;
 const bridgeResult = await taskflowBridge.start(message, {
 userId,
 sessionId: userId,
 channel: currentChannel,
 }, {
 template: isDynamic ? null : workflow.workflowId,
 dynamicSteps: isDynamic ? workflow.plan.steps : null,
 autoApprove: true,
 planSummary: isDynamic ? workflow.plan.summary : null,
 });

 if (bridgeResult && bridgeResult.flowId) {
 const summary = isDynamic
 ? '🚀 已启动自动化工作流: ' + workflow.plan.summary
 : '🚀 已启动自动化工作流「' + (bridgeResult.stages || []).join(' → ') + '」';
 unifiedAddMessage(userId, 'assistant', summary);
 contextCache.invalidateHistory(userId);
 try { ci.registerFlow(bridgeResult.flowId, { userId, goal: message.substring(0, 60) }); } catch (e) { console.warn('[ai] Failed to register flow:', e.message); }
 return summary;
 }
 }
 } catch (e) {
 console.warn('[task-mode] TaskFlow dispatch failed, falling back to LLM:', e.message);
 }
 // 2026-09-03(Plan 实体): 多步任务回落 LLM 主循环时,给消息追加执行计划指令——
 // 仅靠工具描述/系统提示散文,模型实测会跳过 PlanCreate 直接开跑(杭州天气+台风+
 // 简报实锤: 工具列表里有 PlanCreate 仍未调用)。消息尾缀系统提示是本仓库既有
 // 模式(语音简洁性提示同款)。注意: 上下文装配在本段之后(1425 行
 // prepareChatContext), 因此必须挂 message 变量才会进入 LLM 输入。
 if (taskDetection.isTask) {
 message = message + '\n\n[系统提示：这是一个多步任务。请先调用 PlanCreate 工具建立执行计划（传入标题与按顺序的步骤清单），随后每完成一个关键步骤调用 PlanUpdate 同步进度（status: done/running/failed），全部完成后正常作答。]';
 }
 }
 // ── End Task Mode Detection ──

 // 注册可中断请求
 const { globalRequestInterrupt } = require('./request-interrupt');
 const interruptController = globalRequestInterrupt.register(userId, `chat: ${message.substring(0, 50)}`);
 const interruptSignal = interruptController.signal;

 // ── 确认处理（无需上下文准备，提前处理）──
 const isConfirmation = /^(确认|是|yes|ok|确定|执行)$/i.test(message.trim());
 if (isConfirmation && pendingConfirmations.has(userId)) {
 const pending = pendingConfirmations.get(userId);
 pendingConfirmations.delete(userId);

 console.log('✅ 用户确认执行工具:', pending.toolName);

 if (pending.toolName === 'Bash' && pending.params?.command) {
 const cmd = pending.params.command;
 if (cmd.includes('wttr.in')) {
 // S-1c 安全(2026-08-28): 白名单记录「完整命令串」而非 'wttr.in' 子串——
 // bash-tools isCommandConfirmed 按规范化后全等匹配, 24h TTL 内同一命令串直执行。
 // 风险提示: 用户确认过什么串, 什么串就不再审批——含变量/重定向的命令请勿确认。
 addConfirmedPattern(cmd);
 console.log('✅ 已将天气查询命令加入白名单');
 }
 }

 const context = {
 projectRoot: PROJECT_ROOT,
 workspaceDir: WORKSPACE_DIR,
 channel: _currentChannel || 'none',
 userId: _currentUserId || '',
 };

 const tool = toolSystem.get(pending.toolName);
 if (tool) {
 try {
 const result = await tool.handler(pending.params, context);
 const content = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

 if (!silent) unifiedAddMessage(userId, 'user', message);
 if (!silent) unifiedAddMessage(userId, 'assistant', content);
 contextCache.invalidateHistory(userId);

 return content;
 } catch (error) {
 return `工具执行失败: ${error.message}`;
 }
 }
 }

 if (isConfirmation) {
 return '没有待确认的操作。';
 }

 // 感知层副作用（prepareChatContext 内部不调用，需提前触发）
 try { globalTimeAwareness.getTimeContext(); } catch (e) { console.debug('[ai] getTimeContext 失败:', e?.message || e); }
 try { globalOnboarding.recordInteraction(userId); } catch (e) { console.warn('[ai] onboarding 记录失败:', e?.message || e); }

 // ── 上下文准备（注入检测 + 路由 + 技能 + 记忆 + 提示词 + 压缩，已统一到 prepareChatContext）──
 const ctxResult = await prepareChatContext(config, userId, message, {
 isStream: false,
 historyLimit: 20,
 enableShouldBlockLog: true,
 onMemoryPrompt: (memoryPrompt) => {
 // ACI 预取缓存注入
 try {
 var acm = require("./aci/index");
 var acc = acm.getPrefetchCache();
 var acp = [];
 if (acc) {
 var w = acc.get("aci_weather");
 var h = acc.get("aci_hotspot");
 // 2026-08-01: 消费 system_status 预取任务（此前任务注册但无读取方，数据永不生效）
 var ss = acc.get("system_status");
 if (w) acp.push("[预取天气] " + w.city + " " + w.temp + "\u00b0 " + (w.condition || ""));
 if (h && h.items) {
 var t = h.items.slice(0, 3).map(function(x) { return x.title || x; }).join("\n ");
 acp.push("[预取热点]\n " + t);
 }
 if (ss && ss.uptime) acp.push("[系统状态] 运行 " + ss.uptime);
 if (acp.length > 0) memoryPrompt += "\n\n" + acp.join("\n");
 }
 } catch (e) { console.warn('[ai] ACI 预取消费失败:', e?.message || e); }
 return memoryPrompt;
 },
 });

 if (ctxResult.error) {
 globalRequestInterrupt.unregister(userId, interruptController);
 return ctxResult.error;
 }

 const { provider, model, baseUrl, apiKey, messages: compressedMessages, userHistory, proactiveHints, router, processedSkills, systemPrompt } = ctxResult;
 // S1: 技能自动触发——命中分类则向首轮注入技能推荐(chat 文本路径)
 try { injectSkillGuidance(compressedMessages, message); } catch (e) { console.warn('[skill-auto] chat 注入失败:', e.message); }
 console.log(`🎯 模型路由: ${provider}/${model}`);
 console.log(`⏱️ [性能] 上下文准备耗时: ${Date.now() - startTime}ms`);

 // Token 预算预检：在发起 LLM 调用前拦截
 try {
 const { getBudgetEnforcer } = require('./budget-enforcer');
 const budgetEnforcer = getBudgetEnforcer();
 const estimatedTokens = estimateMessagesTokens([{ role: 'user', content: message }]) + (DEFAULT_BUDGET?.maxTokens || 4096);
 const budgetCheck = budgetEnforcer.checkRequest({ model, estimatedTokens, userId, category: 'reasoning' });
 if (!budgetCheck.allowed) {
 console.warn(`💰 预算拦截: ${budgetCheck.reason}`);
 globalRequestInterrupt.unregister(userId, interruptController);
 return `⚠️ 预算限制: ${budgetCheck.reason}。当前降级级别: ${budgetCheck.degradation}。请稍后重试或联系管理员。`;
 }
 if (budgetCheck.degraded && budgetCheck.suggestedModel) {
 console.log(`💰 预算降级: ${model} → ${budgetCheck.suggestedModel}`);
 }
 } catch (e) { console.warn('⚠️ 预算检查异常:', e.message); }

 // 工具调用预算预检（advisory — 仅 BLOCKED 级别硬拦截）
 // 2026-08-15 P1-3: 此前仅拦 degradation==='BLOCKED'——分类配额耗尽时
 // budget-enforcer 返回 allowed:false 但 degradation 不变 → tool_call 日配额
 // 只计数不拦截(名义执法)。改判 !toolBudget.allowed, 两种拦截语义合并,
 // reason 区分触发原因(分类配额 vs 全局封锁)。
 try {
 const { getBudgetEnforcer } = require('./budget-enforcer');
 const budgetEnforcer = getBudgetEnforcer();
 const toolBudget = budgetEnforcer.checkRequest({ model, estimatedTokens: 0, userId, category: 'tool_call' });
 if (!toolBudget.allowed) {
 console.warn(`💰 工具调用预算拦截: ${toolBudget.reason}`);
 globalRequestInterrupt.unregister(userId, interruptController);
 return `⚠️ 工具调用预算已拦截: ${toolBudget.reason}。请等待预算重置或联系管理员。`;
 }
 } catch (e) { console.warn('[ai] Tool budget check failed:', e.message); }
 
 const cacheResult = optimizeCacheBreakpoints(compressedMessages, {
 model,
 baseUrl,
 strategy: 'system_and_3'
 });
 
 let cachedMessages = cacheResult.messages;
 if (cacheResult.cached) {
 const savings = estimateCacheSavings(cachedMessages, cacheResult.provider);
 console.log('💾 提示词缓存已启用:', {
 provider: cacheResult.provider,
 breakpoints: cacheResult.breakpoints,
 estimatedSavings: `${savings.savingsPercent}%`,
 cachedTokens: savings.cachedTokens
 });
 }

 // messages 作为工具执行循环的工作数组（与 cachedMessages 共享引用，push 操作互可见）
 const messages = cachedMessages;

 // 2026-08-17: 文件生成四步流程——生成意图请求开始即开任务（①资料搜集，面板滑入）
 // silent 内部任务（auto-dream 记忆提取等）绝不触发 UI 面板——提取 prompt 含
 // "创建/文件"类词会被 isFileGenIntent 误判 → FileGenPanel 文章编写卡误弹
 // （实机：查大华股份并发 silent 提取弹"文章编写"卡）。与 1349 行同构守卫。
 // 2026-08-22: 命中时注入 FILEGEN_TASK_HINT——覆盖语音 brevityHint 的文本直出
 // 诱导（模型第一轮即走 Write 工具卡片流程，对话窗口只简短确认）。
 if (!silent && maybeStartFileGenTask(message, userId)) {
   // 2026-08-23: 分档引导——轻量文章 vs 深度研究（fileGenHintFor 按词表选择）
   messages.push({ role: 'system', content: fileGenHintFor(message) });
 } else if (!silent) {
   // 2026-09-06 恢复链路: 继续类消息（"继续/接着做完"）+ 存在暂停/未终态任务 →
   // 复活任务重开卡片 + 注入继续引导——此前该路径不命中任何判定，模型凭上下文
   // 把文档全文直吐对话窗口。
   const resumedTask = maybeResumeFileGenTask(message);
   if (resumedTask) {
     messages.push({ role: 'system', content: fileGenResumeHintFor(resumedTask) });
   } else {
     // 2026-09-06 追问回答链路: paused 任务等待补充需求，回答类消息注入条件引导
     const pausedTask = maybePausedFileGenTask();
     if (pausedTask) messages.push({ role: 'system', content: fileGenPausedAnswerHintFor(pausedTask) });
   }
 }

 // silent 内部任务不写主对话历史（防提取指令污染，2026-08-17 根因修复）
 if (!silent) unifiedAddMessage(userId, 'user', message);
 
 const toolDefStart = Date.now();
 const currentChannel = Array.isArray(config.chatChannel) ? config.chatChannel[0] : (config.chatChannel || 'none');
 _currentChannel = currentChannel; // 设置全局通道，供工具 context 使用
 _currentUserId = userId || ''; // 设置全局用户ID，供工具 context 使用
 // 2026-08-19: noTools——内部结构化提取（文档分析等）禁工具。根因：DocumentAnalyze
 // 的提取 prompt 带 100+ 工具定义进上下文，DeepSeek 选择调 Bash 自己解析 docx（被沙箱
 // 拦截后回退"数据处理完成。"）→ JSON 提取恒失败。noTools 时模型必须纯文本作答。
 // 2026-08-26 "几点了"后视频卡复活根因: silent 内部任务(记忆提取等)的 message =
 // 提取 prompt + 用户消息文本 → buildToolDefinitions 意图检测命中"视频"关键词 →
 // video_play 工具集(SceneMedia/BilibiliSearch)被注入 → 提取 LLM 顺手调了
 // SceneMedia → 已关闭的视频卡复活。silent 任务只做提取, 同 noTools 一样禁工具,
 // 且不死守消息文本做意图注入——用户消息的 UI 副作用(弹卡)与提取任务必须隔离。
 const toolDefinitions = (options.noTools || silent) ? [] : buildToolDefinitions(currentChannel, message, { expertToolsets: getActiveExpertToolsets(_currentUserId) });
 console.log('🔧 已加载', toolDefinitions.length, '个工具定义 (通道:', Array.isArray(config.chatChannel) ? config.chatChannel.join(',') : currentChannel, ')');
 console.log(`⏱️ [性能] 工具定义构建耗时: ${Date.now() - toolDefStart}ms`);
 console.log(`📏 [性能] 工具定义大小: ${JSON.stringify(toolDefinitions).length} 字符`);
 
 // P0-3: 意图识别升级 — 硬编码正则 + intent-predictor 融合
 const intentHints = detectMessageIntent(message, currentChannel);

 // 补充 intent-predictor 的序列/时间/领域预测
 try {
 const { globalIntentPredictor, INTENT_CATEGORIES: PREDICTOR_CATEGORIES } = require('./perception/intent-predictor');
 const prediction = globalIntentPredictor.predict(userId, message, {
 domains: proactiveHints?.domains || [],
 history: userHistory,
 });
 if (prediction?.topPrediction && prediction.topPrediction.confidence > 0.5) {
 const extraHint = `预测意图: ${prediction.topPrediction.name || prediction.topPrediction.intent} (置信度 ${(prediction.topPrediction.confidence * 100).toFixed(0)}%)`;
 intentHints.push(extraHint);
 // 如果预测到后续意图，也注入提示
 const followUps = PREDICTOR_CATEGORIES?.[prediction.topPrediction.intent]?.followUpIntents;
 if (followUps?.length) {
 intentHints.push(`后续可能意图: ${followUps.join(', ')}`);
 }
 }
 } catch (e) { console.warn('[ai] Intent predictor unavailable:', e.message); }

 // 2026-08-26: silent 内部任务同样跳过意图提示注入——提取 prompt 夹带的用户文本
 // 会命中"视频/股票/台风"等关键词 → 提示"请优先使用对应专用工具" → 提取 LLM
 // 调业务工具(视频卡复活的第二诱导面)。silent 只提取, 不需要任何工具引导。
 if (intentHints.length > 0 && !silent) {
 const intentMsg = { role: 'system', content: `本次对话意图提示：${intentHints.join('；')}。请优先使用对应的专用工具。` };
 cachedMessages.push(intentMsg);
 }

 // 不再基于关键词强制 tool_choice='required'：弱模型在工具名不清晰时会捏造非法工具名
 // 或错误参数，导致连续失败 break。意图提示词已在 system prompt 和 INTENT_PATTERNS 中注入，
 // 模型知道何时该用工具，用 'auto' 让模型自主判断。
 const toolChoice = 'auto';
 
 const requestBody = {
 model: model,
 messages: cachedMessages,
 temperature: 0.7,
 // noTools 时省略 tools/tool_choice：空数组对部分 provider 不友好，且语义上
 // 明确告诉模型"没有工具可用"（DeepSeek 等推理模型空 tools 也可能捏造调用）
 ...(toolDefinitions.length > 0 ? { tools: toolDefinitions, tool_choice: toolChoice } : {}),
 };
 
 console.log('📤 发送请求到 AI (带 tools 参数)...');
 console.log('📤 请求 URL:', `${baseUrl}/chat/completions`);
 console.log('📤 模型:', model);
 console.log('📤 tool_choice:', toolChoice);
 console.log(`⏱️ [性能] 准备请求耗时: ${Date.now() - startTime}ms`);

 const rlCheck = isRateLimited({ provider, model });
 if (rlCheck.limited) {
 const waitSec = Math.ceil(rlCheck.remainingMs / 1000);
 console.warn(`⏳ 跨会话速率限制: ${provider} 需等待 ${waitSec}s`);
 return `⏳ 当前模型 ${provider}/${model} 正在限流中，请 ${waitSec} 秒后重试。`;
 }

 const preHookResult = await shellHooksBridge.invokeHook('pre_llm_call', {
 toolName: model,
 toolInput: { messages: cachedMessages.length },
 sessionId: userId,
 cwd: WORKSPACE_DIR,
 });
 if (preHookResult.blocked) {
 return `🛑 请求被 Shell Hook 拦截: ${preHookResult.reason}`;
 }

 const apiStart = Date.now();
 // ── Harness: LLM 调用开始 ──
 try { globalHarnessLifecycle.onLlmCallStart(model); } catch (e) { console.warn('[ai] Harness onLlmCallStart failed:', e.message); }
 let resp;
 try {
 const allKeys = collectProviderApiKeysForExecution({ primaryApiKey: apiKey, provider });
 if (allKeys.length > 1) {
 resp = await executeWithApiKeyRotation({
 provider,
 apiKeys: allKeys,
 execute: async (currentKey) => {
 const response = await fetchWithRetry(`${baseUrl}/chat/completions`, {
 method: 'POST',
 // 2026-08-15 P2-3: 补 signal——多密钥分支此前无中断信号, 用户停止后
 // 首轮请求继续烧 token(与单密钥分支不一致)
 signal: interruptSignal,
 headers: {
 'Authorization': `Bearer ${currentKey}`,
 'Content-Type': 'application/json'
 },
 body: JSON.stringify(requestBody)
 });
 if (!response.ok) {
 const err = new Error(`HTTP ${response.status}`);
 err.status = response.status;
 throw err;
 }
 return response;
 },
 shouldRetry: ({ error: _error, message }) => {
 return /rate.?limit|429|too.?many/i.test(message);
 },
 onRetry: ({ apiKey: retryKey, attempt }) => {
 const suffix = retryKey.slice(-8);
 globalKeyRotationManager.setCooldown(provider, suffix, 60000);
 console.log(`🔑 [密钥轮转] 切换到备用密钥 (尝试 ${attempt + 1})`);
 },
 });
 } else {
 resp = await fetchWithRetry(`${baseUrl}/chat/completions`, {
 method: 'POST',
 headers: {
 'Authorization': `Bearer ${apiKey}`,
 'Content-Type': 'application/json'
 },
 body: JSON.stringify(requestBody),
 signal: interruptSignal,
 });
 }
 } catch (rotationError) {
 // 2026-08-15 审查返工 P2-5: 用户主动中断(AbortError)不记为 LLM 失败——此前
 // 中断也走 onLlmCallFailure, 失败指标被"用户停止"污染。控制流不变: 仅跳过
 // 失败钩子, 下方 AbortError 分支照旧 return ''。
 if (rotationError.name !== 'AbortError') {
 // ── Harness: LLM 调用失败 ──
 // 2026-08-15 P2-5: 传入完整上下文(messages/compressFn/fallbackProviderFn/
 // contextEngine)——best-effort 缺参不抛; RecoveryChain 消费端为 Task 3 职责。
 try {
 globalHarnessLifecycle.onLlmCallFailure(rotationError, {
 errorType: 'api_error',
 model,
 messages: cachedMessages,
 compressFn: contextCompressor.compress,
 fallbackProviderFn: async (apiErr) => {
   try {
     const { getFallbackProviderManager } = require('./fallback-provider');
     const fbManager = getFallbackProviderManager();
     return fbManager ? fbManager.performFailover(userId, apiErr, getModelRouter()) : null;
   } catch (e) { console.warn('[ai] fallbackProviderFn failed:', e.message); return null; }
 },
 contextEngine: contextEngineRegistry,
 });
 } catch (e) { console.warn('[ai] Harness onLlmCallFailure failed:', e.message); }
 } // !AbortError(用户中断不计失败)
 // 处理用户中断
 if (rotationError.name === 'AbortError') {
 console.log('🛑 请求被用户中断');
 globalRequestInterrupt.unregister(userId, interruptController);
 // 2026-08-15 审查返工 P2-1: 与流式一致返回 ''——终态已由调用方 interrupted
 // 表达; 此前 '请求已取消。' 会写入历史与 trajectory(两路污染)。
 return '';
 }
 const errorDetail = rotationError.message || String(rotationError);
 const causeDetail = rotationError.cause ? ` | cause: ${rotationError.cause.code || ''} ${rotationError.cause.message || ''}` : '';
 console.error('❌ AI 请求失败 (密钥轮转耗尽):', errorDetail + causeDetail);
 const userFriendly = errorDetail === 'fetch failed'
  ? '网络连接失败，请检查网络后重试'
  : errorDetail;
 return `AI 模型错误: ${userFriendly}\n\n💡 所有可用 API 密钥均已尝试，请检查密钥配置或稍后重试。`;
 }
 console.log(`⏱️ [性能] API 调用耗时: ${Date.now() - apiStart}ms`);
 
 if (!resp.ok) {
 let errorDetail = `AI 模型请求失败 (HTTP ${resp.status})`
 let errorBody = '';
 try {
 errorBody = await resp.text()
 const errJson = JSON.parse(errorBody)
 errorDetail = errJson.error?.message || errJson.message || errJson.error?.type || errorDetail
 } catch (e) { console.warn('解析错误响应失败:', e.message); }
 console.error('❌ AI 请求失败:', errorDetail)

 const apiError = new Error(errorDetail);
 apiError.status = resp.status;
 const classified = classifyApiError(apiError, {
 provider,
 model,
 approxTokens: estimateMessagesTokens(cachedMessages),
 contextLength: contextCompressor.maxTokens,
 numMessages: cachedMessages.length,
 });
 const recovery = getRecoveryAction(classified);

 if (classified.shouldCompress) {
 console.log('🗜️ API错误建议压缩上下文，尝试压缩后重试...');
 const compressionResult = await contextCompressor.compress(cachedMessages, { focusTopic: message });
 if (compressionResult.compressed) {
 cachedMessages = compressionResult.messages;
 console.log(`🗜️ 上下文已压缩: ${compressionResult.originalTokens} → ${compressionResult.compressedTokens} tokens`);
 }
 }

 if (classified.reason === FailoverReason.RATE_LIMIT) {
 recordRateLimit({
 provider,
 model,
 headers: resp.headers,
 errorCode: resp.status,
 });
 const retryAfter = resp.headers?.get('retry-after');
 const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : 5000;
 console.log(`⏳ 速率限制，等待 ${waitMs}ms 后重试...`);
 await sleep(waitMs);
 }

 console.log(`📋 错误分类: ${classified.reason}, 恢复策略: ${recovery.action} (${recovery.description})`);

 // 尝试备用提供者切换
 try {
 const { getFallbackProviderManager } = require('./fallback-provider');
 const fbManager = getFallbackProviderManager();
 if (fbManager) {
 const fallbackRoute = fbManager.performFailover(userId, apiError, router);
 if (fallbackRoute) {
 console.log(`🔄 正在切换到备用模型: ${fallbackRoute.provider}/${fallbackRoute.model}`);
 try {
 const fbResp = await fetchWithRetry(`${fallbackRoute.baseUrl}/chat/completions`, {
 method: 'POST',
 // 2026-08-15 审查返工 P2-3: 补 signal——用户停止后 fallback-provider fetch 可中断
 signal: interruptSignal,
 headers: {
 'Authorization': `Bearer ${fallbackRoute.apiKey}`,
 'Content-Type': 'application/json'
 },
 body: JSON.stringify(requestBody)
 });

 if (fbResp.ok) {
 const fbData = await fbResp.json();
 if (fbData.choices && fbData.choices[0]) {
 const fbChoice = fbData.choices[0];
 const fbMessage = fbChoice.message;
 if (fbMessage.content) {
 if (!silent) unifiedAddMessage(userId, 'assistant', fbMessage.content);
 contextCache.invalidateHistory(userId);
 console.log(`✅ 备用模型响应成功: ${fallbackRoute.provider}/${fallbackRoute.model}`);
 return fbMessage.content;
 }
 }
 }
 console.log(`⚠️ 备用模型也失败，返回原始错误`);
 } catch (fbError) {
 console.log(`⚠️ 备用模型请求失败: ${fbError.message}`);
 }
 }
 }
 } catch (e) { console.warn('⚠️ 模型选择策略执行异常:', e.message); }

 return `AI 模型错误: ${errorDetail}\n\n📋 错误分析: ${recovery.description}`
 }
 
 const data = await resp.json();
 
 try {
 const { globalSystemHealthSensor } = require('./perception/system-health-sensor');
 globalSystemHealthSensor.recordApiCall({ error: false, latencyMs: Date.now() - (resp._startTime || Date.now()) });
 } catch (e) { console.warn('⚠️ 健康传感器记录异常:', e.message); }
 
 if (data.error) {
 console.error('❌ API 错误:', data.error);
 try {
 const { globalSystemHealthSensor } = require('./perception/system-health-sensor');
 globalSystemHealthSensor.recordApiCall({ error: true, errorType: 'api_error', latencyMs: 0 });
 } catch (e) { console.warn('⚠️ 健康传感器记录异常:', e.message); }
 return `API 错误: ${data.error.message || JSON.stringify(data.error)}`;
 }
 
 if (data.usage) {
 const usageInfo = recordUsage(provider, model, data.usage);
 // ── Harness: LLM 调用成功 ──
 try { globalHarnessLifecycle.onLlmCallSuccess(model, { prompt_tokens: usageInfo.promptTokens, completion_tokens: usageInfo.completionTokens, total_tokens: usageInfo.totalTokens }); } catch (e) { console.warn('[ai] Harness onLlmCallSuccess failed:', e.message); }
 console.log(`📊 Token 使用: 输入 ${usageInfo.promptTokens}, 输出 ${usageInfo.completionTokens}, 总计 ${usageInfo.totalTokens}, 估算费用 $${usageInfo.cost.toFixed(6)}`);
 // 记录 LLM 使用到 BudgetEnforcer 类别预算（使 CATEGORY_BUDGETS 限额追踪生效）
 // 2026-08-18: silent 内部任务（auto-dream 记忆提取/记忆清理）计入独立 internal
 // 分类（只统计不拦截）——此前与用户请求共用 reasoning 配额, 内部任务抢光 30/30
 // 后用户被无辜拦截（实机：晚上问天气报"预算限制"且无卡片）。
 try {
 const { getBudgetEnforcer } = require('./budget-enforcer');
 getBudgetEnforcer().recordUsage(provider, model, data.usage, null, userId, { category: silent ? 'internal' : 'reasoning' });
 } catch (e) { console.warn('[ai] Budget tracking recordUsage failed:', e.message); }
 try {
 const { globalCostSensor } = require('./perception/cost-sensor');
 globalCostSensor.recordTokenUsage(
 userId || 'default',
 model,
 data.usage.prompt_tokens || usageInfo.promptTokens || 0,
 data.usage.completion_tokens || usageInfo.completionTokens || 0,
 data.usage.prompt_cache_hit_tokens || 0,
 data.usage.prompt_cache_miss_tokens || 0,
 );
 } catch (e) { console.warn('⚠️ 使用量记录异常:', e.message); }

 // 记录 LLM 服务端缓存命中到 prompt-cache 统计
 try {
 const { recordLLMCacheHit } = require('./caching/prompt-cache');
 recordLLMCacheHit(
 data.usage.prompt_cache_hit_tokens || 0,
 data.usage.prompt_cache_miss_tokens || data.usage.prompt_cache_creation_tokens || 0,
 );
 } catch (e) { console.warn('[ai] Prompt-cache recording failed:', e.message); }
 }
 
 if (data.choices && data.choices[0]) {
 const choice = data.choices[0];
 const assistantMessage = choice.message;
 
 console.log('🤖 AI 响应 finish_reason:', choice.finish_reason);
 // 调试日志：查看 AI 返回的完整消息结构
 console.log('🤖 AI 响应 message keys:', Object.keys(assistantMessage || {}));
 console.log('🤖 AI 响应 content 长度:', (assistantMessage?.content || '').length);
 console.log('🤖 AI 响应 content 前200字符:', JSON.stringify((assistantMessage?.content || '').substring(0, 200)));
 console.log('🤖 AI 响应 tool_calls:', assistantMessage?.tool_calls ? `${assistantMessage.tool_calls.length} 个` : '无');
 console.log('🤖 AI 响应 reasoning_content:', assistantMessage?.reasoning_content ? '有' : '无');
 
 if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
 console.log('✅ 模型返回了 tool_calls:', assistantMessage.tool_calls.length, '个');
 
 let loopFilteredCalls = [];
 for (const tc of assistantMessage.tool_calls) {
 const hashInfo = hashToolCall(tc);
 const loopStatus = globalLoopDetector._detectLoop(userId, hashInfo);
 
 if (loopStatus.isHardLimit) {
 console.warn(`🔄 [循环检测] 工具 "${hashInfo.name}" 已调用 ${loopStatus.count} 次，强制跳过`);
 messages.push({
 role: 'assistant',
 content: '',
 tool_calls: [tc]
 });
 messages.push({
 role: 'tool',
 tool_call_id: tc.id,
 content: `[循环检测] 工具 "${hashInfo.name}" 已连续调用 ${loopStatus.count} 次，请停止重复操作，直接给出当前结论。`
 });
 continue;
 }
 
 if (loopStatus.isWarning) {
 console.warn(`🔄 [循环检测] 工具 "${hashInfo.name}" 已调用 ${loopStatus.count} 次，警告`);
 }
 
 loopFilteredCalls.push(tc);
 }
 
 if (loopFilteredCalls.length === 0) {
 console.log('🔄 [循环检测] 所有工具调用被循环检测过滤');
 // 兜底优先级：assistantMessage.content → 已有工具结果 → 默认提示
 let fallback = assistantMessage.content;
 if (!fallback) {
 // 从 messages 中找最后一个 tool 角色消息作为兜底
 const lastToolMsg = [...messages].reverse().find(m => m.role === 'tool' && m.content);
 if (lastToolMsg) {
 fallback = `根据已获取的信息：${lastToolMsg.content}`;
 }
 }
 return fallback || '无法获取更多有效信息，请稍后重试。';
 }
 
 messages.push({
 role: 'assistant',
 content: assistantMessage.content || '',
 tool_calls: loopFilteredCalls
 });
 
 let lastToolResult = null;
 // 2026-09-04 Loop 第一刀: 循环参数收敛为 agent/loop-contract 单一事实源(此前 8/15/120000 裸字面量双处漂移温床)
 const { IterationBudget } = require('./iteration-budget');
 const { chatLoopParams } = require('./agent/loop-contract');
 const budget = new IterationBudget(chatLoopParams());
 // 2026-09-04 Loop 第四刀: 首轮执行集合改用过滤后的数组——此前用未过滤的
 // assistantMessage.tool_calls, 被循环检测硬限的调用(1810-1819 已注入合成拒绝)
 // 会被真实重复执行, 绕过循环防护(双处不一致的缺陷修复)。
 // 后续轮(2089)沿用 nextMessage.tool_calls——chat 每轮不跑循环检测的不一致另议。
 let currentToolCalls = loopFilteredCalls;
let consecutiveFailures = 0;
 const MAX_CONSECUTIVE_FAILURES = 5; // P0: tolerate more failures for reflection

 toolGuardrail.reset();
 
 // 标记工具循环是否被异常中断（guardrail 阻断 / 空结果 / 循环检测过滤）
 // 用于在 while 结束后接入 graceful degradation，避免返回空字符串
 let toolLoopAborted = false;
 
 while (currentToolCalls && currentToolCalls.length > 0 && !budget.shouldForceStop()) {

 if (toolGuardrail.isBlocked()) {
 console.warn('🛑 工具调用护栏触发硬停止:', toolGuardrail.getBlockedReason());
 toolLoopAborted = true;
 break;
 }
 
 // 连续失败检测：工具连续失败时提前终止循环
 if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
 console.warn(`🛑 连续 ${consecutiveFailures} 次工具调用失败，提前终止循环`);
 break;
 }
 
 budget.incrementIteration();
 console.log(`🔄 工具调用迭代 ${budget.getIteration()}/${budget.maxIterations}`);
 
 const singleToolExecutor = createToolExecutor({
 userId,
 message,
 executeToolCall,
 middleware: globalToolResultMiddleware,
 display: globalToolDisplay,
 budget,
 classifyCategory: _classifyRequestCategory,
 onToolStart: toolCallCallback
 ? (tc, name) => toolCallCallback(userId, name, 'start', tc.function?.arguments)
 : undefined,
 onComplete: toolCallCallback
 ? (tc, name, _res, ok) => toolCallCallback(userId, name, 'end', ok ? 'success' : 'error')
 : undefined,
 });

 const toolResults = await executeToolCallsConcurrent(currentToolCalls, singleToolExecutor, model, config.models?.currentProvider);
 
 // 2026-09-05 Loop 第五刀: 每轮结果批处理抽入 agent/loop-skeleton(失败计数/持久化/
 // needsConfirmation 提前返回信号/预算与压力警告/回填)——ai.js 只做循环控制
 const { processToolResultEntries } = require('./agent/loop-skeleton');
 const processed = await processToolResultEntries(
   { toolResults, messages, budget, userId, message, consecutiveFailures, lastToolResult },
   { persistToolResultContent, unifiedAddMessage, contextCache, lifecycleManager,
     estimateMessagesTokens, contextCompressor, toolGuardrail }
 );
 consecutiveFailures = processed.consecutiveFailures;
 lastToolResult = processed.lastToolResult;
 if (processed.earlyReturn) return processed.earlyReturn;
 
 // 检查是否有工具返回空结果
 // 不再立即终止循环，而是注入提示让模型基于空结果做出解释
 
 // P0: Reflection mechanism — inject analysis prompt when tools fail
 if (consecutiveFailures >= 2) {
 const failedToolNames2 = toolResults.filter(r => !r.success).map(r => r.toolCall?.function?.name).filter(Boolean);
 const failedErrors2 = toolResults.filter(r => !r.success).map(r => {
 const err = typeof r.result === 'object' ? (r.result?.error || '') : String(r.result || '');
 return err.substring(0, 120);
 }).filter(Boolean);
 const reflectionPrompt = `\n[REFLECTION: 最近 ${consecutiveFailures} 次工具调用失败（${failedToolNames2.join(", ") || "unknown"}）。\n错误信息: ${failedErrors2.join(" | ").substring(0, 300)}\n请分析失败根因，尝试替代策略：\n1. 换一个不同的工具\n2. 调整参数后重试\n3. 向用户说明并提供手动操作建议]`;
 messages.push({ role: "user", content: reflectionPrompt });
 }
const emptyResults = toolResults.filter(
 r => r.status === 'fulfilled' && r.value.result.success && !r.value.result.content
 );
 if (emptyResults.length === toolResults.length && budget.getIteration() > 1) {
 console.log('⚠️ 所有工具返回空结果，注入提示让模型解释');
 // 不再 break，而是让循环继续，模型会收到空结果并有机会解释
 // 仅在迭代预算接近耗尽时才终止
 if (budget.getUsageRatio() >= 0.9) {
 toolLoopAborted = true;
 break;
 }
 }
 
 console.log(`📤 发送工具结果给 AI (迭代 ${budget.getIteration()})...`);
 
 const nextRequestBody = {
 model: model,
 messages: messages,
 temperature: 0.7,
 max_tokens: 8192,
 tools: toolDefinitions,
 tool_choice: (() => {
 const iter = budget.getIteration();
 const maxIter = budget.maxIterations;
 const hasSuccess = messages.some(m => m.role === 'tool' && m.content && !m.content.includes('"error"') && !m.content.includes('失败'));
 // 2026-09-07: 收答轮从硬编码 3 改为契约单源（同 chatStream 路径修复）
 if (iter >= maxIter - 1) return 'none';
 if (iter >= AGENT_LOOP_CONTRACT.finalAnswerRound) return 'none';
 if (iter >= 2) return 'auto';
 if (iter >= 1 && hasSuccess) return 'auto';
 return toolChoice;
 })()
 };

 let nextData;
 const allKeys = collectProviderApiKeysForExecution({ primaryApiKey: apiKey, provider });
 if (allKeys.length > 1) {
 const nextResult = await executeWithApiKeyRotation({
 provider,
 apiKeys: allKeys,
 execute: async (iterApiKey) => {
 const resp = await fetchWithRetry(`${baseUrl}/chat/completions`, {
 method: 'POST',
 // 2026-08-15 P2-3: 补 signal——工具循环 fetch 此前无中断信号(用户停止
 // 后循环继续)
 signal: interruptSignal,
 headers: {
 'Authorization': `Bearer ${iterApiKey}`,
 'Content-Type': 'application/json'
 },
 body: JSON.stringify(nextRequestBody)
 });
 if (!resp.ok) {
 const err = new Error(`HTTP ${resp.status}`);
 err.status = resp.status;
 throw err;
 }
 return resp.json();
 },
 shouldRetry: ({ message: msg }) => /rate.?limit|429|too.?many/i.test(msg),
 onRetry: ({ apiKey: retryKey, attempt }) => {
 const suffix = retryKey.slice(-8);
 globalKeyRotationManager.setCooldown(provider, suffix, 60000);
 console.log(`🔑 [非流式工具循环] [密钥轮转] 切换到备用密钥 (尝试 ${attempt + 1})`);
 },
 });
 nextData = nextResult;
 } else {
 const nextResp = await fetchWithRetry(`${baseUrl}/chat/completions`, {
 method: 'POST',
 // 2026-08-15 P2-3: 补 signal(同多密钥分支)
 signal: interruptSignal,
 headers: {
 'Authorization': `Bearer ${apiKey}`,
 'Content-Type': 'application/json'
 },
 body: JSON.stringify(nextRequestBody)
 });
 nextData = await nextResp.json();
 }
 
 if (!nextData.choices || !nextData.choices[0]) {
 break;
 }
 
 const nextMessage = nextData.choices[0].message;
 currentToolCalls = nextMessage.tool_calls;
 
 if (currentToolCalls && currentToolCalls.length > 0) {
 messages.push({
 role: 'assistant',
 content: nextMessage.content || '',
 tool_calls: currentToolCalls
 });
 } else {
 let reply = nextMessage.content || '';
 console.log('📝 AI 最终回复 (迭代', budget.getIteration(), '):', reply.substring(0, 100));
 console.log('📝 AI 回复长度:', reply.length, '字符');
 console.log('📝 AI 回复完整内容:', reply);
 
 if (!reply || reply.trim() === '') {
 reply = lastToolResult || '抱歉，处理过程中遇到了问题，请稍后再试。';
 }
 
 if (/^\s*\{\s*"candidates"\s*:\s*\[\s*\]\s*\}\s*$/.test(reply)) {
 console.log('⚠️ 检测到空的 candidates 响应，使用工具结果作为回复');
 reply = lastToolResult || '任务已完成，但没有生成最终回复。';
 }
 
 if (/^\s*\{\s*".*"\s*:\s*\[?\{?\s*\}?\]?\s*\}\s*$/.test(reply) && !reply.includes('已完成') && !reply.includes('成功')) {
 console.log('⚠️ 检测到可能的 JSON 工具输出，尝试提取有意义的内容');
 try {
 const parsed = JSON.parse(reply);
 if (Object.keys(parsed).length === 0 || (parsed.candidates && parsed.candidates.length === 0)) {
 reply = lastToolResult || '任务已完成。';
 }
 } catch (e) { console.warn('解析空响应失败:', e.message); }
 }
 
 const dsmlCalls = parseDSMLToolCalls(reply);
 if (dsmlCalls.length > 0) {
 console.log('🔄 检测到 DSML 工具调用:', dsmlCalls.length, '个');
 
 const existingToolResults = [];
 for (const msg of messages) {
 if (msg.role === 'tool' && msg.content) {
 existingToolResults.push(msg.content);
 }
 }
 
 const hasFailedResults = existingToolResults.some(r => {
 const s = typeof r === 'string' ? r : String(r);
 return s.includes('exit code:') && !s.includes('exit code: 0') ||
 s.includes('Error') || s.includes('错误') || s.includes('Cannot find module');
 });
 
 let allResultsContent = '';
 if (existingToolResults.length > 0 && !hasFailedResults) {
 allResultsContent = existingToolResults.map((r, i) => {
 return `【工具结果${i + 1}】\n${typeof r === 'string' ? r.substring(0, 3000) : String(r).substring(0, 3000)}`;
 }).join('\n\n');
 console.log(`📊 收集到 ${existingToolResults.length} 个已有工具结果，总长度 ${allResultsContent.length} 字符`);
 } else {
 if (hasFailedResults) {
 console.log('⚠️ 已有工具结果包含错误，尝试重新执行 DSML 工具调用');
 }
 for (const call of dsmlCalls) {
 try {
 const result = await executeToolCall({ name: call.name, params: call.params });
 console.log('📊 DSML 工具结果:', result.success ? '成功' : result.error);
 const content = result.success ? (typeof result.content === 'object' ? JSON.stringify(result.content, null, 2) : String(result.content || '')) : String(result.error);
 allResultsContent += `【工具: ${call.name}】\n${content.substring(0, 3000)}\n\n`;
 } catch (e) {
 console.error('❌ DSML 工具执行失败:', e.message);
 allResultsContent += `【工具: ${call.name}】执行失败: ${e.message}\n\n`;
 }
 }
 }

 const summaryMessages = [
 { role: 'system', content: '你是一个专业的数据分析助手。请基于提供的工具执行结果，给用户一个完整、详细的分析报告。\n\n格式要求（必须严格遵守）：\n1. 分析内容用自然语言文本描述，包括数据总结、关键发现、趋势和异常\n2. **所有数据必须使用 Markdown 表格展示**，包括：汇总数据、分类数据、明细数据、统计数据\n3. **禁止用列表（• 或 -）展示数据**，数据行≥2行时必须用表格\n4. 给出决策建议\n5. 绝对不要输出任何工具调用标签（如 DSML、XML 标签等）\n6. 用中文回复\n7. 数字使用千分位格式，如 ¥1,000\n8. 合计行用 **加粗** 突出\n\n表格示例：\n| 项目 | 数量 | 单价 | 金额 |\n|------|------|------|------|\n| 交换机 | 1台 | ¥600 | ¥600 |\n| 网线 | 1箱 | ¥380 | ¥380 |\n| **合计** | - | - | **¥980** |' },
 { role: 'user', content: `以下是工具执行的结果，请给出完整的分析报告：\n\n${allResultsContent.substring(0, 12000)}` }
 ];
 
 try {
 const summaryResp = await fetchWithRetry(`${baseUrl}/chat/completions`, {
 method: 'POST',
 // 2026-08-15 审查返工 P2-3: 补 signal——用户停止后 DSML 汇总 fetch 可中断
 signal: interruptSignal,
 headers: {
 'Authorization': `Bearer ${apiKey}`,
 'Content-Type': 'application/json'
 },
 body: JSON.stringify({
 model: model,
 messages: summaryMessages,
 temperature: 0.7,
 max_tokens: 8192
 })
 });
 
 const summaryData = await summaryResp.json();
 if (summaryData.choices && summaryData.choices[0]) {
 reply = summaryData.choices[0].message.content || '数据处理完成。';
 reply = stripDSMLTags(reply);
 console.log('📝 基于工具结果生成完整分析:', reply.substring(0, 100));
 }
 } catch (e) {
 console.error('❌ 生成分析报告失败:', e.message);
 reply = stripDSMLTags(reply);
 if (reply.trim().length < 20) {
 reply = '数据处理完成，但无法生成详细分析报告。';
 }
 }
 }
 
 // 清理 DSML 标签，避免前端显示原始标签；清理后为空则用工具结果兜底
 reply = stripDSMLTags(reply);
 if (!reply || reply.trim() === '') {
 console.warn('⚠️ DSML 标签清理后回复为空，使用工具结果兜底');
 reply = lastToolResult || '抱歉，处理过程中遇到了问题，请稍后再试。';
 }
 
 unifiedAddMessage(userId, 'user', message);
 unifiedAddMessage(userId, 'assistant', reply);
 console.log(`⏱️ [性能] 总耗时: ${Date.now() - startTime}ms`);
 return reply;
 }
 }
 
 if (budget.shouldForceStop() || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES || toolLoopAborted) {
 if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
 console.warn(`⚠️ 连续 ${consecutiveFailures} 次工具调用失败，强制生成降级回复`);
 } else {
 console.warn(`⚠️ ${budget.getStopSummary()}`);
 }
 
 try {
 // 收集失败信息用于生成有意义的降级回复
 const successToolNames = [];
const failedToolNames = [];
 const failureReasons = [];
 for (const msg of messages) {
 if (msg.role === 'tool' && typeof msg.content === 'string' && (msg.content.startsWith('错误:') || msg.content.startsWith('工具执行失败:') || msg.content.includes('失败') || msg.content.includes('error') || msg.content.includes('Error'))) {
 const toolCallId = msg.tool_call_id;
 const parentMsg = messages.find(m => m.role === 'assistant' && m.tool_calls?.some(tc => tc.id === toolCallId));
 if (parentMsg) {
 const tc = parentMsg.tool_calls.find(tc => tc.id === toolCallId);
 if (tc) failedToolNames.push(tc.function?.name || 'unknown');
 } else {
 const tc2 = parentMsg?.tool_calls?.find(tc => tc.id === toolCallId);
 if (tc2) successToolNames.push(tc2.function?.name || 'unknown');
 }
 const reason = msg.content.replace(/^错误:\s*/, '').replace(/^工具执行失败:\s*/, '').replace(/\n\n\[系统提示\].*/, '').substring(0, 200);
 failureReasons.push(reason);
 }
 }

 const failureSummary = failedToolNames.length > 0
 ? `\n\n以下是失败的工具调用信息供你参考：\n- 失败的工具: ${[...new Set(failedToolNames)].join(', ')}\n- 失败原因: ${failureReasons[failureReasons.length - 1] || '未知'}`
 : '';

 const cleanedMessages = messages.map(m => {
 if (m.role === 'tool') {
 return { role: 'user', content: `[工具执行结果] ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}` };
 }
 if (m.role === 'assistant' && m.tool_calls) {
 return { role: 'assistant', content: m.content || '(调用了工具)' };
 }
 return m;
 });
 
 const finalRequestBody = {
 model: model,
 messages: [...cleanedMessages, { role: 'user', content: `请根据以上已获取的信息，直接给出完整回答。不要再调用任何工具。如果之前的工具调用失败了，请向用户解释失败原因并给出替代建议。${failureSummary}` }],
 temperature: 0.7
 };
 
 let finalData;
 const allKeys = collectProviderApiKeysForExecution({ primaryApiKey: apiKey, provider });
 if (allKeys.length > 1) {
 finalData = await executeWithApiKeyRotation({
 provider, apiKeys: allKeys,
 execute: async (iterApiKey) => {
 const resp = await fetchWithRetry(`${baseUrl}/chat/completions`, {
 method: 'POST',
 // 2026-08-15 审查返工 P2-3: 补 signal——用户停止后最终回答 fetch 可中断
 signal: interruptSignal,
 headers: { 'Authorization': `Bearer ${iterApiKey}`, 'Content-Type': 'application/json' },
 body: JSON.stringify(finalRequestBody)
 });
 if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
 return resp.json();
 },
 shouldRetry: ({ message: msg }) => /rate.?limit|429|too.?many/i.test(msg),
 });
 } else {
 const finalResp = await fetchWithRetry(`${baseUrl}/chat/completions`, {
 method: 'POST',
 // 2026-08-15 审查返工 P2-3: 补 signal——用户停止后最终回答 fetch 可中断
 signal: interruptSignal,
 headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
 body: JSON.stringify(finalRequestBody)
 });
 finalData = await finalResp.json();
 }
 
 let reply = (finalData.choices?.[0]?.message?.content);
 if (!reply || reply.trim() === '') {
 if (lastToolResult) {
 reply = lastToolResult;
 } else {
 reply = '抱歉，处理超时。已完成的步骤已保留，可简化问题后重试。';
 }
 }
 reply = stripDSMLTags(reply);
 unifiedAddMessage(userId, 'user', message);
 unifiedAddMessage(userId, 'assistant', reply);
 console.log(`⏱️ [性能] 总耗时: ${Date.now() - startTime}ms`);
 return reply;
 } catch (e) {
 console.error('❌ 强制生成最终回答失败:', e.message);
 const successToolNames = [];
 const failedToolNames = [];
 const successList = [...new Set(successToolNames || [])];
 const failList = [...new Set(failedToolNames || [])];
 let reply;
 if (successList.length > 0 || failList.length > 0) {
 reply = "⚠️ 任务部分完成。";
 if (successList.length > 0) reply += "\n✅ 已完成: " + successList.join(", ");
 if (failList.length > 0) reply += "\n❌ 失败: " + failList.join(", ");
 reply += "\n💡 建议: 可尝试手动执行失败的操作。";
 } else {
 reply = lastToolResult || '抱歉，处理过程中遇到了问题。已完成的部分已保存。';
 }
 reply = stripDSMLTags(reply);
 unifiedAddMessage(userId, 'user', message);
 unifiedAddMessage(userId, 'assistant', reply);
 return reply;
 }
 }
 } // 结束 if (assistantMessage.tool_calls ...) 块

 // 调试日志：确认到达此处
 console.log('🔧 [调试] 到达非工具调用分支, assistantMessage.content 长度:', (assistantMessage.content || '').length);
 let reply = assistantMessage.content || '';
 reply = stripThinkBlocks(reply);
 console.log('🤖 AI 原始回复:', reply.substring(0, 200));
 console.log('🤖 AI 原始回复长度:', reply.length);

 // 2026-08-06: 空回复兜底——弱模型(deepseek-v4-flash)对模糊/口语输入会输出
 // "```json\n[]\n```" 或空对象 {}，被直接透传为用户看到的空白回复。
 // 检测纯 JSON 空结构/无效内容，替换为友好提示(不重试——重试大概率同样返回空)。
 if (isEmptyInvalidReply(reply)) {
   console.warn(`🤖 检测到无效回复(长度=${reply.length})，替换为友好提示:`, JSON.stringify(String(reply).trim().slice(0, 50)));
   reply = '抱歉，我刚才没听清您的问题，能再说一遍吗？';
 }
 
 if (reply.includes('需要确认') && reply.includes('curl wttr.in')) {
 const weatherSkill = processedSkills.find(s => s.name === 'weather');
 if (weatherSkill && weatherSkill.extractedParams?.city) {
 const city = weatherSkill.extractedParams.city;
 const command = `curl wttr.in/${city}?format=3`;
 console.log('🔄 检测到文本形式的确认请求，使用正确的命令:', command);
 lifecycleManager.managedSet('pendingConfirmations', userId, {
 toolName: 'Bash',
 params: { command },
 timestamp: Date.now()
 });
 } else {
 const curlMatch = reply.match(/curl\s+wttr\.in\/[^\s\n]+/);
 if (curlMatch) {
 const command = curlMatch[0];
 console.log('🔄 检测到文本形式的确认请求，设置 pendingConfirmations');
 lifecycleManager.managedSet('pendingConfirmations', userId, {
 toolName: 'Bash',
 params: { command },
 timestamp: Date.now()
 });
 }
 }
 }
 
 const dsmlCalls = parseDSMLToolCalls(reply);
 if (dsmlCalls.length > 0) {
 console.log('🔄 检测到 DSML 工具调用:', dsmlCalls.length, '个');
 
 const existingToolResults = [];
 for (const msg of messages) {
 if (msg.role === 'tool' && msg.content) {
 existingToolResults.push(msg.content);
 }
 }
 
 const hasFailedResults = existingToolResults.some(r => {
 const s = typeof r === 'string' ? r : String(r);
 return s.includes('exit code:') && !s.includes('exit code: 0') ||
 s.includes('Error') || s.includes('错误') || s.includes('Cannot find module');
 });
 
 let allResultsContent = '';
 if (existingToolResults.length > 0 && !hasFailedResults) {
 allResultsContent = existingToolResults.map((r, i) => {
 return `【工具结果${i + 1}】\n${typeof r === 'string' ? r.substring(0, 3000) : String(r).substring(0, 3000)}`;
 }).join('\n\n');
 console.log(`📊 收集到 ${existingToolResults.length} 个已有工具结果，总长度 ${allResultsContent.length} 字符`);
 } else {
 if (hasFailedResults) {
 console.log('⚠️ 已有工具结果包含错误，尝试重新执行 DSML 工具调用');
 }
 for (const call of dsmlCalls) {
 try {
 const result = await executeToolCall({ name: call.name, params: call.params });
 console.log('📊 DSML 工具结果:', result.success ? '成功' : result.error);
 const content = result.success ? (typeof result.content === 'object' ? JSON.stringify(result.content, null, 2) : String(result.content || '')) : String(result.error);
 allResultsContent += `【工具: ${call.name}】\n${content.substring(0, 3000)}\n\n`;
 } catch (e) {
 console.error('❌ DSML 工具执行失败:', e.message);
 allResultsContent += `【工具: ${call.name}】执行失败: ${e.message}\n\n`;
 }
 }
 }

 const summaryMessages = [
 { role: 'system', content: '你是一个专业的数据分析助手。请基于提供的工具执行结果，给用户一个完整、详细的分析报告。\n\n格式要求（必须严格遵守）：\n1. 分析内容用自然语言文本描述，包括数据总结、关键发现、趋势和异常\n2. **所有数据必须使用 Markdown 表格展示**，包括：汇总数据、分类数据、明细数据、统计数据\n3. **禁止用列表（• 或 -）展示数据**，数据行≥2行时必须用表格\n4. 给出决策建议\n5. 绝对不要输出任何工具调用标签（如 DSML、XML 标签等）\n6. 用中文回复\n7. 数字使用千分位格式，如 ¥1,000\n8. 合计行用 **加粗** 突出\n\n表格示例：\n| 项目 | 数量 | 单价 | 金额 |\n|------|------|------|------|\n| 交换机 | 1台 | ¥600 | ¥600 |\n| 网线 | 1箱 | ¥380 | ¥380 |\n| **合计** | - | - | **¥980** |' },
 { role: 'user', content: `以下是工具执行的结果，请给出完整的分析报告：\n\n${allResultsContent.substring(0, 12000)}` }
 ];
 
 try {
 const summaryResp = await fetchWithRetry(`${baseUrl}/chat/completions`, {
 method: 'POST',
 // 2026-08-15 审查返工 P2-3: 补 signal——用户停止后 DSML 汇总 fetch 可中断
 signal: interruptSignal,
 headers: {
 'Authorization': `Bearer ${apiKey}`,
 'Content-Type': 'application/json'
 },
 body: JSON.stringify({
 model: model,
 messages: summaryMessages,
 temperature: 0.7,
 max_tokens: 8192
 })
 });
 
 const summaryData = await summaryResp.json();
 if (summaryData.choices && summaryData.choices[0]) {
 reply = summaryData.choices[0].message.content || '数据处理完成。';
 reply = stripDSMLTags(reply);
 console.log('📝 基于工具结果生成完整分析:', reply.substring(0, 100));
 }
 } catch (e) {
 console.error('❌ 生成分析报告失败:', e.message);
 reply = stripDSMLTags(reply);
 if (reply.trim().length < 20) {
 reply = '数据处理完成，但无法生成详细分析报告。';
 }
 }
 }
 
 unifiedAddMessage(userId, 'user', message);
 unifiedAddMessage(userId, 'assistant', reply);

 globalCommitmentTracker.enqueueExtraction({
 userText: message,
 assistantText: reply,
 sessionId: userId,
 channel: 'cli',
 });

 try {
 const trajectoryMessages = [
 { role: 'system', content: systemPrompt },
 ...userHistory.map(m => ({ role: m.role, content: m.content })),
 { role: 'user', content: message },
 { role: 'assistant', content: reply }
 ];
 globalTrajectorySaver.save(trajectoryMessages, model, true);
 } catch (e) { console.warn('保存轨迹失败:', e.message); }
 
 console.log(`⏱️ [性能] 总耗时: ${Date.now() - startTime}ms`);
 globalRequestInterrupt.unregister(userId, interruptController);
 // 后对话自动学习：非阻塞触发 ConversationReviewFork
 try {
 const { getReviewFork } = require('./evolution/conversation-review-fork');
 // 2026-08-16 修复: getRecentMessages 是 async(返回 Promise)——直接传入 fork
 // 的 messages 为 Promise, _extractUserMessages 调 .filter 崩 "messages.filter
 // is not a function"(体验回放学习从未真正执行)。await 后传数组。
 const recentMessages = await history.getRecentMessages(userId, 50);
 getReviewFork().reviewAfterTurn({ messages: Array.isArray(recentMessages) ? recentMessages : [], userId, sessionId: userId }).catch((e) => { console.debug('[ai] Conversation review fork 后置学习失败:', e?.message || e); });
 } catch (_e) { console.warn('[ai] Conversation review fork failed:', _e.message); }
 // ── ACI Phase 3 flush：把本次的工具链写入 PatternLearner ──
 try { _aciBufferFlush(userId); } catch (e) { console.warn('[ai] ACI flush 失败:', e?.message || e); }
 return reply;
 }
 console.log(`⏱️ [性能] 总耗时: ${Date.now() - startTime}ms`);
 globalRequestInterrupt.unregister(userId, interruptController);
 return '抱歉，我暂时无法处理您的请求，请稍后重试或换一种方式提问。';
}

function buildMemoryContextPrompt(context) {
 const parts = [];

 if (context.sessionMemory && context.sessionMemory.messages) {
 const msgs = context.sessionMemory.messages;
 if (msgs.length > 0) {
 const recentMessages = msgs.slice(-10).map(m => {
 const role = m.role === 'user' ? '👤 用户' : '🦀 助手';
 const time = m.timestamp ? new Date(m.timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
 const content = m.content.length > 300 ? m.content.slice(0, 300) + '...' : m.content;
 return `[${time}] ${role}: ${content}`;
 }).join('\n');

 parts.push(`
## 💬 近期对话记忆

${recentMessages}
`);
 }
 }

 if (context.sessionMemory && context.sessionMemory.sections) {
 const sections = context.sessionMemory.sections;
 const activeSections = Object.entries(sections)
 .filter(([_, s]) => s.content && s.content.trim())
 .slice(0, 5);

 if (activeSections.length > 0) {
 const sessionText = activeSections.map(([_name, section]) =>
 `### ${section.title}\n${section.content.slice(0, 300)}`
 ).join('\n\n');

 parts.push(`
## ⚡ 会话关键信息

${sessionText}
`);
 }
 }
 
 if (context.notebook && context.notebook.length > 0) {
 const notes = context.notebook.map(n => {
 const typeEmoji = {
 'user': '👤',
 'feedback': '💬',
 'project': '📁',
 'reference': '🔗'
 }[n.type] || '📝';
 
 return `${typeEmoji} **${n.title}** (${n.type})\n ${n.content.slice(0, 200)}`;
 }).join('\n\n');
 
 parts.push(`

## 📓 笔记本记忆

以下是你记录的重要信息（按类型分类）：

${notes}

> 记忆类型说明：
> - 👤 user: 用户偏好和背景
> - 💬 feedback: 用户反馈和指导
> - 📁 project: 项目相关信息
> - 🔗 reference: 外部资源引用
`);
 }
 
 if (context.insights && context.insights.length > 0) {
 const insights = context.insights.map(i => 
 `- 💡 ${i.content} (重要性: ${Math.round(i.importance * 100)}%)`
 ).join('\n');
 
 parts.push(`

## 🧠🌙 深度洞察

通过分析历史对话，你发现了以下模式：

${insights}

> 这些洞察来自自动梦境整理，帮助你更好地理解用户需求。
`);
 }
 
 return parts.join('');
}

// summarize 实现已移至 ./ai-summarizer.js（依赖注入模式）
async function summarize(config, keyword, results, customPrompt) {
 return _summarizeImpl(config, keyword, results, customPrompt, {
 getModelRouter,
 createModelRouter,
 fetchWithRetry,
 });
}

// parseSkillCall 实现已移至 ./ai-parsers.js（顶部已 import，直接复用）

// parseToolCall 实现已移至 ./ai-parsers.js（依赖注入：传入 toolSystem）
function parseToolCall(text) {
 return _parseToolCallImpl(text, toolSystem);
}

// _evaluateAgentRoute / buildMultiPhasePrompt / _needsResearch / _needsReview
// 实现已移至 ./ai/agent-router.js（顶部已 import，纯函数无需包装）
// _executeMultiAgentTask 需注入 subAgentCallback，此处保留薄包装

async function _executeMultiAgentTask(config, userId, message, route) {
 return _executeMultiAgentTaskImpl(config, userId, message, route, subAgentCallback);
}

async function enhancedChat(config, skills, userId, message) {
 let router = getModelRouter();
 if (!router) {
 router = createModelRouter(config);
 }

 router.route(message);

 // 多智能体路由：评估任务复杂度，决定是否使用分层智能体
 const agentRoute = _evaluateAgentRoute(message);
 if (agentRoute.useMultiAgent) {
 console.log(`🤖 [多智能体] 任务路由: ${agentRoute.archetype} (${agentRoute.reason})`);
 try {
 const agentResult = await _executeMultiAgentTask(config, userId, message, agentRoute);
 if (agentResult) {
 unifiedAddMessage(userId, 'user', message);
 unifiedAddMessage(userId, 'assistant', agentResult);
 return agentResult;
 }
 } catch (e) {
 console.warn('⚠️ [多智能体] 执行失败，降级到单智能体:', e.message);
 }
 }

 const processedSkills = processSkillArguments(getLoadedSkills(), message);
 
 const allTools = toolSystem.getAll();
 const ecChannel = Array.isArray(config.chatChannel) ? config.chatChannel[0] : (config.chatChannel || 'none');
 const tools = filterToolsByChannel(allTools, ecChannel);
 const toolNames = tools.map(t => t.name);

 const filteredSkills = filterSkillsByContext(processedSkills, toolNames);
 // P1-4: 技能清单按需注入（无命中自动全量回退，能力零回退）
 const skillPrompt = buildSkillsPromptScoped(message, filteredSkills);

 console.log('📚 [流式] 技能列表:', filteredSkills.map(s => s.name).join(', '));
 console.log('📝 [流式] 技能提示词长度:', skillPrompt?.length || 0);
 
 const memoryContext = await memoryManager.getFullContext(userId, message);
 const memoryPrompt = buildMemoryContextPrompt(memoryContext);
 const toolSummaries = {};
 tools.forEach(t => { toolSummaries[t.name] = t.description; });

 const runtimeInfo = buildRuntimeInfo(config);
 const sessionMode = _detectSessionMode(message);
 const environmentIssues = _collectEnvironmentIssues();
 // 注入本机环境信息（systemEnvironment, ）
 let systemEnvironmentText = '';
 try {
 const { getSystemEnvironment } = require('./system-environment');
 systemEnvironmentText = await getSystemEnvironment().formatForPrompt({ maxLength: 600 });
 } catch (e) { console.warn('[ai] 系统环境获取失败(降级):', e?.message || e); }
 // 注入自我画像（自我感知层）
 let selfAwarenessText = '';
 try {
 const { getSelfAwareness } = require('./self-awareness');
 selfAwarenessText = await getSelfAwareness().perceiveLite();
 } catch (e) { console.warn('[ai] 自我画像获取失败(降级):', e?.message || e); }
 const systemPrompt = contextCache.getSystemPrompt(config, {
 toolNames,
 skillsPrompt: skillPrompt,
 memoryPrompt: memoryPrompt,
 runtimeInfo,
 sessionMode,
 environmentIssues,
 systemEnvironmentText,
 selfAwarenessText,
 }, () => buildSystemPrompt(config, {
 toolNames,
 toolSummaries,
 skillsPrompt: skillPrompt,
 memoryPrompt: memoryPrompt,
 runtimeInfo,
 sessionMode,
 environmentIssues,
 systemEnvironmentText,
 selfAwarenessText,
 }));
 
 const userHistory = await contextCache.getHistory(
 userId,
 () => history.getRecentMessages(userId, 20)
 );

 const now = new Date();
 const currentTime = now.toLocaleString('zh-CN', {
 timeZone: 'Asia/Shanghai',
 year: 'numeric',
 month: '2-digit',
 day: '2-digit',
 hour: '2-digit',
 minute: '2-digit',
 hour12: false
 });

 let timeContext = `\n\n[当前时间: ${currentTime}]`;
 if (userHistory.length > 0) {
 const firstMsg = userHistory[0];
 if (firstMsg.timestamp) {
 const firstTime = new Date(firstMsg.timestamp).toLocaleString('zh-CN', {
 timeZone: 'Asia/Shanghai',
 year: 'numeric',
 month: '2-digit',
 day: '2-digit',
 hour: '2-digit',
 minute: '2-digit',
 hour12: false
 });
 const lastMsg = userHistory[userHistory.length - 1];
 const lastTime = new Date(lastMsg.timestamp).toLocaleString('zh-CN', {
 timeZone: 'Asia/Shanghai',
 year: 'numeric',
 month: '2-digit',
 day: '2-digit',
 hour: '2-digit',
 minute: '2-digit',
 hour12: false
 });
 timeContext += `\n[对话时间线: 首次对话 ${firstTime}, 最近对话 ${lastTime}]`;
 }
 }

 const executionContext = {
 toolSystem,
 projectRoot: PROJECT_ROOT,
 workspaceDir: WORKSPACE_DIR,
 history: userHistory,
 historyManager: history,
 systemPrompt: systemPrompt + timeContext,
 memoryManager
 };
 
 unifiedAddMessage(userId, 'user', message);
 
 try {
 const result = await enhancedTaskExecutor.executeTask(config, userId, message, executionContext);
 
 unifiedAddMessage(userId, 'assistant', result);
 
 return result;
 } catch (error) {
 console.error('❌ 增强任务执行失败:', error.message);
 
 const fallbackResult = await chat(config, skills, userId, message);
 return fallbackResult;
 }
}

// 2026-09-06: 同 chat()——回合收敛包装（语音主路径）
async function chatStream(config, skills, userId, message, onChunk, options = {}) {
  const filegen = require('./filegen-events');
  const isSilent = !!(options && options.silent);
  if (!isSilent) { try { filegen.beginTurn(); } catch (e) { /* 不阻塞 */ } }
  try {
    return await chatStreamImpl(config, skills, userId, message, onChunk, options);
  } finally {
    if (!isSilent) { try { filegen.settleTurn(); } catch (e) { /* 不阻塞 */ } }
  }
}

async function chatStreamImpl(config, skills, userId, message, onChunk, options = {}) {
 // 2026-08-13 P2-4: 会话上下文——sessionId 非空时历史按会话过滤、持久化按会话落库
 const sessionId = options.sessionId || null;
 // 2026-08-15 P1-4: roundId 由 chat-handler 经 options 传入(recordLLMEvent('start')
 // 已生成)——流内工具事件/轨迹显式锚定本轮, 不再依赖 activity-stream 全局
 // _currentRoundId 回退(并发双流错乱的根因)。
 const roundId = options.roundId || null;
 // 2026-08-04: 执行验证门(幻觉防护)——每次 chatStream 请求全新局部状态,强制重试
 // 只触发一次。2026-08-15 P2-7: 从模块级移入局部(跨请求竞态修复)。
 let _hallucinationGuardFired = false;
 // 2026-08-04 P1: 验证门触发后强制 tool_choice 的工具名(Write)
 let _forceToolChoice = null;
 // 2026-09-07: 收答保底轮已使用标志——finalAnswerRound 收答时若生成任务未终态,
 // 给一轮 required 保底(注入 FILEGEN_GRACE_NUDGE), 只给一次, 下一轮硬收答。
 let _filegenGraceFired = false;
 sessionImageGenerateSuccess.delete(userId);
 sessionVideoGenerateSuccess.delete(userId);

 // ── ACI Phase 3：模式学习 - 开启新的工具链 buffer ──
 try {
 const intent = detectMessageIntent ? (detectMessageIntent(message) || 'general') : 'general';
 _aciBufferReset(userId, intent);
 } catch (e) { console.warn('[ai] ACI buffer reset 失败:', e?.message || e); }

 // 2026-09-03(Plan 实体): chatStream 主路径此前完全没有任务检测——多步任务
 // (GUI/语音全走本函数)模型实测跳过 PlanCreate 直接开跑。与 chat() 尾缀同款:
 // 命中多步任务时给用户消息追加执行计划指令(经 prepareChatContext 进入 LLM 输入)。
 let streamMessage = message;
 try {
 const { detectTaskMode } = require('./task-mode-detector');
 const td = detectTaskMode(message);
 if (td.isTask && td.confidence > 0.25) {
 streamMessage = message + '\n\n[系统提示：这是一个多步任务。请先调用 PlanCreate 工具建立执行计划（传入标题与按顺序的步骤清单），随后每完成一个关键步骤调用 PlanUpdate 同步进度（status: done/running/failed），全部完成后正常作答。]';
 console.log('[task-mode] chatStream 多步任务命中, 已注入执行计划指令');
 }
 } catch (e) { console.warn('[task-mode] chatStream 检测失败(忽略):', e?.message || e); }

 const ctxResult = await prepareChatContext(config, userId, streamMessage, {
 isStream: true,
 historyLimit: 10,
 // 2026-09-07: 注入检测只扫用户原文——streamMessage 已含系统脚手架
 // (执行计划指令/上传说明/专家人设)，扫全文会把自家注入误判为攻击
 rawUserMessage: (options && options.rawUserMessage) || undefined,
 enableGatewayPreCheck: true,
 sessionId,
 onCompressed: (compressionResult) => {
 try {
 const ctxRule = globalStrategyOptimizer.getBestRule('context_management');
 if (ctxRule) {
 globalStrategyOptimizer.recordRuleExecution('context_management', ctxRule.id, compressionResult.compressed);
 }
 } catch (e) { console.warn('⚠️ 模型选择策略执行异常:', e.message); }
 },
 });
 
 if (ctxResult.error) {
 onChunk({ content: ctxResult.error, done: true });
 return ctxResult.error;
 }
 
 // eslint-disable-next-line no-unused-vars -- 解构出的 tools 在当前分支未消费（保留上下文取值对齐）
 const { provider, model, baseUrl, apiKey, messages: compressedMessages, tools } = ctxResult;
 // S1: 技能自动触发——命中分类则向首轮注入技能推荐(chatStream 语音主路径)
 try { injectSkillGuidance(compressedMessages, message); } catch (e) { console.warn('[skill-auto] chatStream 注入失败:', e.message); }
 
 // 2026-08-13 P2-4: 用户消息按会话落库(会话上下文延续的关键)
 // 2026-08-17: 文件生成四步流程——生成意图请求开始即开任务（①资料搜集，面板滑入）
 //（chat()/chatStream() 双路径幂等：ensureFileGenTask 复用活跃任务，重复调用只重发 phase）
 // 2026-08-22: 命中时注入 FILEGEN_TASK_HINT 事前引导（同 chat() 1379 挂点）
 if (maybeStartFileGenTask(message, userId)) {
   // 2026-08-23: 分档引导——轻量文章 vs 深度研究（fileGenHintFor 按词表选择）
   compressedMessages.push({ role: 'system', content: fileGenHintFor(message) });
 } else if (!(options && options.silent)) {
   // 2026-09-06 恢复链路（与 chat() 挂点同构）: 继续类消息复活暂停任务 +
   // 注入继续引导，治"恢复后全文直吐对话"。chatStreamImpl 无 isSilent 闭包
  //（isSilent 在 chatStream 包装器局部），经 options 就地取值。
   const resumedTask = maybeResumeFileGenTask(message);
   if (resumedTask) {
     compressedMessages.push({ role: 'system', content: fileGenResumeHintFor(resumedTask) });
   } else {
     // 追问回答链路: paused 任务等待补充需求，回答类消息注入条件引导
     const pausedTask = maybePausedFileGenTask();
     if (pausedTask) compressedMessages.push({ role: 'system', content: fileGenPausedAnswerHintFor(pausedTask) });
   }
 }
 unifiedAddMessage(userId, 'user', message, sessionId);
 globalOnboarding.recordInteraction(userId);

 // 感知层已在 prepareChatContext() 中统一调用，无需重复
 // 2026-08-04 P1 修复:chatStream(语音主路径)改用 buildToolDefinitions——与 chat() 一致,
 // 走意图路由/熔断/checkFn/僵尸过滤。注意:buildToolDefinitions 已返回 LLM 格式
 // {type, function} 并 sanitize,不能再次 filter(t => t.schema)(会把全部工具清空
 // → LLM 收到 0 工具 → 只能文本回复"已生成"——"胡说"的终极根因!)
 const streamChannel = Array.isArray(config.chatChannel) ? config.chatChannel[0] : (config.chatChannel || 'none');
 const toolDefinitions = buildToolDefinitions(streamChannel, message, { expertToolsets: getActiveExpertToolsets(_currentUserId) });

  // 2026-08-15 P1-6: 流式路径设置工具 execContext 全局——此前仅 chat() 设置
  // (ai.js:1260-1261), 流式工具 channel='none'/userId=''(preToolHook sessionId
  // 恒 '')。与 chat() 同一来源; 并发覆盖风险已知(模块级全局), 至少保证
  // chatStream 内设置值随请求更新。
  _currentChannel = streamChannel;
  _currentUserId = userId || '';
  // 2026-08-15 P1-5: 本轮 RepeatFailureGuard 清零——per-user 隔离后, 用户上一轮
  // 的连续失败计数不应影响本轮 forceFinalAnswer 判定。
  _getFailureGuard(userId).reset();

  // —— I-3 T1: chatStream 中断注册 ——
  const _interruptReg = registerInterruptForChatStream(userId);
  // 2026-08-15 P1-7: 用户停止中断信号(内部 latch)——所有 fetch/副作用检查共用,
  // 用户主动停止时整轮立即终止(中断语义不变)。
  const interruptSignal = _interruptReg.signal;
  // 2026-08-15 审查返工 Important-1: 外部空闲超时信号(chat-handler 120s 无 chunk)
  // 不再与内部信号静态合并——一次性 latch 在工具执行期间超时 abort 后会把合并
  // 信号永久 latch, 工具完成后下一轮 fetch 立即 AbortError → 整轮被误判"用户
  // 中断"。改为流读取专用 relay: 每轮 fetch 前新建 readAbort 并挂接"当前"空闲
  // 信号(已 abort 则跳过——超时只中止它在飞的读取, 不污染后续轮次); chat-handler
  // 在超时 abort 后立刻换新 controller, 后续轮次经 getIdleSignal() 取到未 abort
  // 的新信号, 计时器随 chunk 重新武装。
  const relay = createStreamInterruptRelay({
    internalSignal: interruptSignal,
    getIdleSignal: typeof options.getIdleSignal === 'function'
      ? options.getIdleSignal
      : (options.interruptSignal ? () => options.interruptSignal : null),
  });

  // ── Streaming phase-based multi-agent ──
  // 2026-08-01 架构决策：本阶段式 orchestrator 是"装饰流"——
  // LLM 在单次回复中通过 <phase:xxx> 标记角色扮演各阶段（规划/研究/执行/审查/交付），
  // SSE subagent:start/end 事件仅提供多阶段视觉反馈，不产生真实子代理进程。
  // 真实子代理只通过 SpawnSubagent 工具（LLM 显式调用 → TieredSubAgentRunner）创建，
  // 两条路径刻意分离：装饰流保证 UX 反馈即时性，工具路径保证执行可控性。
  const agentRoute = _evaluateAgentRoute(message);
  onChunk({ type: 'route', useMultiAgent: agentRoute.useMultiAgent, archetype: agentRoute.archetype, reason: agentRoute.reason, complexity: agentRoute.complexity });
  if (agentRoute.useMultiAgent) {
 console.log(`🤖 [复杂任务][流式] 阶段式执行: ${agentRoute.archetype} (${agentRoute.reason})`);
 const phasePrompt = buildMultiPhasePrompt(message, agentRoute);
 compressedMessages.unshift({ role: "system", content: phasePrompt });
 if (subAgentCallback) subAgentCallback(userId, "start", { agentId: "orchestrator", archetype: "orchestrator", tier: "chat", task: message.substring(0, 100) });
 onChunk({ type: "subagent", status: "start", agentId: "orchestrator", archetype: "orchestrator", tier: "chat", task: message.substring(0, 100) });
 onChunk({ type: "thinking", content: "🤖 检测到复杂任务，按分阶段策略处理..." });
 }
 // 未路由到多智能体，发送初始思考事件
 if (!agentRoute.useMultiAgent) {
 onChunk({ type: 'thinking', content: '正在理解您的问题...' });
 }
 // ── End streaming phase block ──

 console.log('📤 发送流式请求到 AI...');

 // 不再基于关键词强制 tool_choice='required'：弱模型在工具名不清晰时会捏造非法工具名
 // 或错误参数，导致连续失败 break。意图提示词已在 system prompt 和 INTENT_PATTERNS 中注入，
 // 模型知道何时该用工具，用 'auto' 让模型自主判断。
 const streamToolChoice = 'auto';
 // 2026-08-04 P1: 文档生成场景检测(首轮强制工具调用——deepseek 受历史
 // "生成报告成功"记录污染,始终文本复述"已生成"不实际调用工具。
 // 生成类请求首轮 tool_choice=required,LLM 无法再以文本回复逃避执行)
 const hasDocGeneration = /生成.*Word|生成.*文档|写.*文档|创建.*文档|导出.*文档|导出.*Word|MarkdownToWord|生成.*Excel|导出.*Excel|生成.*表格|导出.*表格|创建.*表格|MarkdownToExcel|xlsx_generate|生成.*PPT|制作.*PPT|导出.*PPT|生成.*幻灯片|MarkdownToPPT|pptx_generate|生成.*PDF|导出.*PDF|生成.*pdf|MarkdownToPDF|pdf_generate|生成.*HTML|生成.*网页|导出.*HTML|MarkdownToHTML|html_generate/i.test(message);
 // 广义生成请求(报告/网页/文档/文件 + 生成动词)——首轮强制工具
 const forceRequiredFirstRound = /生成|创建|写|制作|导出|转换/.test(message)
   && /报告|网页|文档|文件|html|word|excel|ppt|pdf|md/i.test(message);

 let streamTotalToolCalls = 0;
 // 2026-09-04 Loop 第一刀: 循环参数收敛为 agent/loop-contract 单一事实源
 // (此前 8/10/15/120000 裸字面量, effectiveToolCallLimit 与旧中间常量已删)
 const { IterationBudget } = require('./iteration-budget');
 const { chatStreamLoopParams } = require('./agent/loop-contract');
 const budget = new IterationBudget(chatStreamLoopParams(agentRoute.useMultiAgent));
 const effectiveToolCallLimit = agentRoute.useMultiAgent
   ? require('./agent/loop-contract').AGENT_LOOP_CONTRACT.maxTotalToolCalls.chatStreamMultiAgent
   : require('./agent/loop-contract').AGENT_LOOP_CONTRACT.maxTotalToolCalls.chatStreamSingleAgent;
 const currentChannel = Array.isArray(config.chatChannel) ? config.chatChannel[0] : (config.chatChannel || 'none');
 // 连续失败计数已统一到 globalFailureGuard（RepeatFailureGuard），不再使用独立计数
 // 工具执行累积摘要（参考 OpenHuman run_tool_digest）
 let runToolDigest = '';
 // 电路断路器标志 — 触发后直接返回根因摘要，不再调 AI
 let circuitBreakerTripped = false;
 let circuitBreakerReason = '';

 async function forceFinalAnswer(currentMessages) {
 console.log('📝 [流式] 强制生成最终回答（不带工具）');

 // 收集失败信息用于生成有意义的降级回复
 const failedToolNames = [];
 const failureReasons = [];
 const successToolResults = [];
  // 发送降级事件—让前端明确知道进入了降级路径
  try { if (typeof onChunk === "function") onChunk({ type: "eval_start", cycle: -1, mode: "degraded" }); } catch(e) { console.debug('[ai] [流式降级] eval_start 发送失败:', e?.message || e); }
 successToolResults.length = 0;
 for (const msg of currentMessages) {
 if (msg.role === 'tool' && typeof msg.content === 'string') {
 const toolCallId = msg.tool_call_id;
 const parentMsg = currentMessages.find(m => m.role === 'assistant' && m.tool_calls?.some(tc => tc.id === toolCallId));
 if (msg.content.startsWith('错误:') || msg.content.startsWith('工具执行失败:') || msg.content.includes('失败') || msg.content.includes('error') || msg.content.includes('Error')) {
 if (parentMsg) {
 const tc = parentMsg.tool_calls.find(tc => tc.id === toolCallId);
 if (tc) failedToolNames.push(tc.function?.name || 'unknown');
 }
 const reason = msg.content.replace(/^错误:\s*/, '').replace(/^工具执行失败:\s*/, '').replace(/\n\n\[系统提示\].*/, '').substring(0, 200);
 failureReasons.push(reason);
 } else if (!msg.content.startsWith('[循环检测]')) {
 // 收集成功的工具结果
 const toolName = parentMsg ? parentMsg.tool_calls?.find(tc => tc.id === toolCallId)?.function?.name : null;
 successToolResults.push({ name: toolName, content: msg.content.substring(0, 500) });
 }
 }
 }

 // 将累积摘要作为上下文注入，让 AI 生成最终解释性回复（而非直接拼接摘要返回）
 // 参考 Codex 的做法：降级时模型始终作为"最后一道关"生成回复
 if (runToolDigest && runToolDigest.trim().length > 0) {
 const digestLines = runToolDigest.split('\n').filter(l => l.trim());
 const okLines = digestLines.filter(l => l.includes('[ok]'));
 const failLines = digestLines.filter(l => l.includes('[failed]'));

 let digestContext = '[系统] 你的迭代预算已用尽或工具连续失败。以下是工具执行摘要：\n\n';
 if (okLines.length > 0) {
 digestContext += '**已成功执行的操作**:\n';
 for (const line of okLines) {
 digestContext += line.replace(/- /, '• ').replace(/ \[ok\]: /, ': ') + '\n';
 }
 digestContext += '\n';
 }
 if (failLines.length > 0) {
 digestContext += '**失败的操作**:\n';
 for (const line of failLines) {
 digestContext += line.replace(/- /, '• ').replace(/ \[failed\]: /, ': ') + '\n';
 }
 digestContext += '\n';
 }
 if (circuitBreakerTripped && circuitBreakerReason) {
 digestContext += `**中断原因**: ${circuitBreakerReason}\n\n`;
 }
 digestContext += '请根据以上信息：1) 总结你已完成的工作；2) 解释遇到的障碍；3) 给用户提供有意义的建议和替代方案。绝对不要沉默，必须给出有意义的回复。';

 // 不再直接 onChunk 返回摘要，而是将摘要注入消息让 AI 生成最终回复
 // 清理消息中的孤立 tool messages
 const cleanedForDigest = [];
 const digestAssistantToolCallIds = new Set();
 for (const msg of currentMessages) {
 if (msg.role === 'assistant' && msg.tool_calls) {
 for (const tc of msg.tool_calls) {
 if (tc.id) digestAssistantToolCallIds.add(tc.id);
 }
 }
 }
 for (const msg of currentMessages) {
 if (msg.role === 'tool' && msg.tool_call_id && !digestAssistantToolCallIds.has(msg.tool_call_id)) {
 continue;
 }
 // 压缩 tool 消息为 user 消息，避免无工具定义时的 API 错误
 if (msg.role === 'tool') {
 cleanedForDigest.push({ role: 'user', content: `[工具执行结果] ${typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)}` });
 } else if (msg.role === 'assistant' && msg.tool_calls) {
 cleanedForDigest.push({ role: 'assistant', content: msg.content || '(调用了工具)' });
 } else {
 cleanedForDigest.push(msg);
 }
 }

 try {
 const allKeys = collectProviderApiKeysForExecution({ primaryApiKey: apiKey, provider });
 const digestRequest = async (currentKey) => {
 const response = await fetchWithRetry(`${baseUrl}/chat/completions`, {
 method: 'POST',
 signal: relay.nextReadSignal(),
 headers: {
 'Authorization': `Bearer ${currentKey}`,
 'Content-Type': 'application/json'
 },
 body: JSON.stringify({
 model: model,
 messages: [...cleanedForDigest, { role: 'user', content: digestContext }],
 temperature: 0.7,
 stream: true
 })
 });
 if (!response.ok) {
 const err = new Error(`HTTP ${response.status}`);
 err.status = response.status;
 throw err;
 }
 return response;
 };

 let resp;
 if (allKeys.length > 1) {
 resp = await executeWithApiKeyRotation({
 provider, apiKeys: allKeys, execute: digestRequest,
 shouldRetry: ({ message: msg }) => /rate.?limit|429|too.?many/i.test(msg),
 onRetry: ({ apiKey: retryKey, attempt: _attempt }) => {
 globalKeyRotationManager.setCooldown(provider, retryKey.slice(-8), 60000);
 },
 });
 } else {
 resp = await digestRequest(apiKey);
 }

 const reader = resp.body.getReader();
 const decoder = new TextDecoder();
 let finalContent = '';
 let buffer = '';
 thinkScrubber.reset();
 contextScrubber.reset();
 dsmlScrubber.reset();

 // eslint-disable-next-line no-constant-condition
 while (true) {
 const { done, value } = await reader.read();
 if (done) break;
 buffer += decoder.decode(value, { stream: true });
 const lines = buffer.split('\n');
 buffer = lines.pop() || '';
 for (const line of lines) {
 if (line.startsWith('data: ')) {
 const data = line.slice(6);
 if (data === '[DONE]') continue;
 try {
 const parsed = JSON.parse(data);
 const delta = parsed.choices?.[0]?.delta;
 if (delta?.content) {
 // 2026-08-06: 流式过滤 DSML 工具调用标签，防止 <tool_calls> 透传前端
 const dsmlScrubbed = dsmlScrubber.feed(delta.content);
 if (!dsmlScrubbed) continue
 const thinkScrubbed = thinkScrubber.feed(dsmlScrubbed);
 if (thinkScrubbed) {
 const contextScrubbed = contextScrubber.process(thinkScrubbed);
 if (contextScrubbed) {
 finalContent += contextScrubbed;
 onChunk({ content: contextScrubbed, done: false });
 }
 }
 }
 } catch (e) { console.warn('流式解析失败:', e.message); }
 }
 }
 }
 const thinkTail = thinkScrubber.flush();
 const contextTail = thinkTail ? contextScrubber.process(thinkTail) + contextScrubber.flush() : contextScrubber.flush();
 if (contextTail) { finalContent += contextTail; onChunk({ content: contextTail, done: false }); }
 const dsmlTail = dsmlScrubber.flush();
 if (dsmlTail) { finalContent += dsmlTail; onChunk({ content: dsmlTail, done: false }); }

  // 2026-08-06: 空 JSON 兜底——deepseek-v4-flash 对模糊/口语输入会流式输出
  // "```json\n[]\n```" 或 {}。trim 后长度>0 会绕过下方空回复摘要降级,直接透传空白。
  // 这里显式检测纯 JSON 空结构,替换为友好提示。
  if (isEmptyInvalidReply(finalContent)) {
    console.warn('🤖 流式检测到空 JSON/空回复，替换为友好提示:', JSON.stringify(String(finalContent).trim().slice(0, 50)));
    finalContent = '抱歉，我刚才没听清您的问题，能再说一遍吗？';
    try { onChunk({ content: finalContent, done: true }); } catch(e) { console.debug('[ai] [流式降级] 空回复兜底 chunk 发送失败:', e?.message || e); }
    try { onChunk({ type: "eval_done", cycle: -1, mode: "degraded" }); } catch(e) { console.debug('[ai] [流式降级] eval_done 发送失败:', e?.message || e); }
    return finalContent;
  }

  if (finalContent && finalContent.trim().length > 0) {
    try { onChunk({ type: "eval_done", cycle: -1, mode: "degraded" }); } catch(e) { console.debug('[ai] [流式降级] eval_done 发送失败:', e?.message || e); }
    return finalContent;
  }
 // AI 生成空回复时，降级到摘要
 let summaryMsg = '⚠️ 任务执行已达到限制\n\n';
 if (okLines.length > 0) {
 summaryMsg += '**已获取的结果**:\n';
 for (const line of okLines) {
 summaryMsg += line.replace(/- /, '• ').replace(/ \[ok\]: /, ': ') + '\n';
 }
 summaryMsg += '\n';
 }
 if (failLines.length > 0) {
 summaryMsg += '**失败的操作**:\n';
 for (const line of failLines) {
 summaryMsg += line.replace(/- /, '• ').replace(/ \[failed\]: /, ': ') + '\n';
 }
 summaryMsg += '\n';
 }
 if (circuitBreakerTripped && circuitBreakerReason) {
 summaryMsg += `**中断原因**: ${circuitBreakerReason}\n\n`;
 }
  summaryMsg += '请尝试换一种方式描述需求，或检查相关工具是否可用。';
  onChunk({ content: summaryMsg, done: true });
   try { onChunk({ type: "eval_done", cycle: -1, mode: "degraded" }); } catch(e) { console.debug('[ai] [流式降级] eval_done 发送失败:', e?.message || e); }
   return summaryMsg;
   } catch (e) {
   console.error('❌ [流式] 基于摘要生成最终回答失败:', e.message);
   // AI 生成失败时，降级到摘要
 let summaryMsg = '⚠️ 任务执行已达到限制\n\n';
 if (okLines.length > 0) {
 summaryMsg += '**已获取的结果**:\n';
 for (const line of okLines) {
 summaryMsg += line.replace(/- /, '• ').replace(/ \[ok\]: /, ': ') + '\n';
 }
 summaryMsg += '\n';
 }
 if (failLines.length > 0) {
 summaryMsg += '**失败的操作**:\n';
 for (const line of failLines) {
 summaryMsg += line.replace(/- /, '• ').replace(/ \[failed\]: /, ': ') + '\n';
 }
 summaryMsg += '\n';
 }
 if (circuitBreakerTripped && circuitBreakerReason) {
 summaryMsg += `**中断原因**: ${circuitBreakerReason}\n\n`;
 }
  summaryMsg += '请尝试换一种方式描述需求，或检查相关工具是否可用。';
   onChunk({ content: summaryMsg, done: true });
   try { onChunk({ type: "eval_done", cycle: -1, mode: "degraded" }); } catch(e) { console.debug('[ai] [流式降级] eval_done 发送失败:', e?.message || e); }
   return summaryMsg;
   }
   }

 const failureSummary = failedToolNames.length > 0
 ? `\n\n以下是失败的工具调用信息供你参考：\n- 失败的工具: ${[...new Set(failedToolNames)].join(', ')}\n- 失败原因: ${failureReasons[failureReasons.length - 1] || '未知'}`
 : '\n\n注意：之前的工具调用被系统循环检测机制阻止了（工具被重复调用太多次），请直接向用户解释情况并给出替代建议。';

 // 如果有成功的工具结果，构建结果摘要
 const successSummary = successToolResults.length > 0
 ? `\n\n以下是已成功获取的工具结果：\n${successToolResults.map(r => `- ${r.name || '工具'}: ${r.content}`).join('\n')}`
 : '';

 // 清理消息中的孤立 tool messages（没有对应 assistant tool_calls 的）
 const cleanedMessages = [];
 const assistantToolCallIds = new Set();
 for (const msg of currentMessages) {
 if (msg.role === 'assistant' && msg.tool_calls) {
 for (const tc of msg.tool_calls) {
 if (tc.id) assistantToolCallIds.add(tc.id);
 }
 }
 }
 for (const msg of currentMessages) {
 if (msg.role === 'tool' && msg.tool_call_id && !assistantToolCallIds.has(msg.tool_call_id)) {
 // 跳过孤立的 tool message
 continue;
 }
 cleanedMessages.push(msg);
 }

 try {
 const allKeys = collectProviderApiKeysForExecution({ primaryApiKey: apiKey, provider });
 const execRequest = async (currentKey) => {
 const response = await fetchWithRetry(`${baseUrl}/chat/completions`, {
 method: 'POST',
 signal: relay.nextReadSignal(),
 headers: {
 'Authorization': `Bearer ${currentKey}`,
 'Content-Type': 'application/json'
 },
 body: JSON.stringify({
 model: model,
 messages: [...cleanedMessages, { role: 'user', content: `请根据以上已获取的信息，直接给出完整回答。不要再调用任何工具。如果之前的工具调用成功了，请基于结果直接回答用户。如果工具调用失败了，请向用户解释失败原因并给出替代建议。${failureSummary}${successSummary}` }],
 temperature: 0.7,
 stream: true
 })
 });
 if (!response.ok) {
 const err = new Error(`HTTP ${response.status}`);
 err.status = response.status;
 throw err;
 }
 return response;
 };

 let resp;
 if (allKeys.length > 1) {
 resp = await executeWithApiKeyRotation({
 provider, apiKeys: allKeys, execute: execRequest,
 shouldRetry: ({ message: msg }) => /rate.?limit|429|too.?many/i.test(msg),
 onRetry: ({ apiKey: retryKey, attempt: _attempt }) => {
 globalKeyRotationManager.setCooldown(provider, retryKey.slice(-8), 60000);
 },
 });
 } else {
 resp = await execRequest(apiKey);
 }

 const reader = resp.body.getReader();
 const decoder = new TextDecoder();
 let finalContent = '';
 let buffer = '';
 thinkScrubber.reset();
 contextScrubber.reset();
 dsmlScrubber.reset();

 // eslint-disable-next-line no-constant-condition
 while (true) {
 const { done, value } = await reader.read();
 if (done) break;
 buffer += decoder.decode(value, { stream: true });
 const lines = buffer.split('\n');
 buffer = lines.pop() || '';
 for (const line of lines) {
 if (line.startsWith('data: ')) {
 const data = line.slice(6);
 if (data === '[DONE]') continue;
 try {
 const parsed = JSON.parse(data);
 const delta = parsed.choices?.[0]?.delta;
 if (delta?.content) {
 // 2026-08-06: 流式过滤 DSML 工具调用标签，防止 <tool_calls> 透传前端
 const dsmlScrubbed = dsmlScrubber.feed(delta.content);
 if (!dsmlScrubbed) continue
 const thinkScrubbed = thinkScrubber.feed(dsmlScrubbed);
 if (thinkScrubbed) {
 const contextScrubbed = contextScrubber.process(thinkScrubbed);
 if (contextScrubbed) {
 finalContent += contextScrubbed;
 onChunk({ content: contextScrubbed, done: false });
 }
 }
 }
 } catch (e) { console.warn('流式解析失败:', e.message); }
 }
 }
 }
 const thinkTail = thinkScrubber.flush();
 const contextTail = thinkTail ? contextScrubber.process(thinkTail) + contextScrubber.flush() : contextScrubber.flush();
 if (contextTail) { finalContent += contextTail; onChunk({ content: contextTail, done: false }); }
 const dsmlTail = dsmlScrubber.flush();
 if (dsmlTail) { finalContent += dsmlTail; onChunk({ content: dsmlTail, done: false }); }
 return finalContent;
 } catch (e) {
 console.error('❌ [流式] 强制生成最终回答失败:', e.message);
 // 生成降级回复，确保用户始终能收到反馈
 const fallbackMsg = failedToolNames.length > 0
 ? `抱歉，我在执行 ${[...new Set(failedToolNames)].join('、')} 时遇到了问题（${failureReasons[failureReasons.length - 1] || '未知错误'}），暂时无法完成您的请求。请稍后重试或换一种方式提问。`
 : '抱歉，我在处理您的请求时遇到了问题，暂时无法完成。请稍后重试或换一种方式提问。';
 onChunk({ content: fallbackMsg, done: true });
 return fallbackMsg;
 }
 }

 async function processWithStreaming(currentMessages, depth = 0) {
 // 2026-09-07 实测修复: 此处原为硬编码 `depth > 5` 强制终答——它位于 tool_choice
 // 分级与 filegen 收答保底轮的上游, 导致契约 finalAnswerRound 与保底轮从未执行
 // (13:20 轮实测 depth=6 直达此处, HTML 未落盘就收答)。改为与契约对齐:
 // depth > finalAnswerRound(保底轮已用完) 或 已到收答轮但无未终态生成任务时
 // 才强收; 有未终态任务时放行到下方 tool_choice 分级走 required 保底轮。
 if (depth > AGENT_LOOP_CONTRACT.finalAnswerRound
     || (depth >= AGENT_LOOP_CONTRACT.finalAnswerRound
         && (_filegenGraceFired || !hasLiveFileGenTask()))) {
 return forceFinalAnswer(currentMessages);
 }

 // 2026-08-15 P2-4: 每轮迭代计数——此前 IterationBudget 创建后从不 record/tick,
 // 弹性扩展实际由 120s 墙钟超时触发(shouldForceStop 唯一可命中条件), 文案与
 // 真实原因不符。对齐非流式 chat 的 incrementIteration 用法。
 budget.incrementIteration();

 // 2026-08-15 P1-2: 流式主路径预算执法——此前 checkRequest 仅非流式 chat()
 // 调用, chatStream 从不检查。每轮入口检查 reasoning 预算; 被拦截 → 给用户
 // 可见预算提示 + forceFinalAnswer 收尾(不再继续工具循环)。
 try {
 const { getBudgetEnforcer } = require('./budget-enforcer');
 const budgetEnforcer = getBudgetEnforcer();
 const estimatedTokens = estimateMessagesTokens(currentMessages) + (DEFAULT_BUDGET?.maxTokens || 4096);
 const budgetCheck = budgetEnforcer.checkRequest({ model, estimatedTokens, userId, category: 'reasoning' });
 if (!budgetCheck.allowed) {
 console.warn(`💰 [流式] 预算拦截: ${budgetCheck.reason}`);
 const budgetNotice = `⚠️ 预算限制: ${budgetCheck.reason}。当前降级级别: ${budgetCheck.degradation}。请稍后重试或联系管理员。`;
 onChunk({ content: budgetNotice, done: false });
 currentMessages.push({ role: 'user', content: `[系统提示] ${budgetNotice} 请基于已有信息直接给出最终回复, 不要再调用任何工具。` });
 return forceFinalAnswer(currentMessages);
 }
 if (budgetCheck.degraded && budgetCheck.suggestedModel) {
 console.log(`💰 [流式] 预算降级: ${model} → ${budgetCheck.suggestedModel}`);
 }
 } catch (e) { console.warn('[ai] 流式预算检查异常:', e.message); }

 // 2026-08-15 P2-4: 预算驱动的弹性扩展判定——此前仅看 streamTotalToolCalls,
 // 且 IterationBudget 计数器从不递增 → shouldForceStop 只被墙钟超时触发。
 if (budget.shouldForceStop() || streamTotalToolCalls >= effectiveToolCallLimit) {
 // 尝试弹性扩展：给模型额外空间完成收尾（仅扩展一次）
 if (budget.tryElasticExtension()) {
 const EXT_REASON_LABEL = { timeout: '120s 超时', iteration_limit: '迭代次数上限', tool_call_limit: '工具调用次数上限', forced: '强制停止' };
 const extReason = EXT_REASON_LABEL[budget.getExtensionReason()] || budget.getExtensionReason() || '预算上限';
 console.log(`🔄 [流式] 预算已弹性扩展(原因: ${extReason})，允许模型收尾`);
 // 注入预算警告让模型知道需要收尾(文案按实际触发原因修正, P2-4)
 currentMessages.push({
 role: 'user',
 content: `[系统] 你的工具调用预算已触及${extReason}(${budget.getStopSummary()})。请：1) 快速评估当前进度；2) 如果任务接近完成，继续完成；3) 如果遇到阻碍，向用户解释并寻求指导。绝对不要沉默。`
 });
 } else {
 return forceFinalAnswer(currentMessages);
 }
 }
 
 // 使用 globalFailureGuard 替代独立的 streamConsecutiveFailures 计数
 if (globalFailureGuard.consecutive >= 3) {
 console.warn(`⚠️ [流式] RepeatFailureGuard 连续 ${globalFailureGuard.consecutive} 次工具调用失败，强制生成降级回复`);
 return forceFinalAnswer(currentMessages);
 }
 
 const rlCheck = isRateLimited({ provider, model });
 if (rlCheck.limited) {
 const waitSec = Math.ceil(rlCheck.remainingMs / 1000);
 const msg = `⏳ 当前模型 ${provider}/${model} 正在限流中，请 ${waitSec} 秒后重试。`;
 onChunk({ content: msg, done: true });
 return msg;
 }

 let resp;
 try {
 // 根据工具执行结果动态调整 tool_choice
 // - depth=0: 使用原始 tool_choice（通常是 required）
 // - depth=1 且有成功结果: auto（AI 可以选择直接回答）
 // - depth=1 且全部失败: required（AI 必须换工具尝试）
 // - depth>=2: auto（已有足够信息或已尝试多种方案）
 // - depth>=finalAnswerRound: none（强制 AI 直接回答）
 // 2026-09-07: 收答轮从硬编码 3 改为契约单源（此前 8 轮预算被实际压成 3 轮，
 // 多步任务如表格分析必然中途截断，用户看到残缺回复）
 let effectiveToolChoice;
 // 2026-09-07: 保底轮工具面收窄标记——本轮请求只带文件生成类工具
 let graceToolsOnly = false;
 const hasSuccessfulResult = currentMessages.some(m => m.role === 'tool' && m.content && !m.content.includes('"error"') && !m.content.includes('失败'));
 if (depth === 0) {
 // 2026-08-04 P1: 生成类请求首轮强制工具调用(deepseek 文本复述防御)
 effectiveToolChoice = forceRequiredFirstRound ? 'required' : streamToolChoice;
 } else if (depth === 1) {
 effectiveToolChoice = hasSuccessfulResult ? 'auto' : streamToolChoice;
 } else if (depth >= AGENT_LOOP_CONTRACT.finalAnswerRound) {
 // 2026-09-07 实测修复: 生成任务(HTML/文档)进行中但产物未落盘时, 直接 none
 // 会把没写完的代码当文本直吐给用户。给一轮保底轮: 工具面收窄为文件生成类
 // (Write/Edit/*Generate)——实测只注入指令不够, 模型保底轮仍会继续跑
 // ShellExec 磨蹭; 收窄后无论如何只能落盘产物。只给一次, 之后硬收答。
 const needsFilegenGrace = !_filegenGraceFired && hasLiveFileGenTask();
 if (needsFilegenGrace) {
 _filegenGraceFired = true;
 graceToolsOnly = true;
 effectiveToolChoice = 'required';
 currentMessages.push({ role: 'system', content: FILEGEN_GRACE_NUDGE });
 console.log('⚠️ [收答保底] 生成任务未终态但已达收答轮——工具面收窄为文件生成类, 注入 Write 保底指令');
 } else {
 effectiveToolChoice = 'none';
 }
 } else {
 effectiveToolChoice = 'auto';
 }
 // 2026-08-04 P1: 执行验证门强制工具——幻觉重试轮强制 tool_choice='required'
 // (deepseek 不支持 tool_choice 指定函数名,仅 auto/none/required)
 // 防止 LLM 再次"直接复述已生成"(历史上下文模式污染,纠偏消息力量不足)
 if (_forceToolChoice && depth >= 1) {
 effectiveToolChoice = 'required';
 }
 // 2026-08-17 实机修复: deepseek 推理模型(deepseek-v4-flash 等)不支持
 // tool_choice='required'——API 返回 400 invalid_request_error
 // ("Thinking mode does not support this tool_choice")。'required' 是
 // OpenAI 特有扩展值, 推理模式仅接受 auto/none/指定函数对象。
 // 降级 auto 保持请求可用(文本复述防御仅弱化, 推理模型自身能力兜底)。
 if (provider === 'deepseek' && effectiveToolChoice === 'required') {
 effectiveToolChoice = 'auto';
 }
 console.log(`📤 [流式] depth=${depth}, hasSuccess=${hasSuccessfulResult}, tool_choice=${JSON.stringify(effectiveToolChoice)}`);
 // 当 tool_choice='none' 时不传 tools 参数，避免某些 API 报错
 // 2026-09-07: 收答保底轮工具面收窄——只保留文件生成类工具(Write/Edit/*Generate)，
 // 保证最后一轮产出落盘而非继续跑分析命令
 let requestTools = toolDefinitions;
 if (graceToolsOnly) {
 requestTools = toolDefinitions.filter(t => {
 const n = t?.function?.name || '';
 return /^(Write|Edit|.*Generate)$/.test(n);
 });
 console.log(`⚠️ [收答保底] 本轮可用工具: ${requestTools.map(t => t.function.name).join(', ')}`);
 }
 const requestBodyBase = {
 model: model,
 messages: currentMessages,
 temperature: 0.7,
 stream: true,
 tool_choice: effectiveToolChoice,
 };
 if (effectiveToolChoice !== 'none') {
 requestBodyBase.tools = requestTools;
 }
 // 2026-08-15 P1-2/P2-5: 请求 usage 随流返回(OpenAI 兼容 provider 支持
 // stream_options.include_usage, deepseek/qwen/glm/moonshot 均已支持)——流式
 // 主路径此前从不 recordUsage/onLlmCallSuccess。不支持该参数的 provider 跳过。
 if (['deepseek', 'qwen', 'glm', 'moonshot'].includes(provider)) {
 requestBodyBase.stream_options = { include_usage: true };
 }
 const allKeys = collectProviderApiKeysForExecution({ primaryApiKey: apiKey, provider });
 // ── 2026-08-15 P2-5: Harness LLM 调用开始(流式此前无 llm 指标) ──
 try { globalHarnessLifecycle.onLlmCallStart(model); } catch (e) { console.warn('[ai] Harness onLlmCallStart (stream) failed:', e.message); }
 if (allKeys.length > 1) {
 resp = await executeWithApiKeyRotation({
 provider,
 apiKeys: allKeys,
 execute: async (currentKey) => {
 const response = await fetchWithRetry(`${baseUrl}/chat/completions`, {
 method: 'POST',
 signal: relay.nextReadSignal(),
 headers: {
 'Authorization': `Bearer ${currentKey}`,
 'Content-Type': 'application/json'
 },
 body: JSON.stringify(requestBodyBase)
 });
 if (!response.ok) {
 const err = new Error(`HTTP ${response.status}`);
 err.status = response.status;
 throw err;
 }
 return response;
 },
 shouldRetry: ({ message: msg }) => /rate.?limit|429|too.?many/i.test(msg),
 onRetry: ({ apiKey: retryKey, attempt }) => {
 const suffix = retryKey.slice(-8);
 globalKeyRotationManager.setCooldown(provider, suffix, 60000);
 console.log(`🔑 [流式] [密钥轮转] 切换到备用密钥 (尝试 ${attempt + 1})`);
 },
 });
 } else {
 resp = await fetchWithRetry(`${baseUrl}/chat/completions`, {
 method: 'POST',
 signal: relay.nextReadSignal(),
 headers: {
 'Authorization': `Bearer ${apiKey}`,
 'Content-Type': 'application/json'
 },
 body: JSON.stringify(requestBodyBase)
 });
 }
 } catch (rotationError) {
 const errorDetail = rotationError.message || String(rotationError);
 const causeDetail = rotationError.cause ? ` | cause: ${rotationError.cause.code || ''} ${rotationError.cause.message || ''}` : '';
 console.error('❌ AI 流式请求失败 (密钥轮转耗尽):', errorDetail + causeDetail);
 // ── 2026-08-15 P2-5: Harness LLM 调用失败(流式此前无调用) ——
 // 传入完整上下文(消息/压缩函数/兜底提供者/上下文引擎), best-effort 不抛——
 // RecoveryChain 消费端为 Task 3 职责。
 // 2026-08-15 审查返工 P2-5: AbortError(用户主动中断)不记为 LLM 失败。
 if (rotationError.name !== 'AbortError') {
 try {
 globalHarnessLifecycle.onLlmCallFailure(rotationError, {
 errorType: 'api_error',
 model,
 messages: currentMessages,
 compressFn: contextCompressor.compress,
 fallbackProviderFn: async (apiErr) => {
   try {
     const { getFallbackProviderManager } = require('./fallback-provider');
     const fbManager = getFallbackProviderManager();
     return fbManager ? fbManager.performFailover(userId, apiErr, getModelRouter()) : null;
   } catch (e) { console.warn('[ai] fallbackProviderFn (stream) failed:', e.message); return null; }
 },
 contextEngine: contextEngineRegistry,
 });
 } catch (e) { console.warn('[ai] Harness onLlmCallFailure (stream) failed:', e.message); }
 } // !AbortError(用户中断不计失败)
 if (rotationError.name === 'AbortError') {
 // 2026-08-15 D8(审计 P1): 首轮 fetch/工具执行阶段的 abort 统一发 interrupted
 // 标记——此前落 {content:'请求已取消。', done:true} → chat-handler 判
 // streamErrored → run:error, 与流式阶段 abort 的 run:interrupt 语义漂移
 // (同一"用户停止"动作两种终态)。现在统一为 interrupted。
 // 2026-08-15 P2-1: return ''——终态已由 interrupted chunk 表达; 此前返回
 // '请求已取消。' 会写入历史与 trajectory_samples.jsonl(与流式中断路径
 // return '' 不一致, 两路污染)。
 onChunk({ type: 'interrupted', content: '', done: true });
 return '';
 }
 const userMessage = errorDetail === 'fetch failed' ? '网络连接失败，请检查网络后重试' : errorDetail;
 onChunk({ content: userMessage, done: true });
 return userMessage;
 }
 
 if (!resp.ok) {
 let errorDetail = `AI 模型返回错误 (HTTP ${resp.status})`
 try {
 const errBody = await resp.text()
 const errJson = JSON.parse(errBody)
 errorDetail = errJson.error?.message || errJson.message || errJson.error?.type || errorDetail
 } catch (e) { console.warn('解析流式错误响应失败:', e.message); }
 console.error('❌ AI 流式请求失败:', errorDetail)
 onChunk({ content: errorDetail, done: true })
 return errorDetail
 }
 
 const reader = resp.body.getReader();
 const decoder = new TextDecoder();
 let fullContent = '';
 let rawContent = ''; // 保留原始内容（含 DSML 标签），用于兜底解析工具调用
 let buffer = '';
 let lastStreamUsage = null; // 2026-08-15 P1-2/P2-5: 流末 usage(stream_options.include_usage)
let toolCalls = [];
let currentPhase = '';
 const phaseLabels = {
 plan: { label: '📋 规划阶段', agent: 'planner' },
 research: { label: '🔍 研究阶段', agent: 'researcher' },
 execute: { label: '✏️ 执行阶段', agent: 'code_executor' },
 review: { label: '📋 审查阶段', agent: 'critic' },
 deliver: { label: '✅ 交付阶段', agent: 'summarizer' },
 };
 // 阶段进度映射（plan → deliver 均匀分布，deliver 封顶 99）
 const phaseProgress = { plan: 20, research: 40, execute: 60, review: 80, deliver: 99 };
 thinkScrubber.reset();
 contextScrubber.reset();
 dsmlScrubber.reset();

 // eslint-disable-next-line no-constant-condition
 while (true) {
 const { done, value } = await reader.read();
 if (done) break;

 buffer += decoder.decode(value, { stream: true });
 const lines = buffer.split('\n');
 buffer = lines.pop() || '';

 for (const line of lines) {
 if (line.startsWith('data: ')) {
 const data = line.slice(6);
 if (data === '[DONE]') continue;

 try {
 const parsed = JSON.parse(data);
 // 2026-08-15 P1-2/P2-5: 捕获流末 usage(include_usage 时最后一个 chunk 携带)
 if (parsed.usage) lastStreamUsage = parsed.usage;
 const delta = parsed.choices?.[0]?.delta;

 if (delta?.content) {
 rawContent += delta.content;

 // ── Phase detection for multi-stage tasks ──
 const phaseMatch2 = delta.content.match(/<phase:(\w+)>/);
 if (phaseMatch2) {
 const phaseName = phaseMatch2[1];
 if (phaseName !== currentPhase && phaseLabels[phaseName]) {
 if (currentPhase && phaseLabels[currentPhase]) {
 const prev = phaseLabels[currentPhase];
 if (subAgentCallback) subAgentCallback(userId, "end", { agentId: prev.agent, archetype: prev.agent, status: "completed" });
 onChunk({ type: "subagent", status: "end", agentId: prev.agent, archetype: prev.agent, outputPreview: (prev.result || '').substring(0, 200) });
 }
          currentPhase = phaseName;
          const info = phaseLabels[phaseName];
          onChunk({ type: 'phase', phase: phaseName, label: info.label, agent: info.agent, progress: phaseProgress[phaseName] });
          if (subAgentCallback) subAgentCallback(userId, "start", { agentId: info.agent, archetype: info.agent, tier: "worker", task: message.substring(0, 100) });
          onChunk({ type: "subagent", status: "start", agentId: info.agent, archetype: info.agent, tier: "worker", task: message.substring(0, 100) });
          onChunk({ type: "thinking", content: info.label });
 }
 // Strip <phase:xxx> marker from output
 delta.content = delta.content.replace(/<phase:\w+>/g, '');
 if (!delta.content.trim()) continue;
 }

 const dsmlScrubbed2 = dsmlScrubber.feed(delta.content);
 if (!dsmlScrubbed2) { continue }
 const thinkScrubbed = thinkScrubber.feed(dsmlScrubbed2);
 if (thinkScrubbed) {
 const contextScrubbed = contextScrubber.process(thinkScrubbed);
 if (contextScrubbed) {
 fullContent += contextScrubbed;
 onChunk({ content: contextScrubbed, done: false });
 }
 }
 }

 if (delta?.tool_calls) {
 for (const tc of delta.tool_calls) {
 if (tc.index !== undefined) {
 if (!toolCalls[tc.index]) {
 toolCalls[tc.index] = {
 id: tc.id || '',
 type: 'function',
 function: { name: '', arguments: '' }
 };
 }
 if (tc.id) toolCalls[tc.index].id = tc.id;
 if (tc.function?.name) toolCalls[tc.index].function.name += tc.function.name;
 if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
 }
 }
 }
 } catch (e) {
 console.debug('[ai] 流式解析失败(单 chunk 跳过):', e?.message || e);
 }
 }
 }
 }
 
 const thinkTailContent = thinkScrubber.flush();
 const contextTailContent = thinkTailContent ? contextScrubber.process(thinkTailContent) + contextScrubber.flush() : contextScrubber.flush();
 if (contextTailContent) {
 fullContent += contextTailContent;
 onChunk({ content: contextTailContent, done: false });
 }
 const dsmlTailContent = dsmlScrubber.flush();
 if (dsmlTailContent) { fullContent += dsmlTailContent; onChunk({ content: dsmlTailContent, done: false }); }

 // ── 2026-08-15 P1-2/P2-5: 流式 fetch 结束——usage 记账 + Harness 成功钩子
 // (参考非流式 ai.js:1504 用法)。流式主路径此前从不 recordUsage, 类别预算/
 // 日预算对语音主路径不生效。
 if (lastStreamUsage) {
 try {
 const usageInfo = recordUsage(provider, model, lastStreamUsage);
 try { globalHarnessLifecycle.onLlmCallSuccess(model, { prompt_tokens: usageInfo.promptTokens, completion_tokens: usageInfo.completionTokens, total_tokens: usageInfo.totalTokens }); } catch (e) { console.warn('[ai] Harness onLlmCallSuccess (stream) failed:', e.message); }
 console.log(`📊 [流式] Token 使用: 输入 ${usageInfo.promptTokens}, 输出 ${usageInfo.completionTokens}, 总计 ${usageInfo.totalTokens}, 估算费用 $${usageInfo.cost.toFixed(6)}`);
 try {
 const { getBudgetEnforcer } = require('./budget-enforcer');
 getBudgetEnforcer().recordUsage(provider, model, lastStreamUsage, null, userId, { category: 'reasoning' });
 } catch (e) { console.warn('[ai] [流式] Budget tracking recordUsage failed:', e.message); }
 // B5(Runtime差距分析): per-run 用量采集——runId 存在时累计,chat-handler 终态时随
 // RunStore 落盘(此前 token 只按天/模型聚合,单次 Run 成本无从回答)
 if (roundId) {
 try {
 const { recordLlmUsage } = require('./run-usage');
 recordLlmUsage(roundId, { provider, model, promptTokens: usageInfo.promptTokens, completionTokens: usageInfo.completionTokens, totalTokens: usageInfo.totalTokens, cost: usageInfo.cost });
 } catch (e) { console.warn('[ai] run-usage 记录失败(忽略):', e.message); }
 }
 } catch (e) { console.warn('[ai] [流式] 使用量记录异常:', e.message); }
 }

 if (toolCalls.length > 0 && toolCalls.some(tc => tc && tc.id)) {
 const validToolCalls = toolCalls.filter(tc => tc && tc.id);
 const sanitizedToolCalls = sanitizeToolCallsForProvider(validToolCalls, provider);
 console.log('🔧 流式模式检测到工具调用:', sanitizedToolCalls.length, '个');
 
 const filteredToolCalls = [];
 const seenToolCalls = new Map(); // 同一轮迭代中已执行的(工具名:参数哈希)
 for (const tc of sanitizedToolCalls) {
 const hashInfo = hashToolCall(tc);
 const loopStatus = globalLoopDetector._detectLoop(userId, hashInfo);
 const toolName = tc.function?.name || 'unknown';
 
 if (loopStatus.isHardLimit) {
 console.warn(`🔄 [循环检测] 工具 "${hashInfo.name}" 已调用 ${loopStatus.count} 次，强制跳过`);
 onChunk({ type: 'thinking', content: `⚠️ 循环检测: ${hashInfo.name} 已重复调用 ${loopStatus.count} 次，已跳过` });
 continue;
 }
 
 // 同一轮迭代中，相同(工具名+参数)才去重
 const callSignature = `${toolName}:${tc.function?.arguments || ""}`;
 if (seenToolCalls.has(callSignature)) {
 console.warn(`🔄 [同轮去重] 工具 "${toolName}" 相同参数已在本轮调用，跳过重复调用`);
 onChunk({ type: 'thinking', content: `⚠️ ${toolName} 相同参数已调用，已跳过` });
 continue;
 }
 seenToolCalls.set(callSignature, true);
 
 if (loopStatus.isWarning) {
 console.warn(`🔄 [循环检测] 工具 "${hashInfo.name}" 已调用 ${loopStatus.count} 次，警告`);
 }
 
 if (hasDocGeneration && depth >= 3 && (toolName === 'WebSearch' || toolName === 'WebFetch')) {
 console.warn(`🛑 [文档生成] 深度${depth}，将搜索工具 ${toolName} 标记为阻止`);
 tc._blockedByDocGeneration = true;
 }
 
 if (sessionImageGenerateSuccess.has(userId)) {
 console.warn(`🛑 [图片生成后] 阻止所有后续工具调用 ${toolName}，图片已在对话窗口显示`);
 currentMessages.push({
 role: 'tool',
 tool_call_id: tc.id,
 content: `[系统规则] 图片已生成成功！图片已自动在对话窗口显示预览。不需要调用任何其他工具（包括搜索、打开文件夹等）。请直接用自然语言告诉用户：图片已生成完成，并简要描述图片内容即可。`
 });
 continue;
 } else if (sessionVideoGenerateSuccess.has(userId)) {
 console.warn(`🛑 [视频生成后] 阻止所有后续工具调用 ${toolName}，视频已在对话窗口显示`);
 currentMessages.push({
 role: 'tool',
 tool_call_id: tc.id,
 content: `[系统规则] 视频已生成成功！视频已自动在对话窗口显示播放。不需要调用任何其他工具。请直接用自然语言告诉用户：视频已生成完成，并简要描述视频内容即可。`
 });
 continue;
 } else {
 filteredToolCalls.push(tc);
 }
 }
 
 if (filteredToolCalls.length === 0) {
 if (sessionImageGenerateSuccess.has(userId)) {
 console.log('📸 [图片生成后] 无其他工具调用，直接返回图片信息');
 let imagePreview = '';
 let imagePath = '';
 let imageInfo = '';
 
 for (let i = currentMessages.length - 1; i >= 0; i--) {
 const msg = currentMessages[i];
 if (msg.role === 'tool') {
 let content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
 
 if (content.includes('[系统规则]')) {
 continue;
 }
 
 try {
 const parsed = JSON.parse(content);
 if (parsed.content) {
 try {
 const innerParsed = JSON.parse(parsed.content);
 if (innerParsed.content) {
 content = innerParsed.content;
 }
 } catch (e2) {
 content = parsed.content;
 }
 }
 } catch (e) {
 console.debug('[图片生成后] 解析工具结果异常:', e.message);
 }
 
 console.log('📸 [图片生成后] 解析后的内容:', content.substring(0, 300));
 
 if (content.includes('![生成的图片]') || content.includes('local://') || content.includes('/files/') || content.includes('图片生成成功')) {
 imageInfo = content;
 const previewMatch = content.match(/!\[生成的图片\]\([^)]+\)/);
 if (previewMatch) {
 imagePreview = previewMatch[0];
 }
 const localMatch = content.match(/local:\/\/([^)\s\n]+)/);
 if (localMatch) {
 imagePath = `local://${localMatch[1]}`;
 }
 const httpMatch = content.match(/http:\/\/localhost:\d+\/files\/([^)\s\n]+)/);
 if (httpMatch && !imagePath) {
 imagePath = httpMatch[0];
 }
 break;
 }
 }
 }
 
 if (!imagePreview && imagePath) {
 imagePreview = `![生成的图片](${imagePath})`;
 }
 
 const reply = `✅ 图片已生成完成！

${imagePreview}

${imageInfo ? imageInfo.split('\n').filter(line => !line.includes('![生成的图片]') && !line.includes('### 生成的图片') && !line.includes('> 点击')).slice(0, 6).join('\n') : '图片已保存到本地。'}

图片已在对话窗口显示，您可以直接查看。`;
 onChunk({ content: reply, done: true });
 return reply;
 }
 
 if (sessionVideoGenerateSuccess.has(userId)) {
 console.log('🎬 [视频生成后] 无其他工具调用，直接返回视频信息');
 let videoPreview = '';
 let videoPath = '';
 let videoInfo = '';
 
 for (let i = currentMessages.length - 1; i >= 0; i--) {
 const msg = currentMessages[i];
 if (msg.role === 'tool') {
 let content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
 
 if (content.includes('[系统规则]')) {
 continue;
 }
 
 try {
 const parsed = JSON.parse(content);
 if (parsed.content) {
 try {
 const innerParsed = JSON.parse(parsed.content);
 if (innerParsed.content) {
 content = innerParsed.content;
 }
 } catch (e2) {
 content = parsed.content;
 }
 }
 } catch (e) {
 console.debug('[视频生成后] 解析工具结果异常:', e.message);
 }

 console.log('🎬 [视频生成后] 解析后的内容:', content.substring(0, 300));
 
 if (content.includes('[video]') || content.includes('/files/') || content.includes('视频生成成功')) {
 videoInfo = content;
 const videoMatch = content.match(/\[video\]\(([^)]+)\)/);
 if (videoMatch) {
 videoPath = videoMatch[1];
 videoPreview = `[video](${videoPath})`;
 }
 const localMatch = content.match(/local:\/\/([^)\s\n]+)/);
 if (localMatch && !videoPath) {
 videoPath = `local://${localMatch[1]}`;
 videoPreview = `[video](${videoPath})`;
 }
 const httpMatch = content.match(/http:\/\/localhost:\d+\/files\/([^)\s\n]+)/);
 if (httpMatch && !videoPath) {
 videoPath = httpMatch[0];
 videoPreview = `[video](${videoPath})`;
 }
 break;
 }
 }
 }
 
 if (!videoPreview && videoPath) {
 videoPreview = `[video](${videoPath})`;
 }
 
 const reply = `✅ 视频已生成完成！

${videoPreview}

${videoInfo ? videoInfo.split('\n').filter(line => !line.includes('[video]') && !line.includes('### 生成的视频') && !line.includes('> 点击')).slice(0, 6).join('\n') : '视频已保存到本地。'}

视频已在对话窗口显示，您可以直接播放查看。`;
 onChunk({ content: reply, done: true });
 return reply;
 }
 
 console.log('🔄 [循环检测] 所有工具调用被循环检测过滤，强制生成最终回答');
 return forceFinalAnswer(currentMessages);
 }
 
 const toolNames = filteredToolCalls.map(tc => tc.function?.name || 'unknown');
 const toolHints = {
 'StockQuery': '正在查询股票数据...',
 'WebSearch': '正在搜索网络...',
 'Read': '正在读取文件...',
 'LS': '正在列出目录...',
 'Grep': '正在搜索文本...',
 'SearchCodebase': '正在搜索代码库...',
 'Glob': '正在匹配文件...',
 'Bash': '正在执行命令...',
 'WebFetch': '正在获取网页内容...',
 };
 
 const processingHint = toolNames.map(name => toolHints[name] || `正在执行 ${name}...`).join(' ');
 onChunk({ type: 'thinking', content: `⏳ ${processingHint}` });
 
 currentMessages.push({
 role: 'assistant',
 content: fullContent || '',
 tool_calls: filteredToolCalls
 });
 
 // WeakMap：在并行执行下安全地配对 onToolStart/onToolEnd 的 toolCallId
 const _toolCallIdMap = new WeakMap();
 const streamingToolExecutor = createToolExecutor({
 userId,
 message,
 executeToolCall,
 middleware: globalToolResultMiddleware,
 display: globalToolDisplay,
 // 2026-08-15 P2-4: 传入 budget——createToolExecutor 每次工具执行
 // incrementToolCalls(对齐非流式 chat 用法), IterationBudget 计数器生效。
 budget,
 classifyCategory: _classifyRequestCategory,
 onToolStart: (tc, name) => {
 streamTotalToolCalls++;
 const toolCallId = tc.id || `${name}_${Date.now()}`;
 _toolCallIdMap.set(tc, toolCallId);
 onChunk({ type: 'tool_call', toolName: name, toolId: toolCallId, toolArgs: tc.function?.arguments, cardState: 'running' });
 // B5(Runtime差距分析): per-run 工具调用计数
 if (roundId) {
 try { require('./run-usage').recordToolCall(roundId, name); } catch (e) { /* best-effort */ }
 }
 try {
 const { globalActivityStream } = require('./activity-stream');
 // 2026-08-15 P1-4: 显式传 roundId——此前回退全局 _currentRoundId,
 // 并发双流时工具事件归属错乱(roundId 污染)
 globalActivityStream.recordToolEvent('executing', name, { summary: `执行: ${name}`, silent: false, cardState: 'running', roundId });
 } catch (e) { console.warn('[ai] activity-stream recordToolEvent(executing) 失败:', e?.message || e); }
 },
 onToolEnd: (tc, name, result, ok) => {
 const toolCallId = _toolCallIdMap.get(tc) || tc.id || name;
 // 2026-08-04 P1 修复:补 toolName——此前前端 TaskPanelHost/ActivityStream
 // 的"工具完成"卡工具名为空(chunk.toolName||'' 恒空)
 // 2026-08-13 P1-8: 附加 cardState + 结构化 resultPayload(2KB 截断+脱敏)
 let resultPayload = null;
 try {
 const { buildResultPayload } = require('./activity-stream');
 resultPayload = buildResultPayload(result);
 } catch (e) { console.warn('[ai] buildResultPayload 失败:', e?.message || e); }
 onChunk({ type: 'tool_result', toolName: name, toolId: toolCallId, success: ok, cardState: ok ? 'done' : 'error', result: JSON.stringify(result).substring(0, 200), resultPayload });
 try {
 const { globalActivityStream } = require('./activity-stream');
 globalActivityStream.recordToolEvent(ok ? 'result' : 'error', name, {
 summary: ok ? `工具完成: ${name}` : `工具出错: ${name}`,
 duration: result.duration,
 cardState: ok ? 'done' : 'error',
 resultPayload,
 // 2026-08-15 P1-4: 显式传 roundId(同 onToolStart)
 roundId,
 });
 } catch (e) { console.warn('[ai] activity-stream recordToolEvent(result) 失败:', e?.message || e); }
 },
 });

 const toolResults = await Promise.allSettled(filteredToolCalls.map(streamingToolExecutor));

 for (const settled of toolResults) {
 // 电路断路器已触发，跳过后续工具结果处理
 if (circuitBreakerTripped) {
 const { toolCall } = settled.value || {};
 if (toolCall) {
 currentMessages.push({
 role: 'tool',
 tool_call_id: toolCall.id,
 content: '[系统] 电路断路器已触发，跳过此工具结果'
 });
 }
 continue;
 }

 if (settled.status === 'rejected') {
 console.error('❌ 流式工具执行异常:', settled.reason);
 onChunk({ type: 'thinking', content: `❌ 执行异常: ${String(settled.reason?.message || settled.reason || '').slice(0, 60)}` });
 continue;
 }
 
 const { toolCall, result: toolResult, success } = settled.value;
 
 if (success) {
 // 连续失败计数由 globalFailureGuard.record(success=true) 自动重置
 onChunk({ type: 'thinking', content: `✅` });
 const toolName = toolCall.function?.name || 'unknown';
 if (toolName === 'ImageGenerate') {
 lifecycleManager.managedSet('sessionImageGenerateSuccess', userId, true);
 console.log('📸 [图片生成] 成功，后续将阻止 DesktopControl/BrowserControl');
 let imgData = toolResult;
 if (toolResult && toolResult.content && typeof toolResult.content === 'string') {
 try { imgData = JSON.parse(toolResult.content); } catch(e) { console.warn("[ai]", e?.message) }
 }
 const imgFilePath = imgData.image_path || (imgData.images && imgData.images[0] && imgData.images[0].file_path);
 if (imgFilePath) {
 const imgName = imgFilePath.split(/[/\\]/).pop();
 onChunk({ content: '', done: false, file_generated: { type: 'image', path: imgFilePath, name: imgName, size: imgData.total_size || 0 } });
 console.log('📸 [图片生成] 图片已生成:', imgFilePath);
 getMediaNotifier().notify({
 chatId: userId,
 mediaType: 'image',
 filePath: imgFilePath,
 name: imgName,
 size: imgData.total_size || 0,
 }).catch(e => console.warn('⚠️ [MediaNotifier] 图片通知失败:', e.message));
 }
 }
 if (toolName === 'PosterGenerate') {
 // 2026-09-08 实机修复: 海报工具此前无 file_generated 广播——生成了但对话窗口
 // 无处可见（用户实测"说生成了但没看到"）。对齐 ImageGenerate 特例：发
 // file_generated(type:image) 进对话流 + MediaNotifier 回推（企微会话自动回图）。
 let pData = toolResult;
 if (pData && typeof pData.content === 'string') { try { pData = JSON.parse(pData.content); } catch (e) { console.warn('[ai]', e?.message); } }
 if (pData && typeof pData === 'string') { try { pData = JSON.parse(pData); } catch (e) { /* 保持原样 */ } }
 const d = (pData && typeof pData === 'object' && pData.data) ? pData.data : (pData || {});
 const posterPath = d.path || d.poster_path;
 if (posterPath) {
 const posterName = require('path').basename(String(posterPath));
 onChunk({ content: '', done: false, file_generated: { type: 'image', path: posterPath, name: posterName, size: d.bytes || 0 } });
 console.log('🖼️ [海报生成] 成品:', posterPath);
 getMediaNotifier().notify({
 chatId: userId,
 mediaType: 'image',
 filePath: posterPath,
 name: posterName,
 size: d.bytes || 0,
 }).catch(e => console.warn('⚠️ [MediaNotifier] 海报通知失败:', e.message));
 }
 }
 if (toolName === 'VideoGenerate' || toolName === 'VideoGenerateFromImage') {
 lifecycleManager.managedSet('sessionVideoGenerateSuccess', userId, true);
 console.log('🎬 [视频生成] 成功，后续将阻止其他工具调用');
 let videoData = toolResult;
 if (toolResult && toolResult.content && typeof toolResult.content === 'string') {
 try { videoData = JSON.parse(toolResult.content); } catch(e) { console.warn("[ai]", e?.message) }
 }
 const videoFilePath = videoData.video_path || (videoData.videos && videoData.videos[0] && videoData.videos[0].file_path);
 if (videoFilePath) {
 const videoName = videoFilePath.split(/[/\\]/).pop();
 onChunk({ content: '', done: false, file_generated: { type: 'video', path: videoFilePath, name: videoName, size: videoData.total_size || 0 } });
 console.log('🎬 [视频生成] 视频已生成:', videoFilePath);
 getMediaNotifier().notify({
 chatId: userId,
 mediaType: 'video',
 filePath: videoFilePath,
 name: videoName,
 size: videoData.total_size || 0,
 }).catch(e => console.warn('⚠️ [MediaNotifier] 视频通知失败:', e.message));
 }
 }
 if (toolName === 'MarkdownToWord' && typeof toolResult === 'object') {
 let mwData = toolResult;
 if (toolResult.content && typeof toolResult.content === 'string') {
 try { mwData = JSON.parse(toolResult.content); } catch(e) { console.warn("[ai]", e?.message) }
 }
 if (mwData.output_path) {
 const mdSourcePath = mwData.input_path || mwData.output_path.replace(/\.docx$/i, '.md');
 onChunk({ content: '', done: false, file_generated: { type: 'docx', path: mwData.output_path, name: mwData.output_path.split(/[/\\]/).pop(), size: mwData.size, mdSourcePath } });
 console.log('📄 [文档生成] Word文档已生成:', mwData.output_path);
 getMediaNotifier().notify({
 chatId: userId,
 mediaType: 'docx',
 filePath: mwData.output_path,
 name: mwData.output_path.split(/[/\\]/).pop(),
 size: mwData.size,
 }).catch(e => console.warn('⚠️ [MediaNotifier] 通知失败:', e.message));
 }
 }
 // 2026-08-14 文档生成广播补口: html_generate/docx_generate/xlsx_generate/
 // pptx_generate/pdf_generate/html-presentation 直接生成文件时此前无
 // file_generated 广播也无 web-preview 推送——产物存在但前端 DocReader
 // 收不到完成事件、网页无预览卡（MarkdownToHTML 有而 html_generate 没有,
 // 同渲染引擎不同待遇）。统一按工具名→文件类型映射广播; html 产物再推
 // web-preview 场景卡（对齐 file-tools.js MarkdownToHTML 的 local:// 口径）。
 const DOC_GEN_TOOL_TYPES = {
 html_generate: 'html',
 docx_generate: 'docx',
 xlsx_generate: 'xlsx',
 pptx_generate: 'pptx',
 pdf_generate: 'pdf',
 'html-presentation': 'html',
 };
 if (DOC_GEN_TOOL_TYPES[toolName] && typeof toolResult === 'object' && toolResult.success) {
 let dgData = toolResult;
 if (toolResult.content && typeof toolResult.content === 'string') {
 try { dgData = JSON.parse(toolResult.content); } catch (e) { console.warn("[ai]", e?.message) }
 }
 const dgPath = dgData.path || dgData.output_path;
 if (dgPath) {
 const dgName = dgPath.split(/[/\\]/).pop();
 const dgType = DOC_GEN_TOOL_TYPES[toolName];
 onChunk({ content: '', done: false, file_generated: { type: dgType, path: dgPath, name: dgName, size: dgData.size } });
 console.log(`📄 [文档生成] ${dgName} 已生成:`, dgPath);
 getMediaNotifier().notify({
 chatId: userId,
 mediaType: dgType,
 filePath: dgPath,
 name: dgName,
 size: dgData.size,
 }).catch(e => console.warn('⚠️ [MediaNotifier] 通知失败:', e.message));
 // 2026-08-17: web-preview 中央卡推送已移除——html 预览统一在 FileGenPanel
 // 面板内开发模式分屏(html_generate 已补 filegen 插桩, done 事件带 previewUrl),
 // 不再弹中央全息卡破坏组合布局(与 file-tools.js MarkdownToHTML 同口径)。
 }
 }
 // Write工具生成文件时发送 file_generated 事件
 // 2026-08-04 P1 修复:此前仅 .html/.htm 广播,LLM 用 Write 生成 .md/.txt 报告时
 // 无广播 → DocReader 停在 generating 60s 超时收起、TaskPanelHost 无文件卡。
 // 按扩展名统一广播(md/html/txt 等文档类),DocReader 按 type 渲染
 if (toolName === 'Write') {
 let args = toolCall.function?.arguments || {};
 if (typeof args === 'string') {
 try { args = JSON.parse(args); } catch (e) { args = {}; }
 }
 const filePath = args.file_path || args.path;
 if (filePath) {
 const fileName = filePath.split(/[/\\]/).pop();
 const ext = (filePath.split('.').pop() || '').toLowerCase();
 if (/^(html?|md|txt|json|csv|js|ts|py|css)$/.test(ext)) {
 const mediaType = ext === 'html' || ext === 'htm' ? 'html' : 'document';
 onChunk({ content: '', done: false, file_generated: { type: mediaType, path: filePath, name: fileName } });
 console.log(`📄 [文件生成] ${fileName} 已生成:`, filePath);
 getMediaNotifier().notify({
 chatId: userId,
 mediaType: mediaType,
 filePath: filePath,
 name: fileName,
 }).catch(e => console.warn('⚠️ [MediaNotifier] 文件通知失败:', e.message));
 }
 }
 }
 } else {
 // 连续失败计数由 globalFailureGuard.record(success=false) 自动递增
 const errorMsg = typeof toolResult === 'object' ? (toolResult.error || '失败') : '失败';
 onChunk({ type: 'thinking', content: `❌ ${errorMsg}` });

 // 检查电路断路器标志（参考 OpenHuman RepeatFailureGuard）
 if (toolResult && toolResult.circuitBreaker) {
 circuitBreakerTripped = true;
 circuitBreakerReason = toolResult.error || errorMsg;
 console.warn(`🛑 [流式] 电路断路器触发: ${circuitBreakerReason}`);
 }
 }

 // 累积工具执行摘要（参考 OpenHuman run_tool_digest）
 const digestToolName = toolCall.function?.name || 'unknown';
 const digestStatus = success ? 'ok' : 'failed';
 const digestContent = success
 ? (typeof toolResult === 'object' ? JSON.stringify(toolResult.content || '').substring(0, 200) : String(toolResult || '').substring(0, 200))
 : String(typeof toolResult === 'object' ? (toolResult.error || '未知错误') : toolResult).substring(0, 200);
 runToolDigest += `- ${digestToolName} [${digestStatus}]: ${digestContent}\n`;

 // 2026-09-04 Loop 第三刀: 结果→内容构建收敛为 agent/loop-skeleton 单一事实源
 // (此前流式版文案结尾多一个 ']' 的复制漂移一并修复)
 const { buildToolResultContent: buildToolResultContentS } = require('./agent/loop-skeleton');
 let resultContent = buildToolResultContentS({ toolCall, toolResult, success });

 if (success && resultContent && typeof resultContent === 'string') {
 resultContent = persistToolResultContent(toolCall, resultContent);
 }
 
 currentMessages.push({
 role: 'tool',
 tool_call_id: toolCall.id,
 content: resultContent
 });
 }
 
 // 电路断路器触发：不再直接拼接摘要返回，而是让 forceFinalAnswer 通过 AI 生成解释性回复
 if (circuitBreakerTripped) {
 console.warn('🛑 [流式] 电路断路器已触发，转交 forceFinalAnswer 生成解释性回复');
 return forceFinalAnswer(currentMessages);
 }
 
 console.log('🔧 继续处理，深度:', depth + 1);
 return processWithStreaming(currentMessages, depth + 1);
 }
 
 // 无工具调用 — 最终回复路径（参考 OpenHuman empty response detection）
 // 2026-08-04: 执行验证门——LLM 看到历史会话"生成报告成功"记录后,
 // 跳过本轮工具调用直接声称"已生成"+编造文件路径(幻觉/上下文污染)。
 // 生成类请求 + 本轮零工具调用 + 声称完成 或 长文本直出全文 → 强制重试一轮(注入纠偏指令)
 // 2026-08-22: 判定抽为 shouldForceWriteRetry 纯函数——旧判定只拦「声称完成」
 //（已生成/已写好…），语音模式模型直接输出全文（"我先把它写出来给你看"+ 完整演讲稿，
 // 无完成词）绕过；且词表缺文章类词（写演讲稿不命中文件词）。两处一并修复。
 if (streamTotalToolCalls === 0 && depth === 0 && shouldForceWriteRetry({ depth, streamTotalToolCalls, message, fullContent, liveFileGenTask: hasLiveFileGenTask(), pausedFileGenTask: hasPausedFileGenTask() })) {
   // 调试:打印首轮无工具调用的回复,确认验证门判定
   console.log('[验证门调试] depth=%d tools=%d 回复前120: "%s"', depth, streamTotalToolCalls, String(fullContent || '').slice(0, 120).replace(/\n/g, ' '))
 }
 if (!_hallucinationGuardFired
     && depth < 3
     && shouldForceWriteRetry({ depth, streamTotalToolCalls, message, fullContent, liveFileGenTask: hasLiveFileGenTask(), pausedFileGenTask: hasPausedFileGenTask() })) {
   _hallucinationGuardFired = true
   _forceToolChoice = 'Write'
   console.warn('⚠️ [执行验证门] 生成请求但零工具调用且回复声称完成/文本直出全文——强制重试工具调用')
   currentMessages.push({
     role: 'system',
     content: '⚠️ 检测到你未实际调用任何工具。这是不允许的——生成请求必须实际调用 Write 工具(或其他生成工具)创建用户要求的文件，不要将文章/网页全文直接输出到对话中；历史会话中生成的文件不属于本轮，你不能引用它们作为本轮结果。工具执行成功后才能向用户确认完成。',
   })
   return processWithStreaming(currentMessages, depth + 1)
 }
 // 2026-08-04 P1: 二次防护——重试轮(required)仍幻觉(deepseek 违反 required 复述)
 // → 清理历史上下文污染(SmartLoader 加载的"生成报告成功"记录是幻觉源头)
 // + 诚实告知用户,而非继续给幻觉回复
 if (depth >= 1
     && shouldForceWriteRetry({ depth, streamTotalToolCalls, message, fullContent, liveFileGenTask: hasLiveFileGenTask(), pausedFileGenTask: hasPausedFileGenTask() })) {
   try { contextCache.invalidateHistory(userId) } catch (e) { console.warn('[执行验证门] 清理历史缓存失败:', e?.message || e) }
   console.warn('⚠️ [执行验证门] 二次重试仍幻觉——清理历史上下文污染并明确告知')
   const honestMsg = '⚠️ 检测到本次生成请求未能实际执行(模型未调用文件工具)。已清理历史会话上下文,请重新发送一次请求,我将实际调用工具生成文件。'
   onChunk({ content: honestMsg, done: true })
   return honestMsg
 }

 if (!fullContent || fullContent.trim().length === 0) {
   // 2026-08-23 实机修复: 本轮已成功执行工具(如 XlsxGenerate 已生成文件并广播
   // filegen:done)后, deepseek 推理模型下一轮常输出空 content(收尾文字留在
   // reasoning)——旧逻辑一律判"AI 空回复"→ run:error → 前端追加
   // 「（出错了，请重试）」, 用户看到"文件已生成却报错"的荒谬体验。
   // 工具成功即任务实际完成, 以工具摘要收尾; 仅零工具调用时空回复才算退化。
   const hasSuccessfulTool = currentMessages.some(m => m.role === 'tool' && m.content && !m.content.includes('"error"') && !m.content.includes('失败'));
   if (hasSuccessfulTool) {
     console.warn('[流式] 工具已成功执行但模型空回复——视为任务完成, 以工具摘要收尾');
     const okLines = (runToolDigest || '').split('\n').filter(l => l.includes('[ok]')).join('\n').trim();
     const doneMsg = okLines ? `已完成。\n${okLines}` : '已完成。';
     onChunk({ content: doneMsg, done: true });
     return doneMsg;
   }
   // 退化回复：AI 返回空文本且无工具调用
   console.warn('[流式] AI 返回空回复且无工具调用 — 返回错误提示');
   const emptyMsg = '抱歉，AI 未返回有效回复。请尝试换一种方式描述您的需求，或稍后重试。';
   onChunk({ content: emptyMsg, done: true });
   return emptyMsg;
 }

 // 返回对象，包含清理后的内容和原始内容（用于 DSML 兜底解析）
 return { content: fullContent, raw: rawContent };
 }

 try {
 let streamResult;
 try {
 streamResult = await processWithStreaming(compressedMessages);
 } catch (streamError) {
 // 2026-08-08 fix: 用户中断(新请求抢占/手动停止)时 fetch 流抛 AbortError,
 // 旧实现当真实错误处理——刷 ERROR 日志 + 给用户回"对话遇到问题"。
 // abort 属正常控制流,静默结束。
 const errName = streamError?.name || '';
 const errCode = streamError?.code || '';
 const errMsg = streamError?.message || '';
 const isAbort = errName === 'AbortError' || errCode === 'ERR_ABORTED' || /aborted/i.test(errMsg);
 if (isAbort) {
   console.log('ℹ️ [流式] 流被中断(abort),正常结束');
   // 2026-08-13 P2-2: interrupted 标记——chat-handler 据此广播 run:interrupt,
   // 不再把用户中断记成"正常完成"
   onChunk({ type: 'interrupted', content: '', done: true });
   return '';
 }
 console.error('❌ [流式] 未捕获异常:', streamError.message);
 const fallbackMsg = '抱歉，对话过程中遇到了问题。请尝试重新描述您的需求，或稍后重试。';
 onChunk({ content: fallbackMsg, done: true });
 // 2026-08-15 P2-5: 失败路径轨迹落 failed_trajectories.jsonl——此前 save 恒
 // completed=true, failed_trajectories.jsonl 永不写入。
 try {
 globalTrajectorySaver.save(compressedMessages.concat([{ role: 'assistant', content: fallbackMsg }]), model, false);
 } catch (e) { console.warn('[ai] 保存失败轨迹异常:', e.message); }
 return fallbackMsg;
 }
 // 兼容：processWithStreaming 可能返回字符串（降级路径）或对象（正常路径）
 const fullContent = typeof streamResult === 'string' ? streamResult : (streamResult?.content || '');
 const rawContent = typeof streamResult === 'string' ? streamResult : (streamResult?.raw || streamResult?.content || '');

 let finalContent = fullContent;
 // 使用原始内容（含 DSML 标签）解析工具调用，因为 scrubber 可能已清理 fullContent 中的标签
 const dsmlToolCalls = parseDSMLToolCalls(rawContent);
 if (dsmlToolCalls.length > 0) {
 console.log('🔧 [DSML兜底] 检测到文本中的工具调用:', dsmlToolCalls.map(tc => tc.name).join(', '));
 // 先清理 DSML 标签，避免用户看到原始标签
 finalContent = stripDSMLTags(finalContent);
 let lastWriteMdPath = null;
 let hasMarkdownToWord = false;
 // 收集成功的工具结果，用于后续让AI生成最终回答
 const dsmlSuccessResults = [];
 const dsmlFailedResults = [];
 for (const tc of dsmlToolCalls) {
 // 2026-08-15 P2-3: 每次迭代前检查中断——停止后 DSML 兜底副作用
 // (Write/SendWecomFile 等)此前仍继续执行
 if (interruptSignal.aborted) {
   console.log('ℹ️ [DSML兜底] 检测到中断, 停止后续 DSML 工具执行');
   onChunk({ type: 'interrupted', content: '', done: true });
   break;
 }
 const dsmlToolId = 'dsml_' + tc.name + '_' + Date.now();
    onChunk({ type: 'tool_call', toolName: tc.name, toolId: dsmlToolId, toolArgs: JSON.stringify(tc.params || tc.arguments) });
 try {
 onChunk({ type: 'thinking', content: `⏳ 正在执行 ${tc.name}...` });
 const result = await executeToolCall({ name: tc.name, params: tc.params || tc.arguments });
 const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
 // 改进成功判断：不仅检查error字符串，还要检查exit code（针对Bash工具）
 const isError = resultStr.includes('"error"') || 
 resultStr.includes('"success":false') ||
 (tc.name === 'Bash' && /\[exit code: [^0]\d*\]/.test(resultStr));
 if (resultStr && !isError) {
 console.log(`✅ [DSML兜底] ${tc.name} 执行成功`);
 const resultPreview = resultStr.substring(0, 500);
 finalContent += `\n\n📄 ${tc.name} 结果: ${resultPreview}`;
 onChunk({ type: 'thinking', content: `✅` });
 onChunk({ type: 'tool_result', toolId: dsmlToolId, success: true, result: resultStr.substring(0, 200) });
 // 收集成功结果
 dsmlSuccessResults.push({ name: tc.name, content: resultStr });
 if (tc.name === 'Write' && (tc.params || tc.arguments).file_path) {
 const filePath = (tc.params || tc.arguments).file_path;
 if (filePath.endsWith('.md')) {
 lastWriteMdPath = filePath;
 }
 // HTML文件生成后发送 file_generated 事件，让前端可以打开或发送到企微
 if (filePath.endsWith('.html') || filePath.endsWith('.htm')) {
 const fileName = filePath.split(/[/\\]/).pop();
 onChunk({ content: '', done: false, file_generated: { type: 'html', path: filePath, name: fileName } });
 getMediaNotifier().notify({
 chatId: userId,
 mediaType: 'html',
 filePath: filePath,
 name: fileName,
 }).catch(e => console.warn('⚠️ [MediaNotifier] HTML通知失败:', e.message));
 }
 }
 if (tc.name === 'MarkdownToWord') {
 hasMarkdownToWord = true;
 let mwData = result;
 if (typeof result === 'object' && result.content && typeof result.content === 'string') {
 try { mwData = JSON.parse(result.content); } catch(e) { console.warn("[ai]", e?.message) }
 }
 if (mwData && mwData.output_path) {
 const mdSourcePath = mwData.input_path || mwData.output_path.replace(/\.docx$/i, '.md');
 onChunk({ content: '', done: false, file_generated: { type: 'docx', path: mwData.output_path, name: mwData.output_path.split(/[/\\]/).pop(), size: mwData.size, mdSourcePath } });
 getMediaNotifier().notify({
 chatId: userId,
 mediaType: 'docx',
 filePath: mwData.output_path,
 name: mwData.output_path.split(/[/\\]/).pop(),
 size: mwData.size,
 }).catch(e => console.warn('⚠️ [MediaNotifier] DSML兜底通知失败:', e.message));
 }
 }
 if (tc.name === 'MarkdownToExcel') {
 hasMarkdownToWord = true; // reuse flag for Excel too
 let meData = result;
 if (typeof result === 'object' && result.content && typeof result.content === 'string') {
 try { meData = JSON.parse(result.content); } catch(e) { console.warn("[ai]", e?.message) }
 }
 if (meData && meData.output_path) {
 const mdSourcePath = meData.input_path || meData.output_path.replace(/\.xlsx$/i, '.md');
 onChunk({ content: '', done: false, file_generated: { type: 'xlsx', path: meData.output_path, name: meData.output_path.split(/[/\\]/).pop(), size: meData.size, mdSourcePath } });
 getMediaNotifier().notify({
 chatId: userId,
 mediaType: 'xlsx',
 filePath: meData.output_path,
 name: meData.output_path.split(/[/\\]/).pop(),
 size: meData.size,
 }).catch(e => console.warn('⚠️ [MediaNotifier] DSML兜底通知(Excel)失败:', e.message));
 }
 }
 if (tc.name === 'MarkdownToPPT') {
 hasMarkdownToWord = true;
 let mpData = result;
 if (typeof result === 'object' && result.content && typeof result.content === 'string') {
 try { mpData = JSON.parse(result.content); } catch(e) { console.warn("[ai]", e?.message) }
 }
 if (mpData && mpData.output_path) {
 const mdSourcePath = mpData.input_path || mpData.output_path.replace(/\.pptx$/i, '.md');
 onChunk({ content: '', done: false, file_generated: { type: 'pptx', path: mpData.output_path, name: mpData.output_path.split(/[/\\]/).pop(), size: mpData.size, mdSourcePath } });
 getMediaNotifier().notify({
 chatId: userId,
 mediaType: 'pptx',
 filePath: mpData.output_path,
 name: mpData.output_path.split(/[/\\]/).pop(),
 size: mpData.size,
 }).catch(e => console.warn('⚠️ [MediaNotifier] DSML兜底通知(PPT)失败:', e.message));
 }
 }
 if (tc.name === 'MarkdownToPDF') {
 hasMarkdownToWord = true;
 let mpData = result;
 if (typeof result === 'object' && result.content && typeof result.content === 'string') {
 try { mpData = JSON.parse(result.content); } catch(e) { console.warn("[ai]", e?.message) }
 }
 if (mpData && mpData.output_path) {
 const mdSourcePath = mpData.input_path || mpData.output_path.replace(/\.pdf$/i, '.md');
 onChunk({ content: '', done: false, file_generated: { type: 'pdf', path: mpData.output_path, name: mpData.output_path.split(/[/\\]/).pop(), size: mpData.size, mdSourcePath } });
 getMediaNotifier().notify({
 chatId: userId,
 mediaType: 'pdf',
 filePath: mpData.output_path,
 name: mpData.output_path.split(/[/\\]/).pop(),
 size: mpData.size,
 }).catch(e => console.warn('⚠️ [MediaNotifier] DSML兜底通知(PDF)失败:', e.message));
 }
 }
 if (tc.name === 'MarkdownToHTML') {
 hasMarkdownToWord = true;
 let mhData = result;
 if (typeof result === 'object' && result.content && typeof result.content === 'string') {
 try { mhData = JSON.parse(result.content); } catch(e) { console.warn("[ai]", e?.message) }
 }
 if (mhData && mhData.output_path) {
 const mdSourcePath = mhData.input_path || mhData.output_path.replace(/\.html$/i, '.md');
 onChunk({ content: '', done: false, file_generated: { type: 'html', path: mhData.output_path, name: mhData.output_path.split(/[/\\]/).pop(), size: mhData.size, mdSourcePath } });
 getMediaNotifier().notify({
 chatId: userId,
 mediaType: 'html',
 filePath: mhData.output_path,
 name: mhData.output_path.split(/[/\\]/).pop(),
 size: mhData.size,
 }).catch(e => console.warn('⚠️ [MediaNotifier] DSML兜底通知(HTML)失败:', e.message));
 }
 }
 } else {
 console.warn(`⚠️ [DSML兜底] ${tc.name} 执行失败:`, resultStr.substring(0, 200));
 onChunk({ type: 'thinking', content: `❌` });
 onChunk({ type: 'tool_result', toolId: dsmlToolId, success: false, result: resultStr.substring(0, 200) });
 // 收集失败结果，让AI知道失败原因并给出替代方案
 dsmlFailedResults.push({ name: tc.name, error: resultStr.substring(0, 1000) });
 }
 } catch (e) {
 console.error(`❌ [DSML兜底] ${tc.name} 执行失败:`, e.message);
 onChunk({ type: 'thinking', content: `❌` });
 onChunk({ type: 'tool_result', toolId: dsmlToolId, success: false, result: e.message.substring(0, 200) });
 dsmlFailedResults.push({ name: tc.name, error: e.message });
 }
 }
 if (!interruptSignal.aborted && lastWriteMdPath && !hasMarkdownToWord && /生成.*Word|生成.*文档|写.*文档|创建.*文档|导出.*文档|导出.*Word/i.test(message)) {
 console.log('🔧 [DSML兜底] 检测到文档生成意图，自动链式执行 MarkdownToWord');
 try {
 const mwResult = await executeToolCall({ name: 'MarkdownToWord', params: { input_path: lastWriteMdPath } });
 const mwResultStr = typeof mwResult === 'string' ? mwResult : JSON.stringify(mwResult);
 if (mwResultStr && !mwResultStr.includes('"error"')) {
 console.log('✅ [DSML兜底] MarkdownToWord 执行成功');
 finalContent += `\n\n📄 MarkdownToWord 结果: ${mwResultStr.substring(0, 500)}`;
 let docxPath = lastWriteMdPath.replace(/\.md$/i, '.docx');
 try {
 let mwData = mwResult;
 if (mwResult.content && typeof mwResult.content === 'string') {
 mwData = JSON.parse(mwResult.content);
 }
 if (mwData.output_path) docxPath = mwData.output_path;
 } catch(e) { console.warn('⚠️ Word 文档生成后处理异常:', e.message); }
 onChunk({ content: '', done: false, file_generated: { type: 'docx', path: docxPath, name: docxPath.split(/[/\\]/).pop(), mdSourcePath: lastWriteMdPath } });
 getMediaNotifier().notify({
 chatId: userId,
 mediaType: 'docx',
 filePath: docxPath,
 name: docxPath.split(/[/\\]/).pop(),
 }).catch(e => console.warn('⚠️ [MediaNotifier] 链式执行通知失败:', e.message));
 if (!interruptSignal.aborted && (/发送.*企微|发送.*企业微信|send.*wecom/i.test(message) || currentChannel === 'wecom')) {
 console.log('🔧 [DSML兜底] 自动链式执行 SendWecomFile');
 try {
 const swResult = await executeToolCall({ name: 'SendWecomFile', params: { file_path: docxPath } });
 const swResultStr = typeof swResult === 'string' ? swResult : JSON.stringify(swResult);
 console.log(swResultStr && !swResultStr.includes('"error"') ? '✅ [DSML兜底] SendWecomFile 执行成功' : '⚠️ [DSML兜底] SendWecomFile 结果: ' + swResultStr.substring(0, 200));
 finalContent += `\n\n📄 SendWecomFile 结果: ${swResultStr.substring(0, 500)}`;
 } catch (e) {
 console.error('❌ [DSML兜底] SendWecomFile 执行失败:', e.message);
 }
 }
 } else {
 console.warn('⚠️ [DSML兜底] MarkdownToWord 执行结果:', mwResultStr.substring(0, 200));
 }
 } catch (e) {
 console.error('❌ [DSML兜底] MarkdownToWord 执行失败:', e.message);
 }
 }
 if (!interruptSignal.aborted && lastWriteMdPath && !hasMarkdownToWord && /生成.*Excel|导出.*Excel|生成.*表格|导出.*表格|创建.*表格|Excel.*转换/i.test(message)) {
 console.log('🔧 [DSML兜底] 检测到Excel生成意图，自动链式执行 MarkdownToExcel');
 try {
 const meResult = await executeToolCall({ name: 'MarkdownToExcel', params: { input_path: lastWriteMdPath } });
 const meResultStr = typeof meResult === 'string' ? meResult : JSON.stringify(meResult);
 if (meResultStr && !meResultStr.includes('"error"')) {
 console.log('✅ [DSML兜底] MarkdownToExcel 执行成功');
 finalContent += `\n\n📄 MarkdownToExcel 结果: ${meResultStr.substring(0, 500)}`;
 let xlsxPath = lastWriteMdPath.replace(/\.md$/i, '.xlsx');
 try {
 let meData = meResult;
 if (meResult.content && typeof meResult.content === 'string') {
 meData = JSON.parse(meResult.content);
 }
 if (meData.output_path) xlsxPath = meData.output_path;
 } catch(e) { console.warn('⚠️ Excel 生成后处理异常:', e.message); }
 onChunk({ content: '', done: false, file_generated: { type: 'xlsx', path: xlsxPath, name: xlsxPath.split(/[/\\]/).pop(), mdSourcePath: lastWriteMdPath } });
 getMediaNotifier().notify({
 chatId: userId,
 mediaType: 'xlsx',
 filePath: xlsxPath,
 name: xlsxPath.split(/[/\\]/).pop(),
 }).catch(e => console.warn('⚠️ [MediaNotifier] Excel链式执行通知失败:', e.message));
 } else {
 console.warn('⚠️ [DSML兜底] MarkdownToExcel 执行结果:', meResultStr.substring(0, 200));
 }
 } catch (e) {
 console.error('❌ [DSML兜底] MarkdownToExcel 执行失败:', e.message);
 }
 }
 if (!interruptSignal.aborted && lastWriteMdPath && !hasMarkdownToWord && /生成.*PPT|制作.*PPT|导出.*PPT|生成.*幻灯片|创建.*PPT|PPT.*转换/i.test(message)) {
 console.log('🔧 [DSML兜底] 检测到PPT生成意图，自动链式执行 MarkdownToPPT');
 try {
 const mpResult = await executeToolCall({ name: 'MarkdownToPPT', params: { input_path: lastWriteMdPath } });
 const mpResultStr = typeof mpResult === 'string' ? mpResult : JSON.stringify(mpResult);
 if (mpResultStr && !mpResultStr.includes('"error"')) {
 console.log('✅ [DSML兜底] MarkdownToPPT 执行成功');
 finalContent += `\n\n📄 MarkdownToPPT 结果: ${mpResultStr.substring(0, 500)}`;
 let pptxPath = lastWriteMdPath.replace(/\.md$/i, '.pptx');
 try {
 let mpData = mpResult;
 if (mpResult.content && typeof mpResult.content === 'string') {
 mpData = JSON.parse(mpResult.content);
 }
 if (mpData.output_path) pptxPath = mpData.output_path;
 } catch(e) { console.warn('⚠️ PPT 生成后处理异常:', e.message); }
 onChunk({ content: '', done: false, file_generated: { type: 'pptx', path: pptxPath, name: pptxPath.split(/[/\\]/).pop(), mdSourcePath: lastWriteMdPath } });
 getMediaNotifier().notify({
 chatId: userId,
 mediaType: 'pptx',
 filePath: pptxPath,
 name: pptxPath.split(/[/\\]/).pop(),
 }).catch(e => console.warn('⚠️ [MediaNotifier] PPT链式执行通知失败:', e.message));
 } else {
 console.warn('⚠️ [DSML兜底] MarkdownToPPT 执行结果:', mpResultStr.substring(0, 200));
 }
 } catch (e) {
 console.error('❌ [DSML兜底] MarkdownToPPT 执行失败:', e.message);
 }
 }
 if (!interruptSignal.aborted && lastWriteMdPath && !hasMarkdownToWord && /生成.*PDF|导出.*PDF|生成.*pdf|PDF.*转换|MarkdownToPDF|pdf_generate/i.test(message)) {
 console.log('🔧 [DSML兜底] 检测到PDF生成意图，自动链式执行 MarkdownToPDF');
 try {
 const mpResult = await executeToolCall({ name: 'MarkdownToPDF', params: { input_path: lastWriteMdPath } });
 const mpResultStr = typeof mpResult === 'string' ? mpResult : JSON.stringify(mpResult);
 if (mpResultStr && !mpResultStr.includes('"error"')) {
 console.log('✅ [DSML兜底] MarkdownToPDF 执行成功');
 finalContent += `\n\n📄 MarkdownToPDF 结果: ${mpResultStr.substring(0, 500)}`;
 let pdfPath = lastWriteMdPath.replace(/\.md$/i, '.pdf');
 try {
 let mpData = mpResult;
 if (mpResult.content && typeof mpResult.content === 'string') {
 mpData = JSON.parse(mpResult.content);
 }
 if (mpData.output_path) pdfPath = mpData.output_path;
 } catch(e) { console.warn('⚠️ PDF 生成后处理异常:', e.message); }
 onChunk({ content: '', done: false, file_generated: { type: 'pdf', path: pdfPath, name: pdfPath.split(/[/\\]/).pop(), mdSourcePath: lastWriteMdPath } });
 getMediaNotifier().notify({
 chatId: userId,
 mediaType: 'pdf',
 filePath: pdfPath,
 name: pdfPath.split(/[/\\]/).pop(),
 }).catch(e => console.warn('⚠️ [MediaNotifier] PDF链式执行通知失败:', e.message));
 } else {
 console.warn('⚠️ [DSML兜底] MarkdownToPDF 执行结果:', mpResultStr.substring(0, 200));
 }
 } catch (e) {
 console.error('❌ [DSML兜底] MarkdownToPDF 执行失败:', e.message);
 }
 }
 if (!interruptSignal.aborted && lastWriteMdPath && !hasMarkdownToWord && /生成.*HTML|生成.*网页|导出.*HTML|创建.*网页|HTML.*生成/i.test(message)) {
 console.log('🔧 [DSML兜底] 检测到HTML生成意图，自动链式执行 MarkdownToHTML');
 try {
 const mhResult = await executeToolCall({ name: 'MarkdownToHTML', params: { input_path: lastWriteMdPath } });
 const mhResultStr = typeof mhResult === 'string' ? mhResult : JSON.stringify(mhResult);
 if (mhResultStr && !mhResultStr.includes('"error"')) {
 console.log('✅ [DSML兜底] MarkdownToHTML 执行成功');
 finalContent += `\n\n📄 MarkdownToHTML 结果: ${mhResultStr.substring(0, 500)}`;
 let htmlPath = lastWriteMdPath.replace(/\.md$/i, '.html');
 try {
 let mhData = mhResult;
 if (mhResult.content && typeof mhResult.content === 'string') {
 mhData = JSON.parse(mhResult.content);
 }
 if (mhData.output_path) htmlPath = mhData.output_path;
 } catch(e) { console.warn('⚠️ HTML 生成后处理异常:', e.message); }
 onChunk({ content: '', done: false, file_generated: { type: 'html', path: htmlPath, name: htmlPath.split(/[/\\]/).pop(), mdSourcePath: lastWriteMdPath } });
 getMediaNotifier().notify({
 chatId: userId,
 mediaType: 'html',
 filePath: htmlPath,
 name: htmlPath.split(/[/\\]/).pop(),
 }).catch(e => console.warn('⚠️ [MediaNotifier] HTML链式执行通知失败:', e.message));
 } else {
 console.warn('⚠️ [DSML兜底] MarkdownToHTML 执行结果:', mhResultStr.substring(0, 200));
 }
 } catch (e) {
 console.error('❌ [DSML兜底] MarkdownToHTML 执行失败:', e.message);
 }
 }

 // 关键修复：DSML兜底执行工具后，调用AI基于结果生成最终回答
 // 否则用户只能看到原始工具结果JSON，无法得到有意义的分析
 // 2026-08-15 P2-3: 中断时停止后续 LLM 调用并走中断路径(不落历史/轨迹)
 if (interruptSignal.aborted) {
   console.log('ℹ️ [DSML兜底] 检测到中断, 停止 DSML 收尾');
   return '';
 }
 if (dsmlSuccessResults.length > 0 || dsmlFailedResults.length > 0) {
 // 2026-09-07 P0: DSML 兜底执行的工具有效性计入总数——此前只统计原生
 // tool_calls 路径, 兜底路径的工具调用不占预算, 循环上限失真。
 streamTotalToolCalls += dsmlSuccessResults.length + dsmlFailedResults.length;
 console.log(`📝 [DSML兜底] ${dsmlSuccessResults.length} 个工具成功, ${dsmlFailedResults.length} 个工具失败，调用AI生成最终回答`);
 // 将工具结果加入对话历史，让AI能基于结果生成回答
 let toolResultsText = '';
 if (dsmlSuccessResults.length > 0) {
 toolResultsText += '【成功执行的工具】\n' + dsmlSuccessResults.map(r =>
 `${r.name}: ${r.content.substring(0, 1500)}`
 ).join('\n\n');
 }
 if (dsmlFailedResults.length > 0) {
 toolResultsText += '\n\n【执行失败的工具】\n' + dsmlFailedResults.map(r =>
 `${r.name} 失败原因: ${r.error}`
 ).join('\n\n');
 }
 // 2026-09-07 P0-3: 兜底不再一步强制收尾——此前执行一批 DSML 工具后立即
 // forceFinalAnswer(结果提示词明令"不要再调用任何工具"), 长任务被切成
 // "一轮一个动作", 用户必须手动催(宣传片实测: 渲完探路示例即停, 用户催两次
 // 仍未产出)。预算有余时把结果回灌主循环再跑一轮: 原生 tool_calls 的多轮
 // 循环照常工作; 收尾时机统一由 IterationBudget/工具数上限执法。
 // 注: 续跑轮若模型又以 DSML 文本收尾, 落入下方一次性收尾(与旧行为一致,
 // 不劣化); 连续多批 DSML 的完全循环化留待 Loop 层重构。
 const dsmlBudgetRemaining = !budget.shouldForceStop() && streamTotalToolCalls < effectiveToolCallLimit;
 if (dsmlBudgetRemaining) {
 compressedMessages.push({
 role: 'user',
 content: `[系统提示] 以上工具已执行完成，结果如下：\n\n${toolResultsText}\n\n请继续推进任务（可以继续调用工具）；若任务已完成，直接给出最终回复。`,
 });
 // 重置 runToolDigest 以跳过 forceFinalAnswer 的快速路径
 runToolDigest = '';
 try {
 const continued = await processWithStreaming(compressedMessages, 1);
 const continuedContent = typeof continued === 'string' ? continued : (continued?.content || '');
 if (continuedContent && continuedContent.trim().length > 0) {
 finalContent = continuedContent;
 }
 } catch (e) {
 console.error('❌ [DSML兜底] 续跑失败，降级为基于已有结果收尾:', e.message);
 }
 } else {
 const promptContent = dsmlFailedResults.length > 0
 ? `[系统提示] 工具执行完成，但有部分失败。请分析失败原因并给出替代方案，或基于成功的工具结果回答用户问题。不要再调用任何工具：\n\n${toolResultsText}`
 : `[系统提示] 以上工具已执行完成，以下是执行结果。请基于这些结果直接回答用户的问题，不要再调用任何工具：\n\n${toolResultsText}`;
 compressedMessages.push({
 role: 'user',
 content: promptContent
 });
 // 重置 runToolDigest 以跳过 forceFinalAnswer 的快速路径，确保调用AI生成回答
 runToolDigest = '';
 try {
 const finalAnswer = await forceFinalAnswer(compressedMessages);
 if (finalAnswer && finalAnswer.trim().length > 0) {
 finalContent = finalAnswer;
 }
 } catch (e) {
 console.error('❌ [DSML兜底] 调用AI生成最终回答失败:', e.message);
 // 降级：使用已有的 finalContent（包含工具结果预览）
 }
 }
 }
 } // end if (dsmlToolCalls.length > 0)

 const cleanedContent = stripDSMLTags(finalContent);
 // 2026-08-13 P2-4: 中断(abort/超时)时 finalContent 为空——不再落空 assistant 消息
 if (cleanedContent && cleanedContent.trim()) {
   unifiedAddMessage(userId, 'assistant', cleanedContent, sessionId);
 }
 contextCache.invalidateHistory(userId);

 // 2026-08-20 弹卡治理: 删除 R19 自动 document 场景卡推送。
 // 根因: 无意图过滤,任何 >300 字符回答(资讯摘要/内部任务回答)都会
 // 自动推 document 卡进对话窗口左侧阅读面板——用户"已要求清除却反复出现"。
 // 文档产出改由显式工具(file-panel/HtmlGenerate)承载,AI 回答留在对话流。
 // 对话窗口不再自动产生临时文本卡片。

 // 2026-08-13 P2-4: 中断时 cleanedContent 为空——轨迹不存空 assistant 消息
 if (!cleanedContent || !cleanedContent.trim()) return finalContent || '';
 try {
 globalTrajectorySaver.save(compressedMessages.concat([{ role: 'assistant', content: cleanedContent }]), model, true);
 } catch (e) { console.warn('保存流式轨迹失败:', e.message); }
 
 // ── ACI Phase 3 flush（流式）──
 try { _aciBufferFlush(userId); } catch (e) { console.warn('[ai] ACI flush 失败:', e?.message || e); }
 onChunk({ content: '', done: true });
 return cleanedContent;
 } finally {
 _interruptReg.unregister();
 // 2026-08-15 P2-5: 会话(请求)结束指标——onSessionEnd 此前无任何调用方,
 // harness session 指标永不上报。best-effort 不阻断主流程。
 try { globalHarnessLifecycle.onSessionEnd({ sessionId: sessionId || userId, userId }); } catch (e) { console.warn('[ai] Harness onSessionEnd failed:', e?.message || e); }
 }
}

/**
 * 2026-08-15 审查返工 Important-1: 流读取专用中断 relay——外部空闲超时信号
 * (chat-handler 120s 无 chunk 超时)是一次性 AbortController, 与内部用户停止
 * 信号静态合并(AbortSignal.any)会在工具执行期间超时 abort 后把合并信号永久
 * latch, 工具完成后下一轮 fetch 立即 AbortError → 整轮被误判"用户中断"。
 *
 * 语义: 每轮 fetch 前调用 nextReadSignal() 新建 readAbort 并挂接"当前"空闲
 * 信号(一次性转发, 已 abort 则跳过——超时只中止它在飞的读取, 不污染后续
 * 轮次); 空闲信号持有方(chat-handler)在超时 abort 后立刻换新 controller,
 * 收到 chunk 重置计时器, 后续轮次经 getIdleSignal() 取到未 abort 的新信号。
 * 内部用户停止信号仍是 latch(整轮终止), 始终参与合并。
 */
function createStreamInterruptRelay({ internalSignal, getIdleSignal }) {
  const nextReadSignal = () => {
    const readAbort = new AbortController();
    let idle = null;
    try { idle = typeof getIdleSignal === 'function' ? getIdleSignal() : null; }
    catch (e) { console.warn('[ai] getIdleSignal 失败(降级仅内部信号):', e?.message || e); }
    if (idle && !idle.aborted) {
      idle.addEventListener('abort', () => readAbort.abort(), { once: true });
    }
    return AbortSignal.any([internalSignal, readAbort.signal]);
  };
  return { nextReadSignal };
}

/**
 * chatStream 中断注册（I-3）——与 chat() 的 globalRequestInterrupt 同款，按 userId 隔离
 */
function registerInterruptForChatStream(userId) {
  try {
    const { globalRequestInterrupt } = require('./request-interrupt');
    const abortController = globalRequestInterrupt.register(userId, 'chatStream');
    return {
      abortController,
      signal: abortController.signal,
      unregister() {
        try {
          // B4(Runtime差距分析): 传 controller 做所有权校验——断连解耦后旧 run 可能
          // 存活到新 run 注册之后,盲删会把新 run 的中断注册一并删掉。
          globalRequestInterrupt.unregister(userId, abortController);
        } catch (e) { console.warn('[ai] 中断注销失败:', e.message || e); }
      },
    };
  } catch (e) {
    console.warn('[ai] 中断注册失败（降级无中断）:', e.message || e);
    const ac = new AbortController();
    return { signal: ac.signal, abortController: ac, unregister() {} };
  }
}

async function* reply_stream(config, skills, userId, message) {
 const queue = [];
 let finished = false;
 let capturedError = null;
 let notify = null;

 const onChunk = (chunk) => {
 queue.push(chunk);
 if (chunk && chunk.done) finished = true;
 if (notify) { notify(); notify = null; }
 };

 const promise = chatStream(config, skills, userId, message, onChunk)
 .catch(err => { capturedError = err; finished = true; if (notify) { notify(); notify = null; } });

 while (!finished) {
 if (queue.length === 0) {
 await new Promise(r => { notify = r; });
 }
 while (queue.length > 0) {
 yield queue.shift();
 }
 }

 while (queue.length > 0) {
 yield queue.shift();
 }

 if (capturedError) throw capturedError;
 await promise;
}

module.exports = {
 registerInterruptForChatStream,
 createStreamInterruptRelay,
 chat,
 enhancedChat,
 summarize,
 parseSkillCall,
 parseToolCall,
 executeToolCall,
 chatStream,
 reply_stream,
 getLastLarkCard,
 clearLastLarkCard,
 deliveryRouter,
 shellHooksBridge,
 contextEngineRegistry,
 webhookAnomalyTracker,
 globalCommitmentTracker,
 globalContextWindowGuard,
 globalKeyRotationManager,
 globalHeartbeatPatrol,
 globalDiagnosticCustodian,
 globalToolResultMiddleware,
 globalHumanDelay,
 globalToolDisplay,
 globalTimeAwareness,
 globalConsoleSanitizer,
 globalAnnouncementManager,
 globalAgentDeleteSafety,
 setToolCallCallback,
 setSubAgentCallback,
 // 2026-08-15 P1-5: 测试钩子——per-user RepeatFailureGuard 隔离单测入口
 _getFailureGuard,
 // 2026-08-17: 文件生成意图判定（纯函数）——导出供单测回归保护
 isFileGenIntent,
 // 2026-08-22: 执行验证门判定（纯函数）——导出供单测回归保护（长文本直出/词表统一）
 shouldForceWriteRetry,
 // 2026-08-22: 文件生成任务引导提示——导出供测试断言文案
 FILEGEN_TASK_HINT,
 // 2026-08-23: 深度研究引导提示（fileGenHintFor 分档）——导出供测试断言文案
 FILEGEN_TASK_HINT_DEEP,
 // 2026-08-23: 分档引导选择（轻量文章 vs 深度研究）——导出供单测回归保护
 fileGenHintFor,
 // 2026-09-06 恢复链路: 继续类消息判定/恢复引导——导出供单测回归保护
 isFileGenResumeMessage,
 fileGenResumeHintFor,
 fileGenPausedAnswerHintFor,
 // 2026-08-20: 技能知识注入（纯函数）——导出供反证测试直接断言注入生效
 injectSkillGuidance,
};
