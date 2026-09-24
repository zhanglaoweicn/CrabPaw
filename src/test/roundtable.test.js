/**
 * 圆桌会（roundtable）单元测试（2026-09-20）
 * 覆盖：跨部门选人/部门选人、两轮编排与发言可见性、老板插话注入、
 *       结论+任务解析、音色稳定绑定与补位、进行中单例闸。
 * 注入 fake runner（不触真实 LLM）；CRABPAW_DATA_DIR 指向临时目录隔离落盘。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-'));
process.env.CRABPAW_DATA_DIR = TEST_DATA_DIR;

// 专家库 mock：6 岗位 5 部门（营销 2 席用于验证部门多样性上限）
jest.mock('../core/experts/index', () => {
  const experts = [
    { id: 'boss_cockpit', name: '驾驶舱', title: '首席经营官', department: 'strategy_invest', status: 'active', systemPrompt: '你是经营分析专家' },
    { id: 'finance_advisor', name: '财务顾问', title: '财务主管', department: 'finance', status: 'active', systemPrompt: '你是财务专家' },
    { id: 'sales_director', name: '销售总监', title: '销售主管', department: 'sales', status: 'active', systemPrompt: '你是销售专家' },
    { id: 'hr_manager', name: '人力经理', title: 'HR主管', department: 'hr_admin', status: 'active', systemPrompt: '你是人力专家' },
    { id: 'mkt_one', name: '营销顾问', title: '营销策划', department: 'marketing', status: 'active', systemPrompt: '你是营销专家' },
    { id: 'mkt_two', name: '品牌顾问', title: '品牌', department: 'marketing', status: 'active', systemPrompt: '你是品牌专家' },
  ];
  return {
    getExpert: (id) => experts.find((e) => e.id === id) || null,
    getDepartments: () => [{ id: 'finance', label: '财务部', lead: 'finance_advisor' }],
    getTeamPresets: () => [],
    getAllExperts: () => experts,
    routeMessage: () => experts.map((e) => ({ expertId: e.id, score: 10 })),
  };
});

const state = require('../core/state');
const rt = require('../core/experts/roundtable');

beforeAll(() => {
  try { state.initState({}); } catch (e) { /* 已初始化 */ }
});

function waitFor(fn, timeoutMs = 8000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (fn()) return resolve();
      } catch (e) { return reject(e); }
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor 超时'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe('意图识别与议题提取', () => {
  test('圆桌/开会讨论句式命中，普通消息不误触', () => {
    expect(rt.isRoundtableIntent('专家们一起开会讨论明年计划')).toBe(true);
    expect(rt.isRoundtableIntent('开个圆桌会聊聊定价')).toBe(true);
    expect(rt.isRoundtableIntent('开个会讨论下成本')).toBe(true);
    expect(rt.isRoundtableIntent('今天天气怎么样')).toBe(false);
    expect(rt.isRoundtableIntent('帮我写个月度总结')).toBe(false);
  });

  test('extractGoal 优先取「讨论 X」宾语', () => {
    expect(rt.extractGoal('专家们开个会讨论2026年业务计划')).toBe('2026年业务计划');
    expect(rt.extractGoal('圆桌会讨论一下降本增效')).toBe('一下降本增效');
  });
});

describe('结论+任务解析', () => {
  test('标准收口文本解析出结论与任务', () => {
    const c = rt.parseConclusion('## 会议结论\n大家一致认为应聚焦主业并控制成本。\n## 任务清单\n【财务顾问】出一份预算初稿\n【销售总监】提交Q4冲刺方案。');
    expect(c.text).toContain('聚焦主业');
    expect(c.tasks).toHaveLength(2);
    expect(c.tasks[0]).toEqual({ owner: '财务顾问', task: '出一份预算初稿' });
    expect(c.tasks[1].task).toBe('提交Q4冲刺方案'); // 尾部句号被清理
  });

  test('无任务/缺结构时优雅降级', () => {
    const c1 = rt.parseConclusion('## 会议结论\n只达成共识。\n## 任务清单\n无');
    expect(c1.tasks).toHaveLength(0);
    const c2 = rt.parseConclusion('一段没有结构的文字结论');
    expect(c2.text).toContain('没有结构');
    expect(c2.tasks).toHaveLength(0);
  });
});

describe('音色稳定绑定', () => {
  test('同人同声/新人间隔音/池耗尽不崩', () => {
    const first = rt.assignVoices(['exp_a', 'exp_b', 'exp_c']);
    expect(new Set(first).size).toBe(3); // 三人三声
    const again = rt.assignVoices(['exp_a']);
    expect(again[0]).toBe(first[0]); // 稳定绑定
    const many = rt.assignVoices(Array.from({ length: rt.VOICE_POOL.length + 4 }, (_, i) => `bulk_${i}`));
    expect(many.every((v) => rt.VOICE_POOL.includes(v))).toBe(true); // 轮转仍在池内
  });
});

