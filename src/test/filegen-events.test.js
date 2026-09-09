/**
 * filegen-events.test.js — 文件生成事件模块（2026-08-17）
 * mock sse-broadcast 与 scene-store，锁定 4 类事件按序广播 + surface 快照驱动。
 */
jest.mock('../core/sse-broadcast', () => ({
  broadcastEvent: jest.fn(),
}));
jest.mock('../core/scene/scene-store', () => {
  // 稳定单例 store（同真实 scene-store 的 getSceneStore 语义）——
  // 每次调用都返回新对象会让 upsertSurface 调用计数无法被观察到（brief 原 mock 缺陷）。
  const mockStore = { upsertSurface: jest.fn() };
  return { getSceneStore: jest.fn(() => mockStore) };
});
// 2026-08-17 I1: mock panel-state——锁定 startFileGen 写入 open 侧（此前仅测试有 setPanelState 调用）
// 2026-08-17 final-review: setPanelState 落地到 mockPanelStates 迷你状态表,
// getEffectiveState 读同表——锁定 doneFileGen 写入 open 后 AI 上下文可查询到 'open'
const mockPanelStates = {};
jest.mock('../core/panel-state', () => ({
  SURFACE_PANEL_MAP: { 'file-panel': 'filegen' },
  setPanelState: jest.fn((panel, state) => { mockPanelStates[panel] = state; }),
  getEffectiveState: jest.fn((panel) => mockPanelStates[panel] ?? null),
}));

const { broadcastEvent } = require('../core/sse-broadcast');
const { getSceneStore } = require('../core/scene/scene-store');
const { startFileGen, ensureFileGenTask, phaseFileGen, doneFileGen, failFileGen, sourceFileGen, getFileGenStatus, formatFromPath, previewUrlFor, FILE_PANEL_SURFACE } = require('../core/filegen-events');

beforeEach(() => { jest.clearAllMocks(); });

