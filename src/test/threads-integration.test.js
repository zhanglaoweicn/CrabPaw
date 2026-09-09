/**
 * Integration test for Thread/Focus Stack system
 *
 * Run with: npx jest src/test/threads-integration.test.js --no-coverage
 */

const idx = require('../core/threads/index');
const { classifyMessage, CLASSIFICATION_TYPES: _CLASSIFICATION_TYPES } = require('../core/threads/thread-classifier');
const { ThreadManager, THREAD_STATUS: _THREAD_STATUS } = require('../core/threads/threads');
const { FocusStack } = require('../core/threads/focus-stack');

// ==========================================================================
// Thread Classifier
// ==========================================================================
describe('ThreadClassifier', () => {
  const singleThread = [{ id: '1', title: 'test', keywords: ['test'], lastActive: Date.now() }];

  test('classifyMessage with no threads returns new_topic', () => {
    const r = classifyMessage('帮我设计一个Logo', []);
    expect(r.type).toBe('new_topic');
  });

  test('topic switch marker returns new_topic', () => {
    const r = classifyMessage(
      '不说这个了，换个话题',
      singleThread,
      { foregroundThreadId: '1' }
    );
    expect(r.type).toBe('new_topic');
  });

  test('continuation markers return continuation', () => {
    const r1 = classifyMessage('继续说说', singleThread, { foregroundThreadId: '1' });
    expect(r1.type).toBe('continuation');

    const r2 = classifyMessage('然后呢', singleThread, { foregroundThreadId: '1' });
    expect(r2.type).toBe('continuation');

    const r3 = classifyMessage('', singleThread, { foregroundThreadId: '1' });
    expect(r3.type).toBe('continuation');
  });

  test('foreground thread mention returns continuation with matching threadId', () => {
    const thread = [{ id: '1', title: 'Logo设计讨论', keywords: ['logo', '设计'], lastActive: Date.now() }];
    const r = classifyMessage('说说那个Logo设计', thread, { foregroundThreadId: '1' });
    expect(r.type).toBe('continuation');
    expect(r.threadId).toBe('1');
  });

  test('resume with reference and keyword returns resume with matching threadId', () => {
    const thread = [{ id: '1', title: '爬虫程序', keywords: ['爬虫'], lastActive: Date.now() }];
    const r = classifyMessage('之前说的爬虫', thread, { foregroundThreadId: null });
    expect(r.type).toBe('resume');
    expect(r.threadId).toBe('1');
  });

  test('English topic switch returns new_topic', () => {
    const r = classifyMessage('by the way, new question', singleThread);
    expect(r.type).toBe('new_topic');
  });

  test('English continuation markers return continuation', () => {
    const thread = [{ id: '1', title: 'web crawler', keywords: ['crawler'], lastActive: Date.now() }];
    const r = classifyMessage('tell me more about it', thread, { foregroundThreadId: '1' });
    expect(r.type).toBe('continuation');
  });

  test('English reference pattern with keyword returns resume', () => {
    const thread = [{ id: '1', title: 'web crawler', keywords: ['crawler'], lastActive: Date.now() }];
    const r = classifyMessage('you mentioned the crawler earlier', thread, { foregroundThreadId: null });
    expect(r.type).toBe('resume');
  });
});

// ==========================================================================
// Thread Manager
// ==========================================================================
describe('ThreadManager', () => {
  let tm;
  let id1, id2;

  test('starts empty', () => {
    tm = new ThreadManager({ maxOpen: 3 });
    expect(tm.count).toBe(0);
  });

  test('createThread creates thread and sets it as foreground', () => {
    id1 = tm.createThread('爬虫项目', '帮我写个爬虫');
    expect(tm.count).toBe(1);
    expect(tm.getForegroundThread().id).toBe(id1);
  });

  test('continueThread adds keywords to thread', () => {
    tm.continueThread(id1, '用Python写');
    expect(tm.getThread(id1).keywords.length).toBeGreaterThan(0);
  });

  test('second createThread switches foreground', () => {
    id2 = tm.createThread('设计项目', '帮我设计Logo');
    expect(tm.count).toBe(2);
    expect(tm.getForegroundThread().id).toBe(id2);
  });

  test('deactivateThread sets status to background', () => {
    tm.deactivateThread(id2);
    expect(tm.getThread(id2).status).toBe('background');
  });

  test('activateThread promotes thread to foreground', () => {
    tm.activateThread(id1);
    expect(tm.getForegroundThread().id).toBe(id1);
  });

  test('summarizeThread updates summary', () => {
    tm.summarizeThread(id1, '讨论爬虫的技术方案');
    expect(tm.getThread(id1).summary).toBe('讨论爬虫的技术方案');
  });

  test('tagKeyword adds keywords to thread', () => {
    tm.tagKeyword(id1, 'python', 'requests', 'beautifulsoup');
    const kw = tm.getThread(id1).keywords;
    expect(kw).toContain('python');
  });

  test('adjustTemperature clamps within [0, 1]', () => {
    const t1 = tm.adjustTemperature(id1, 0.2);
    expect(t1).toBe(0.7);

    const t2 = tm.adjustTemperature(id1, -0.8);
    expect(t2).toBe(0.0);

    const t3 = tm.adjustTemperature(id1, 2.0);
    expect(t3).toBe(1.0);
  });

  test('freezeThread prevents deactivation; thawThread restores', () => {
    tm.freezeThread(id2);
    expect(tm.getThread(id2).status).toBe('frozen');
    expect(tm.deactivateThread(id2)).toBe(false);

    tm.thawThread(id2);
    expect(tm.getThread(id2).status).toBe('active');
  });

  test('eviction keeps count at or below maxOpen', () => {
    // eslint-disable-next-line no-unused-vars -- 创建线程以触发淘汰，返回值仅用于占位
    const id3 = tm.createThread('第三个话题', '第三个消息');
    // eslint-disable-next-line no-unused-vars -- 创建线程以触发淘汰，返回值仅用于占位
    const id4 = tm.createThread('第四个话题', '第四个消息');
    expect(tm.count).toBeLessThanOrEqual(3);
  });

  test('getAllThreads returns formatted output with foreground marker', () => {
    const fmt = tm.getAllThreads();
    expect(fmt).toContain('爬虫项目');
    expect(fmt).toContain('>>>');
  });

  test('expireOldThreads removes aged threads', () => {
    const all = tm.listThreads();
    for (const t of all) {
      const internal = tm._getThreadInternal(t.id);
      if (internal) internal.lastActive = 0;
    }
    const expired = tm.expireOldThreads(0);
    expect(expired).toBeGreaterThanOrEqual(1);
    expect(tm.count).toBe(0);
  });
});

