/**
 * 上下文构建模块
 * 
 * 从 ai.js 中提取的上下文构建逻辑，包括：
 * - 感知层上下文构建（volatile context）
 * - 智能记忆加载
 * - 对话时间线构建
 * - @-引用预处理
 * - 上下文压缩与窗口保护
 * - 消息组装与Bootstrap注入
 */

const fs = require('fs');
const path = require('path');
const { WORKSPACE_DIR } = require('./config');
const { isChannelEnabled } = require('./credential-manager');
const { memoryManager } = require('./memory-system');
const { contextCache } = require('./context-cache');
const { buildSystemPrompt, buildLayeredSystemPrompt } = require('./system-prompt');
const { buildCompactMemoryPrompt, loadSmartContext } = require('./memory-smart-loader');
const { preprocessContextReferences } = require('./context/context-references');
const { BOOTSTRAP_MARKER, buildBootstrapBookmark, buildBootstrapDetail, injectFullBootstrap } = require('./bootstrap-injector');
const { estimateMessagesTokens } = require('./context/compressor');

/**
 * 构建感知层上下文（每轮变化的 volatile 内容）
 * 返回 { volatileParts, proactiveHints }
 */
async function buildVolatileContext(userId, message, config, timeContext, onboardingPrompt, layeredPrompt) {
 const volatileParts = [];
 // -- boss profile --
 try {
   const { getBossProfile } = require('./boss-profile');
   const block = getBossProfile().getIdentityBlock();
   if (block) volatileParts.push(block);
 } catch (e) {
   console.warn('[context-builder] :', e.message || e);
 }

 // 记忆回响（可引用历史，勿编造）
 try {
   const { getRelatedMemories, buildEchoHints } = require("./memory/echo-hints");
   const qText = typeof message === "string" ? message : "";
   if (qText) {
     const related = await getRelatedMemories(qText, { limit: 3 });
     const echo = buildEchoHints(qText, related);
     if (echo.promptBlock) volatileParts.push(echo.promptBlock);
   }
 } catch (e) {
   console.warn("[context-builder] 记忆回响注入失败:", e.message || e);
 }
 if (layeredPrompt.context) volatileParts.push(layeredPrompt.context);
 if (layeredPrompt.volatile) volatileParts.push(layeredPrompt.volatile);
 volatileParts.push(timeContext);
 if (onboardingPrompt) volatileParts.push(onboardingPrompt);

 // 对话阶段感知注入（参考 Superpowers 自动触发模式）
 try {
 const { detectConversationPhase } = require('./skill-router');
 const phaseInfo = detectConversationPhase(message, { recentSkills: [] });
 if (phaseInfo.confidence > 0.3 && phaseInfo.prompt) {
 volatileParts.push(phaseInfo.prompt);
 }
 } catch (e) { /* skill-router 不可用时静默降级 */ console.debug('[context] skill-router(volatile)失败:', e.message); }

 // 项目工作目录注入
 try {
 const activeProjectId = config.activeProjectId || null;
 if (activeProjectId) {
 const { getProjectsRoot } = require('../cli/handlers/project-handlers');
 const projectsRoot = getProjectsRoot(userId);
 const projectDir = path.join(projectsRoot, activeProjectId);
 if (fs.existsSync(projectDir)) {
 volatileParts.push(`[当前项目] 用户正在项目 "${activeProjectId}" 中工作。项目目录: ${projectDir}\n当用户要求创建/写入文件时，优先将文件存入项目目录。但不要自动修改已有文件的路径。`);
 }
 }
 } catch (e) { /* 项目上下文不可用时静默降级 */ console.debug('[context] 项目上下文(volatile)失败:', e.message); }

 // ── Scene Manifest（当前界面有什么） ──
 try {
 const { getSceneStore } = require('./scene/scene-store');
 const manifest = getSceneStore().getManifest();
 if (manifest && manifest.manifest && manifest.manifest.length > 0) {
 const sceneLines = manifest.manifest.map(function(s) {
 return ' [' + s.id + '] ' + s.kind + ' (' + s.intent + '): ' + s.dataSummary;
 }).join('\n');
 volatileParts.push('[当前界面]\n' + sceneLines);
 }
 } catch (e) {
   /* scene store 不可用 */
   console.warn('[context-builder.js] 空 catch 补日志:', e && e.message);
 }

 // ── 面板状态上下文（相关度注入：仅非 null 状态；open 60min / closed 120s 内）──
 try {
   const { getPanelState, buildPanelStateContext } = require('./panel-state');
   const { getSceneStore } = require('./scene/scene-store');
   const PANEL_SURFACES = { weather: 'weather-panel', hotspot: 'hotspot-panel', stock: 'stock-panel', music: null, filegen: 'file-panel' };
   const states = getPanelState();
   const blocks = [];
   for (const [panel, state] of Object.entries(states)) {
     if (state == null) continue;    // 从未交互 / 超 TTL → 零注入
     const surfaceId = PANEL_SURFACES[panel];
     let surfaceData = null;
     if (surfaceId) {
       try {
         const surface = getSceneStore().getSurface(surfaceId);
         surfaceData = surface ? surface.data : null;
       } catch (e) { console.warn('[context-builder] 面板快照获取失败:', e.message || e); }
     }
     const block = buildPanelStateContext(panel, state, surfaceData);
     if (block) blocks.push(block);
   }
   if (blocks.length > 0) {
     volatileParts.push(blocks.join('\n\n'));
     console.log(`[context] panel-state: ${Object.entries(states).filter(([, s]) => s != null).map(([p, s]) => `${p}=${s}`).join(', ') || '(none)'}`);
   }
 } catch (e) {
   console.warn('[context-builder] 面板状态注入失败:', e.message || e);
 }

 // ── 未消费的 UI Intent（用户与 scene surface 的交互）──
 try {
 const { getSceneStore } = require('./scene/scene-store');
 var pendingIntents = getSceneStore().consumePendingIntents();
 if (pendingIntents && pendingIntents.length > 0) {
 // 2026-08-13: choice 卡 pending 确认(P1-6, 参考实现 data.pending 借鉴)——
 // select/toggle 且 data.pending===true 的点击是"用户已决策、待执行",
 // 以最高优先级指令注入头部:要求回复以确认句开头并直接执行,不再罗列选项。
 var confirmedChoices = pendingIntents.filter(function(intent) {
 return (intent.name === 'select' || intent.name === 'toggle')
   && intent.data && intent.data.pending === true && intent.data.value != null;
 });
 if (confirmedChoices.length > 0) {
   var choiceLines = confirmedChoices.map(function(intent) {
     return '用户刚刚在界面选择卡上点击了「' + String(intent.data.value) + '」。';
   }).join('\n');
   volatileParts.unshift('[最高优先级指令]\n' + choiceLines + '\n你的回复必须以一句话确认该选择(如"好的，已选择X")作为开头，然后直接执行对应的任务。不要重新罗列选项或反问用户。');
 }
 var intentLines = pendingIntents.map(function(intent) {
 return ' [' + intent.surface + '] ' + intent.name + ': ' + JSON.stringify(intent.data);
 }).join('\n');
 volatileParts.push('[未处理的用户操作]\n' + intentLines);
 }
 } catch (e) {
   /* scene intents 不可用 */
   console.warn('[context-builder.js] 空 catch 补日志:', e && e.message);
 }

 // ── 热点上下文注入（用户消息提到热点时自动匹配）──
 try {
 const { buildHotspotRuntimeContext } = require('./hotspot-intent');
 const hotspotCtx = buildHotspotRuntimeContext(message || '');
 if (hotspotCtx) {
 volatileParts.push(hotspotCtx);
 }
 } catch (e) {
   /* hotspot-intent 不可用 */
   console.warn('[context-builder.js] 空 catch 补日志:', e && e.message);
 }

 // ── Scene 卡片提示（精简版）：可见任务用卡片展示进度 ──
 // 参考 SceneSet 工具的完整 description 了解所有卡片种类和使用方式
 volatileParts.push(`[界面提示] 当执行用户可见的任务（如编写网页/代码、生成文件、搜索信息）时，用 SceneSet 创建 selfcheck/progress/text 等卡片展示过程。完成后移除卡片。卡片内容会直接渲染给用户，回复中不要复述卡片已展示的内容，只给结论。`);

 // ── ACI 预判注入（ACI 4 阶段：意图检测 + 工具链预判 + 预取缓存 + 语义记忆）──
 try {
 const { getACIInjector, getPatternLearner } = require('./aci');
 const injector = getACIInjector();
 // 准备阶段：意图检测 + 工具链预判 + 预取缓存读取 + 语义记忆检索
 const aciPromise = injector.prepare(message || '', {
 // 提供轻量记忆管理器，触发语义记忆预取（Phase 1）
 // 注入器会通过 this._memoryManager 调用，但这里我们直接传 cache + patternLearner 已就绪
 });
 // 加超时保护：不超过 800ms 阻塞主流程
 const aciTimeoutMs = 800;
 const aciResult = await Promise.race([
 aciPromise,
 new Promise(resolve => setTimeout(() => resolve(null), aciTimeoutMs)),
 ]);

 if (aciResult) {
 const { highConfidenceSections, mediumConfidenceSections, rawContext } = aciResult;

 // 注入高置信度章节（直接放入 system message）
 if (Array.isArray(highConfidenceSections) && highConfidenceSections.length > 0) {
 for (const section of highConfidenceSections) {
 if (section && section.length > 0) {
 volatileParts.push(section);
 }
 }
 }

 // 注入中置信度章节（标注为"可能需要"）
 if (Array.isArray(mediumConfidenceSections) && mediumConfidenceSections.length > 0) {
 const medHints = mediumConfidenceSections
 .filter(s => s && s.length > 0)
 .map(s => `[可能需要] ${s}`)
 .join('\n');
 if (medHints) {
 volatileParts.push(medHints);
 }
 }

 // 注入工具链预判（来自 PatternLearner）
 try {
 const learner = getPatternLearner();
 const detectedIntents = (rawContext && rawContext.detectedIntents) || [];
 if (detectedIntents.length > 0 && learner) {
 const toolHints = [];
 for (const intent of detectedIntents) {
 const p = learner.getPattern(intent.name);
 if (p && Array.isArray(p.chain) && p.chain.length > 0) {
 toolHints.push(` - ${intent.name}: ${p.chain.join(' → ')}（已学习 ${p.count} 次，平均 ${Math.round(p.avgDuration)}ms）`);
 }
 }
 if (toolHints.length > 0) {
 volatileParts.push('[工具链预判] 检测到以下意图对应的工具链已学习：\n' + toolHints.join('\n'));
 }
 }
 } catch (e) {
   /* pattern learner 不可用时静默 */
   console.warn('[context-builder.js] 空 catch 补日志:', e && e.message);
 }

 // 记录 elapsed 供调试
 if (aciResult.elapsed) {
 // eslint-disable-next-line no-console
 console.log(`[aci-injector] prepare() took ${aciResult.elapsed}ms, highConf=${(highConfidenceSections||[]).length}, medConf=${(mediumConfidenceSections||[]).length}`);
 }
 }
 } catch (e) {
 // ACI 不可用时静默降级（不影响主流程）
 console.debug('[context] ACI 预判注入(volatile)失败:', e.message);
 }

 let proactiveHints = null;
 try {
 const { globalUserBehaviorSensor } = require('./perception/user-behavior-sensor');
 const { globalBusinessContextSensor } = require('./perception/business-context-sensor');
 globalUserBehaviorSensor.recordActivity(userId, {
 type: 'message',
 detail: message.slice(0, 100),
 channel: isChannelEnabled(config.chatChannel || 'none', 'none') ? 'chat' : (Array.isArray(config.chatChannel) ? config.chatChannel[0] : config.chatChannel),
 });
 globalBusinessContextSensor.recordContext(userId, message);

 const { globalProactivePlanner, globalContextPreloader } = require('./perception');
 const domains = globalBusinessContextSensor.getActiveDomains();
 const result = globalProactivePlanner.evaluateForUser(userId, message, { domains });
 if (result?.prediction?.topPrediction) {
 proactiveHints = result.prediction;
 volatileParts.push(`[主动提示] ${result.prediction.topPrediction.action || result.prediction.topPrediction.type}: ${result.prediction.topPrediction.description || ''}`);
 globalContextPreloader.preloadForPrediction(userId, result.prediction).catch(() => {});
 }
 } catch (e) { console.warn('⚠️ 感知层评估异常:', e.message); }

 return { volatileParts, proactiveHints };
}

