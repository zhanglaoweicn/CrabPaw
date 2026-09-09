/**
 * memoryExtraction 防自复制测试（2026-08-17）
 *
 * 根因链：历史里混入的提取指令（role=user "Extract key info..."）不得再作为
 * 提取输入——否则提取指令 → 被提取 → 新提取指令写入历史 → 指数污染。
 */

const { MemoryExtractionService } = require('../services/memoryExtraction');

describe('MemoryExtractionService._getRecentUserTurns 防自复制', () => {
  test('提取指令消息不作为提取输入', () => {
    const svc = new MemoryExtractionService();
    const conversation = [
      { role: 'user', content: 'Extract key info from this conversation turn. Return JSON array. ...' },
      { role: 'user', content: '播放铁血丹心' },
      { role: 'assistant', content: '好的。' },
      { role: 'user', content: 'Extract key info from this conversation turn. Return JSON array. ...' },
    ];
    const turns = svc._getRecentUserTurns(conversation, 3);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toBe('播放铁血丹心');
  });

  test('正常用户消息完整保留（无指令时行为不变）', () => {
    const svc = new MemoryExtractionService();
    const conversation = [
      { role: 'user', content: '我喜欢Python' },
      { role: 'assistant', content: '好的。' },
      { role: 'user', content: '帮我写个脚本' },
    ];
    const turns = svc._getRecentUserTurns(conversation, 3);
    expect(turns).toEqual(['我喜欢Python', '帮我写个脚本']);
  });

  test('全部为提取指令时返回空（不提取）', () => {
    const svc = new MemoryExtractionService();
    const conversation = [
      { role: 'user', content: 'Extract key info from this conversation turn. Return JSON array. ...' },
      { role: 'user', content: 'Extract key info from this conversation turn. Return JSON array. ...' },
    ];
    expect(svc._getRecentUserTurns(conversation, 3)).toHaveLength(0);
  });
});
