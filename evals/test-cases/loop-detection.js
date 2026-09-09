const {
  LoopDetectionMiddleware,
  RepeatFailureGuard,
  hashToolCall,
  stableToolKey,
  normalizeToolCallArgs,
  isHardRejection,
  DEFAULT_WARN_THRESHOLD,
  DEFAULT_HARD_LIMIT,
  HARD_REJECT_REPEAT_THRESHOLD,
  REPEAT_FAILURE_THRESHOLD,
  NO_PROGRESS_FAILURE_THRESHOLD,
} = require('../../src/core/middleware/loop-detection');

module.exports = {
  name: 'Loop Detection',
  cases: [
    // ── hashToolCall 测试 ──────────────────────────────────────────
    {
      id: 'ld_001',
      name: 'hashToolCall: 相同工具+参数产生相同哈希',
      category: 'loop_detection',
      run: () => {
        const a = hashToolCall({ name: 'Bash', arguments: { command: 'ls' } });
        const b = hashToolCall({ name: 'Bash', arguments: { command: 'ls' } });
        return a.hash === b.hash && a.name === 'Bash';
      },
    },
    {
      id: 'ld_002',
      name: 'hashToolCall: 不同工具产生不同哈希',
      category: 'loop_detection',
      run: () => {
        const a = hashToolCall({ name: 'Bash', arguments: { command: 'ls' } });
        const b = hashToolCall({ name: 'Read', arguments: { file_path: 'test.js' } });
        return a.hash !== b.hash;
      },
    },
    {
      id: 'ld_003',
      name: 'hashToolCall: 不同参数产生不同哈希',
      category: 'loop_detection',
      run: () => {
        const a = hashToolCall({ name: 'WebSearch', arguments: { query: '天气' } });
        const b = hashToolCall({ name: 'WebSearch', arguments: { query: '股票' } });
        return a.hash !== b.hash;
      },
    },
    {
      id: 'ld_004',
      name: 'hashToolCall: 支持 function.call 格式',
      category: 'loop_detection',
      run: () => {
        const a = hashToolCall({ function: { name: 'Bash', arguments: '{"command":"ls"}' } });
        const b = hashToolCall({ name: 'Bash', arguments: { command: 'ls' } });
        return a.name === b.name;
      },
    },

    // ── stableToolKey 测试 ─────────────────────────────────────────
    {
      id: 'ld_005',
      name: 'stableToolKey: Read 工具合并相邻行号段',
      category: 'loop_detection',
      run: () => {
        const k1 = stableToolKey('read', { path: '/a/b.js', offset: 10, limit: 50 });
        const k2 = stableToolKey('read', { path: '/a/b.js', offset: 30, limit: 70 });
        return k1 === k2; // 都在 0-199 段内
      },
    },
    {
      id: 'ld_006',
      name: 'stableToolKey: Read 工具区分不同行号段',
      category: 'loop_detection',
      run: () => {
        const k1 = stableToolKey('read', { path: '/a/b.js', offset: 10 });
        const k2 = stableToolKey('read', { path: '/a/b.js', offset: 450 });
        return k1 !== k2; // 0-199 vs 400-599
      },
    },
    {
      id: 'ld_007',
      name: 'stableToolKey: 提取 salient 字段',
      category: 'loop_detection',
      run: () => {
        const k1 = stableToolKey('WebSearch', { query: 'test', extra: 'ignored' });
        const k2 = stableToolKey('WebSearch', { query: 'test', extra: 'different' });
        return k1 === k2; // extra 不在 salientFields 中，应被忽略
      },
    },

    // ── normalizeToolCallArgs 测试 ─────────────────────────────────
    {
      id: 'ld_008',
      name: 'normalizeToolCallArgs: 对象参数直接返回',
      category: 'loop_detection',
      run: () => {
        const result = normalizeToolCallArgs({ file_path: '/test.js', content: 'hello' });
        return result.args.file_path === '/test.js' && result.fallbackKey === null;
      },
    },
    {
      id: 'ld_009',
      name: 'normalizeToolCallArgs: JSON 字符串参数可解析',
      category: 'loop_detection',
      run: () => {
        const result = normalizeToolCallArgs('{"command":"ls -la"}');
        return result.args.command === 'ls -la' && result.fallbackKey === null;
      },
    },
    {
      id: 'ld_010',
      name: 'normalizeToolCallArgs: 非 JSON 字符串作为 fallbackKey',
      category: 'loop_detection',
      run: () => {
        const result = normalizeToolCallArgs('not json at all');
        return result.fallbackKey === 'not json at all' && typeof result.args === 'object';
      },
    },

    // ── isHardRejection 测试 ───────────────────────────────────────
    {
      id: 'ld_011',
      name: 'isHardRejection: 检测权限拒绝消息',
      category: 'loop_detection',
      run: () => {
        return isHardRejection('permission denied: cannot access this file') === true;
      },
    },
    {
      id: 'ld_012',
      name: 'isHardRejection: 正常错误不被误判',
      category: 'loop_detection',
      run: () => {
        return isHardRejection('file not found: /tmp/missing.txt') === false;
      },
    },
    {
      id: 'ld_013',
      name: 'isHardRejection: 检测中文权限拒绝',
      category: 'loop_detection',
      run: () => {
        return isHardRejection('权限不足：无法写入该目录') === true;
      },
    },
    {
      id: 'ld_014',
      name: 'isHardRejection: 空值返回 false',
      category: 'loop_detection',
      run: () => {
        return isHardRejection(null) === false && isHardRejection(undefined) === false;
      },
    },

    // ── RepeatFailureGuard 三级熔断测试 ────────────────────────────
    {
      id: 'ld_015',
      name: 'RepeatFailureGuard: 成功调用重置计数器',
      category: 'loop_detection',
      run: () => {
        const guard = new RepeatFailureGuard();
        guard.record('Bash', 'sig1', false, 'error');
        guard.record('Bash', 'sig1', false, 'error');
        const msg = guard.record('Bash', 'sig1', true, 'ok');
        // 成功后 consecutive 重置，sigCount 清除
        return msg === null && guard.consecutive === 0;
      },
    },
    {
      id: 'ld_016',
      name: 'RepeatFailureGuard: 硬拒绝 3 次触发熔断',
      category: 'loop_detection',
      run: () => {
        const guard = new RepeatFailureGuard({ hardRejectThreshold: 3 });
        guard.record('Bash', 'rm', false, 'permission denied');
        guard.record('Bash', 'rm', false, 'permission denied');
        const msg = guard.record('Bash', 'rm', false, 'permission denied');
        return msg !== null && msg.includes('disallowed action');
      },
    },
    {
      id: 'ld_017',
      name: 'RepeatFailureGuard: 相同签名重复失败 5 次触发',
      category: 'loop_detection',
      run: () => {
        const guard = new RepeatFailureGuard({ repeatFailureThreshold: 5 });
        for (let i = 0; i < 4; i++) {
          guard.record('Read', 'file1', false, 'file not found');
        }
        const msg = guard.record('Read', 'file1', false, 'file not found');
        return msg !== null && msg.includes('stuck in a loop');
      },
    },
    {
      id: 'ld_018',
      name: 'RepeatFailureGuard: 无进展 8 次连续失败触发',
      category: 'loop_detection',
      run: () => {
        const guard = new RepeatFailureGuard({ noProgressThreshold: 8 });
        const sigs = ['a','b','c','d','e','f','g','h'];
        for (let i = 0; i < 7; i++) {
          guard.record('Tool' + i, sigs[i], false, 'error ' + i);
        }
        const msg = guard.record('Tool8', 'sig8', false, 'error 8');
        return msg !== null && msg.includes('no progress');
      },
    },
    {
      id: 'ld_019',
      name: 'RepeatFailureGuard: reset 清除所有状态',
      category: 'loop_detection',
      run: () => {
        const guard = new RepeatFailureGuard();
        guard.record('Bash', 'sig1', false, 'error');
        guard.record('Bash', 'sig1', false, 'error');
        guard.reset();
        return guard.consecutive === 0 && guard.sigCounts.size === 0;
      },
    },
    {
      id: 'ld_020',
      name: 'RepeatFailureGuard: getStats 返回正确的统计信息',
      category: 'loop_detection',
      run: () => {
        const guard = new RepeatFailureGuard();
        guard.record('Bash', 'sig1', false, 'error');
        guard.record('Bash', 'sig1', false, 'error');
        guard.record('Read', 'sig2', false, 'not found');
        const stats = guard.getStats();
        return stats.consecutive === 3 && stats.trackedSignatures === 2;
      },
    },

    // ── LoopDetectionMiddleware 测试 ───────────────────────────────
    {
      id: 'ld_021',
      name: 'LoopDetectionMiddleware: 构造函数正确设置默认值',
      category: 'loop_detection',
      run: () => {
        const mw = new LoopDetectionMiddleware();
        return mw.warnThreshold === DEFAULT_WARN_THRESHOLD
          && mw.hardLimit === DEFAULT_HARD_LIMIT
          && mw.windowSize === 20;
      },
    },
    {
      id: 'ld_022',
      name: 'LoopDetectionMiddleware: 自定义配置生效',
      category: 'loop_detection',
      run: () => {
        const mw = new LoopDetectionMiddleware({ warnThreshold: 5, hardLimit: 8, windowSize: 50 });
        return mw.warnThreshold === 5 && mw.hardLimit === 8 && mw.windowSize === 50;
      },
    },
    {
      id: 'ld_023',
      name: 'LoopDetectionMiddleware: reset 清除线程状态',
      category: 'loop_detection',
      run: () => {
        const mw = new LoopDetectionMiddleware();
        // 先通过 _detectLoop 注入一些哈希
        const hashInfo = hashToolCall({ name: 'Bash', arguments: { command: 'ls' } });
        mw._detectLoop('thread1', hashInfo);
        mw._detectLoop('thread1', hashInfo);
        mw.reset('thread1');
        const stats = mw.getStats('thread1');
        return stats.totalCalls === 0;
      },
    },
    {
      id: 'ld_024',
      name: 'LoopDetectionMiddleware: recordToolResult 返回熔断消息',
      category: 'loop_detection',
      run: () => {
        const mw = new LoopDetectionMiddleware();
        // 连续 5 次相同签名的失败应触发熔断
        for (let i = 0; i < 4; i++) {
          const msg = mw.recordToolResult('t1', 'Read', 'file_missing', false, 'file not found');
          if (i < 3 && msg !== null) return false; // 前几次不应触发
        }
        const finalMsg = mw.recordToolResult('t1', 'Read', 'file_missing', false, 'file not found');
        return finalMsg !== null && finalMsg.includes('stuck in a loop');
      },
    },
    {
      id: 'ld_025',
      name: 'LoopDetectionMiddleware: 不同线程独立跟踪',
      category: 'loop_detection',
      run: () => {
        const mw = new LoopDetectionMiddleware();
        // 在线程 A 中记录失败
        mw.recordToolResult('threadA', 'Bash', 'sig1', false, 'error');
        mw.recordToolResult('threadA', 'Bash', 'sig1', false, 'error');
        // 线程 B 应该独立
        const guardB = mw._getFailureGuard('threadB');
        const statsB = guardB.getStats();
        return statsB.consecutive === 0;
      },
    },

    // ── 阈值常量测试 ──────────────────────────────────────────────
    {
      id: 'ld_026',
      name: '阈值常量符合预期值',
      category: 'loop_detection',
      run: () => {
        return HARD_REJECT_REPEAT_THRESHOLD === 3
          && REPEAT_FAILURE_THRESHOLD === 5
          && NO_PROGRESS_FAILURE_THRESHOLD === 8
          && DEFAULT_WARN_THRESHOLD === 3
          && DEFAULT_HARD_LIMIT === 5;
      },
    },
  ],
};