/**
 * 构建对话时间线上下文
 */
function buildTimeContext(userHistory, globalTimeAwareness, isStream) {
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
 return timeContext;
}

/**
 * 注入 Todo 和 Commitment 上下文到消息末尾
 */
function injectAuxiliaryContext(compressedMessages, userId, globalTodoManager, globalCommitmentTracker) {
 const todoInjection = globalTodoManager.formatForInjection();
 if (todoInjection && compressedMessages.length > 0) {
 const lastIdx = compressedMessages.length - 1;
 compressedMessages[lastIdx] = {
 ...compressedMessages[lastIdx],
 content: compressedMessages[lastIdx].content + todoInjection
 };
 }

 const commitmentPrompt = globalCommitmentTracker.buildCommitmentsPrompt(userId);
 if (commitmentPrompt && compressedMessages.length > 0) {
 const lastIdx = compressedMessages.length - 1;
 const userMsg = compressedMessages[lastIdx].content || '';
 // 前置保护：对简短问候/闲聊消息，不注入到期承诺提醒
 const GREETING_RE = /^(你好|您好|嗨|哈喽|早上好|下午好|晚上好|在吗|在么|hi|hello|hey|嗨呀|你好啊|你好呀|哈喽啊)\s*[！!？?。.~]*\s*$/i;
 const isGreeting = GREETING_RE.test(userMsg.trim()) ||
 (userMsg.trim().length <= 6 && /^(你好|您好|嗨|哈喽|在吗|在么|hi|hello)/i.test(userMsg.trim()));
 if (!isGreeting) {
 compressedMessages[lastIdx] = {
 ...compressedMessages[lastIdx],
 content: compressedMessages[lastIdx].content + commitmentPrompt
 };
 }
 }

 return compressedMessages;
}

