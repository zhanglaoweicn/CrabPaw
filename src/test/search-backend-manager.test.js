/**
 * 2026-08-31 回归: SearchBackendManager.syncCredentials 缺失 + web-tools 不读 config 密钥
 *   T1 getSearchManager 不再抛 TypeError(此前 syncCredentials is not a function → 网络搜索恒失败)
 *   T2 syncCredentials 用 config 值注册/更新前端后端(复用 K, 不重复注册)
 */
process.env.BAIDU_API_KEY = ''; // 隔离环境变量——确保测试走 syncCredentials/config 路径
const baiduKey = `bce-v3/test-${Date.now()}`;

test('T1 web-tools.getSearchManager 不再抛错并返回实例', () => {
  const { getSearchManager } = require('../tools/web-tools');
  let m = null;
  expect(() => { m = getSearchManager(); }).not.toThrow();
  expect(m).toBeTruthy();
  expect(typeof m.search).toBe('function');
});

test('T2 syncCredentials 注册并复用百后端(不重复)', () => {
  const { SearchBackendManager } = require('../core/search');
  const { getSearchManager } = require('../tools/web-tools');
  const manager = getSearchManager();
  manager.unregister('baidu_api'); // 清场——确保注册来自 syncCredentials
  expect(() => {
    SearchBackendManager.syncCredentials({ baiduKey, tavilyKey: '', bingKey: '', braveKey: '', exaKey: '' });
  }).not.toThrow();
  const be = manager.getBackend('baidu_api');
  expect(be).toBeTruthy();
  expect(be.apiKey).toBe(baiduKey);
  // 再次调用——复用而非重复注册(数量不变)
  SearchBackendManager.syncCredentials({ baiduKey: `${baiduKey}-v2` });
  expect(manager.getBackend('baidu_api').apiKey).toBe(`${baiduKey}-v2`);
});

// ─── 2026-09-06: detectScenario 中文新闻场景修复 ───
// 旧写法 \b(新闻|最新|...)\b 对纯中文永不命中（JS \b 只认 ASCII 词字符）→
// "最新AI资讯"恒落 chinese → 千帆 search_mode=normal，新闻时效排序失效。
test('T3 纯中文资讯类查询命中 news 场景（\b 中文缺陷回归）', () => {
  const { SearchBackendManager } = require('../core/search');
  const m = new SearchBackendManager({});
  for (const q of ['最新AI资讯', '推荐最新的AI资讯', 'AI 资讯', '今天科技新闻', '行业热点', 'AI大模型动态', '昨日快讯', '头条要闻']) {
    expect(m.detectScenario(q)).toBe('news');
  }
});

test('T4 英文词维持 \b 边界语义', () => {
  const { SearchBackendManager } = require('../core/search');
  const m = new SearchBackendManager({});
  expect(m.detectScenario('latest AI news')).toBe('news');
  expect(m.detectScenario('breaking news today')).toBe('news');
  // 无场景词的中文查询 → chinese（不误入 news；技术/学术行的中文词同病未修，
  // "怎么"等仍不命中——本轮只修 news 行，见 search-backend-manager.js 注释）
  expect(m.detectScenario('怎么用python读写文件')).toBe('chinese');
  expect(m.detectScenario('帮我写首诗')).toBe('chinese');
  // 英文技术词 \b 语义不变
  expect(m.detectScenario('how to use async await')).toBe('technical');
});
