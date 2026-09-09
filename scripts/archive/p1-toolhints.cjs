/**
 * P1 一次性脚本：ai.js 全部工具状态 chunk → thinking 类型
 * 处理所有 onChunk({ content: <工具状态文案> }) 调用点（⏳/✅/❌/⚠️ 开头），
 * 转换为 onChunk({ type: 'thinking', content: <去掉前导空白> })。
 * 不进主回复流 → 不再被 TTS 朗读 / 进对话卡 / 流式气泡。
 */
const fs = require('fs');
let src = fs.readFileSync('src/core/ai.js', 'utf8');
let count = 0;

// 逐个定位 onChunk({ content: `...` , done: false }) 调用并判断内容
const re = /onChunk\(\{\s*content:\s*`((?:[^`\\]|\\.)*)`\s*,\s*done:\s*false\s*\}\)/g;
let m;
const replaced = [];
while ((m = re.exec(src)) !== null) {
  const full = m[0];
  const body = m[1];
  // 剥掉字面 \n（模板串里的转义）
  const text = body.replace(/\\n/g, '').replace(/\n/g, '').trim();
  if (/^[⏳✅❌⚠️]/.test(text)) {
    const newCall = `onChunk({ type: 'thinking', content: \`${text}\` })`;
    src = src.slice(0, m.index) + newCall + src.slice(m.index + full.length);
    re.lastIndex = m.index + newCall.length;
    replaced.push(`${text.slice(0, 40)}`);
    count++;
  }
}

fs.writeFileSync('src/core/ai.js', src);
console.log('转换:', count, '处');
replaced.forEach(r => console.log(' -', r));
