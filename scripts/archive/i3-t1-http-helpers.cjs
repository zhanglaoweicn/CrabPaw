// I-3 T1: Modify fetchWithRetry to combine external signal with timeout signal
const fs = require('fs');
const path = require('path');
const target = path.resolve(__dirname, '..', 'src', 'core', 'ai', 'http-helpers.js');

let content = fs.readFileSync(target, 'utf8');
// Normalize line endings
const hasCRLF = content.includes('\r\n');
content = content.replace(/\r\n/g, '\n');

const applied = [];

// Replace the core fetch logic to combine signals
const oldBlock = `      const controller = new AbortController();
      const timeout = options.timeout || 60000;
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });`;

const newBlock = `      const controller = new AbortController();
      const timeout = options.timeout || 60000;
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      // I-3 T1: 组合外部 signal 与超时 signal（Node 24 AbortSignal.any）
      const effectiveSignal = options.signal
        ? AbortSignal.any([controller.signal, options.signal])
        : controller.signal;

      const response = await fetch(url, {
        ...options,
        signal: effectiveSignal
      });`;

if (content.includes(oldBlock)) {
  content = content.replace(oldBlock, newBlock);
  applied.push('signal combination added');
} else {
  applied.push('SKIP: anchor not found');
}

// Add external-signal abort check to prevent retry when user interrupted
// After `lastError = error;` and before `if (attempt < maxRetries ...)`
const retryBlock = `      lastError = error;

      if (attempt < maxRetries && isRetryableError(error)) {`;

const retryReplacement = `      lastError = error;

      // I-3 T1: 外部中断不重试
      if (options.signal?.aborted) {
        console.log('🛑 [fetchWithRetry] 外部中断，跳过重试');
        throw error;
      }

      if (attempt < maxRetries && isRetryableError(error)) {`;

if (content.includes(retryBlock) && !content.includes('外部中断不重试')) {
  content = content.replace(retryBlock, retryReplacement);
  applied.push('external abort skip-retry added');
} else {
  applied.push('SKIP: retry guard already present or anchor not found');
}

const output = hasCRLF ? content.replace(/\n/g, '\r\n') : content;
fs.writeFileSync(target, output, 'utf8');

console.log('=== Changes applied to http-helpers.js ===');
applied.forEach(a => console.log('  ' + a));
console.log('DONE');
