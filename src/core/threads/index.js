/**
 * Threads System — Public API
 *
 * Combines the thread classifier, thread manager, and focus stack
 * into a cohesive system for conversational thread management.
 *
 * Main entry point for other CrabPaw modules.
 *
 * Usage:
 *   const { globalThreadManager, globalFocusStack, classifyAndRoute }
 *     = require('./threads');
 *
 *   // Classify and route an incoming message
 *   const result = classifyAndRoute('继续说说那个架构', userMessageId);
 *
 *   // Inject thread context into system prompt
 *   const context = getThreadContext();
 */

const { classifyMessage, CLASSIFICATION_TYPES } = require('./thread-classifier');
const { ThreadManager, globalThreadManager, THREAD_STATUS: _THREAD_STATUS } = require('./threads');
const { FocusStack, globalFocusStack } = require('./focus-stack');

// ─── Combined classification + routing ───

/**
 * Classify an incoming message and update threads + focus stack accordingly.
 *
 * This is the primary entry point for message processing:
 * 1. Classify the message against existing threads
 * 2. Update thread state (continue, create, activate)
 * 3. Optionally update focus stack
 *
 * @param {string} messageText - the raw user message
 * @param {object} [options]
 * @param {string} [options.sourceMessageId] - for tracing
 * @param {boolean} [options.updateFocus=true] - whether to update focus stack
 * @param {boolean} [options.extractFocusTopic=false] - whether to extract topic
 * @returns {{ classification: object, thread: object|null, focus: object|null }}
 */
function classifyAndRoute(messageText, options = {}) {
  const {
    // eslint-disable-next-line no-unused-vars
    sourceMessageId,
    updateFocus = true,
    extractFocusTopic = false,
  } = options || {};

  // Get threads from manager
  const threads = globalThreadManager.listThreads();
  const foregroundId = globalThreadManager._foregroundId || null;

  // Classify
  const classification = classifyMessage(messageText, threads, {
    foregroundThreadId: foregroundId,
  });
  const { type, threadId } = classification;

  let thread = null;
  let focus = null;

  // ── Route based on classification ──
  switch (type) {
    case CLASSIFICATION_TYPES.CONTINUATION: {
      if (threadId) {
        globalThreadManager.continueThread(threadId, messageText);
        thread = globalThreadManager.getThread(threadId);
      } else if (foregroundId) {
        globalThreadManager.continueThread(foregroundId, messageText);
        thread = globalThreadManager.getThread(foregroundId);
      }
      break;
    }

    case CLASSIFICATION_TYPES.RESUME: {
      if (threadId) {
        globalThreadManager.activateThread(threadId);
        globalThreadManager.continueThread(threadId, messageText);
        thread = globalThreadManager.getThread(threadId);
      } else {
        // No specific thread matched — create new
        const title = _extractTitle(messageText);
        const newId = globalThreadManager.createThread(title, messageText);
        thread = globalThreadManager.getThread(newId);
      }
      break;
    }

    case CLASSIFICATION_TYPES.REFERENCE: {
      // Reference: don't change foreground, just log
      thread = threadId ? globalThreadManager.getThread(threadId) : null;
      break;
    }

    case CLASSIFICATION_TYPES.NEW_TOPIC:
    default: {
      // Create a new thread
      const title = extractFocusTopic
        ? _extractTitle(messageText)
        : messageText.slice(0, 60);
      const newId = globalThreadManager.createThread(title, messageText);
      thread = globalThreadManager.getThread(newId);
      break;
    }
  }

  // ── Update focus stack ──
  if (updateFocus) {
    if (type === CLASSIFICATION_TYPES.NEW_TOPIC) {
      // New topic clears focus
      if (globalFocusStack.hasFocus) {
        globalFocusStack.clear();
      }
    } else if (extractFocusTopic && thread) {
      // If a subtopic is detected within a thread, push a focus frame
      const subtopic = _detectSubtopic(messageText);
      if (subtopic) {
        const result = globalFocusStack.pushFrame(subtopic, messageText);
        if (result.success) {
          focus = result.frame;
        }
      }
    }
  }

  return { classification, thread, focus };
}

/**
 * Get thread context for injection into system prompts.
 * Returns a formatted string with thread and focus information.
 *
 * @returns {string}
 */
function getThreadContext() {
  const parts = [];

  // Thread context from ThreadManager
  const threadsInfo = globalThreadManager.getAllThreads();
  if (threadsInfo) {
    parts.push(threadsInfo);
  }

  // Focus context from FocusStack
  if (globalFocusStack.hasFocus) {
    const focusPath = globalFocusStack.getFocusPathString();
    const current = globalFocusStack.peekFrame();
    parts.push(`[Focus Path] ${focusPath}`);
    if (current && current.context) {
      parts.push(`[Current Focus] ${current.topic}: ${current.context}`);
    }
  }

  return parts.join('\n\n');
}

/**
 * Get structured thread + focus state (for API responses, debug)
 *
 * @returns {object}
 */
function getThreadState() {
  return {
    threads: globalThreadManager.listThreads(),
    foregroundThread: globalThreadManager.getForegroundThread(),
    focusStack: {
      depth: globalFocusStack.depth,
      path: globalFocusStack.getFocusPath({ includeContext: true }),
      currentFrame: globalFocusStack.peekFrame(),
    },
  };
}

/**
 * Reset all thread state
 */
function resetAll() {
  globalThreadManager.reset();
  globalFocusStack.clear();
}

// ─── Internal helpers ───

/**
 * Extract a short title from a message
 * @param {string} message
 * @returns {string}
 */
function _extractTitle(message) {
  if (!message) return 'untitled';
  // Take first sentence or first N chars
  const firstSentence = message.split(/[。！？\n.!?]/)[0] || message;
  return firstSentence.trim().slice(0, 80);
}

/**
 * Detect if a message contains a subtopic within a thread
 * Returns the subtopic string or null
 * @param {string} message
 * @returns {string|null}
 */
function _detectSubtopic(message) {
  const subtopicPatterns = [
    // Chinese: 关于X, 具体来说X, 深入X, 聚焦X
    /关于["「『]?(.+?)["」』]?(?:的|方面|问题|部分)?[,，:：]?/,
    /具体[地说来]?[,，:：]?\s*(.+?)[,，。]?$/,
    /深入[讨论聊]?[,，:：]?\s*(.+?)[,，。]?$/,
    /聚焦[于在]?\s*(.+?)[,，。]?$/,
    // English: specifically X, regarding X, dive into X, focus on X
    /(?:regarding|regarding the|about the|concerning)\s+(.+?)(?:[,.]|$)/i,
    /(?:dive (?:deeper )?into|deep dive on)\s+(.+?)(?:[,.]|$)/i,
    /(?:focus(?:ing)? on|zoom in on|drill into)\s+(.+?)(?:[,.]|$)/i,
    /(?:specifically|in particular)[,:\s]*(.+?)(?:[,.]|$)/i,
  ];

  for (const pattern of subtopicPatterns) {
    const match = message.match(pattern);
    if (match && match[1] && match[1].length < 60) {
      return match[1].trim();
    }
  }

  return null;
}

// ─── Exports ───

module.exports = {
  // Singletons
  globalThreadManager,
  globalFocusStack,

  // Core class (for testing / custom instances)
  ThreadManager,
  FocusStack,

  // Classifier
  classifyMessage,
  CLASSIFICATION_TYPES,

  // Combined API
  classifyAndRoute,
  getThreadContext,
  getThreadState,

  // Lifecycle
  resetAll,
};
