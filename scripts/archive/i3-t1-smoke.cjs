// I-3 T1: Smoke test for registerInterruptForChatStream
const { registerInterruptForChatStream } = require('../src/core/ai');
const r = registerInterruptForChatStream('smoke');
console.log('REG:', !!(r && r.signal));
if (r) r.unregister();
console.log('SMOKE OK');