describe('filegen-events 广播序列', () => {
  test('start→phase→done 按序广播且携带契约字段', () => {
    startFileGen('filegen-1', { title: '测试文章', format: 'md' });
    expect(broadcastEvent).toHaveBeenCalledWith('filegen:start', { taskId: 'filegen-1', title: '测试文章', format: 'md' });
    phaseFileGen('filegen-1', 'writing', '正在撰写…');
    expect(broadcastEvent).toHaveBeenCalledWith('filegen:phase', { taskId: 'filegen-1', phase: 'writing', label: '正在撰写…' });
    doneFileGen('filegen-1', { path: 'D:/x/a.md', name: 'a.md', size: 10, format: 'md', url: null });
    expect(broadcastEvent).toHaveBeenCalledWith('filegen:done', { taskId: 'filegen-1', file: expect.objectContaining({ name: 'a.md', format: 'md' }), files: expect.any(Array) });
  });

  test('每步均 upsertSurface 打开/刷新 file-panel', () => {
    startFileGen('filegen-2', { title: 'T', format: 'html' });
    const upsert = getSceneStore().upsertSurface;
    expect(upsert).toHaveBeenCalledTimes(1);
    const [id, payload] = upsert.mock.calls[0];
    expect(id).toBe(FILE_PANEL_SURFACE);
    expect(payload.kind).toBe('file-panel');
    expect(payload.data.phase).toBe('collect');
    phaseFileGen('filegen-2', 'converting', '转 HTML…');
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls[1][1].data.phase).toBe('converting');
  });

  test('error 广播携带 message 且状态可查询', () => {
    startFileGen('filegen-3', { title: 'T', format: 'pdf' });
    failFileGen('filegen-3', 'python 转换失败');
    expect(broadcastEvent).toHaveBeenCalledWith('filegen:error', { taskId: 'filegen-3', message: 'python 转换失败' });
    const st = getFileGenStatus();
    expect(st.phase).toBe('error');
    expect(st.error).toBe('python 转换失败');
  });

  test('新任务顶掉旧任务（覆盖语义）', () => {
    startFileGen('filegen-4', { title: '旧', format: 'md' });
    startFileGen('filegen-5', { title: '新', format: 'html' });
    const st = getFileGenStatus();
    expect(st.taskId).toBe('filegen-5');
    expect(st.title).toBe('新');
  });

  // 2026-08-17 I1: 打开时刻写入 panel-state open——AI 上下文"面板已打开"感知链
  // （closed 侧由 FileGenPanel handleClose 经 /api/scene/panel-state 写入，key 同为 'filegen'）
  test('startFileGen 写入 panel-state open（SURFACE_PANEL_MAP file-panel→filegen）', () => {
    const { setPanelState } = require('../core/panel-state');
    startFileGen('filegen-6', { title: 'T', format: 'md' });
    expect(setPanelState).toHaveBeenCalledWith('filegen', 'open');
  });

  test('panel-state 写入自身失败不阻塞广播/任务态（I1 隔离）', () => {
    const { setPanelState } = require('../core/panel-state');
    setPanelState.mockImplementation(() => { throw new Error('panel-state 爆炸'); });
    startFileGen('filegen-7', { title: 'T', format: 'md' });
    expect(broadcastEvent).toHaveBeenCalledWith('filegen:start', expect.objectContaining({ taskId: 'filegen-7' }));
    expect(getFileGenStatus().taskId).toBe('filegen-7');
  });

  test('formatFromPath 按扩展名映射', () => {
    expect(formatFromPath('a.md')).toBe('md');
    expect(formatFromPath('a.HTML')).toBe('html');
    expect(formatFromPath('a.docx')).toBe('docx');
    expect(formatFromPath('a.xlsx')).toBe('xlsx');
    expect(formatFromPath('a.pptx')).toBe('pptx');
    expect(formatFromPath('a.pdf')).toBe('pdf');
    expect(formatFromPath('a.txt')).toBe('txt');
    expect(formatFromPath('a.py')).toBe('code');
    expect(formatFromPath('a.js')).toBe('code');
  });

  test('previewUrlFor 仅 DATA_DIR 与 backend data/workspace 内 md/html 产出 local:// 地址', () => {
    expect(previewUrlFor('html', 'D:/bossagent/data/.crabpaw/out.html')).toBe('local:///D:/bossagent/data/.crabpaw/out.html');
    expect(previewUrlFor('docx', 'D:/bossagent/data/.crabpaw/a.docx')).toBeNull();
    expect(previewUrlFor('html', 'C:/outside/out.html')).toBeNull();
    // 2026-08-18 实机修复: backend data/workspace（Write 指引落盘目录）必须放行——
    // 此前只认 DATA_DIR 前缀 → iframe 恒不渲染
    expect(previewUrlFor('html', 'D:/bossagent/data/workspace/deepseek-intro.html')).toBe('local:///D:/bossagent/data/workspace/deepseek-intro.html');
    expect(previewUrlFor('md', 'D:/bossagent/data/workspace/a.md')).toBe('local:///D:/bossagent/data/workspace/a.md');
    expect(previewUrlFor('html', 'D:/bossagent/data/workspace-other/out.html')).toBeNull();
  });

  // 2026-08-17: 四步流程可视化基础——生成意图请求开始（资料搜集）与工具插桩共用
  describe('ensureFileGenTask 惰性任务保障', () => {
    // 前组测试残留模块级 currentTask（collect 态）——消化为 done，确保"新建"语义
    // R2-4: 新语义下 done 任务 5 分钟窗口内复用——"消化为 done"不足以恢复新建语义，
    // 追加强制窗口过期（startedAt 提前 6 分钟），保持本组"新建任务"前置条件
    beforeEach(() => {
      jest.clearAllMocks();
      const st = getFileGenStatus();
      if (st && st.phase !== 'done') {
        doneFileGen(st.taskId, { path: 'D:/x/reset.md', name: 'reset.md', size: 0, format: 'md', url: null });
      }
      if (getFileGenStatus()) getFileGenStatus().startedAt = Date.now() - 6 * 60 * 1000;
    });

    test('无进行中任务 → 新建 start(collect) 且 label 生效', () => {
      const id = ensureFileGenTask({ title: '端测AI', format: 'md', phase: 'collect', label: '正在搜集资料…' });
      expect(broadcastEvent).toHaveBeenCalledWith('filegen:start', { taskId: id, title: '端测AI', format: 'md' });
      const st = getFileGenStatus();
      expect(st.phase).toBe('collect');
      expect(st.label).toBe('正在搜集资料…');
    });

    test('流程进行中（collect）→ 复用同 taskId 推进 writing，不再 start', () => {
      const id = ensureFileGenTask({ title: '端测AI', format: 'md', phase: 'collect', label: '正在搜集资料…' });
      broadcastEvent.mockClear();
      const id2 = ensureFileGenTask({ title: 'X', format: 'md', phase: 'writing', label: '正在撰写 X…' });
      expect(id2).toBe(id);
      expect(broadcastEvent).not.toHaveBeenCalledWith('filegen:start', expect.anything());
      expect(broadcastEvent).toHaveBeenCalledWith('filegen:phase', { taskId: id, phase: 'writing', label: '正在撰写 X…' });
    });

    test('2026-08-22 autoDocx 标记: 新建写入, 复用不清除（intent 级属性）', () => {
      const id = ensureFileGenTask({ title: '文章', format: 'docx', phase: 'collect', autoDocx: true });
      expect(getFileGenStatus().autoDocx).toBe(true);
      // md Write 插桩复用（同任务）——不带 autoDocx 参数, flag 保持
      const id2 = ensureFileGenTask({ title: 'a.md', format: 'md', phase: 'writing' });
      expect(id2).toBe(id);
      expect(getFileGenStatus().autoDocx).toBe(true);
    });

    test('2026-08-23: 模型中断后 collect 卡死任务（窗口外）→ 新请求新建任务并广播 start', () => {
      // 实机: 生成请求后模型零工具调用回复 → 任务永卡 collect；后续新请求无条件
      // 复用旧任务（不广播 start、旧 sources 残留）。修复: 非终态复用受窗口约束。
      const id = ensureFileGenTask({ title: '僵尸任务', format: 'md', phase: 'collect', label: '正在搜集资料…' });
      const st = getFileGenStatus();
      st.sources = [{ query: '旧资料', sources: [{ title: 'T', url: 'https://x' }], ts: Date.now() }];
      broadcastEvent.mockClear();
      // 模拟窗口过期（僵尸任务卡 collect 超 5 分钟）
      st.startedAt = Date.now() - 6 * 60 * 1000;
      const id2 = ensureFileGenTask({ title: '新请求', format: 'md', phase: 'collect', label: '正在搜集资料…' });
      expect(id2).not.toBe(id);
      expect(broadcastEvent).toHaveBeenCalledWith('filegen:start', expect.objectContaining({ taskId: id2 }));
      expect(getFileGenStatus().sources).toHaveLength(0); // 新任务清空旧资料
    });

    test('窗口内非终态任务任意 phase 复用（同请求双路径幂等不裂任务）', () => {
      const id = ensureFileGenTask({ title: 'X', format: 'md', phase: 'collect', label: '正在搜集资料…' });
      broadcastEvent.mockClear();
      const id2 = ensureFileGenTask({ title: 'X', format: 'md', phase: 'writing', label: '正在撰写 X…' });
      expect(id2).toBe(id);
      expect(broadcastEvent).not.toHaveBeenCalledWith('filegen:start', expect.anything());
    });

    test('任务已 done（复用窗口外）→ 新请求新建任务', () => {
      const id = ensureFileGenTask({ title: '旧', format: 'md', phase: 'collect' });
      doneFileGen(id, { path: 'D:/x/a.md', name: 'a.md', size: 10, format: 'md', url: null });
      // R2-4: done 任务 5 分钟窗口内复用——窗口外（新一轮生成）才新建；模拟窗口过期
      getFileGenStatus().startedAt = Date.now() - 6 * 60 * 1000;
      const id2 = ensureFileGenTask({ title: '新', format: 'md', phase: 'collect', label: '正在搜集资料…' });
      expect(id2).not.toBe(id);
      expect(getFileGenStatus().title).toBe('新');
    });
  });

  // 2026-08-23: 研究阶段资料来源插桩（WebSearch → filegen:source 广播 → 面板资料区）
  describe('sourceFileGen 资料插桩', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      const st = getFileGenStatus();
      if (st && st.phase !== 'done') {
        doneFileGen(st.taskId, { path: 'D:/x/reset.md', name: 'reset.md', size: 0, format: 'md', url: null });
      }
      if (getFileGenStatus()) getFileGenStatus().startedAt = Date.now() - 6 * 60 * 1000;
      startFileGen('filegen-src-1', { title: '研究任务', format: 'md' });
    });

    test('活跃任务期间 WebSearch 命中 → filegen:source 广播 + 资料累积可查询', () => {
      sourceFileGen('OPC 智能体 市场趋势', [
        { title: 'OPC UA 与智能体集成指南', url: 'https://example.com/opc-guide', snippet: 'OPC UA 智能体集成的最佳实践……' },
        { title: '智能制造 2026', url: 'https://example.com/manufacturing-2026', snippet: '行业报告摘要' },
      ]);
      expect(broadcastEvent).toHaveBeenCalledWith('filegen:source', {
        taskId: 'filegen-src-1',
        query: 'OPC 智能体 市场趋势',
        sources: [
          { title: 'OPC UA 与智能体集成指南', url: 'https://example.com/opc-guide', snippet: 'OPC UA 智能体集成的最佳实践……' },
          { title: '智能制造 2026', url: 'https://example.com/manufacturing-2026', snippet: '行业报告摘要' },
        ],
      });
      const st = getFileGenStatus();
      expect(st.sources).toHaveLength(1);
      expect(st.sources[0].query).toBe('OPC 智能体 市场趋势');
      // 快照（surface）也含 sources——面板重开恢复资料区
      expect(getSceneStore().upsertSurface.mock.calls.at(-1)[1].data.sources).toHaveLength(1);
    });

    test('无活跃任务（普通聊天搜索）→ 不广播不累积', () => {
      doneFileGen('filegen-src-1', { path: 'D:/x/a.md', name: 'a.md', size: 1, format: 'md', url: null });
      broadcastEvent.mockClear();
      sourceFileGen('随便搜搜', [{ title: 'T', url: 'https://example.com/t' }]);
      expect(broadcastEvent).not.toHaveBeenCalledWith('filegen:source', expect.anything());
      expect(getFileGenStatus().sources || []).toHaveLength(0);
    });

    test('空结果/字段缺失 → 静默跳过（不广播、不抛）', () => {
      expect(() => sourceFileGen('空结果', [])).not.toThrow();
      expect(() => sourceFileGen('坏数据', [{ url: 'https://example.com/no-title' }])).not.toThrow();
      expect(() => sourceFileGen('非数组', 'nope')).not.toThrow();
      expect(broadcastEvent).not.toHaveBeenCalledWith('filegen:source', expect.anything());
    });

    test('2026-08-23: 资料收集完成 → 阶段推进 writing「正在组织内容…」', () => {
      // 实机: PPT 场景 WebSearch 完成后卡片 15 秒停「正在搜集资料…」（资料区已有
      // 来源仍显示搜集）→ 用户判定"卡住"。sourceFileGen 后 collect 推进一次。
      sourceFileGen('端侧AI', [{ title: '端侧AI 原理', url: 'https://example.com/edge', snippet: '…' }]);
      const st = getFileGenStatus();
      expect(st.phase).toBe('writing');
      expect(st.label).toBe('正在组织内容…');
      expect(broadcastEvent).toHaveBeenCalledWith('filegen:phase', { taskId: st.taskId, phase: 'writing', label: '正在组织内容…' });
    });

    test('2026-08-23: 非 collect 阶段二次搜索不再推进（不覆盖 writing 后 label）', () => {
      sourceFileGen('第一次', [{ title: 'A', url: 'https://example.com/a', snippet: '' }]);
      expect(getFileGenStatus().label).toBe('正在组织内容…');
      // 直接推进 writing 其他 label（如生成中）→ 再搜索不得回滚
      phaseFileGen(getFileGenStatus().taskId, 'writing', '正在生成 PPT 演示…');
      broadcastEvent.mockClear();
      sourceFileGen('第二次', [{ title: 'B', url: 'https://example.com/b', snippet: '' }]);
      expect(getFileGenStatus().label).toBe('正在生成 PPT 演示…');
      // 仅广播 source, 无 phase 回滚
      expect(broadcastEvent).not.toHaveBeenCalledWith('filegen:phase', expect.objectContaining({ label: '正在组织内容…' }));
    });

    test('字段兼容：link/name/abstract 别名 + 长字段截断', () => {
      sourceFileGen('A'.repeat(200), [
        { name: '别名标题', link: 'https://example.com/alias', abstract: '摘要' },
        { title: 'L'.repeat(300), url: 'U'.repeat(400), snippet: 'S'.repeat(300) },
      ]);
      const entry = getFileGenStatus().sources[0];
      expect(entry.query.length).toBeLessThanOrEqual(100);
      expect(entry.sources[0].title).toBe('别名标题');
      expect(entry.sources[0].url).toBe('https://example.com/alias');
      expect(entry.sources[1].title.length).toBeLessThanOrEqual(120);
      expect(entry.sources[1].url.length).toBeLessThanOrEqual(300);
      expect(entry.sources[1].snippet.length).toBeLessThanOrEqual(200);
    });
  });
});

