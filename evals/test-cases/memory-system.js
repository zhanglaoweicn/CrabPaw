/**
 * E2E Test: Memory System (P1)
 *
 * 记忆体系冒烟闭环：
 * - addMemory → searchMemories（主协调器 FTS 检索）
 * - addMemory → unified-store 落盘（HybridRetrievalEngine 数据源）
 * - HybridRetrievalEngine 检索（个人 namespace 查询命中 global 共享记忆）
 * - 会话记忆（SessionMemory / getFullContext）
 * - MemoryAuditor 工具层（extract / recall）
 *
 * 每个用例使用唯一标记内容，避免并行运行时相互干扰。
 */
const { memoryManager } = require('../../src/core/memory-system');
const { getUnifiedStore } = require('../../src/core/memory/unified-store');
const { getHybridRetrievalEngine } = require('../../src/core/memory/hybrid-retrieval');

// 统一测试标记：所有写入的记忆带此前缀，mem_cleanup 用例负责清理。
// 2026-08-31 Eval 隔离轮 Task 2：eval 进程数据目录已隔离到 mkdtemp 临时根
// （evals/isolated-data-dir.js），本套件不再触碰真实 data/.crabpaw；
// 清理逻辑保留——现在清理的是隔离目录内本套件产物，防止套件内并行用例
// 间相互干扰，并在隔离失效（如宿主进程内运行）时兜底保护真实库。
const TEST_MARK = `eval_mem_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;

function uniqueTag(prefix) {
  return `${prefix}_${TEST_MARK}`;
}

module.exports = {
  name: 'Memory System Tests',
  cases: [
    {
      id: 'mem_001',
      name: 'addMemory → searchMemories closed loop',
      category: 'memory',
      tags: ['P1', 'cap:memory', 'severity:critical'],
      run: async () => {
        await memoryManager.initialize();
        const tag = uniqueTag('mem_test');
        await memoryManager.addMemory('fact', `记忆测试-${tag}`, `这是记忆闭环测试内容 ${tag}`, ['test'], 'private');
        const results = await memoryManager.searchMemories(tag, 5);
        return results.length > 0 && results.some(r => (r.content || '').includes(tag));
      },
    },
    {
      id: 'mem_002',
      name: 'addMemory persists to unified-store (global ns)',
      category: 'memory',
      tags: ['P1', 'cap:memory'],
      run: async () => {
        await memoryManager.initialize();
        const tag = uniqueTag('mem_store');
        // 唯一标记前置：addMemory 近重复键取归一化后前 40 字符，
        // 固定前缀 "unified-store落盘验证mem_store_eval_mem_" 已占 36 字符、
        // 余 4 字符为时间戳高位(跨天稳定)，会导致跨运行误判近重复而 skip 落盘。
        await memoryManager.addMemory('fact', `存储测试-${tag}`, `${tag} unified-store 落盘验证`, ['test'], 'private');
        const store = getUnifiedStore();
        const all = store.getAllMemories({ limit: 500 });
        const hit = all.find(m => (m.content || '').includes(tag));
        return !!hit && hit.namespace === 'global';
      },
    },
    {
      id: 'mem_003',
      name: 'HybridRetrievalEngine finds global memory from personal ns',
      category: 'memory',
      tags: ['P1', 'cap:memory', 'severity:major'],
      run: async () => {
        await memoryManager.initialize();
        const tag = uniqueTag('mem_hybrid');
        await memoryManager.addMemory('fact', `混合检索-${tag}`, `混合检索引擎命中验证 ${tag}`, ['test'], 'private');
        const hybrid = await getHybridRetrievalEngine();
        const results = await hybrid.search(tag, { namespace: `user-${Date.now()}`, types: ['memory'], limit: 5 });
        return results.length > 0 && results.some(r => (r.content || '').includes(tag));
      },
    },
    {
      id: 'mem_004',
      name: 'SessionMemory addMessage/getSession round-trip',
      category: 'memory',
      tags: ['P2', 'cap:memory'],
      run: async () => {
        await memoryManager.initialize();
        const sessionId = `mem_session_${Date.now()}`;
        memoryManager.addMessage(sessionId, 'user', `会话消息内容 ${sessionId}`);
        const session = memoryManager.getSession(sessionId);
        return !!session && session.messages.length > 0;
      },
    },
    {
      id: 'mem_005',
      name: 'getFullContext includes recent session content',
      category: 'memory',
      tags: ['P2', 'cap:memory'],
      run: async () => {
        await memoryManager.initialize();
        const sessionId = `mem_ctx_${Date.now()}`;
        const content = `上下文验证 ${sessionId}`;
        memoryManager.addMessage(sessionId, 'user', content);
        const ctx = await memoryManager.getFullContext(sessionId, '查看');
        const serialized = JSON.stringify(ctx);
        return serialized.includes(sessionId);
      },
    },
    {
      id: 'mem_006',
      name: 'MemoryAuditor extract produces facts',
      category: 'memory',
      tags: ['P2', 'cap:memory'],
      run: () => {
        const { getMemoryAuditor } = require('../../src/core/memory-audit');
        const auditor = getMemoryAuditor();
        const results = auditor.extract('用户说他喜欢喝椰子水，明天要去海口出差');
        return Array.isArray(results) && results.length > 0;
      },
    },
    {
      id: 'mem_007',
      name: 'MemoryAuditor recall retrieves stored memory',
      category: 'memory',
      tags: ['P2', 'cap:memory'],
      run: () => {
        const { getMemoryAuditor } = require('../../src/core/memory-audit');
        const auditor = getMemoryAuditor();
        const tag = uniqueTag('recall_test');
        const entry = auditor.add({ text: `回忆目标内容 ${tag}`, importance: 5 });
        const results = auditor.recall(tag, { limit: 3 });
        return !!entry && results.length > 0 && results.some(r => (r.text || r.content || '').includes(tag));
      },
    },
    {
      id: 'mem_008',
      name: 'MemoryRecall tool finds persisted memories',
      category: 'memory',
      tags: ['P1', 'cap:memory'],
      run: async () => {
        await memoryManager.initialize();
        const tag = uniqueTag('tool_recall');
        await memoryManager.addMemory('fact', `工具检索-${tag}`, `MemoryRecall 工具检索验证 ${tag}`, ['test'], 'private');
        const { registry } = require('../../src/tools/registry');
        // 确保工具已注册（require 副作用注册）
        require('../../src/tools/memory-audit-tool');
        const tool = registry.get('MemoryRecall');
        if (!tool) return false;
        const result = await tool.handler({ query: tag, limit: 5 });
        const results = result.results || [];
        return results.some(r => (r.text || r.content || '').includes(tag));
      },
    },
    {
      id: 'mem_009',
      name: 'gateCheck rejects one-off queries and meta-descriptions',
      category: 'memory',
      tags: ['P2', 'cap:memory'],
      run: () => {
        const { memoryExtractionService } = require('../../src/services/memoryExtraction');
        const junk1 = memoryExtractionService._gateCheck({ content: '用户询问当前时间', confidence: 0.8 });
        const junk2 = memoryExtractionService._gateCheck({ content: '现在几点了？', confidence: 0.8 });
        const good = memoryExtractionService._gateCheck({ content: '用户表示喜欢喝椰子水', confidence: 0.8 });
        return junk1 === false && junk2 === false && good === true;
      },
    },
    {
      id: 'mem_cleanup',
      name: 'cleanup test artifacts from (isolated) data dir',
      category: 'memory',
      tags: ['P2', 'cap:memory'],
      run: async () => {
        const fs = require('fs');
        const path = require('path');
        await memoryManager.initialize();
        let removed = 0;

        // 1. autoMemory 内存条目 + 独立文件（mem_*.md）
        const filePaths = [];
        for (const [id, m] of memoryManager.autoMemory.memories) {
          if ((m.title || '').includes(TEST_MARK) || (m.content || '').includes(TEST_MARK)) {
            filePaths.push(path.join(require('../../src/core/memory-system').MEMORY_DIR, `${id}.md`));
            memoryManager.autoMemory.memories.delete(id);
            memoryManager.autoMemory.index = memoryManager.autoMemory.index.filter(e => e.file !== `${id}.md`);
            removed++;
          }
        }
        for (const fp of filePaths) {
          try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch { /* best-effort */ }
        }
        await memoryManager.autoMemory.save();

        // 2. unified-store memories 表
        try {
          const store = getUnifiedStore();
          const all = store.getAllMemories({ limit: 500 });
          for (const m of all) {
            if ((m.content || '').includes(TEST_MARK)) {
              try { store.deleteMemory(m.id); removed++; } catch { /* best-effort */ }
            }
          }
        } catch { /* best-effort */ }

        return removed >= 0;
      },
    },
  ],
};
