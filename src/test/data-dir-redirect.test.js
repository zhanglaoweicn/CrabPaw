/**
 * 数据目录路径统一（2026-08-31 Eval 隔离轮 Task 1）
 *
 * 两条钉子：
 * 1. 行为不变红线——不设 env 时，统一后路径与历史硬编码
 *    path.join(<repo>, 'data', '.crabpaw', ...) 逐字节一致（真实数据不搬家）；
 * 2. 重定向生效——设 CRABPAW_DATA_DIR 后（须在 config 单例 require 之前），
 *    全部关键存储路径落重定向目录（Task 2 eval 隔离的前提）。
 *
 * 探测用子进程：env 生效时机是"config 单例 require 期固化"，独立进程最真实，
 * 也避免污染本 jest worker 的模块缓存。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const DEFAULT_DATA_DIR = path.join(REPO, 'data', '.crabpaw');

function probeModulePaths(envOverride) {
  const script = `
    const config = require(${JSON.stringify(path.join(REPO, 'src', 'core', 'config'))});
    const memorySystem = require(${JSON.stringify(path.join(REPO, 'src', 'core', 'memory-system'))});
    const { getSharedSessionPersistence } = require(${JSON.stringify(path.join(REPO, 'src', 'core', 'memory', 'session-persistence'))});
    console.log(JSON.stringify({
      dataDir: config.DATA_DIR,
      memoryDir: memorySystem.MEMORY_DIR,
      sessionsDir: memorySystem.SESSIONS_DIR,
      memoryFile: memorySystem.MEMORY_FILE,
      dreamFile: memorySystem.DREAM_FILE,
      persistSessionsDir: getSharedSessionPersistence().sessionsDir,
    }));
  `;
  const env = { ...process.env };
  delete env.CRABPAW_DATA_DIR;
  delete env.DATA_DIR;
  if (envOverride) Object.assign(env, envOverride);
  const out = execFileSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

// 已统一到 config.DATA_DIR 的模块清单——禁止回退硬编码（源码契约）
const UNIFIED_MODULES = [
  'src/core/memory-system.js',
  'src/core/memory-smart-loader.js',
  'src/core/memory/session-persistence.js',
  'src/core/memory/auto-memory.js',
  'src/core/memory/auto-dream.js',
  'src/core/memory/memory-manager.js',
  'src/core/memory/fts-search.js',
  'src/tools/memory-tools.js',
  'src/tools/session-search-tools.js',
  'src/core/skill-metrics.js',
  'src/core/skill/skill-fusion-engine.js',
  'src/core/skill/skill-importer.js',
  'src/core/skill/skill-market-client.js',
  'src/tasks/core/task-execution-history.js',
  'src/schedule/storage/local-storage.js',
  'src/handlers/local-handlers/wecom.js',
  // 2026-08-31 Eval 隔离轮 Task 2 追加（415MB memory.json 泄漏根因链）：
  'src/core/memory/index.js',
  'src/core/memory/memory-isolation.js',
  'src/core/memory/memory-manager.js',
];

describe('数据目录路径统一（Eval 隔离轮 Task 1）', () => {
  jest.setTimeout(60000);

  describe('默认路径（无 env）——与历史硬编码逐字节一致', () => {
    let paths;
    beforeAll(() => { paths = probeModulePaths(null); });

    test('config.DATA_DIR 默认 = <repo>/data/.crabpaw', () => {
      expect(paths.dataDir).toBe(DEFAULT_DATA_DIR);
    });

    test('memory-system: MEMORY_DIR/SESSIONS_DIR/MEMORY_FILE/DREAM_FILE 逐字节不变', () => {
      expect(paths.memoryDir).toBe(path.join(DEFAULT_DATA_DIR, 'memory'));
      expect(paths.sessionsDir).toBe(path.join(DEFAULT_DATA_DIR, 'memory', 'sessions'));
      expect(paths.memoryFile).toBe(path.join(DEFAULT_DATA_DIR, 'memory', 'MEMORY.md'));
      expect(paths.dreamFile).toBe(path.join(DEFAULT_DATA_DIR, 'memory', 'dream.json'));
    });

    test('session-persistence: 默认会话目录逐字节不变', () => {
      expect(paths.persistSessionsDir).toBe(path.join(DEFAULT_DATA_DIR, 'memory', 'sessions'));
    });
  });

  describe('env 重定向——CRABPAW_DATA_DIR 生效', () => {
    let tmpRoot;
    let paths;
    beforeAll(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crabpaw-data-redirect-'));
      paths = probeModulePaths({ CRABPAW_DATA_DIR: tmpRoot });
    });
    afterAll(() => {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { console.warn('[data-dir-redirect] 清理临时目录失败:', e.message); }
    });

    test('config.DATA_DIR 落重定向目录', () => {
      expect(paths.dataDir).toBe(tmpRoot);
    });

    test('memory-system 全部路径落重定向目录且不再指向真实库', () => {
      for (const p of [paths.memoryDir, paths.sessionsDir, paths.memoryFile, paths.dreamFile]) {
        expect(p.startsWith(tmpRoot + path.sep)).toBe(true);
        expect(p.startsWith(DEFAULT_DATA_DIR)).toBe(false);
      }
      expect(paths.sessionsDir).toBe(path.join(tmpRoot, 'memory', 'sessions'));
    });

    test('session-persistence 落重定向目录', () => {
      expect(paths.persistSessionsDir.startsWith(tmpRoot + path.sep)).toBe(true);
      expect(paths.persistSessionsDir.startsWith(DEFAULT_DATA_DIR)).toBe(false);
    });
  });

  describe('env 必须先于 config 单例 require（推导链固化时机）', () => {
    afterEach(() => {
      delete process.env.CRABPAW_DATA_DIR;
      jest.resetModules();
    });

    test('fresh require 时 env 已设 → 重定向生效', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crabpaw-fresh-require-'));
      process.env.CRABPAW_DATA_DIR = tmp;
      jest.resetModules();
      const config = require('../core/config');
      const memorySystem = require('../core/memory-system');
      expect(config.DATA_DIR).toBe(tmp);
      expect(memorySystem.MEMORY_DIR).toBe(path.join(tmp, 'memory'));
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.warn('[data-dir-redirect] 清理临时目录失败:', e.message); }
    });
  });

  describe('源码契约——已统一模块不得回退硬编码', () => {
    const HARDCODE_JOIN = /['"]data['"]\s*,\s*['"]\.crabpaw['"]/;

    test.each(UNIFIED_MODULES)('%s 不含 path.join(..., "data", ".crabpaw") 硬编码', (rel) => {
      const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
      expect(HARDCODE_JOIN.test(src)).toBe(false);
    });

    test('memory-tools/session-search-tools 不含 process.cwd() 数据目录拼接', () => {
      for (const rel of ['src/tools/memory-tools.js', 'src/tools/session-search-tools.js']) {
        const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
        expect(/process\.cwd\(\)\s*,\s*['"]data['"]/.test(src)).toBe(false);
      }
    });

    // 2026-08-31 Task 2：CWD 相对 './data/.crabpaw' 字面量是本轮 415MB 真实库
    // 泄漏的确切形态（EnhancedMemorySystem 默认 dataDir）——同样禁止回退。
    test('UNIFIED_MODULES 不含 CWD 相对 ./data/.crabpaw 字面量默认路径', () => {
      for (const rel of UNIFIED_MODULES) {
        const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
        expect(src.includes('./data/.crabpaw')).toBe(false);
      }
    });
  });
});
