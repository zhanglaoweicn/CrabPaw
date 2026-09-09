/**
 * 专家真传（_expert → SubAgent）单元测试——部门化 P4（2026-09-05）
 * 断言：岗位人设以独立 system 消息注入 SubAgent（无 800 字截断），
 *       无 _expert 时行为不变（类型级人设 + goal 直传）。
 * 注入 fake llmFn 捕获 messages——不触真实 LLM。
 */

const { delegateTasks } = require('../core/subagent-enhanced');
const state = require('../core/state');

beforeAll(() => {
  try { state.initState({}); } catch (e) { /* 已初始化 */ }
});

describe('_expert 真传链(delegateTasks → SubAgent 消息)', () => {
  test('带 _expert: 岗位人设成为独立 system 消息, 完整无截断', async () => {
    const captured = [];
    const longPersona = '你是财务专家。'.repeat(200); // 1200 字 > 旧 800 字截断
    const results = await delegateTasks(
      [{ goal: '【子任务】算清成本', type: 'ANALYZE', _expert: { id: 'finance_advisor', name: '财务顾问', systemPrompt: longPersona } }],
      {
        llmFn: async (messages) => {
          if (captured.length === 0) captured.push(messages);
          return { content: '任务完成' };
        },
        onTaskComplete: () => {},
      }
    );
    expect(results[0].status).toBe('completed');
    const msgs = captured[0];
    const systemMsgs = msgs.filter((m) => m.role === 'system');
    // 类型人设 + 岗位身份两条 system
    expect(systemMsgs.length).toBe(2);
    expect(systemMsgs[1].content).toContain('【岗位身份：财务顾问】');
    expect(systemMsgs[1].content).toContain('你是财务专家。');
    // 无 800 字截断: 完整人设长度保留
    expect(systemMsgs[1].content.length).toBeGreaterThanOrEqual(longPersona.length);
  });

  test('无 _expert: 行为不变(仅类型人设, goal 直传 user)', async () => {
    const captured = [];
    const results = await delegateTasks(
      [{ goal: '【子任务】普通任务', type: 'ANALYZE' }],
      {
        llmFn: async (messages) => {
          if (captured.length === 0) captured.push(messages);
          return { content: '任务完成' };
        },
      }
    );
    expect(results[0].status).toBe('completed');
    const msgs = captured[0];
    expect(msgs.filter((m) => m.role === 'system').length).toBe(1);
    expect(msgs.find((m) => m.role === 'user').content).toContain('【子任务】普通任务');
  });

  test('goal 不再携带人设前缀(真传后消除双份冗余)', async () => {
    const captured = [];
    await delegateTasks(
      [{ goal: '【子任务】算清成本', type: 'ANALYZE', _expert: { id: 'x', name: '财务顾问', systemPrompt: '人设内容' } }],
      {
        llmFn: async (messages) => {
          if (captured.length === 0) captured.push(messages);
          return { content: 'done' };
        },
      }
    );
    const userMsg = captured[0].find((m) => m.role === 'user');
    expect(userMsg.content).not.toContain('【专家：'); // 前缀不再拼进 goal
  });
});

// ─── 2026-09-07: 稀疏数组假完成回归——delegateTasks 并发完成判定 ───
// 实测：4 成员例会恒定 2 个"整体看门狗"超时——results 是按下标回填的稀疏数组，
// 旧判定 results.length === agents.length 在"最后下标的任务先完成"时立即成立
//（length 只反映最高下标+1），runner 提前 resolve，仍在跑的成员被上层协作
// 看门狗标记超时。修复：显式 completed 计数。
describe('delegateTasks 稀疏数组假完成回归（2026-09-07）', () => {
  test('末位任务先完成 → 不提前 resolve，等全部任务落定', async () => {
    const t0 = Date.now();
    const results = await delegateTasks(
      [
        { goal: '慢任务A', type: 'ANALYZE' },
        { goal: '慢任务B', type: 'ANALYZE' },
        { goal: '快任务C', type: 'ANALYZE' },
      ],
      {
        llmFn: async (messages) => {
          const goal = messages.find(m => m.role === 'user')?.content || '';
          // 模拟真实竞速：数组末位(C)最快，前两位(A/B)慢 800ms
          const delay = goal.includes('快任务C') ? 10 : 800;
          await new Promise(r => setTimeout(r, delay));
          return { content: `完成: ${goal}` };
        },
      }
    );
    const elapsed = Date.now() - t0;
    // 提前假完成的话，resolve 发生在 ~10ms（C 完成即返回）
    expect(elapsed).toBeGreaterThanOrEqual(700);
    // 三个结果按原下标齐备且全部完成
    expect(results.length).toBe(3);
    for (const r of results) {
      expect(r.status).toBe('completed');
      expect(r.result).toBeTruthy();
    }
  }, 10000);

  test('完成计数含失败任务——失败不吞计数（不悬挂）', async () => {
    const results = await delegateTasks(
      [
        { goal: '会失败的任务', type: 'ANALYZE' },
        { goal: '正常任务', type: 'ANALYZE' },
      ],
      {
        llmFn: async (messages) => {
          const goal = messages.find(m => m.role === 'user')?.content || '';
          if (goal.includes('会失败')) throw new Error('模拟 LLM 失败');
          return { content: 'ok' };
        },
      }
    );
    expect(results.length).toBe(2);
    expect(results[0].status).toBe('failed');
    expect(results[1].status).toBe('completed');
  });
});
