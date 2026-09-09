const { HookManager } = require('../../src/core/harness-hooks');
const { PathRuleEngine, PERMISSION_MODE, setPermissionMode, getPermissionMode } = require('../../src/core/permissions/path-rules');
const { getEventBus } = require('../../src/core/events');

module.exports = {
  name: 'Hooks',
  cases: [
    // ── 原有安全 Hook 测试（保留并增强）──────────────────────────
    {
      id: 'hk_001',
      name: 'safety hook blocks rm -rf /',
      category: 'hooks',
      run: async () => {
        const mgr = new HookManager();
        for (const h of HookManager.createSafetyHooks()) mgr.registerPreToolUse(h);
        const r = await mgr.triggerPreToolUse('Bash', { command: 'rm -rf /' }, {});
        return !r.allowed;
      },
    },
    {
      id: 'hk_002',
      name: 'safety hook blocks mkfs command',
      category: 'hooks',
      run: async () => {
        const mgr = new HookManager();
        for (const h of HookManager.createSafetyHooks()) mgr.registerPreToolUse(h);
        const r = await mgr.triggerPreToolUse('Bash', { command: 'mkfs.ext4 /dev/sda' }, {});
        return !r.allowed;
      },
    },
    {
      id: 'hk_003',
      name: 'safety hook blocks fork bomb',
      category: 'hooks',
      run: async () => {
        const mgr = new HookManager();
        for (const h of HookManager.createSafetyHooks()) mgr.registerPreToolUse(h);
        const r = await mgr.triggerPreToolUse('Bash', { command: ':(){ :|:& };:' }, {});
        return !r.allowed;
      },
    },
    {
      id: 'hk_004',
      name: 'safety hook blocks format c:',
      category: 'hooks',
      run: async () => {
        const mgr = new HookManager();
        for (const h of HookManager.createSafetyHooks()) mgr.registerPreToolUse(h);
        const r = await mgr.triggerPreToolUse('Bash', { command: 'format c:' }, {});
        return !r.allowed;
      },
    },
    {
      id: 'hk_005',
      name: 'safety hook allows safe commands',
      category: 'hooks',
      run: async () => {
        const mgr = new HookManager();
        for (const h of HookManager.createSafetyHooks()) mgr.registerPreToolUse(h);
        const r = await mgr.triggerPreToolUse('Bash', { command: 'ls -la' }, {});
        return r.allowed;
      },
    },
    {
      id: 'hk_006',
      name: 'safety hook allows non-Bash tools',
      category: 'hooks',
      run: async () => {
        const mgr = new HookManager();
        for (const h of HookManager.createSafetyHooks()) mgr.registerPreToolUse(h);
        const r = await mgr.triggerPreToolUse('Read', { file_path: '/etc/passwd' }, {});
        return r.allowed; // Safety hooks only apply to Bash
      },
    },

    // ── 参数修改 Hook 测试 ────────────────────────────────────────
    {
      id: 'hk_007',
      name: 'hook can modify params',
      category: 'hooks',
      run: async () => {
        const mgr = new HookManager();
        mgr.registerPreToolUse(async (toolName, params) => {
          return { allowed: true, modifiedParams: { ...params, _hooked: true } };
        });
        const r = await mgr.triggerPreToolUse('read', { file_path: 'test.js' }, {});
        return r.allowed && r.params._hooked === true;
      },
    },
    {
      id: 'hk_008',
      name: 'hook can block execution with reason',
      category: 'hooks',
      run: async () => {
        const mgr = new HookManager();
        mgr.registerPreToolUse(async () => {
          return { allowed: false, blockReason: 'Test block: file outside workspace' };
        });
        const r = await mgr.triggerPreToolUse('Write', { file_path: '/etc/hosts' }, {});
        return !r.allowed && r.blockReason.includes('Test block');
      },
    },
    {
      id: 'hk_009',
      name: 'hook returning false is treated as blocked',
      category: 'hooks',
      run: async () => {
        const mgr = new HookManager();
        mgr.registerPreToolUse(async () => false);
        const r = await mgr.triggerPreToolUse('Bash', { command: 'ls' }, {});
        return !r.allowed;
      },
    },

    // ── 优先级排序测试 ────────────────────────────────────────────
    {
      id: 'hk_010',
      name: 'hooks execute in priority order (high first)',
      category: 'hooks',
      run: async () => {
        const mgr = new HookManager();
        const order = [];
        mgr.registerPreToolUsePriority(async () => { order.push('low'); return { allowed: true }; }, 10);
        mgr.registerPreToolUsePriority(async () => { order.push('high'); return { allowed: true }; }, 90);
        mgr.registerPreToolUsePriority(async () => { order.push('mid'); return { allowed: true }; }, 50);
        await mgr.triggerPreToolUse('Test', {}, {});
        return order[0] === 'high' && order[1] === 'mid' && order[2] === 'low';
      },
    },
    {
      id: 'hk_011',
      name: 'high-priority hook block stops chain',
      category: 'hooks',
      run: async () => {
        const mgr = new HookManager();
        const called = [];
        mgr.registerPreToolUsePriority(async () => { called.push('blocker'); return { allowed: false }; }, 100);
        mgr.registerPreToolUsePriority(async () => { called.push('never'); return { allowed: true }; }, 1);
        await mgr.triggerPreToolUse('Test', {}, {});
        return called.length === 1 && called[0] === 'blocker';
      },
    },

    // ── PostToolUse Hook 测试 ──────────────────────────────────────
    {
      id: 'hk_012',
      name: 'postToolUse hooks fire after execution',
      category: 'hooks',
      run: async () => {
        const mgr = new HookManager();
        let fired = false;
        mgr.registerPostToolUse(async (toolName, params, result) => {
          fired = true;
        });
        await mgr.triggerPostToolUse('Read', { file_path: 'test.js' }, { content: 'hello' }, {});
        return fired;
      },
    },
    {
      id: 'hk_013',
      name: 'postToolUse hook error does not crash',
      category: 'hooks',
      run: async () => {
        const mgr = new HookManager();
        mgr.registerPostToolUse(async () => { throw new Error('test error'); });
        // Should not throw
        try {
          await mgr.triggerPostToolUse('Read', {}, {}, {});
          return true;
        } catch { return false; }
      },
    },

    // ── Command Hook 测试 ──────────────────────────────────────────
    {
      id: 'hk_014',
      name: 'command hook registration and structure',
      category: 'hooks',
      run: () => {
        const mgr = new HookManager();
        mgr.registerCommandHook({ id: 'test-cmd', command: 'echo hello', events: ['pre'] });
        const counts = mgr.getHookCounts();
        return counts.command === 1;
      },
    },
    {
      id: 'hk_015',
      name: 'command hook with matcher triggers correctly',
      category: 'hooks',
      run: async () => {
        const mgr = new HookManager();
        mgr.registerCommandHook({
          id: 'test-echo',
          command: 'echo "Bash called"',
          matcher: (toolName) => toolName === 'Bash',
          events: ['pre'],
        });
        // triggerCommandHooks with matching tool
        const results = await mgr.triggerCommandHooks('pre', 'Bash', {}, null, {});
        return results.length === 1 && results[0].success === true;
      },
    },
    {
      id: 'hk_016',
      name: 'command hook matcher filters non-matching tools',
      category: 'hooks',
      run: async () => {
        const mgr = new HookManager();
        mgr.registerCommandHook({
          id: 'test-echo',
          command: 'echo "Bash called"',
          matcher: (toolName) => toolName === 'Bash',
          events: ['pre'],
        });
        // triggerCommandHooks with non-matching tool
        const results = await mgr.triggerCommandHooks('pre', 'Read', {}, null, {});
        return results.length === 0;
      },
    },

    // ── HTTP Hook 测试 ─────────────────────────────────────────────
    {
      id: 'hk_017',
      name: 'http hook registration and structure',
      category: 'hooks',
      run: () => {
        const mgr = new HookManager();
        mgr.registerHttpHook({ id: 'test-webhook', url: 'http://localhost/test' });
        const counts = mgr.getHookCounts();
        return counts.http === 1;
      },
    },

    // ── Prompt/Agent Hook 测试 ─────────────────────────────────────
    {
      id: 'hk_018',
      name: 'prompt hook registration',
      category: 'hooks',
      run: () => {
        const mgr = new HookManager();
        mgr.registerPromptHook({ id: 'test-prompt', promptTemplate: 'Analyze: ${toolName}' });
        const counts = mgr.getHookCounts();
        return counts.prompt === 1;
      },
    },
    {
      id: 'hk_019',
      name: 'agent hook registration',
      category: 'hooks',
      run: () => {
        const mgr = new HookManager();
        mgr.registerAgentHook({ id: 'test-agent', agentDef: { name: 'TestAgent' } });
        const counts = mgr.getHookCounts();
        return counts.agent === 1;
      },
    },

    // ── Stop/Unresponsive Hook 测试 ────────────────────────────────
    {
      id: 'hk_020',
      name: 'stop hooks fire on triggerStopHooks',
      category: 'hooks',
      run: async () => {
        const mgr = new HookManager();
        let fired = false;
        mgr.registerStopHook(async () => { fired = true; });
        await mgr.triggerStopHooks({});
        return fired;
      },
    },
    {
      id: 'hk_021',
      name: 'unresponsive hooks fire with duration',
      category: 'hooks',
      run: async () => {
        const mgr = new HookManager();
        let duration = 0;
        mgr.registerUnresponsiveHook(async (session, hangMs) => { duration = hangMs; });
        await mgr.triggerUnresponsiveHooks({}, 5000);
        return duration === 5000;
      },
    },

    // ── Path Permission Hook 测试 ──────────────────────────────────
    {
      id: 'hk_022',
      name: 'path permission hook allows workspace writes',
      category: 'hooks',
      run: async () => {
        const pathRules = new PathRuleEngine({ workspaceRoot: '/tmp/test-workspace' });
        const hooks = HookManager.createPathPermissionHooks(pathRules);
        const mgr = new HookManager();
        for (const h of hooks) mgr.registerPreToolUse(h);
        const r = await mgr.triggerPreToolUse('Write', { file_path: '/tmp/test-workspace/output.txt' }, {});
        return r.allowed;
      },
    },

    // ── EventEmitter 测试 ──────────────────────────────────────────
    {
      id: 'hk_023',
      name: 'tool blocked publishes via EventBus',
      category: 'hooks',
      run: async () => {
        const mgr = new HookManager();
        let emitted = false;
        const unsub = getEventBus().subscribe('tool:blocked', () => { emitted = true; });
        mgr.registerPreToolUse(async () => ({ allowed: false, blockReason: 'test' }));
        await mgr.triggerPreToolUse('Bash', { command: 'ls' }, {});
        unsub();
        return emitted;
      },
    },
    {
      id: 'hk_024',
      name: 'preToolUse hook returns correct data in result',
      category: 'hooks',
      run: async () => {
        const mgr = new HookManager();
        const r = await mgr.triggerPreToolUse('Read', { file_path: 'test.js' }, {});
        return r.allowed && r.params.file_path === 'test.js';
      },
    },

    // ── Hook 计数测试 ─────────────────────────────────────────────
    {
      id: 'hk_025',
      name: 'getHookCounts returns correct totals',
      category: 'hooks',
      run: async () => {
        const mgr = new HookManager();
        mgr.registerPreToolUse(async () => ({ allowed: true }));
        mgr.registerPreToolUse(async () => ({ allowed: true }));
        mgr.registerPostToolUse(async () => {});
        mgr.registerStopHook(async () => {});
        const counts = mgr.getHookCounts();
        return counts.preToolUse === 2 && counts.postToolUse === 1 && counts.stop === 1;
      },
    },

    // ── registerIntoRegistry 集成测试 ──────────────────────────────
    {
      id: 'hk_026',
      name: 'registerIntoRegistry adds preExecuteHook to toolRegistry',
      category: 'hooks',
      run: () => {
        const mgr = new HookManager();
        const preHooks = [];
        const mockRegistry = {
          addPreExecuteHook: (fn) => { preHooks.push(fn); },
        };
        mgr.registerIntoRegistry(mockRegistry);
        return preHooks.length === 1 && typeof preHooks[0] === 'function';
      },
    },
    {
      id: 'hk_027',
      name: 'registerIntoRegistry gracefully handles unsupported registry',
      category: 'hooks',
      run: () => {
        const mgr = new HookManager();
        // Should not throw for registry without addPreExecuteHook
        try {
          mgr.registerIntoRegistry({});
          return true;
        } catch { return false; }
      },
    },
    {
      id: 'hk_028',
      name: 'registerIntoRegistry hook blocks on contract violation',
      category: 'hooks',
      run: async () => {
        const mgr = new HookManager();
        mgr.registerPreToolUse(async () => ({ allowed: false, blockReason: 'Blocked by policy' }));
        const preHooks = [];
        const mockRegistry = {
          addPreExecuteHook: (fn) => { preHooks.push(fn); },
        };
        mgr.registerIntoRegistry(mockRegistry);
        // Execute the registered preExecuteHook
        const result = await preHooks[0]('Write', { file_path: '/tmp/test' }, {});
        return result.blocked === true && result.errorCode === 'HOOK_BLOCKED';
      },
    },

    // ── 权限模式接线测试 (2026-08-15 P1-1) ────────────────────────
    {
      id: 'hk_029',
      name: 'DEFAULT mode: path permission hook allows workspace writes',
      category: 'hooks',
      run: async () => {
        setPermissionMode(PERMISSION_MODE.DEFAULT);
        try {
          const pathRules = new PathRuleEngine({ workspaceRoot: '/tmp/test-workspace' });
          const mgr = new HookManager();
          for (const h of HookManager.createPathPermissionHooks(pathRules)) mgr.registerPreToolUse(h);
          const r = await mgr.triggerPreToolUse('Write', { file_path: '/tmp/test-workspace/output.txt' }, {});
          return r.allowed === true;
        } finally {
          setPermissionMode(PERMISSION_MODE.DEFAULT);
        }
      },
    },
    {
      id: 'hk_030',
      name: 'DEFAULT mode mirrors pre-wiring behavior: outside-workspace reads allowed',
      category: 'hooks',
      run: async () => {
        setPermissionMode(PERMISSION_MODE.DEFAULT);
        try {
          const pathRules = new PathRuleEngine({ workspaceRoot: '/tmp/test-workspace' });
          const mgr = new HookManager();
          for (const h of HookManager.createPathPermissionHooks(pathRules)) mgr.registerPreToolUse(h);
          const r = await mgr.triggerPreToolUse('read', { file_path: '/somewhere/else/notes.md' }, {});
          return r.allowed === true;
        } finally {
          setPermissionMode(PERMISSION_MODE.DEFAULT);
        }
      },
    },
    {
      id: 'hk_031',
      name: 'PLAN mode blocks writes via path permission hook',
      category: 'hooks',
      run: async () => {
        setPermissionMode(PERMISSION_MODE.PLAN);
        try {
          const pathRules = new PathRuleEngine({ workspaceRoot: '/tmp/test-workspace' });
          const mgr = new HookManager();
          for (const h of HookManager.createPathPermissionHooks(pathRules)) mgr.registerPreToolUse(h);
          const r = await mgr.triggerPreToolUse('Write', { file_path: '/tmp/test-workspace/output.txt' }, {});
          return r.allowed === false && r.blockReason.includes('Write denied');
        } finally {
          setPermissionMode(PERMISSION_MODE.DEFAULT);
        }
      },
    },
    {
      id: 'hk_032',
      name: 'FULL_AUTO mode allows writes anywhere',
      category: 'hooks',
      run: async () => {
        setPermissionMode(PERMISSION_MODE.FULL_AUTO);
        try {
          const pathRules = new PathRuleEngine({ workspaceRoot: '/tmp/test-workspace' });
          const mgr = new HookManager();
          for (const h of HookManager.createPathPermissionHooks(pathRules)) mgr.registerPreToolUse(h);
          const r = await mgr.triggerPreToolUse('Write', { file_path: '/outside/anywhere.txt' }, {});
          return r.allowed === true;
        } finally {
          setPermissionMode(PERMISSION_MODE.DEFAULT);
        }
      },
    },
    {
      id: 'hk_033',
      name: 'permission mode helpers: default mode + invalid mode rejected',
      category: 'hooks',
      run: () => {
        setPermissionMode(PERMISSION_MODE.DEFAULT);
        try {
          if (getPermissionMode() !== PERMISSION_MODE.DEFAULT) return false;
          let threw = false;
          try { setPermissionMode('bogus_mode'); } catch (e) { threw = true; }
          return threw && getPermissionMode() === PERMISSION_MODE.DEFAULT;
        } finally {
          setPermissionMode(PERMISSION_MODE.DEFAULT);
        }
      },
    },
    {
      id: 'hk_034',
      name: 'DEFAULT mode delegates to file-safety isWriteDenied: protected-path write intercepted (T7 累积E)',
      category: 'hooks',
      run: async () => {
        // 临时安全根(CRABPAW_WRITE_SAFE_ROOT)：DEFAULT 模式路径钩子委托
        // file-safety.isWriteDenied——安全根外的写入 = 保护路径写 = 拦截。
        const os = require('os');
        const path = require('path');
        const fs = require('fs');
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crabpaw-safe-root-'));
        const prev = process.env.CRABPAW_WRITE_SAFE_ROOT;
        process.env.CRABPAW_WRITE_SAFE_ROOT = tmp;
        setPermissionMode(PERMISSION_MODE.DEFAULT);
        try {
          const pathRules = new PathRuleEngine({ workspaceRoot: tmp });
          const mgr = new HookManager();
          for (const h of HookManager.createPathPermissionHooks(pathRules)) mgr.registerPreToolUse(h);
          const outside = path.join(os.tmpdir(), `crabpaw-outside-${Date.now()}.txt`);
          const rOutside = await mgr.triggerPreToolUse('Write', { file_path: outside }, {});
          const rInside = await mgr.triggerPreToolUse('Write', { file_path: path.join(tmp, 'ok.txt') }, {});
          return rOutside.allowed === false && String(rOutside.blockReason || '').includes('Write denied')
            && rInside.allowed === true;
        } finally {
          if (prev === undefined) delete process.env.CRABPAW_WRITE_SAFE_ROOT; else process.env.CRABPAW_WRITE_SAFE_ROOT = prev;
          setPermissionMode(PERMISSION_MODE.DEFAULT);
          try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (cleanupErr) { console.warn('[hk_034] cleanup failed:', cleanupErr?.message); }
        }
      },
    },
  ],
};
