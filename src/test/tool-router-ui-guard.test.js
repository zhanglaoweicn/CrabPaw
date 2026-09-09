/**
 * tool-router-ui-guard.test.js — UI 弹卡工具连续性注入守卫（2026-08-19）
 *
 * 现象：用户「推荐热门资讯」→ 正确路由 web_search（panel 集不可见），但近期
 * 用过热点面板后，recentTools 连续性把 ShowHotspot 无条件注回工具集 →
 * LLM 看到即弹热点卡片（用户两次反馈「搜索/资讯回复弹卡，影响体验」）。
 * 修复：连续性注入时，panel/scene（UI 弹卡）工具仅当当前意图已加载对应集才放行。
 * 本测试锁定：资讯类请求不漏弹卡工具；热搜榜等明确请求不受影响；panel/scene 精确区分。
 */
const { selectToolsForContext } = require('../core/ai/tool-router');

// 构造最小 toolSystem：panel/scene 集成员 + 常用集
const tsMap = {
  panel: [{ name: 'ShowHotspot' }, { name: 'ShowStock' }, { name: 'ShowWeather' }],
  scene: [{ name: 'SceneSet' }, { name: 'SceneClear' }, { name: 'SceneText' }],
  web: [{ name: 'WebSearch' }],
  browser: [{ name: 'BrowserControl' }],
  trending: [{ name: 'HotSearch' }],
  interaction: [{ name: 'T' }], agent: [{ name: 'A' }], file: [{ name: 'F' }],
  document: [{ name: 'D' }], memory: [{ name: 'M' }], ui: [{ name: 'U' }],
  desktop: [{ name: 'D2' }], data: [{ name: 'D3' }], network: [{ name: 'N' }],
  skills: [{ name: 'K' }], workflow: [{ name: 'W' }], stock: [{ name: 'ST' }],
  calendar: [{ name: 'C' }], reminder: [{ name: 'R' }], media: [{ name: 'ME' }],
  multimodal: [{ name: 'MM' }], travel: [{ name: 'TV' }], platform: [{ name: 'P' }],
  system: [{ name: 'SY' }], voice: [{ name: 'V' }], tick: [{ name: 'T2' }],
  tools: [{ name: 'T3' }], news: [{ name: 'N2' }], finance: [{ name: 'FI' }],
  mining: [{ name: 'MI' }], 'file-op': [{ name: 'FO' }],
};
const toolSystem = {
  getByToolset: (t) => tsMap[t] || [],
  get: (n) => ({ name: n }),
};

function route(message, opts = {}) {
  return selectToolsForContext({ message, channel: 'gui', toolSystem, ...opts });
}

function uiToolNames(r) {
  return r.tools.map((t) => t.name).filter((n) => n.startsWith('Show') || n.startsWith('Scene') || n === 'HotSearch');
}

describe('UI 弹卡守卫 — 连续性注入', () => {
  test('推荐热门资讯 + recentTools 含 ShowHotspot → 不注入（泄漏被堵）', () => {
    const r = route('推荐热门资讯', { recentTools: ['ShowHotspot', 'WebSearch'] });
    expect(r.intent).toBe('web_search');
    expect(uiToolNames(r)).toEqual([]);
  });

  test('推荐热门资讯（无 recentTools）→ panel/scene 工具均不可见', () => {
    const r = route('推荐热门资讯');
    expect(uiToolNames(r)).toEqual([]);
  });

  test('热搜榜 + recentTools 含 ShowHotspot → 正常注入（明确请求不受影响）', () => {
    const r = route('热搜榜', { recentTools: ['ShowHotspot'] });
    expect(r.intent).toBe('news');
    expect(uiToolNames(r)).toContain('ShowHotspot');
  });

  test('推荐热门资讯 + recentTools 含 HotSearch → 不注入（trending 集泄漏同样拦截）', () => {
    const r = route('推荐热门资讯', { recentTools: ['HotSearch', 'WebSearch'] });
    expect(r.intent).toBe('web_search');
    expect(r.tools.map((t) => t.name)).not.toContain('HotSearch');
  });

  test('推荐热门资讯 + recentTools 含全小写 hotsearch → 不注入（大小写归一化兜底）', () => {
    const r = route('推荐热门资讯', { recentTools: ['hotsearch'] });
    expect(r.tools.map((t) => t.name)).not.toContain('HotSearch');
  });

  test('打开百度 + recentTools 含 ShowHotspot+SceneSet → 只注入 SceneSet（panel/scene 精确区分）', () => {
    const r = route('打开百度', { recentTools: ['ShowHotspot', 'SceneSet'] });
    expect(r.intent).toBe('open_app');
    expect(uiToolNames(r)).toContain('SceneSet');
    expect(uiToolNames(r)).not.toContain('ShowHotspot');
  });

  test('打开天气 + recentTools 含 ShowWeather → 正常注入（weather 意图含 panel 集）', () => {
    const r = route('打开天气', { recentTools: ['ShowWeather'] });
    expect(uiToolNames(r)).toContain('ShowWeather');
  });
});

