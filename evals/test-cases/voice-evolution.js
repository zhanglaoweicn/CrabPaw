const { resolveRefinedText, getCachedRefinement, saveCachedRefinement, recognizeScene } = require('../../src/core/voice-evolution');

module.exports = {
  name: 'Voice Evolution Wiring',
  cases: [
    {
      id: 've_001',
      name: 'recognizeScene classifies weather text',
      category: 'voice',
      run: () => recognizeScene('今天天气怎么样') === 'weather',
    },
    {
      id: 've_002',
      name: 'saveCachedRefinement then resolveRefinedText returns refined',
      category: 'voice',
      run: () => {
        saveCachedRefinement('测试原始文本ABC', '测试提炼文本ABC', 5);
        return resolveRefinedText('测试原始文本ABC') === '测试提炼文本ABC';
      },
    },
    {
      id: 've_003',
      name: 'resolveRefinedText returns original on cache miss',
      category: 'voice',
      run: () => resolveRefinedText('没有缓存的文本XYZ') === '没有缓存的文本XYZ',
    },
    {
      id: 've_004',
      name: 'allowRefine=false forces original text',
      category: 'voice',
      run: () => resolveRefinedText('测试原始文本ABC', { allowRefine: false }) === '测试原始文本ABC',
    },
    {
      id: 've_005',
      name: 'TTS 端点已接线 resolveRefinedText（Task 6 后位于 local-handlers/voice-tts.js）',
      category: 'voice',
      run: () => {
        const fs = require('fs');
        const path = require('path');
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'handlers', 'local-handlers', 'voice-tts.js'), 'utf-8');
        // 所有 resolveRefinedText 调用（handleVoiceTTS / handleVoiceTTSStream / handleVoiceTTSStreamGet 各一）
        const resolveCount = (src.match(/resolveRefinedText\(/g) || []).length;
        // 所有 synthesize/synthesizeStream 调用均使用 ttsText 变量
        const usesTtsText = /synthesizeStream\(ttsText|synthesize\(ttsText/.test(src);
        // 不应存在 synthesize(body.text) 或 synthesizeStream(body.text)
        const usesBodyText = /synthesize\(body\.text|synthesizeStream\(body\.text/.test(src);
        return resolveCount >= 2 && usesTtsText && !usesBodyText;
      },
    },
  ],
};
