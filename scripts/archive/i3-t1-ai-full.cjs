// I-3 T1: Full ai.js modifications (CRLF-safe)
// Normalizes to \n for editing, then writes back with \r\n
const fs = require('fs');
const path = require('path');
const target = path.resolve(__dirname, '..', 'src', 'core', 'ai.js');

// Read raw, normalize to LF for reliable matching
const raw = fs.readFileSync(target, 'utf8');
const hasCRLF = raw.includes('\r\n');
let content = raw.replace(/\r\n/g, '\n');

const applied = [];

// ═══ A: Add registerInterruptForChatStream function before reply_stream ═══
const aMarker = '\nasync function* reply_stream(';
if (!content.includes('function registerInterruptForChatStream')) {
  const aCode = `
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

async function* reply_stream(`;
  content = content.replace(aMarker, aCode);
  applied.push('A: registerInterruptForChatStream function');
} else {
  applied.push('A: SKIP (exists)');
}

// ═══ B: Add export ═══
if (!content.includes('\n registerInterruptForChatStream,')) {
  const bMarker = 'module.exports = {\n chat,\n enhancedChat,';
  const bReplace = 'module.exports = {\n registerInterruptForChatStream,\n chat,\n enhancedChat,';
  content = content.replace(bMarker, bReplace);
  applied.push('B: export added');
} else {
  applied.push('B: SKIP (export exists)');
}

// ═══ C: Insert interrupt registration in chatStream after toolDefinitions ═══
const cMarker = `const toolDefinitions = buildToolDefinitions(streamChannel, message);

  // ── Streaming phase-based multi-agent ──`;
if (!content.includes('// —— I-3 T1: chatStream 中断注册 ——')) {
  const cReplace = `const toolDefinitions = buildToolDefinitions(streamChannel, message);

  // —— I-3 T1: chatStream 中断注册 ——
  const _interruptReg = registerInterruptForChatStream(userId);
  const interruptSignal = _interruptReg.signal;

  // ── Streaming phase-based multi-agent ──`;
  content = content.replace(cMarker, cReplace);
  applied.push('C: interrupt registration in chatStream');
} else {
  applied.push('C: SKIP (already registered)');
}

// ═══ D: Add signal to 4 fetchWithRetry calls ═══
// Each call has unique context; add `signal: interruptSignal,` after `method: 'POST',`

// D1: digestRequest in forceFinalAnswer (cleanedForDigest)
let d1Marker = `method: 'POST',
 headers: {
 'Authorization': \`Bearer \${currentKey}\`,
 'Content-Type': 'application/json'
 },
 body: JSON.stringify({
 model: model,
 messages: [...cleanedForDigest`;
let d1Replace = `method: 'POST',
 signal: interruptSignal,
 headers: {
 'Authorization': \`Bearer \${currentKey}\`,
 'Content-Type': 'application/json'
 },
 body: JSON.stringify({
 model: model,
 messages: [...cleanedForDigest`;
if (content.includes(d1Marker) && !content.includes("signal: interruptSignal,\n headers: {\n 'Authorization': `Bearer ${currentKey}`")) {
  content = content.replace(d1Marker, d1Replace);
  applied.push('D1: signal added to digestRequest fetch');
} else {
  applied.push('D1: SKIP');
}

// D2: execRequest in forceFinalAnswer (cleanedMessages, failureSummary)
let d2Marker = `model: model,
 messages: [...cleanedMessages, { role: 'user', content: \`请根据以上已获取的信息`;
// Find the matching fetchWithRetry that contains cleanedMessages + failureSummary
// It's preceded by method:'POST' with currentKey
let d2FullMarker = `method: 'POST',
 headers: {
 'Authorization': \`Bearer \${currentKey}\`,
 'Content-Type': 'application/json'
 },
 body: JSON.stringify({
 model: model,
 messages: [...cleanedMessages, { role: 'user', content: \`请根据以上已获取的信息，直接给出完整回答。`;
let d2FullReplace = `method: 'POST',
 signal: interruptSignal,
 headers: {
 'Authorization': \`Bearer \${currentKey}\`,
 'Content-Type': 'application/json'
 },
 body: JSON.stringify({
 model: model,
 messages: [...cleanedMessages, { role: 'user', content: \`请根据以上已获取的信息，直接给出完整回答。`;