/**
 * 上下文窗口保护与压缩
 */
async function applyContextWindowProtection(compressedMessages, provider, model, message, contextCompressor, globalContextWindowGuard) {
 const estimatedTokens = estimateMessagesTokens(compressedMessages);
 const contextMaxTokens = contextCompressor.maxTokens || 128000;
 const windowGuard = globalContextWindowGuard.check({
 provider,
 modelId: model,
 currentTokenCount: estimatedTokens,
 });

 if (windowGuard.warning) {
 console.warn(`🪟 [上下文窗口] ${windowGuard.warning}`);
 }
 if (windowGuard.shouldCompress && windowGuard.compressionTarget) {
 const forcedCompress = await contextCompressor.compress(compressedMessages, {
 maxTokens: windowGuard.compressionTarget,
 focusTopic: message,
 });
 if (forcedCompress.compressed) {
 compressedMessages = forcedCompress.messages;
 }
 }
 if (windowGuard.shouldBlock) {
 console.error(`🪟 [上下文窗口] 模型上下文窗口过小，可能无法正常工作: ${windowGuard.warning}`);
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

 return compressedMessages;
}

/**
 * 网关安全网预检：在 Agent 压缩器之前，检查消息总量是否接近上下文窗口上限
 */
async function gatewayPreCheck(messages, contextCompressor) {
 const preCheckTokens = estimateMessagesTokens(messages);
 const contextMaxTokens = contextCompressor.maxTokens || 128000;
 const gatewayThreshold = 0.85;
 if (preCheckTokens > contextMaxTokens * gatewayThreshold) {
 console.warn(`🚨 [网关安全网] 消息总量 ${preCheckTokens} tokens 超过 ${Math.round(gatewayThreshold * 100)}% 阈值 (${contextMaxTokens})，执行预压缩`);
 const preCompressResult = await contextCompressor.compress(messages, {
 maxTokens: Math.floor(contextMaxTokens * 0.5),
 focusTopic: null,
 });
 if (preCompressResult.compressed) {
 messages.length = 0;
 messages.push(...preCompressResult.messages);
 console.log(`🗜️ [网关安全网] 预压缩完成: ${preCompressResult.originalTokens} → ${preCompressResult.compressedTokens} tokens`);
 }
 }
 return messages;
}

module.exports = {
 buildVolatileContext,
 buildTimeContext,
 injectAuxiliaryContext,
 applyContextWindowProtection,
 gatewayPreCheck,
};
