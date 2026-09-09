const { TopicIndex } = require('../../src/core/memory/topic-index');

module.exports = {
  name: 'Topic Index',
  cases: [
    {
      id: 'ti_001',
      name: '同话题记忆聚类（关键词重叠）',
      category: 'topic_index',
      run: () => {
        const idx = new TopicIndex();
        const r = idx.indexMemories([
          { id: 'a', content: '供应链分析：上海供应商报价' },
          { id: 'b', content: '供应链风险：双供应商策略' },
          { id: 'c', content: '今天天气不错' },
        ]);
        return r.topics.some((t) => t.memoryIds.includes('a') && t.memoryIds.includes('b')) && !r.topics.some((t) => t.memoryIds.includes('c'));
      },
    },
    {
      id: 'ti_002',
      name: '话题检索命中标题关键词',
      category: 'topic_index',
      run: () => {
        const idx = new TopicIndex();
        idx.indexMemories([{ id: 'a', content: '融资方案：天使轮估值模型' }]);
        const hits = idx.searchTopics('上次那个融资方案');
        return hits.length > 0 && hits[0].score > 0.5;
      },
    },
    {
      id: 'ti_003',
      name: '空输入优雅返回',
      category: 'topic_index',
      run: () => {
        const idx = new TopicIndex();
        return idx.searchTopics('').length === 0 && idx.indexMemories([]).topics.length === 0;
      },
    },
    {
      id: 'ti_004',
      name: '话题标题可读（取最高频关键词）',
      category: 'topic_index',
      run: () => {
        const idx = new TopicIndex();
        const r = idx.indexMemories([{ id: 'a', content: '合同到期提醒：供应商合同' }, { id: 'b', content: '合同续约：明年三月' }]);
        return r.topics[0].title.includes('合同');
      },
    },
    {
      id: 'ti_005',
      name: 'getMemoriesForTopic 返回完整记忆列表',
      category: 'topic_index',
      run: () => {
        const idx = new TopicIndex();
        const r = idx.indexMemories([{ id: 'a', content: '库存盘点' }, { id: 'b', content: '库存补货' }]);
        const topic = r.topics[0];
        return idx.getMemoriesForTopic(topic.id).length === 2;
      },
    },
  ],
};
