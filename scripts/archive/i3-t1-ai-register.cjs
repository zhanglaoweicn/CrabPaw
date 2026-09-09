// I-3 T1: Add registerInterruptForChatStream function before module.exports (ai.js CRLF-safe)
const fs = require('fs');
const path = require('path');
const target = path.resolve(__dirname, '..', 'src', 'core', 'ai.js');
let content = fs.readFileSync(target, 'utf8');

// ── 1. Add registerInterruptForChatStream function before module.exports ──
const funcAnchor = `\nmodule.exports = {`;
const funcInsert = `
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
          globalRequestInterrupt.unregister(userId);
        } catch (e) { console.warn('[ai] 中断注销失败:', e.message || e); }
      },
    };
  } catch (e) {
    console.warn('[ai] 中断注册失败（降级无中断）:', e.message || e);
    const ac = new AbortController();
    return { signal: ac.signal, abortController: ac, unregister() {} };
  }
}

module.exports = {`;

if (!content.includes('function registerInterruptForChatStream')) {
  content = content.replace(funcAnchor, funcInsert);
  console.log('OK: Added registerInterruptForChatStream function');
} else {
  console.log('SKIP: registerInterruptForChatStream already exists');
}

// ── 2. Add export ──
const exportAnchor = `module.exports = {\n chat,\n enhancedChat,`;
if (!content.includes('registerInterruptForChatStream,')) {
  content = content.replace(
    `module.exports = {\n chat,\n enhancedChat,`,
    `module.exports = {\n registerInterruptForChatStream,\n chat,\n enhancedChat,`
  );
  console.log('OK: Added registerInterruptForChatStream to exports');
} else {
  console.log('SKIP: export already present');
}

fs.writeFileSync(target, content, 'utf8');
console.log('DONE: ai.js updated with registerInterruptForChatStream');