// ─── 2026-08-17 R2-4 多文件产物 ───

describe('R2-4 多文件产物（files[] 累积 + done 复用窗口）', () => {
  // 偏差修正: brief 原块无 beforeEach——模块级 currentFiles 跨用例泄漏（前一用例
  // 产物残留叠加），且进行中任务（非 done/error）无论窗口一律复用、done 任务窗口内
  // 也复用，使 ensureFileGenTask 不复新建。先消化残留任务为 done、再强制窗口过期
  // → 每用例以新一轮生成会话开始（files 清空），锁定各用例独立语义。
  beforeEach(() => {
    const fg = require('../core/filegen-events');
    const st = fg.getFileGenStatus();
    if (st && st.phase !== 'done') {
      fg.doneFileGen(st.taskId, { path: 'D:/x/reset.md', name: 'reset.md', size: 0, format: 'md', url: null });
    }
    if (fg.getFileGenStatus()) fg.getFileGenStatus().startedAt = Date.now() - 6 * 60 * 1000;
  });

  test('连续 done 同一任务（窗口内复用）：files 去重累积，任务不顶掉', () => {
    const fg = require('../core/filegen-events');
    const t1 = fg.ensureFileGenTask({ title: 'index.html', format: 'html', phase: 'writing', label: '正在撰写 index.html…' });
    fg.doneFileGen(t1, { path: 'C:/proj/index.html', name: 'index.html', size: 100, format: 'html', url: 'local:///proj/index.html' });
    // 第二次 Write（style.css）——done 任务窗口内复用同一 taskId
    const t2 = fg.ensureFileGenTask({ title: 'style.css', format: 'code', phase: 'writing', label: '正在撰写 style.css…' });
    expect(t2).toBe(t1);
    fg.doneFileGen(t2, { path: 'C:/proj/style.css', name: 'style.css', size: 50, format: 'code', url: null });
    const st = fg.getFileGenStatus();
    expect(st.files).toHaveLength(2);
    expect(st.files[0].path).toBe('C:/proj/index.html');
    expect(st.files[1].path).toBe('C:/proj/style.css');
    expect(st.taskId).toBe(t1); // 未顶掉
  });

  test('同一文件重复 done 去重（不重复登记）', () => {
    const fg = require('../core/filegen-events');
    const t = fg.ensureFileGenTask({ title: 'a.md', format: 'md', phase: 'writing' });
    fg.doneFileGen(t, { path: '/x/a.md', name: 'a.md', size: 1, format: 'md', url: null });
    fg.doneFileGen(t, { path: '/x/a.md', name: 'a.md', size: 2, format: 'md', url: null });
    expect(fg.getFileGenStatus().files).toHaveLength(1);
  });

  test('done 事件携带 files 数组（file 字段兼容保留）', () => {
    // broadcastEvent 为普通函数（sse-broadcast.js:21），直接 spyOn 拦截调用
    const { broadcastEvent } = require('../core/sse-broadcast');
    const spy = jest.spyOn(require('../core/sse-broadcast'), 'broadcastEvent').mockImplementation(() => {});
    const fg = require('../core/filegen-events');
    const t = fg.ensureFileGenTask({ title: 'b.html', format: 'html', phase: 'writing' });
    fg.doneFileGen(t, { path: '/y/b.html', name: 'b.html', size: 3, format: 'html', url: null });
    fg.doneFileGen(t, { path: '/y/b.css', name: 'b.css', size: 4, format: 'code', url: null });
    // 偏差修正: brief 用 find（返回首次 done=b.html）；契约是"file 字段=最新产物"，
    // 取最后一次 done 事件
    const doneEvents = spy.mock.calls.filter(c => c[0] === 'filegen:done');
    const doneEvent = doneEvents[doneEvents.length - 1];
    expect(doneEvent).toBeTruthy();
    expect(doneEvent[1].file.name).toBe('b.css'); // file 字段=最新产物（兼容）
    expect(doneEvent[1].files).toHaveLength(2);
    spy.mockRestore();
  });

  test('窗口外新任务 → files 清空（新一轮生成会话）', () => {
    const fg = require('../core/filegen-events');
    const t1 = fg.ensureFileGenTask({ title: 'old.md', format: 'md', phase: 'writing' });
    fg.doneFileGen(t1, { path: '/z/old.md', name: 'old.md', size: 1, format: 'md', url: null });
    // 模拟窗口过期：直接改 startedAt
    const st = fg.getFileGenStatus();
    st.startedAt = Date.now() - 6 * 60 * 1000;
    const t2 = fg.ensureFileGenTask({ title: 'new.md', format: 'md', phase: 'writing' });
    expect(t2).not.toBe(t1);
    expect(fg.getFileGenStatus().files).toEqual([]);
  });
});

