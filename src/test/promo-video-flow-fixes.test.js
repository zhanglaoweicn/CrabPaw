/**
 * 宣传片卡点修复回归（2026-09-07）
 * 背景：用户实测"做个crabpaw产品宣传片视频"全流程卡死，五根因修复的回归锁。
 * 证据与诊断见 crabpaw.log 17:50-17:59 段。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── P0-2: 意图污染修复 ──────────────────────────────────────
describe('P0-2 意图分类不被专家后缀污染', () => {
  const { selectToolsForContext, INTENT_TOOLSETS } = require('../core/ai/tool-router');
  const { routeAndActivate, buildExpertPromptSuffix, getActiveExpert, reset } = require('../core/expert-context');

  test('video_gen 关键词覆盖宣传片/做视频等口语短语', () => {
    expect(INTENT_TOOLSETS.video_gen.keywords).toContain('宣传片');
    expect(INTENT_TOOLSETS.video_gen.keywords).toContain('视频');
    const r = selectToolsForContext({ message: '帮我做个crabpaw产品宣传片视频', channel: 'gui', toolSystem: null });
    expect(r.intent).toBe('video_gen');
    // media 工具集必须随意图加载（RemotionRender/VideoGenerate 所在）
    expect(r.toolsets).toContain('media');
  });

  test('专家人设后缀（含嵌套 ]）不再把意图带成 open_app', () => {
    const uid = 'test-promo-user';
    reset(uid);
    const msg = '帮我做个crabpaw产品宣传片视频';
    routeAndActivate(uid, msg);
    const active = getActiveExpert(uid);
    // 前提：该消息确实激活了营销侧专家（否则此测试没测到目标场景）
    if (!active) return;
    const polluted = msg + buildExpertPromptSuffix(active);
    const r = selectToolsForContext({ message: polluted, channel: 'gui', toolSystem: null });
    expect(r.intent).not.toBe('open_app');
    reset(uid);
  });

  test('语音 brevityHint 剥除行为不回归（voice 意图误判旧坑）', () => {
    const msg = '现在几点了\n\n[系统提示：当前是语音对话模式，你的回复将被 TTS 朗读——保持简洁。]';
    const r = selectToolsForContext({ message: msg, channel: 'gui', toolSystem: null });
    expect(r.intent).not.toBe('voice');
  });
});

// ── P0-1a: 技能正文内联 ─────────────────────────────────────
describe('P0-1a 高分命中技能内联正文', () => {
  const { buildSkillsPromptScoped } = require('../core/skills');

  const fakeSkill = {
    name: 'remotion-video',
    description: 'Remotion 代码驱动视频生成：写 React 组件合成动画/数据视频并渲染 MP4。做个视频/宣传片时使用。',
    metadata: { crabpaw: { category: 'visualization', tags: ['video', 'remotion'] } },
    instructions: '工作区项目位于 data/.crabpaw/workspace/remotion。第一步写组件，第二步登记，第三步调用 RemotionRender。',
    body: '工作区项目位于 data/.crabpaw/workspace/remotion。第一步写组件，第二步登记，第三步调用 RemotionRender。',
  };
  const otherSkill = {
    name: 'weather',
    description: '天气查询技能，查天气/气温/下雨时使用。',
    metadata: { crabpaw: { category: 'domain' } },
    instructions: '调用天气工具查询。',
    body: '调用天气工具查询。',
  };

  test('视频任务命中 remotion-video 时正文内联进 prompt', () => {
    const out = buildSkillsPromptScoped('帮我做个crabpaw产品宣传片视频', [otherSkill, fakeSkill]);
    expect(out).toMatch(/执行方法（高置信匹配/);
    expect(out).toContain('data/.crabpaw/workspace/remotion');
    expect(out).toContain('无需再读取技能文件');
  });

  test('弱相关任务不内联正文（防刷屏）', () => {
    const out = buildSkillsPromptScoped('今天天气怎么样', [fakeSkill, otherSkill]);
    expect(out).not.toMatch(/执行方法（高置信匹配/);
  });
});

// ── P0-1b: RemotionRender 预检自愈 ──────────────────────────
describe('P0-1b 合成物预检失败带回自愈信息', () => {
  const { registry } = require('../tools/registry');
  require('../tools/remotion-tools');
  const { _listCompositions, _buildScaffold } = require('../tools/remotion-tools');

  test('_listCompositions 解析已登记 id', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rmo-list-'));
    try {
      for (const [rel, content] of Object.entries(_buildScaffold())) {
        const t = path.join(tmp, rel);
        fs.mkdirSync(path.dirname(t), { recursive: true });
        fs.writeFileSync(t, content);
      }
      const ids = _listCompositions(tmp);
      expect(ids).toContain('HelloCrab');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('未登记合成物快速失败并带回项目路径+可用清单', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rmo-precheck-'));
    try {
      for (const [rel, content] of Object.entries(_buildScaffold())) {
        const t = path.join(tmp, rel);
        fs.mkdirSync(path.dirname(t), { recursive: true });
        fs.writeFileSync(t, content);
      }
      fs.mkdirSync(path.join(tmp, 'node_modules', 'remotion'), { recursive: true });
      const render = registry.get('RemotionRender');
      const r = await render.handler({ composition: 'NotRegistered', project_dir: tmp, wait_seconds: 5 });
      expect(r.success).toBe(false);
      expect(r.available_compositions).toContain('HelloCrab');
      expect(r.project_dir).toBe(path.resolve(tmp));
      expect(r.error).toContain('COMPOSITIONS');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('RemotionStatus 无参返回项目路径+合成物清单', async () => {
    const { handleRemotionStatus, PROJECT_DIR } = require('../tools/remotion-tools');
    const r = await handleRemotionStatus({});
    expect(r.success).toBe(true);
    expect(r.project_dir).toBe(path.resolve(PROJECT_DIR));
    expect(Array.isArray(r.available_compositions)).toBe(true);
  });
});

// ── P0-3: DSML 兜底回灌（源码级锁定） ────────────────────────
describe('P0-3 DSML 兜底预算内回灌主循环', () => {
  test('chatStream DSML 兜底含预算余量判定与回灌递归（防一步收尾回归）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'ai.js'), 'utf8');
    expect(src).toMatch(/dsmlBudgetRemaining/);
    expect(src).toMatch(/streamTotalToolCalls \+= dsmlSuccessResults\.length/);
    expect(src).toMatch(/请继续推进任务（可以继续调用工具）/);
  });
});

describe('Glob 多段模式匹配（相对路径）', () => {
  const { registry } = require('../tools/registry');
  require('../tools/file-tools');

  test('**/compositions/index.tsx 能命中嵌套文件（旧实现只匹配文件名恒空）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glob-nested-'));
    try {
      const nested = path.join(tmp, 'workspace', 'remotion', 'src', 'compositions');
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(nested, 'index.tsx'), 'export const COMPOSITIONS = [];');
      fs.writeFileSync(path.join(tmp, 'root.js'), 'x');
      const glob = registry.get('Glob');
      const r = await glob.handler({ pattern: '**/compositions/index.tsx', path: tmp });
      expect(r.filenames.length).toBe(1);
      expect(r.filenames[0]).toContain(path.join('workspace', 'remotion', 'src', 'compositions', 'index.tsx'));
      // 单段模式不回归
      const r2 = await glob.handler({ pattern: '*.js', path: tmp });
      expect(r2.filenames.length).toBe(1);
      expect(r2.filenames[0]).toContain('root.js');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('隐藏目录仍被跳过（不做越权扫描）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glob-hidden-'));
    try {
      const hidden = path.join(tmp, '.secret', 'nested');
      fs.mkdirSync(hidden, { recursive: true });
      fs.writeFileSync(path.join(hidden, 'a.js'), 'x');
      fs.writeFileSync(path.join(tmp, 'b.js'), 'x');
      const glob = registry.get('Glob');
      const r = await glob.handler({ pattern: '**/*.js', path: tmp });
      expect(r.filenames.length).toBe(1);
      expect(r.filenames[0]).toContain('b.js');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── P1: PlanCreate 去重 ─────────────────────────────────────
describe('P1 PlanCreate 同回合去重', () => {
  const { registry } = require('../tools/registry');
  require('../tools/plan-tools');

  test('同 runId 第二次 PlanCreate 返回既有计划并标记 deduplicated', async () => {
    const planCreate = registry.get('PlanCreate');
    const ctx = { runId: `test_plan_dedup_${Date.now()}` };
    const first = await planCreate.handler({ title: '测试计划', steps: ['步骤一', '步骤二'] }, ctx);
    expect(first.success).toBe(true);
    expect(first.data.deduplicated).toBeUndefined();

    const second = await planCreate.handler({ title: '测试计划改版', steps: ['新步骤一', '新步骤二', '新步骤三'] }, ctx);
    expect(second.success).toBe(true);
    expect(second.data.deduplicated).toBe(true);
    expect(second.data.planId).toBe(first.data.planId);
    expect(second.data.hint).toMatch(/PlanUpdate/);
  });
});

// ── 二轮实测卡点修复（2026-09-07 晚） ────────────────────────
describe('循环检测参数感知（Read 误拦修复）', () => {
  const { hashToolCall } = require('../core/middleware/loop-detection');

  test('读不同文件产生不同哈希（旧实现全部同哈希→误判循环）', () => {
    const a = hashToolCall({ name: 'Read', arguments: { file_path: 'D:/proj/src/Root.tsx' } });
    const b = hashToolCall({ name: 'Read', arguments: { file_path: 'D:/proj/src/index.ts' } });
    expect(a.hash).not.toBe(b.hash);
  });

  test('同一文件同区间保持同哈希（真循环仍可检测）', () => {
    const a = hashToolCall({ name: 'Read', arguments: { file_path: 'D:/proj/src/Root.tsx' } });
    const b = hashToolCall({ name: 'Read', arguments: { file_path: 'D:/proj/src/Root.tsx' } });
    expect(a.hash).toBe(b.hash);
  });

  test('Read 的 file_path 落在稳定 key 里（salientFields 覆盖）', () => {
    const { stableToolKey } = require('../core/middleware/loop-detection');
    const k = stableToolKey('Read', { file_path: 'D:/x/a.ts' }, '');
    expect(k).toContain('a.ts');
  });
});

describe('SkillView 参数别名', () => {
  const { validateToolInput } = require('../core/tool-contract');

  test('name 与 skill_name 两种写法都过契约（旧实现 name 被拒）', () => {
    expect(validateToolInput('SkillView', { name: 'remotion-video' }).valid).toBe(true);
    expect(validateToolInput('SkillView', { skill_name: 'remotion-video' }).valid).toBe(true);
    expect(validateToolInput('SkillView', {}).valid).toBe(true); // required 放空, handler 兜底报错
  });

  test('handler 对两种参数名都能加载技能', async () => {
    const { registry } = require('../tools/registry');
    require('../tools/skill-tools');
    const sv = registry.get('SkillView');
    const byName = await sv.handler({ name: 'remotion-video' });
    const byContract = await sv.handler({ skill_name: 'remotion-video' });
    expect(byName.success).toBe(true);
    expect(byContract.success).toBe(true);
    expect(await sv.handler({})).toMatchObject({ success: false });
  });
});

describe('渲染进度流程化（步骤条数据）', () => {
  const { _buildSteps } = require('../tools/remotion-tools');

  test('阶段推导：preparing 期后续全 pending', () => {
    const steps = _buildSteps('preparing', 20);
    expect(steps.map((s) => s.status)).toEqual(['active', 'pending', 'pending', 'pending', 'pending']);
  });

  test('渲染中：前三步 done、渲染 active、输出 pending', () => {
    const steps = _buildSteps('rendering', 80);
    expect(steps.map((s) => s.status)).toEqual(['done', 'done', 'done', 'active', 'pending']);
  });

  test('完成：全 done', () => {
    const steps = _buildSteps('done', 100);
    expect(steps.every((s) => s.status === 'done')).toBe(true);
  });
});

describe('合成物登记接线校验（导出名不匹配快速拦截）', () => {
  const { _validateWiring } = require('../tools/remotion-tools');

  function makeProject(indexSrc, compSrc) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rmo-wiring-'));
    const compDir = path.join(tmp, 'src', 'compositions');
    fs.mkdirSync(compDir, { recursive: true });
    fs.writeFileSync(path.join(compDir, 'index.tsx'), indexSrc);
    fs.writeFileSync(path.join(compDir, 'Promo.tsx'), compSrc);
    return tmp;
  }

  test('import 名与实际导出不匹配 → 报出真实导出清单', () => {
    const tmp = makeProject(
      'import { Promo, promoMeta } from "./Promo";\nexport const COMPOSITIONS = [{ id: "Promo", component: Promo, ...promoMeta }];',
      'export const crabMeta = { durationInFrames: 90 };\nexport const Promo: React.FC = () => null;'
    );
    try {
      const issues = _validateWiring(tmp);
      expect(issues.length).toBe(1);
      expect(issues[0]).toContain('promoMeta');
      expect(issues[0]).toContain('crabMeta'); // 指出实际导出
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('命名一致时不误报', () => {
    const tmp = makeProject(
      'import { Promo, promoMeta } from "./Promo";\nexport const COMPOSITIONS = [{ id: "Promo", component: Promo, ...promoMeta }];',
      'export const promoMeta = { durationInFrames: 90 };\nexport const Promo: React.FC = () => null;'
    );
    try {
      expect(_validateWiring(tmp)).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('渲染 handler 对接线断裂快速失败且错误含修复指引', async () => {
    const tmp = makeProject(
      'import { Promo, promoMeta } from "./Promo";\nexport const COMPOSITIONS = [{ id: "Promo", component: Promo, ...promoMeta }];',
      'export const crabMeta = { durationInFrames: 90 };\nexport const Promo: React.FC = () => null;'
    );
    try {
      fs.mkdirSync(path.join(tmp, 'node_modules', 'remotion'), { recursive: true });
      const { registry } = require('../tools/registry');
      require('../tools/remotion-tools');
      const r = await registry.get('RemotionRender').handler({ composition: 'Promo', project_dir: tmp, wait_seconds: 5 });
      expect(r.success).toBe(false);
      expect(r.error).toContain('promoMeta');
      expect(r.error).toContain('重试');
      expect(r.wiring_issues.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