// ==========================================================================
// Focus Stack
// ==========================================================================
describe('FocusStack', () => {
  let fs;

  test('starts empty with no focus', () => {
    fs = new FocusStack();
    expect(fs.depth).toBe(0);
    expect(fs.peekFrame()).toBeNull();
    expect(fs.hasFocus).toBe(false);
  });

  test('pushFrame adds frame and sets hasFocus', () => {
    fs.pushFrame('architecture', '系统架构讨论');
    expect(fs.depth).toBe(1);
    expect(fs.hasFocus).toBe(true);
  });

  test('second pushFrame builds focus path', () => {
    fs.pushFrame('database', '数据库设计');
    expect(fs.depth).toBe(2);
    expect(fs.getFocusPathString()).toBe('architecture > database');
  });

  test('peekFrame shows top frame topic', () => {
    const peek = fs.peekFrame();
    expect(peek.topic).toBe('database');
  });

  test('getFocusPath returns all frames', () => {
    const path = fs.getFocusPath();
    expect(path.length).toBe(2);
    expect(path[0].topic).toBe('architecture');
  });

  test('popFrame removes top frame and returns result with compressed note', () => {
    const pop = fs.popFrame();
    expect(pop.success).toBe(true);
    expect(pop.poppedFrame.topic).toBe('database');
    expect(pop.compressedNote).toContain('Focus: database');
    expect(pop.parentFrame.topic).toBe('architecture');
    expect(fs.depth).toBe(1);
  });

  test('clear resets depth to 0', () => {
    fs.clear();
    expect(fs.depth).toBe(0);
  });

  test('maxDepth enforcement blocks overflow at depth 5', () => {
    for (let i = 0; i < 6; i++) {
      const result = fs.pushFrame('topic-' + i, 'test');
      if (i >= 5) expect(result.success).toBe(false);
    }
    expect(fs.depth).toBe(5);
  });

  test('restore restores frames from saved data', () => {
    fs.clear();
    const saved = [
      { topic: 'root', context: 'root ctx', depth: 1, timestamp: Date.now() },
      { topic: 'child', context: 'child ctx', depth: 2, timestamp: Date.now() },
    ];
    fs.restore(saved);
    expect(fs.depth).toBe(2);
    expect(fs.getFocusPathString()).toBe('root > child');
  });

  test('getDiagnostics returns current state', () => {
    const diag = fs.getDiagnostics();
    expect(diag.depth).toBe(2);
    expect(diag.currentFrame.topic).toBe('child');
  });
});

// ==========================================================================
// Index API
// ==========================================================================
describe('Index API', () => {
  test('resetAll clears threads and focus', () => {
    idx.resetAll();
    expect(idx.globalThreadManager.count).toBe(0);
    expect(idx.globalFocusStack.hasFocus).toBe(false);
  });

  test('classifyAndRoute returns classification and creates thread', () => {
    const cr = idx.classifyAndRoute('你好，帮我查一下天气');
    expect(cr.classification.type).toBe('new_topic');
    expect(cr.thread.title).toBeTruthy();
  });

  test('getThreadState returns threads and focus state', () => {
    const state = idx.getThreadState();
    expect(state.threads.length).toBe(1);
    expect(state.focusStack.depth).toBe(0);
  });
});