describe('资讯语义不落 news 意图（第二道防线）', () => {
  test('最新AI新闻 → web_search（news 的资讯词已移入 web_search）', () => {
    const r = route('最新AI新闻');
    expect(r.intent).toBe('web_search');
    expect(uiToolNames(r)).toEqual([]);
  });

  test('今天有什么头条 → web_search', () => {
    const r = route('今天有什么头条');
    expect(r.intent).toBe('web_search');
    expect(uiToolNames(r)).toEqual([]);
  });

  test('热搜榜 → news（明确榜单语义保留 panel 集）', () => {
    const r = route('热搜榜');
    expect(r.intent).toBe('news');
    expect(r.toolsets).toContain('panel');
  });

  test('今日热点排行 → news（明确榜单语义保留 panel 集）', () => {
    const r = route('今日热点排行');
    expect(r.intent).toBe('news');
    expect(r.toolsets).toContain('panel');
  });
});

describe('general/greeting 意图直通防线（2026-08-19 复现修复）', () => {
  test('推送热门消息（无关键词命中）→ general, 无弹卡工具但有 WebSearch', () => {
    const r = route('推送热门消息');
    expect(r.intent).toBe('general');
    expect(uiToolNames(r)).toEqual([]);
    expect(r.tools.map((t) => t.name)).toContain('WebSearch');
  });

  test('推送热门消息 + recentTools 含 ShowHotspot → general 无 panel 集, 泄漏仍被拦', () => {
    const r = route('推送热门消息', { recentTools: ['ShowHotspot'] });
    expect(r.intent).toBe('general');
    expect(uiToolNames(r)).toEqual([]);
  });

  test('你好，推送热门消息（多句落 greeting）→ 无弹卡工具', () => {
    const r = route('你好，推送热门消息');
    expect(r.intent).toBe('greeting');
    expect(uiToolNames(r)).toEqual([]);
    expect(r.tools.map((t) => t.name)).toContain('WebSearch');
  });

  test('热搜榜仍正常 → news 意图不受 general 收紧影响', () => {
    const r = route('热搜榜');
    expect(r.intent).toBe('news');
    expect(uiToolNames(r)).toContain('ShowHotspot');
  });
});

describe('UI 弹卡守卫 — find_tool 发现集', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.mock('../tools/find-tool', () => ({
      getRecentFoundTools: () => ['ShowHotspot'],
    }));
  });

  test('推荐热门资讯 + find_tool 发现 ShowHotspot → 不注入', () => {
    const { selectToolsForContext: sel } = require('../core/ai/tool-router');
    const r = sel({ message: '推荐热门资讯', channel: 'gui', toolSystem });
    expect(uiToolNames(r)).toEqual([]);
  });

  test('热搜榜 + find_tool 发现 ShowHotspot → 正常注入', () => {
    const { selectToolsForContext: sel } = require('../core/ai/tool-router');
    const r = sel({ message: '热搜榜', channel: 'gui', toolSystem });
    expect(uiToolNames(r)).toContain('ShowHotspot');
  });
});
