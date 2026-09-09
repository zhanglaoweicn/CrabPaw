/**
 * Bilibili 工具解析回归测试 — 2026-08-16
 *
 * 现象：语音"播放三亚旅游攻略的视频" → 意图对(video_play 0.95)、SceneMedia 可见
 * （scene 工具集激活修复后），但 BilibiliSearch 永远返回"未找到相关视频"（5 行
 * 109 字符）→ LLM 拿不到 bvid → 无法调 SceneMedia → 卡片不弹。
 * 根因：search/all/v2 返回的分区字段是 `result_type`（实测 video 分区 20 条），
 * 代码误判不存在的 `module_type` → videoResults 恒空。
 * 连带：duration 是 "mm:ss" 字符串，按秒格式化得 "NaN:NaN"。
 */

const { handleBilibiliSearch } = require('../tools/bilibili-tools');

// 模拟 B站 search/all/v2 响应（真实结构：result[] 含 result_type 分区）
const MOCK_API_RESPONSE = {
  code: 0,
  data: {
    result: [
      { result_type: 'esports', data: [] },
      {
        result_type: 'video',
        data: [
          { bvid: 'BV1TEST1', title: '<em>三亚</em>攻略一', author: 'UP主甲', play: 164000, duration: '13:48', pic: '//i0.hdslb.com/1.jpg' },
          { bvid: 'BV1TEST2', title: '三亚攻略二', author: 'UP主乙', play: 69000, duration: '10:02', pic: '//i0.hdslb.com/2.jpg' },
        ],
      },
      { result_type: 'bili_user', data: [{ mid: '1' }] },
    ],
  },
};

let originalFetch;
beforeAll(() => {
  originalFetch = global.fetch;
  global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => MOCK_API_RESPONSE }));
});
afterAll(() => {
  global.fetch = originalFetch;
});

describe('BilibiliSearch 结果解析', () => {
  test('result_type 分区解析 → 返回视频列表含 bvid', async () => {
    const r = await handleBilibiliSearch({ keyword: '三亚旅游攻略' });
    expect(r.ok).toBe(true);
    expect(r.total).toBe(2);
    expect(r.results[0].bvid).toBe('BV1TEST1');
    expect(r.results[1].bvid).toBe('BV1TEST2');
  });

  test('返回 hint 引导 SceneMedia 应用内播放', async () => {
    const r = await handleBilibiliSearch({ keyword: '三亚旅游攻略' });
    expect(r.hint).toContain('SceneMedia(id="video_1", bvid="BV1TEST1"');
  });

  test('duration "mm:ss" 字符串原样保留（不产出 NaN:NaN）', async () => {
    const r = await handleBilibiliSearch({ keyword: '三亚旅游攻略' });
    expect(r.results[0].duration).toBe('13:48');
    expect(r.results[0].duration).not.toContain('NaN');
  });

  test('标题去除 em 标签', async () => {
    const r = await handleBilibiliSearch({ keyword: '三亚旅游攻略' });
    expect(r.results[0].title).toBe('三亚攻略一');
  });

  test('无 keyword → 报错', async () => {
    const r = await handleBilibiliSearch({});
    expect(r.ok).toBe(false);
    expect(r.error).toContain('关键词');
  });
});
