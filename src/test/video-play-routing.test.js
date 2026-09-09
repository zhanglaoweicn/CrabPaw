/**
 * 视频播放路由 + SceneMedia 契约回归测试 — 2026-08-16
 *
 * 现象：语音"播放海南旅游的视频" → 未弹视频卡片, 反而打开外部浏览器。
 * 根因（wiring 断层, 与 panel-state/车票轮同类）：
 *   1. 意图路由: "播放X视频"命中 music 裸词'播放' → 工具集无 scene
 *      → SceneMedia(唯一能创建应用内媒体卡的活工具)不可见
 *   2. SceneMedia 只收 url, AI 只有关键词没有直链 → 无法应用内播放
 *   3. LLM 退而求其次调浏览器搜索/打开 → 实机看到浏览器弹出
 * 修复: video_play 意图(pairs 复合词, '播放'+'视频' 同现命中) + SceneMedia
 *   支持 bvid 自动解析直链(media-stage-tools 同款)。
 */
const { selectToolsForContext } = require('../core/ai/tool-router');
const { sceneMedia } = require('../core/scene/scene-kinds-tool');

// bvid 解析走 mock——不真实请求 B站 API
// 注意：必须保留真实模块的注册 side-effect（BilibiliSearch/BilibiliPlay 工具注册），
// 否则生产注入链测试的活跃集里没有这两个工具。
jest.mock('../tools/bilibili-tools', () => {
  const actual = jest.requireActual('../tools/bilibili-tools');
  return {
    ...actual,
    getBilibiliPlayUrl: jest.fn(async () => ({
      bvid: 'BV1xxTEST',
      title: '海南旅游大片',
      playUrl: 'https://example.com/hainan.mp4',
      quality: '720P',
    })),
  };
});

async function route(message) {
  return selectToolsForContext({ message, channel: 'cli', toolSystem: null });
}

describe('video_play 意图路由', () => {
  test('播放X视频 → video_play, scene/media/web 工具集在列', async () => {
    const r = await route('播放海南旅游的视频');
    expect(r.intent).toBe('video_play');
    expect(r.toolsets).toContain('scene');
    expect(r.toolsets).toContain('media');
    expect(r.toolsets).toContain('web');
  });

  test('看个视频 → video_play', async () => {
    expect((await route('看个视频')).intent).toBe('video_play');
  });

  test('播放电影 → video_play（不落 music）', async () => {
    expect((await route('播放电影')).intent).toBe('video_play');
  });

  test('播放音乐不误抢 → music', async () => {
    expect((await route('播放铁血丹心')).intent).toBe('music');
  });

  test('听歌 → music', async () => {
    expect((await route('听歌')).intent).toBe('music');
  });

  test('生成视频 → video_gen（不落 video_play）', async () => {
    expect((await route('生成视频')).intent).toBe('video_gen');
  });
});

describe('SceneMedia bvid 直链解析', () => {
  const { getSceneStore } = require('../core/scene/scene-store');

  test('仅传 bvid → 解析直链并写入标题', async () => {
    const store = getSceneStore();
    const r = await sceneMedia.handler({ id: 'video_bvid_1', bvid: 'BV1xxTEST' });
    expect(r.success).toBe(true);
    const surface = store.getSurface('video_bvid_1');
    expect(surface.kind).toBe('media');
    expect(surface.data.items[0].url).toBe('https://example.com/hainan.mp4');
    expect(surface.data.items[0].title).toBe('海南旅游大片');
  });

  test('传 url → 直接用直链, 不触发 bvid 解析', async () => {
    const store = getSceneStore();
    const r = await sceneMedia.handler({ id: 'video_url_1', url: 'https://example.com/direct.mp4', title: '直链视频' });
    expect(r.success).toBe(true);
    const surface = store.getSurface('video_url_1');
    expect(surface.data.items[0].url).toBe('https://example.com/direct.mp4');
    expect(surface.data.items[0].title).toBe('直链视频');
  });

  test('url 与 bvid 均缺 → 失败并提示', async () => {
    const r = await sceneMedia.handler({ id: 'video_none_1' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('bvid');
  });

  test('audio kind → 映射为 music 类型', async () => {
    const store = getSceneStore();
    const r = await sceneMedia.handler({ id: 'video_audio_1', kind: 'audio', url: 'https://example.com/a.mp3', title: '音频' });
    expect(r.success).toBe(true);
    expect(store.getSurface('video_audio_1').data.items[0].type).toBe('music');
  });
});

// ── 生产注入链回归：scene 工具集必须进入 cli/gui 平台活跃集 ──
// 2026-08-16 实锤：意图路由正常(video_play 0.95, routed 91 工具含 SceneMedia)，
// 但 scene 工具集从未被任何平台激活 → buildToolDefinitions 交集过滤
// (活跃集 ∩ 意图路由)把 SceneMedia 滤掉 → LLM 只能回退浏览器。
// 修复: toolset-manager CORE_TOOLSETS 加 scene 定义 + PLATFORM_TOOLSETS.cli 启用。
// 注意: 此测试必须走 buildToolDefinitions 真实路径(之前测试 toolSystem:null
// 绕过了活跃集交集, 恰是漏网原因)。
describe('生产注入链：scene 工具集激活', () => {
  const { resetToolsetManager, getToolsetManager } = require('../core/toolset-manager');
  const { buildToolDefinitions } = require('../core/ai/tool-definitions');

  afterAll(() => resetToolsetManager());

  test('cli/gui 平台激活后 buildToolDefinitions 含 SceneMedia 与 BilibiliSearch', () => {
    resetToolsetManager();
    const tools = buildToolDefinitions('gui', '播放海南旅游的视频');
    const names = tools.map(t => t.function?.name || t.name);
    expect(names).toContain('SceneMedia');
    expect(names).toContain('SceneSet');
    expect(names).toContain('BilibiliSearch');
    expect(names).toContain('BilibiliPlay');
  });

  test('cli 平台工具集列表含 scene', () => {
    resetToolsetManager();
    const tsm = getToolsetManager();
    tsm.setPlatform('cli');
    expect(tsm.getPlatformToolsetNames()).toContain('scene');
  });
});
