async function execute(input) {
  const content = typeof input === 'string' ? input : (input?.content || input?.text || '');
  const format = input?.format || 'tldr';
  const sentences = content.split(/[。！？\n.!?]+/).filter(s => s.trim().length > 5);
  const topN = Math.max(2, Math.min(4, Math.floor(sentences.length * 0.3)));
  const summary = sentences.slice(0, topN).map((s, i) => `${i+1}. ${s.trim()}`).join('\n');
  return { success: true, summary, format, originalLength: content.length, sentenceCount: sentences.length, message: `${format} 摘要完成（${content.length}字→${topN}句）` };
}
const schema = {
  name: 'summarize-pro', description: '文本摘要引擎', capabilities: ['content_summarization'],
  input: { content: { type: 'string' }, format: { type: 'string', enum: ['tldr','bullets','executive','eli5'] } },
  output: { summary: { type: 'string' } },
};
module.exports = { execute, schema };
