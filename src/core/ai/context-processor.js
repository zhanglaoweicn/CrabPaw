'use strict';

/**
 * context-processor — chat / chatStream 共享的上下文准备与压缩逻辑
 *
 * 提取自 ai.js 的 chat (L1363-1437) 和 chatStream (L853-948)。
 * 两者共享：bootstrap 注入 → 压缩 → todo 注入 → 承诺注入 → 窗口守卫检查 → 强制压缩。
 *
 * 差异点通过参数控制：
 *   - enableGatewayPreCheck：chatStream 专属的网关安全网预检（>85% 阈值时预压缩）
 *   - onCompressed：chatStream 专属的压缩后回调（策略优化器记录）
 *   - enableShouldBlockLog：chat 专属的 shouldBlock 错误日志
 *   - isStream：日志前缀 [流式]
 *
 * 设计原则：纯函数 + 依赖注入，所有外部状态通过 deps 传入，不引用 ai.js 全局变量。
 */

const { BOOTSTRAP_MARKER, injectBootstrapIntoMessages } = require('../bootstrap-injector');
const { estimateMessagesTokens } = require('../context/compressor');
const { globalContextWindowGuard, resolveContextWindowInfo } = require('../context-window-guard');
const { globalTodoManager } = require('../../tools/todo-tool');
const { globalCommitmentTracker } = require('../commitment/commitment-tracker');

// 问候语正则：对简短问候/闲聊不注入到期承诺提醒，避免触发不必要的工具调用
const GREETING_RE = /^(你好|您好|嗨|哈喽|早上好|下午好|晚上好|在吗|在么|hi|hello|hey|嗨呀|你好啊|你好呀|哈喽啊)\s*[！!？?。.~]*\s*$/i;
const GREETING_SHORT_RE = /^(你好|您好|嗨|哈喽|在吗|在么|hi|hello)/i;

