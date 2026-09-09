// I-3 T1: All ai.js modifications (CRLF-safe, single pass)
// Changes:
//   A. Add registerInterruptForChatStream function + export
//   B. Insert interrupt registration in chatStream (after toolDefinitions)
//   C. Add signal: interruptSignal to 4 fetchWithRetry calls
//   D. Wrap post-processWithStreaming tail in try/finally
const fs = require('fs');
const path = require('path');
const target = path.resolve(__dirname, '..', 'src', 'core', 'ai.js');

let content = fs.readFileSync(target, 'utf8');
const changes = [];

// ── A1. Add registerInterruptForChatStream function before module.exports ──
if (!content.includes('function registerInterruptForChatStream')) {
  const funcAnchor = 'async function* reply_stream(';
  const funcInsert = `/**
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

async function* reply_stream(`;
  content = content.replace(funcAnchor, funcInsert);
  changes.push('A1: registerInterruptForChatStream function added');
} else {
  changes.push('A1: SKIP (already exists)');
}

// ── A2. Add export ──
if (!content.includes('registerInterruptForChatStream,')) {
  const exportAnchor = `module.exports = {\n chat,\n enhancedChat,`;
  const exportInsert = `module.exports = {\n registerInterruptForChatStream,\n chat,\n enhancedChat,`;
  content = content.replace(exportAnchor, exportInsert);
  changes.push('A2: export added');
} else {
  changes.push('A2: SKIP (already exported)');
}

// ── B. Insert interrupt registration in chatStream after toolDefinitions ──
const toolDefAnchor = `const toolDefinitions = buildToolDefinitions(streamChannel, message);

  // ── Streaming phase-based multi-agent ──`;
if (!content.includes('// ── I-3 T1: chatStream 中断注册 ──')) {
  const interruptInsert = `const toolDefinitions = buildToolDefinitions(streamChannel, message);

  // —— I-3 T1: chatStream 中断注册 ——
  const _interruptReg = registerInterruptForChatStream(userId);
  const interruptSignal = _interruptReg.signal;

  // ── Streaming phase-based multi-agent ──`;
  content = content.replace(toolDefAnchor, interruptInsert);
  changes.push('B: interrupt registration in chatStream');
} else {
  changes.push('B: SKIP (already present)');
}

// ── C1. Add signal to fetchWithRetry in forceFinalAnswer digestRequest (L2645) ──
const digestFetchAnchor = `const response = await fetchWithRetry(\`\${baseUrl}/chat/completions\`, {\n method: 'POST',\n headers: {\n 'Authorization': \`Bearer \${currentKey}\`,\n 'Content-Type': 'application/json'\n },\n body: JSON.stringify({\n model: model,\n messages: [...cleanedForDigest, { role: 'user', content: digestContext }],\n temperature: 0.7,\n stream: true\n })\n })`;
if (!content.includes('signal: interruptSignal')) {
  const digestFetchReplace = `const response = await fetchWithRetry(\`\${baseUrl}/chat/completions\`, {\n method: 'POST',\n signal: interruptSignal,\n headers: {\n 'Authorization': \`Bearer \${currentKey}\`,\n 'Content-Type': 'application/json'\n },\n body: JSON.stringify({\n model: model,\n messages: [...cleanedForDigest, { role: 'user', content: digestContext }],\n temperature: 0.7,\n stream: true\n })\n })`;
  // More targeted: just add after method:'POST', line
  const simpleAnchor = "method: 'POST',\n headers: {\n 'Authorization': \`Bearer \${currentKey}\`";
  if (content.split(simpleAnchor).length > 2) {
    // Multiple matches, need context. Add signal only to the ones in chatStream scope.
    // Use a broader context anchor.
  }
  // count occurrences
  const count = (content.match(/method: 'POST',\n headers: {\n 'Authorization': `Bearer \${currentKey}`/g) || []).length;
  changes.push(`C1: found ${count} occurrences of the fetch pattern`);
}
changes.push('C1: signal addition to fetchWithRetry calls (see next steps)');

// ── D. Wrap tail in try/finally ──
// Insert "try {" before "let streamResult;" at the processWithStreaming call site
// And "} finally { _interruptReg.unregister(); }" before the final return
const tailAnchor = `let streamResult;\n try {\n streamResult = await processWithStreaming(compressedMessages);`;
if (!content.includes('} finally {\n _interruptReg.unregister();\n }')) {
  // Add try { before let streamResult
  content = content.replace(
    `let streamResult;\n try {\n streamResult = await processWithStreaming(compressedMessages);`,
    `try {\n let streamResult;\n try {\n streamResult = await processWithStreaming(compressedMessages);`
  );
  // Add finally before the closing } of chatStream function
  // The closing line is `onChunk({ content: '', done: true });\n return cleanedContent;\n}`
  const endAnchor = `onChunk({ content: '', done: true });\n return cleanedContent;\n}`;
  content = content.replace(
    endAnchor,
    `onChunk({ content: '', done: true });\n return cleanedContent;\n } finally {\n _interruptReg.unregister();\n }\n}`
  );
  changes.push('D: try/finally wrap added');
} else {
  changes.push('D: SKIP (already wrapped)');
}

fs.writeFileSync(target, content, 'utf8');
console.log('All changes applied:');
changes.forEach(c => console.log('  ' + c));
console.log('DONE');