// ─── 2026-08-17 final-review 修复轮（whole-branch 审查 P1 + 2×SHOULD-FIX）───

describe('final-review: 复用任务采纳实际产物 format（意图占位 md 被真实写入覆盖）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const fg = require('../core/filegen-events');
    // 消化前组残留任务为 done、强制窗口过期 → 每用例以新一轮生成会话开始
    const st = fg.getFileGenStatus();
    if (st && st.phase !== 'done') {
      fg.doneFileGen(st.taskId, { path: 'D:/x/reset.md', name: 'reset.md', size: 0, format: 'md', url: null });
    }
    if (fg.getFileGenStatus()) fg.getFileGenStatus().startedAt = Date.now() - 6 * 60 * 1000;
    // 复位 panel-state mock 实现（前组 'panel-state 写入自身失败' 用例把实现换成了抛错）
    const { setPanelState } = require('../core/panel-state');
    setPanelState.mockImplementation((panel, state) => { mockPanelStates[panel] = state; });
    for (const k of Object.keys(mockPanelStates)) delete mockPanelStates[k];
  });

  test('意图启动 md → Write html → 任务 format 变 html（taskId 不变）', () => {
    const fg = require('../core/filegen-events');
    // 意图启动占位 md（ai.js maybeStartFileGenTask 同形态）
    const id = fg.ensureFileGenTask({ title: '生成网页', format: 'md', phase: 'collect', label: '正在搜集资料…' });
    expect(fg.getFileGenStatus().format).toBe('md');
    // 首个真实 Write index.html（Write 插桩同形态）
    const id2 = fg.ensureFileGenTask({ title: 'index.html', format: 'html', phase: 'writing', label: '正在撰写 index.html…' });
    expect(id2).toBe(id);
    expect(fg.getFileGenStatus().format).toBe('html');
  });

  test('html 不被后续 css/js(code) 降级（多文件网页保持 live 分屏）', () => {
    const fg = require('../core/filegen-events');
    fg.ensureFileGenTask({ title: 'index.html', format: 'html', phase: 'writing' });
    fg.ensureFileGenTask({ title: 'style.css', format: 'code', phase: 'writing' });
    fg.ensureFileGenTask({ title: 'app.js', format: 'code', phase: 'writing' });
    expect(fg.getFileGenStatus().format).toBe('html');
  });

  test('非 html 写入覆盖意图占位 md', () => {
    const fg = require('../core/filegen-events');
    const id = fg.ensureFileGenTask({ title: '写脚本', format: 'md', phase: 'collect' });
    const id2 = fg.ensureFileGenTask({ title: 'a.py', format: 'code', phase: 'writing' });
    expect(id2).toBe(id);
    expect(fg.getFileGenStatus().format).toBe('code');
  });

  test('doneFileGen 刷新 startedAt——长会话(>5min) done→下一写复用同任务不裂', () => {
    const fg = require('../core/filegen-events');
    const id = fg.ensureFileGenTask({ title: 'a.md', format: 'md', phase: 'writing' });
    // 模拟长会话：任务 6 分钟前启动——若 done 不刷新 startedAt，
    // done 后下一写将超窗裂成新任务（前端 tabs 清空、后端 files 清空）
    fg.getFileGenStatus().startedAt = Date.now() - 6 * 60 * 1000;
    fg.doneFileGen(id, { path: '/x/a.md', name: 'a.md', size: 1, format: 'md', url: null });
    const id2 = fg.ensureFileGenTask({ title: 'b.md', format: 'md', phase: 'writing' });
    expect(id2).toBe(id); // done 刷新 startedAt → 复用窗口从 done 时刻重新起算
    expect(fg.getFileGenStatus().files).toHaveLength(1); // 后端 files 未被清空
  });

  test('2026-09-06 状态机 v2: doneFileGen 不再强制写 panel-state open（防"完成即打断"，通知分层由前端 toast 承接）', () => {
    const fg = require('../core/filegen-events');
    const { setPanelState } = require('../core/panel-state');
    const id = fg.ensureFileGenTask({ title: 'T', format: 'md', phase: 'writing' });
    setPanelState.mockClear();
    fg.doneFileGen(id, { path: 'D:/x/a.md', name: 'a.md', size: 10, format: 'md', url: null });
    expect(setPanelState).not.toHaveBeenCalled();
  });

  // ─── 2026-09-06 状态机 v2 新增回归 ───

  test('artifactFileGen 登记产物但不触发 done（Write 不再即完成）', () => {
    const fg = require('../core/filegen-events');
    const id = fg.ensureFileGenTask({ title: 't', format: 'md', phase: 'writing' });
    fg.artifactFileGen(id, { path: 'D:/x/a.md', name: 'a.md', size: 10, format: 'md', url: null });
    const st = fg.getFileGenStatus();
    expect(st.phase).toBe('writing'); // 保持写作态，非 done
    expect(st.files).toHaveLength(1);
  });

  test('settleTurn: 有产物无终态 → 收敛 done（主产物 html 优先）', () => {
    const fg = require('../core/filegen-events');
    fg.beginTurn();
    const id = fg.ensureFileGenTask({ title: '网页', format: 'html', phase: 'writing' });
    fg.artifactFileGen(id, { path: 'D:/x/index.html', name: 'index.html', size: 10, format: 'html', url: null });
    fg.artifactFileGen(id, { path: 'D:/x/style.css', name: 'style.css', size: 5, format: 'code', url: null });
    fg.settleTurn();
    const st = fg.getFileGenStatus();
    expect(st.phase).toBe('done');
    expect(st.file.name).toBe('index.html'); // html 主产物，不是最后的 css
  });

  test('settleTurn: 零实质活动（意图开卡后模型只追问）→ paused 而非永卡搜集', () => {
    const fg = require('../core/filegen-events');
    fg.beginTurn();
    const id = fg.ensureFileGenTask({ title: '帮我生成一个网页', format: 'md', phase: 'collect', label: '正在搜集资料…' });
    fg.settleTurn(); // 回合结束：无搜索/无写/无转换
    const st = fg.getFileGenStatus();
    expect(st.taskId).toBe(id);
    expect(st.phase).toBe('paused');
    expect(st.label).toContain('已暂停');
  });

  test('settleTurn: 有实质活动但无产物（搜完未写）→ paused「可继续生成」', () => {
    const fg = require('../core/filegen-events');
    fg.beginTurn();
    const id = fg.ensureFileGenTask({ title: '报告', format: 'md', phase: 'collect' });
    fg.sourceFileGen('关键词', [{ title: '来源', url: 'https://x', snippet: 's' }]);
    fg.settleTurn();
    const st = fg.getFileGenStatus();
    expect(st.phase).toBe('paused');
    expect(st.sources).toHaveLength(1);
  });

  test('cancelFileGen: 进行中任务可取消转终态；终态/他人任务不可取消', () => {
    const fg = require('../core/filegen-events');
    const id = fg.ensureFileGenTask({ title: 't', format: 'md', phase: 'writing' });
    expect(fg.cancelFileGen('wrong-id')).toBe(false);
    expect(fg.cancelFileGen(id)).toBe(true);
    expect(fg.getFileGenStatus().phase).toBe('cancelled');
    expect(fg.cancelFileGen(id)).toBe(false); // 已终态
  });

  test('cancelled 是终态：窗口内新意图(collect) → 新任务；写作插桩仍可复用其壳', () => {
    const fg = require('../core/filegen-events');
    const id = fg.ensureFileGenTask({ title: 't1', format: 'md', phase: 'writing' });
    fg.cancelFileGen(id);
    // 新意图 → 开新任务
    const id2 = fg.ensureFileGenTask({ title: 't2', format: 'md', phase: 'collect', fresh: true });
    expect(id2).not.toBe(id);
    // 终态 + 写作插桩 → 窗口内复用回流程态
    fg.cancelFileGen(id2);
    const id3 = fg.ensureFileGenTask({ title: 't2', format: 'md', phase: 'writing' });
    expect(id3).toBe(id2);
    expect(fg.getFileGenStatus().phase).toBe('writing');
  });

  test('fresh 复用：清 sources/file、更新 title（治复用残留）', () => {
    const fg = require('../core/filegen-events');
    const id = fg.ensureFileGenTask({ title: '旧标题', format: 'md', phase: 'collect' });
    fg.sourceFileGen('旧搜索', [{ title: '旧来源', url: 'https://old', snippet: '' }]);
    fg.artifactFileGen(id, { path: 'D:/x/old.md', name: 'old.md', size: 1, format: 'md', url: null });
    // 同 taskId（窗口内 paused/非终态）+ fresh 新意图
    const id2 = fg.ensureFileGenTask({ title: '新标题', format: 'md', phase: 'collect', fresh: true });
    expect(id2).toBe(id); // 窗口内复用
    const st = fg.getFileGenStatus();
    expect(st.title).toBe('新标题');
    expect(st.sources).toHaveLength(0);
    expect(st.files).toHaveLength(0);
    expect(st.file).toBeNull();
  });

  test('paused 任务收到搜索/写作插桩 → 恢复流程（需求补充后继续）', () => {
    const fg = require('../core/filegen-events');
    fg.beginTurn();
    const id = fg.ensureFileGenTask({ title: 't', format: 'md', phase: 'collect' });
    fg.settleTurn(); // → paused
    expect(fg.getFileGenStatus().phase).toBe('paused');
    // 用户补充后模型开搜 → 恢复 writing
    fg.sourceFileGen('新关键词', [{ title: '来源', url: 'https://y', snippet: '' }]);
    expect(fg.getFileGenStatus().phase).toBe('writing');
  });
});