// 2026-08-17: 内部任务提取指令前缀（memoryExtractionService EXTRACTION_PROMPT 开头）——
// 历史被污染的标记。读取侧过滤（不破坏存储）：
//  - role=user 以该前缀开头 → 提取指令消息，剔除
//  - 紧跟其后的 role=assistant ```json 短回复（<600 字符）→ 提取结果，剔除
// 根因（答非所问）：auto-dream resolveLLMCall 把提取 prompt 当 message 传 ai.chat()，
// chat() 经 unifiedAddMessage 写入主对话历史 → 模型把用户消息当提取任务 →
// 回复 "```json\n[]\n```…不提取" 发给用户（驴唇不对马嘴）。silent 参数已阻止新增，
// 此处兜底剔除历史里已存在的污染消息。
const EXTRACT_PROMPT_PREFIX = 'Extract key info from this conversation turn';
function sanitizeInternalNoise(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const out = [];
  let prevWasExtractPrompt = false;
  for (const m of messages) {
    const c = typeof m?.content === 'string' ? m.content : '';
    const isExtractPrompt = m.role === 'user' && c.startsWith(EXTRACT_PROMPT_PREFIX);
    if (isExtractPrompt) { prevWasExtractPrompt = true; continue; }
    const isExtractReply = prevWasExtractPrompt && m.role === 'assistant'
      && /^```json/.test(c.trim()) && c.length < 600;
    if (isExtractReply) { prevWasExtractPrompt = false; continue; }
    prevWasExtractPrompt = false;
    out.push(m);
  }
  return out.length === messages.length ? messages : out;
}

/**
 * 准备并压缩上下文。
 *
 * 执行流程（与原 chat/chatStream 内联实现严格一致）：
 *   1. Progressive Disclosure 注入（书签层 + 详细层）
 *   2. [可选] 网关安全网预检（chatStream：>85% 阈值时预压缩）
 *   3. 主压缩
 *   4. Todo 注入（追加到最后一条消息）
 *   5. 承诺提醒注入（问候语跳过）
 *   6. 窗口守卫检查 + 强制压缩
 *
 * @param {object} deps
 * @param {Array} deps.messages              消息数组（会被原地修改 bootstrap 注入）
 * @param {string} deps.bookmarkContent      书签层内容
 * @param {string} deps.bootstrapContent     详细层内容
 * @param {object} deps.contextCompressor    ContextCompressor 实例
 * @param {string} deps.focusTopic           压缩焦点（当前用户消息）
 * @param {string} deps.userId               用户 ID（承诺追踪用）
 * @param {string} deps.provider             模型提供者（窗口守卫用）
 * @param {string} deps.model                模型 ID（窗口守卫用）
 * @param {boolean} [deps.isStream=false]    是否流式（影响日志前缀）
 * @param {boolean} [deps.enableGatewayPreCheck=false] chatStream 专属网关预检
 * @param {Array} [deps.userHistory=[]]      网关预检用历史（需 userHistory.length >= 4）
 * @param {Function} [deps.onCompressed]     压缩成功后回调 (compressionResult) => void
 * @param {boolean} [deps.enableShouldBlockLog=false] chat 专属 shouldBlock 错误日志
 * @returns {Promise<{compressedMessages: Array, estimatedTokens: number, contextMaxTokens: number}>}
 */
async function prepareAndCompressContext(deps) {
  const {
    messages,
    bookmarkContent,
    bootstrapContent,
    contextCompressor,
    focusTopic,
    userId,
    provider,
    model,
    isStream = false,
    enableGatewayPreCheck = false,
    userHistory = [],
    onCompressed = null,
    enableShouldBlockLog = false,
  } = deps;

  const streamPrefix = isStream ? '[流式] ' : '';
  const contextMaxTokens = contextCompressor.maxTokens || 128000;

  // 0. 读取侧过滤：剔除内部任务污染的提取指令/结果消息（2026-08-17 答非所问根因兜底）
  //    注意：messages 是从 deps 解构的 const，不能重新赋值——必须原地变异
  //    （与下方网关预压缩的 messages.length=0; push(...) 模式一致），否则抛
  //    "Assignment to constant variable." 导致所有流式聊天失败（实机"出错"）。
  const sanitized = sanitizeInternalNoise(messages);
  if (sanitized !== messages) {
    console.log(`🧹 [上下文] 已过滤 ${messages.length - sanitized.length} 条内部提取噪声消息`);
    messages.length = 0;
    messages.push(...sanitized);
  }

  // 1. Progressive Disclosure 注入（参考 Superpowers 书签模式）
  //    缓存优化 A(2026-08-28)：注入位置从首条 user(最旧历史) 移到末条 user(当前消息)——
  //    bootstrap 内容随消息变化(memoryPrompt=loadSmartContext 逐消息变)，注入 h1 会使
  //    历史前缀从 h1 起全量 cache miss；尾置后前缀 = stable system + 历史（字节稳定）全命中。
  //    书签层：始终注入末条用户消息（< 2000 tokens，技能索引+摘要）
  injectBootstrapIntoMessages(messages, bookmarkContent);
  //    详细层：仅当书签层未触发详细加载时注入（避免重复）
  if (bootstrapContent && !bookmarkContent?.includes(BOOTSTRAP_MARKER)) {
    injectBootstrapIntoMessages(messages, bootstrapContent);
  } else if (bootstrapContent) {
    // 详细内容合并到末条用户消息（紧跟书签之后）
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i] && messages[i].role === 'user') { lastUserIdx = i; break; }
    }
    if (lastUserIdx >= 0) {
      const msg = messages[lastUserIdx];
      if (typeof msg.content === 'string' && !msg.content.includes(BOOTSTRAP_MARKER)) {
        messages[lastUserIdx] = {
          ...msg,
          content: `${bootstrapContent}\n\n${msg.content}`,
        };
      }
    }
  }

  // 2. 网关安全网预检（chatStream 专属）
  //    在 Agent 压缩器之前，检查消息总量是否接近上下文窗口上限
  if (enableGatewayPreCheck) {
    const preCheckTokens = estimateMessagesTokens(messages);
    const gatewayThreshold = 0.85;
    if (preCheckTokens > contextMaxTokens * gatewayThreshold && userHistory.length >= 4) {
      console.warn(`🚨 [网关安全网] 消息总量 ${preCheckTokens} tokens 超过 ${Math.round(gatewayThreshold * 100)}% 阈值 (${contextMaxTokens})，执行预压缩`);
      const preCompressResult = await contextCompressor.compress(messages, {
        maxTokens: Math.floor(contextMaxTokens * 0.5),
        focusTopic,
      });
      if (preCompressResult.compressed) {
        messages.length = 0;
        messages.push(...preCompressResult.messages);
        console.log(`🗜️ [网关安全网] 预压缩完成: ${preCompressResult.originalTokens} → ${preCompressResult.compressedTokens} tokens`);
      }
    }
  }

  // 3. 主压缩
  // P0-1(2026-08-25) 窗口口径对齐：主压缩使用模型真实窗口（与窗口守卫同源 resolveContextWindowInfo），
  // 消灭 62k-90k 死区——此前压缩器默认 128000（阈值 89.6k）远高于守卫 65,536×0.95(62.3k)，
  // 每轮上下文落在死区 → 守卫必触发强制压缩（而大头在受保护头尾，只省 2-24%）。
  // 未识别模型时保持旧行为（默认 128k）。
  let compressedMessages = messages;
  const winInfo = resolveContextWindowInfo({ provider, modelId: model });
  const modelWindow = winInfo && winInfo.tokens > 0 ? winInfo.tokens : null;
  const mainCompressOpts = modelWindow ? { maxTokens: modelWindow } : {};
  const compressionResult = await contextCompressor.compress(messages, mainCompressOpts);
  if (compressionResult.compressed) {
    compressedMessages = compressionResult.messages;
    const ratioStr = compressionResult.ratio != null
      ? ` (-${compressionResult.ratio.toFixed(1)}%)`
      : '';
    console.log(`🗜️ ${streamPrefix}上下文已压缩: ${compressionResult.originalTokens} → ${compressionResult.compressedTokens} tokens${ratioStr}`);
    if (onCompressed) {
      try { onCompressed(compressionResult); }
      catch (e) { console.warn('⚠️ onCompressed 回调异常:', e.message); }
    }
  }

  // P2-1(2026-08-25) 压缩写回载荷透出（主压缩与强制压缩取最新成功者）
  let compressPersist = compressionResult.persist || null;

  // 4. Todo 注入（追加到最后一条消息）
  const todoInjection = globalTodoManager.formatForInjection();
  if (todoInjection && compressedMessages.length > 0) {
    const lastIdx = compressedMessages.length - 1;
    compressedMessages[lastIdx] = {
      ...compressedMessages[lastIdx],
      content: compressedMessages[lastIdx].content + todoInjection,
    };
  }

  // 5. 承诺提醒注入（问候语跳过，避免触发不必要的工具调用）
  const commitmentPrompt = globalCommitmentTracker.buildCommitmentsPrompt(userId);
  if (commitmentPrompt && compressedMessages.length > 0) {
    const lastIdx = compressedMessages.length - 1;
    const userMsg = compressedMessages[lastIdx].content || '';
    const isGreeting = GREETING_RE.test(userMsg.trim()) ||
      (userMsg.trim().length <= 6 && GREETING_SHORT_RE.test(userMsg.trim()));
    if (!isGreeting) {
      compressedMessages[lastIdx] = {
        ...compressedMessages[lastIdx],
        content: compressedMessages[lastIdx].content + commitmentPrompt,
      };
    }
  }

  // 6. 窗口守卫检查 + 强制压缩
  const estimatedTokens = estimateMessagesTokens(compressedMessages);
  const windowGuard = globalContextWindowGuard.check({
    provider,
    modelId: model,
    currentTokenCount: estimatedTokens,
  });
  if (windowGuard.warning) {
    console.warn(`🪟 ${streamPrefix}[上下文窗口] ${windowGuard.warning}`);
  }
  if (windowGuard.shouldCompress && windowGuard.compressionTarget) {
    if (enableShouldBlockLog) {
      console.log(`🪟 [上下文窗口] 使用率过高，强制压缩至 ${windowGuard.compressionTarget} tokens`);
    }
    // P0-2(2026-08-25) 软截断先行：smartTruncate(压缩机已实现、零调用方)删除最旧非系统消息
    // ——压缩器保护头尾，砍得动大头的其实是"丢最旧"，先软后硬避免 -2.4% 级空压。
    const soft = contextCompressor.smartTruncate(compressedMessages, windowGuard.compressionTarget);
    if (soft.truncated) {
      compressedMessages = soft.messages;
      if (enableShouldBlockLog) {
        console.log(`✂️ [软截断] 已移除 ${soft.removedCount} 条最旧消息（目标 ${windowGuard.compressionTarget}）`);
      }
    }
    // 软截断后重估：仍在高水位（触发压缩阈值 0.75）才走硬压缩
    const afterSoft = estimateMessagesTokens(compressedMessages);
    const winTokens = modelWindow || 128000; // 与主压缩同源；未识别模型回退压缩器默认
    if (afterSoft > winTokens * 0.75) {
      const forcedCompress = await contextCompressor.compress(compressedMessages, {
        maxTokens: windowGuard.compressionTarget,
        focusTopic,
      });
      if (forcedCompress.compressed) {
        compressedMessages = forcedCompress.messages;
        if (forcedCompress.persist) compressPersist = forcedCompress.persist;
      }
    }
  }
  if (enableShouldBlockLog && windowGuard.shouldBlock) {
    console.error(`🪟 [上下文窗口] 模型上下文窗口过小，可能无法正常工作: ${windowGuard.warning}`);
  }

  // 返回压缩后消息 + token 统计（chatStream 的"主动压缩提示"需要 estimatedTokens/contextMaxTokens）
  return { compressedMessages, estimatedTokens, contextMaxTokens, compressPersist };
}

module.exports = { prepareAndCompressContext, sanitizeInternalNoise };