describe('选人', () => {
  test('跨部门模式：主持=路由榜首, 成员≤4且部门多样性', () => {
    const { host, members } = rt.selectRoster({ goal: '2026年业务计划' });
    expect(host.id).toBe('boss_cockpit');
    expect(members.length).toBeLessThanOrEqual(rt.MAX_MEMBERS);
    expect(members.length).toBe(4);
    const deptCount = {};
    [host, ...members].forEach((e) => { deptCount[e.department] = (deptCount[e.department] || 0) + 1; });
    expect(Math.max(...Object.values(deptCount))).toBeLessThanOrEqual(2);
  });

  test('部门模式：主管任主持', () => {
    const { host, mode } = rt.selectRoster({ department: 'finance' });
    expect(mode).toBe('department');
    expect(host.id).toBe('finance_advisor');
  });
});

describe('数据简报与发言数字纪律', () => {
  test('有简报：prompt 注入简报原文与引用纪律；无简报：降级定性声明', () => {
    const expert = { id: 'finance_advisor', name: '财务顾问', title: '财务主管', department: 'finance' };
    const base = { goal: '2026年业务计划', host: { id: 'boss_cockpit', name: '驾驶舱' }, statements: [], interventions: [] };
    const withBrief = rt.statementPrompt(expert, { ...base, dataBrief: '【会场数据简报】· 销售：14 笔' }, 1);
    expect(withBrief).toContain('【会场数据简报】');
    expect(withBrief).toContain('禁止编造简报之外的数字');
    const noBrief = rt.statementPrompt(expert, { ...base }, 2);
    expect(noBrief).toContain('定性分析');
    expect(noBrief).toContain('严禁编造任何具体数字');
    // 收口同样吃数字纪律
    const synth = rt.synthesisPrompt({ ...base, dataBrief: '【会场数据简报】x' });
    expect(synth).toContain('结论必须有数字支撑');
  });

  test('collectDataBrief 在无库环境安全降级为空串', () => {
    expect(typeof rt.collectDataBrief()).toBe('string');
  });
});

describe('整场编排（fake runner）', () => {
  test('两轮发言互相可见 + 插话进入后续 prompt + 收口三件套', async () => {
    const prompts = [];
    let released = false;
    let releaseRound;
    const gate = new Promise((r) => { releaseRound = r; });

    const runner = async (taskDefs) => {
      const results = [];
      for (const def of taskDefs) {
        prompts.push(def.goal);
        // 第 5 条发言（round1 末位）处设闸：保证插话发生在全部 round2 prompt 构建之前
        if (prompts.length === 5 && !released) await gate;
        if (def.goal.includes('收口')) {
          results.push({ status: 'completed', result: '## 会议结论\n一致认为聚焦主业与现金流。\n## 任务清单\n【财务顾问】出预算初稿\n【销售总监】交Q4冲刺方案' });
        } else if (def.goal.includes('第二轮')) {
          results.push({ status: 'completed', result: '第二轮：坚持立场并吸收同事观点。' });
        } else {
          results.push({ status: 'completed', result: `第一轮观点（${prompts.length}）` });
        }
      }
      return results;
    };

    const started = await rt.startRoundtable({ goal: '2026年业务计划', sessionId: 'jest-user' }, { runner });
    expect(started.alreadyRunning).toBeUndefined();

    // 等待编排闸住（5 条 prompt 已发起）
    await waitFor(() => prompts.length >= 5);

    // 进行中单例闸：再次召开返回既有会议
    const second = await rt.startRoundtable({ goal: '另一个议题' }, { runner });
    expect(second.alreadyRunning).toBe(true);
    expect(second.meetingId).toBe(started.meetingId);

    // 老板插话（会中生效）→ 放行
    const iv = rt.interveneRoundtable(started.meetingId, '重点考虑现金流');
    expect(iv.ok).toBe(true);
    releaseRound();

    const final = await waitFor(() => rt.getRoundtable(started.meetingId).phase === 'done')
      .then(() => rt.getRoundtable(started.meetingId));

    // 结构：round1=5（主持+4成员）、round2=4、收口=1，共 10 条
    expect(final.statements).toHaveLength(10);
    expect(final.statements.filter((s) => s.round === 1)).toHaveLength(5);
    expect(final.statements.filter((s) => s.round === 2)).toHaveLength(4);
    expect(final.statements[0].expertId).toBe('boss_cockpit'); // 主持先开场
    expect(final.statements[9].round).toBe(3);

    // 第二轮 prompt 可见第一轮发言 + 老板插话（用完整前缀过滤，避免误捞收口 prompt 里引用的发言文本）
    const r2Prompts = prompts.filter((p) => p.includes('【圆桌会议·第二轮】'));
    expect(r2Prompts).toHaveLength(4);
    r2Prompts.forEach((p) => {
      expect(p).toContain('第一轮观点');
      expect(p).toContain('【老板插话·必须重视】重点考虑现金流');
    });

    // 结论与任务
    expect(final.conclusion.text).toContain('聚焦主业');
    expect(final.conclusion.tasks).toHaveLength(2);

    // 每位专家的发言携带音色（豆包池绑定）
    final.statements.forEach((s) => expect(s.voice).toBeTruthy());

    // 进行中单例解除：会议结束后可再开（只验证不再返回同一 meetingId）
    const third = await rt.startRoundtable({ goal: '复盘会' }, { runner: async (defs) => defs.map(() => ({ status: 'completed', result: 'ok' })) });
    expect(third.meetingId).not.toBe(started.meetingId);
    await waitFor(() => ['done', 'error'].includes(rt.getRoundtable(third.meetingId).phase));
  }, 20000);

  test('插话通道：会议结束后拒绝', async () => {
    const r = await rt.startRoundtable({ goal: '快闪会' }, { runner: async (defs) => defs.map(() => ({ status: 'completed', result: '## 会议结论\n无分歧。\n## 任务清单\n无' })) });
    await waitFor(() => rt.getRoundtable(r.meetingId).phase === 'done');
    expect(rt.interveneRoundtable(r.meetingId, '晚了一步').ok).toBe(false);
  }, 15000);
});

