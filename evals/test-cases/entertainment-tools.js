/**
 * Entertainment Tools — eval test cases
 * B站搜索/直链解析、降级路径（mock fetcher，不触网）
 */
const { handleBilibiliSearch, handleBilibiliPlay, resolvePlayUrl, getBilibiliPlayUrl } = require('../../src/tools/bilibili-tools');

function makeFakeFetch(map) {
  return async (url) => {
    for (const [pattern, body] of map) {
      if (String(url).includes(pattern)) {
        return { ok: true, json: async () => body };
      }
    }
    return { ok: false, json: async () => ({ code: -1 }) };
  };
}

module.exports = {
  name: 'Entertainment Tools',
  cases: [
    {
      id: 'ent_001',
      name: 'resolvePlayUrl returns direct link for qn=64',
      category: 'entertainment',
      run: async () => {
        const fake = makeFakeFetch([[
          'qn=64',
          { code: 0, data: { durl: [{ url: 'https://upos-sz-mirror.bilivideo.com/direct.mp4' }] } },
        ]]);
        const r = await resolvePlayUrl('BV1GJ411x7', '12345', fake);
        return r && r.url.includes('bilivideo.com') && r.quality === '480p';
      },
    },
    {
      id: 'ent_002',
      name: 'resolvePlayUrl falls back qn=64 → qn=32',
      category: 'entertainment',
      run: async () => {
        const fake = makeFakeFetch([
          ['qn=64', { code: -404, data: null }],
          ['qn=32', { code: 0, data: { durl: [{ url: 'https://upos-sz-mirror.bilivideo.com/low.mp4' }] } }],
        ]);
        const r = await resolvePlayUrl('BV1GJ411x7', '12345', fake);
        return r && r.quality === '360p';
      },
    },
    {
      id: 'ent_003',
      name: 'resolvePlayUrl returns null when all fail',
      category: 'entertainment',
      run: async () => {
        const fake = makeFakeFetch([]);
        const r = await resolvePlayUrl('BV1GJ411x7', '12345', fake);
        return r === null;
      },
    },
    {
      id: 'ent_004',
      name: 'getBilibiliPlayUrl includes playUrl when resolvable',
      category: 'entertainment',
      run: async () => {
        const fake = makeFakeFetch([
          ['x/web-interface/view', { code: 0, data: { bvid: 'BV1GJ411x7', title: '测试', cid: 999, owner: { name: 'up' }, pic: '', duration: 60 } }],
          ['qn=64', { code: 0, data: { durl: [{ url: 'https://upos.direct.mp4' }] } }],
        ]);
        const v = await getBilibiliPlayUrl('BV1GJ411x7', fake);
        return v.playUrl !== null && v.title === '测试';
      },
    },
    {
      id: 'ent_005',
      name: 'BilibiliPlay returns playUrl field in tool result',
      category: 'entertainment',
      run: async () => {
        const fake = makeFakeFetch([
          ['x/web-interface/view', { code: 0, data: { bvid: 'BV1GJ411x7', title: '测试', cid: 999, owner: { name: 'up' }, pic: '', duration: 60 } }],
          ['qn=64', { code: 0, data: { durl: [{ url: 'https://upos.direct.mp4' }] } }],
        ]);
        // 临时替换全局 fetch（用例内同步完成，无并发冲突——其他用例不依赖 fetch）
        const orig = global.fetch;
        global.fetch = fake;
        try {
          const r = await handleBilibiliPlay({ bvid: 'BV1GJ411x7' });
          return r.ok && typeof r.playUrl === 'string';
        } finally {
          global.fetch = orig;
        }
      },
    },
  ],
};