if (content.includes(d2FullMarker) && !content.includes(d2FullReplace)) {
  content = content.replace(d2FullMarker, d2FullReplace);
  applied.push('D2: signal added to execRequest fetch');
} else {
  applied.push('D2: SKIP');
}

// D3: executeWithApiKeyRotation path in processWithStreaming (requestBodyBase, currentKey)
let d3Marker = `execute: async (currentKey) => {
 const response = await fetchWithRetry(\`\${baseUrl}/chat/completions\`, {
 method: 'POST',
 headers: {
 'Authorization': \`Bearer \${currentKey}\`,
 'Content-Type': 'application/json'
 },
 body: JSON.stringify(requestBodyBase)
 });`;
let d3Replace = `execute: async (currentKey) => {
 const response = await fetchWithRetry(\`\${baseUrl}/chat/completions\`, {
 method: 'POST',
 signal: interruptSignal,
 headers: {
 'Authorization': \`Bearer \${currentKey}\`,
 'Content-Type': 'application/json'
 },
 body: JSON.stringify(requestBodyBase)
 });`;
// This pattern appears twice - once for the key rotation path and once possibly elsewhere.
// But requestBodyBase uniquely identifies chatStream
if (content.includes(d3Marker)) {
  content = content.replace(d3Marker, d3Replace);
  applied.push('D3: signal added to key-rotation fetch');
} else {
  applied.push('D3: SKIP (not found)');
}

// D4: direct path in processWithStreaming (requestBodyBase, apiKey)
let d4Marker = `resp = await fetchWithRetry(\`\${baseUrl}/chat/completions\`, {
 method: 'POST',
 headers: {
 'Authorization': \`Bearer \${apiKey}\`,
 'Content-Type': 'application/json'
 },
 body: JSON.stringify(requestBodyBase)
 });`;
let d4Replace = `resp = await fetchWithRetry(\`\${baseUrl}/chat/completions\`, {
 method: 'POST',
 signal: interruptSignal,
 headers: {
 'Authorization': \`Bearer \${apiKey}\`,
 'Content-Type': 'application/json'
 },
 body: JSON.stringify(requestBodyBase)
 });`;
if (content.includes(d4Marker)) {
  content = content.replace(d4Marker, d4Replace);
  applied.push('D4: signal added to direct fetch');
} else {
  applied.push('D4: SKIP (not found)');
}

// ═══ E: Wrap post-processWithStreaming tail in try/finally ═══
// Insert outer try { before `let streamResult;` and } finally { unregister } before end of chatStream

// E1: Wrap the processWithStreaming + post-processing in try/finally
// The catch block at L3617-3621 has a return - finally will cover it
// The tail from L3614 to L4007 needs wrapping

// Add try { before "let streamResult;"
const e1Marker = `let streamResult;\n try {\n streamResult = await processWithStreaming(compressedMessages);`;
if (!content.includes('} finally {\n _interruptReg.unregister();\n }')) {
  content = content.replace(e1Marker, `try {\n let streamResult;\n try {\n streamResult = await processWithStreaming(compressedMessages);`);
  applied.push('E1: opening try { added');
} else {
  applied.push('E1: SKIP (already wrapped)');
}

// E2: Add finally before closing of chatStream function
// The end of chatStream is:  `onChunk({ content: '', done: true });\n return cleanedContent;\n}\n\nasync function* reply_stream(`
// But wait, since we inserted registerInterruptForChatStream before reply_stream,
// the anchor has changed. Let me anchor on the return + closing brace of chatStream.
const e2Marker = `onChunk({ content: '', done: true });\n return cleanedContent;\n}`;
if (content.includes(e2Marker)) {
  content = content.replace(e2Marker, `onChunk({ content: '', done: true });\n return cleanedContent;\n } finally {\n _interruptReg.unregister();\n }\n}`);
  applied.push('E2: finally block added');
} else {
  applied.push('E2: SKIP (finally not found for wrapping)');
}

// Write back preserving original line ending style
const output = hasCRLF ? content.replace(/\n/g, '\r\n') : content;
fs.writeFileSync(target, output, 'utf8');

console.log('=== Changes applied to ai.js ===');
applied.forEach(a => console.log('  ' + a));
console.log('DONE');