describe('中止会议（2026-09-23）', () => {
  test('中止后不再有新发言，已产生的保留，且不落 error 口径', async () => {
    const prompts = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    let gated = false;

    const runner = async (taskDefs) => {
      const results = [];
      for (const def of taskDefs) {
        prompts.push(def.goal);
        // 第 3 条发言处设闸：模拟"某位专家正在说话时老板按了中止"
        if (prompts.length === 3 && !gated) { gated = true; await gate; }
        results.push({ status: 'completed', result: `第${prompts.length}条观点` });
      }
      return results;
    };

    const started = await rt.startRoundtable({ goal: '中止测试会', sessionId: 'jest-cancel' }, { runner });
    await waitFor(() => prompts.length >= 3);

    // 中止受理，且幂等（连点不重复置位）
    expect(rt.cancelRoundtable(started.meetingId).ok).toBe(true);
    const again = rt.cancelRoundtable(started.meetingId);
    expect(again.ok).toBe(true);
    expect(again.alreadyRequested).toBe(true);

    release();
    await waitFor(() => rt.getRoundtable(started.meetingId).phase === 'cancelled');
    const final = rt.getRoundtable(started.meetingId);

    // 核心语义：不删已说过的，只让后面的人不再开口
    expect(final.phase).toBe('cancelled');
    expect(final.statements).toHaveLength(3);
    expect(final.statements.every((s) => s.round === 1)).toBe(true);
    expect(prompts).toHaveLength(3);          // 第 4 位起未发起
    // 中止不是失败：不落 error、不产结论/纪要
    expect(final.error).toBeNull();
    expect(final.conclusion).toBeNull();
    expect(final.document).toBeNull();
    expect(final.cancelRequested).toBe(true);
  }, 20000);

  test('中止即终态——单例闸解除，可立刻再开一场', async () => {
    const a = await rt.startRoundtable({ goal: '待中止会' }, {
      runner: async (defs) => { await new Promise((r) => setTimeout(r, 5)); return defs.map(() => ({ status: 'completed', result: '观点' })); },
    });
    // 刚开就中止：一位都没开口也应被受理（不应要求"至少说过一句"）
    expect(rt.cancelRoundtable(a.meetingId).ok).toBe(true);
    await waitFor(() => rt.getRoundtable(a.meetingId).phase === 'cancelled');
    const running = rt.findRunning();
    expect(running === null || running.meetingId !== a.meetingId).toBe(true);

    const b = await rt.startRoundtable({ goal: '中止后的新会' }, {
      runner: async (defs) => defs.map(() => ({ status: 'completed', result: '## 会议结论\n无分歧。\n## 任务清单\n无' })),
    });
    expect(b.alreadyRunning).toBeUndefined();
    expect(b.meetingId).not.toBe(a.meetingId);
    await waitFor(() => ['done', 'error'].includes(rt.getRoundtable(b.meetingId).phase));
  }, 20000);

  test('已结束的会议拒绝中止；不存在的会议报 not_found', async () => {
    const r = await rt.startRoundtable({ goal: '结束态会' }, {
      runner: async (defs) => defs.map(() => ({ status: 'completed', result: '## 会议结论\n无。\n## 任务清单\n无' })),
    });
    await waitFor(() => ['done', 'error'].includes(rt.getRoundtable(r.meetingId).phase));
    const ended = rt.cancelRoundtable(r.meetingId);
    expect(ended.ok).toBe(false);
    expect(ended.reason).toBe('meeting_ended');

    const missing = rt.cancelRoundtable('rt_不存在的会议');
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe('not_found');
  }, 20000);
});
