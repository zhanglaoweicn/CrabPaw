const { EmbeddingPipeline, getEmbedding } = require('../../src/core/embedding-pipeline');

module.exports = {
  name: 'Embedding Pipeline',
  cases: [
    {
      id: 'ep_001',
      name: '注入 embedFn 时返回向量',
      category: 'embedding_pipeline',
      run: async () => {
        const p = new EmbeddingPipeline({ embedFn: async () => [0.1, 0.2, 0.3] });
        const v = await p.getEmbedding('测试');
        return Array.isArray(v) && v.length === 3;
      },
    },
    {
      id: 'ep_002',
      name: 'embedFn 失败返回 null（优雅降级）',
      category: 'embedding_pipeline',
      run: async () => {
        const p = new EmbeddingPipeline({ embedFn: async () => { throw new Error('API down'); } });
        const v = await p.getEmbedding('测试');
        return v === null;
      },
    },
    {
      id: 'ep_003',
      name: '同文本命中内存缓存（embedFn 只调一次）',
      category: 'embedding_pipeline',
      run: async () => {
        let calls = 0;
        const p = new EmbeddingPipeline({ embedFn: async () => { calls++; return [1]; } });
        await p.getEmbedding('同一句话');
        await p.getEmbedding('同一句话');
        return calls === 1;
      },
    },
    {
      id: 'ep_004',
      name: 'batchEmbed 并发上限与错误隔离',
      category: 'embedding_pipeline',
      run: async () => {
        let inflight = 0; let maxInflight = 0;
        const p = new EmbeddingPipeline({ embedFn: async () => { inflight++; maxInflight = Math.max(maxInflight, inflight); await new Promise(r => setTimeout(r, 10)); inflight--; return [1]; } });
        const out = await p.batchEmbed([{ id: 'a', text: 'a' }, { id: 'b', text: 'b' }, { id: 'c', text: 'c' }, { id: 'd', text: 'd' }], { concurrency: 2 });
        return out.filter(Boolean).length === 4 && maxInflight <= 2;
      },
    },
    {
      id: 'ep_005',
      name: 'embedMemory 对 null 向量不写入（不抛）',
      category: 'embedding_pipeline',
      run: async () => {
        const p = new EmbeddingPipeline({ embedFn: async () => null });
        const r = await p.embedMemory({ id: 'm1', text: 'x' });
        return r === false;
      },
    },
  ],
};