// ─── 2026-08-17 final-review round 2: done 窗口内新意图(collect) 必须开新任务 ───

describe('final-review round 2: done/error 复用条件收紧（写作/转换插桩限定）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const fg = require('../core/filegen-events');
    // 消化前组残留任务为 done、强制窗口过期 → 每用例以新一轮生成会话开始
    const st = fg.getFileGenStatus();
    if (st && st.phase !== 'done') {
      fg.doneFileGen(st.taskId, { path: 'D:/x/reset.md', name: 'reset.md', size: 0, format: 'md', url: null });
    }
    if (fg.getFileGenStatus()) fg.getFileGenStatus().startedAt = Date.now() - 6 * 60 * 1000;
  });

  test('done 窗口内新意图(collect) → 新 taskId + files 清空 + format 重置', () => {
    const fg = require('../core/filegen-events');
    const id = fg.ensureFileGenTask({ format: 'md', phase: 'collect' });
    fg.ensureFileGenTask({ format: 'html', phase: 'writing' });
    fg.doneFileGen(id, { path: 'C:/proj/index.html', name: 'index.html', size: 100, format: 'html', url: null });
    // 5 分钟内（doneFileGen 刷新 startedAt）用户新请求"转成 Word 报告"——collect 意图
    // 对 done 任务一律开新任务：files 清空 + filegen:start 广播（前端清 mainHtmlPath/tabs）
    const id2 = fg.ensureFileGenTask({ title: '转成 Word 报告', format: 'md', phase: 'collect' });
    expect(id2).not.toBe(id);
    expect(fg.getFileGenStatus().files).toEqual([]);
    expect(fg.getFileGenStatus().format).toBe('md');
  });

  test('done 窗口内写作插桩(writing) → 仍复用且 files 累积、html 不被 code 降级', () => {
    const fg = require('../core/filegen-events');
    const id = fg.ensureFileGenTask({ format: 'md', phase: 'collect' });
    fg.ensureFileGenTask({ format: 'html', phase: 'writing' });
    fg.doneFileGen(id, { path: 'C:/proj/index.html', name: 'index.html', size: 100, format: 'html', url: null });
    // done 任务窗口内写作插桩（R2-4 多文件连续写作）仍复用同任务
    const id2 = fg.ensureFileGenTask({ format: 'code', phase: 'writing' });
    expect(id2).toBe(id);
    expect(fg.getFileGenStatus().files).toHaveLength(1);
    expect(fg.getFileGenStatus().files[0].name).toBe('index.html');
    expect(fg.getFileGenStatus().format).toBe('html');
  });

  test('活跃任务 + collect 意图 → 仍复用（同请求双调用不裂任务）', () => {
    const fg = require('../core/filegen-events');
    const id = fg.ensureFileGenTask({ format: 'md', phase: 'collect' });
    const id2 = fg.ensureFileGenTask({ format: 'md', phase: 'collect' });
    expect(id2).toBe(id);
  });
});

