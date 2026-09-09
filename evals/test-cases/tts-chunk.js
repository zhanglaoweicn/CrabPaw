const { chunkText, extractSpeechContent } = require('../../src/core/tts/index');

module.exports = {
  name: 'TTS Chunk',
  cases: [
    {
      id: 'tc_001',
      name: '按句边界切分',
      category: 'tts_chunk',
      run: () => {
        const chunks = chunkText('第一句。第二句！第三句？', { maxLength: 5 });
        return chunks.length === 3 && chunks[0] === '第一句。';
      },
    },
    {
      id: 'tc_002',
      name: '单句超长按逗号再切',
      category: 'tts_chunk',
      run: () => {
        const chunks = chunkText('今天天气很好，适合外出，记得带伞。', { maxLength: 8 });
        return chunks.length >= 3 && chunks.every((c) => c.length <= 10);
      },
    },
    {
      id: 'tc_003',
      name: '无标点硬切不丢字',
      category: 'tts_chunk',
      run: () => {
        const chunks = chunkText('一二三四五六七八九十', { maxLength: 4 });
        return chunks.join('') === '一二三四五六七八九十';
      },
    },
    {
      id: 'tc_004',
      name: 'extractSpeechContent 超长带尾注',
      category: 'tts_chunk',
      run: () => {
        const long = '第一段内容。'.repeat(50);
        const r = extractSpeechContent(long, { maxLength: 100 });
        return r.includes('完整内容已显示在屏幕上') && r.length < long.length;
      },
    },
    {
      id: 'tc_005',
      name: '短文本不加尾注且原样返回',
      category: 'tts_chunk',
      run: () => {
        const short = '简短内容。';
        const r = extractSpeechContent(short, { maxLength: 2000 });
        return r === short;
      },
    },
  ],
};