// ─── 2026-09-06 恢复链路: hasResumableTask / resumeFileGenTask ───
// 实机场景：网页任务暂停/中断后用户说"继续"→ 后端需复活原任务（保留资料/产物、
// 重开 5min 复用窗口）并重播 surface 让卡片回归——此前恢复路径缺失，模型把全文
// 直吐对话窗口。见 src/test/filegen-write-retry.test.js 恢复分支。
describe('resumeFileGenTask 恢复链路（2026-09-06）', () => {
  const fg = require('../core/filegen-events');

  test('paused 任务 → resume 复活: phase 回 collect、startedAt 刷新、广播 phase+surface', () => {
    fg.cancelFileGen(); // 清掉前序测试遗留的非终态任务，保证从已知状态开始
    fg.ensureFileGenTask({ title: '个人主页', format: 'html', phase: 'collect', fresh: true, originalMessage: '做一个个人主页网页' });
    // 零实质活动回合收敛 → paused（v2 settleTurn 语义）
    fg.settleTurn();
    expect(fg.getFileGenStatus().phase).toBe('paused');
    expect(fg.hasResumableTask()).toBe(true);

    // 模拟跨窗口恢复：startedAt 拨回 10 分钟前（复用窗口 5min 已过期）
    fg.getFileGenStatus().startedAt = Date.now() - 10 * 60 * 1000;
    const staleStartedAt = fg.getFileGenStatus().startedAt;

    const ctx = fg.resumeFileGenTask();
    expect(ctx).toMatchObject({ title: '个人主页', format: 'html', phase: 'collect', label: '正在继续…' });
    expect(fg.getFileGenStatus().startedAt).toBeGreaterThan(staleStartedAt);
    expect(broadcastEvent).toHaveBeenCalledWith('filegen:phase', expect.objectContaining({ phase: 'collect', label: '正在继续…' }));
    expect(getSceneStore().upsertSurface).toHaveBeenCalled();

    // 关键回归: startedAt 刷新后复用窗口重开——恢复后 Write 插桩复用同任务（不裂新任务）
    const tid = fg.ensureFileGenTask({ title: '个人主页', format: 'html', phase: 'writing' });
    expect(tid).toBe(ctx.taskId);
    expect(fg.getFileGenStatus().phase).toBe('writing');
  });

  test('终态任务 → 无可恢复: hasResumableTask false、resumeFileGenTask null', () => {
    fg.cancelFileGen();
    expect(fg.getFileGenStatus().phase).toBe('cancelled');
    expect(fg.hasResumableTask()).toBe(false);
    expect(fg.resumeFileGenTask()).toBeNull();
  });

  test('writing 态 resume → 流程状态不动，仅重播 surface（卡片回归）', () => {
    fg.cancelFileGen();
    fg.ensureFileGenTask({ title: 'T', format: 'md', phase: 'collect', fresh: true });
    const tid = fg.getFileGenStatus().taskId;
    fg.phaseFileGen(tid, 'writing', '正在撰写…');
    const upsert = getSceneStore().upsertSurface;
    upsert.mockClear();
    const ctx = fg.resumeFileGenTask();
    expect(ctx).toMatchObject({ taskId: tid, phase: 'writing' });
    expect(fg.getFileGenStatus().label).toBe('正在撰写…');
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});

// ─── 2026-09-06 追问回答链路: pausedAt 记录 + getPausedTask ───
// 引导词"生成一个网页"→模型追问→任务 paused→用户补充（回答常不含文件词）→
// ai.js 凭 getPausedTask 注入条件引导。pausedAt 供 10 分钟注入窗口判定。
describe('getPausedTask 追问回答链路（2026-09-06）', () => {
  const fg = require('../core/filegen-events');

  test('collect 态无 paused 任务；settleTurn 暂停后记录 pausedAt；复活后清零可见态', () => {
    fg.cancelFileGen(); // 清前序遗留
    fg.ensureFileGenTask({ title: '生成一个网页', format: 'html', phase: 'collect', fresh: true, originalMessage: '生成一个网页' });
    expect(fg.getPausedTask()).toBeNull(); // 活跃 collect 非 paused
    fg.settleTurn(); // 零实质活动 → paused（追问场景）
    const paused = fg.getPausedTask();
    expect(paused).toBeTruthy();
    expect(paused.title).toBe('生成一个网页');
    expect(paused.format).toBe('html');
    expect(paused.pausedAt).toBeGreaterThan(0);
    fg.resumeFileGenTask(); // 复活 → 非 paused
    expect(fg.getPausedTask()).toBeNull();
  });
});
