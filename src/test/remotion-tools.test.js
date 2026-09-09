/**
 * remotion-tools 单元测试（2026-09-07 Remotion 接入轮）
 * 覆盖：契约存在与校验、registry 注册、脚手架生成、任务表、路由接线、技能挂载。
 * 不触网：渲染/npm install 分支不在单测覆盖范围（需要真实依赖树）。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const { TOOL_CONTRACTS, validateToolInput } = require('../core/tool-contract');
const { registry } = require('../tools/registry');
require('../tools/remotion-tools');
const {
  REMOTION_TASKS,
  PROJECT_DIR,
  ensureProject,
  _buildScaffold,
  _localFileUrl,
} = require('../tools/remotion-tools');

describe('Remotion 契约', () => {
  test('RemotionRender / RemotionStatus 契约存在', () => {
    expect(TOOL_CONTRACTS.RemotionRender).toBeTruthy();
    expect(TOOL_CONTRACTS.RemotionStatus).toBeTruthy();
    // 渲染是分钟级任务：契约超时上限必须放宽到 15 分钟
    expect(TOOL_CONTRACTS.RemotionRender.maxTimeout).toBe(900000);
    expect(TOOL_CONTRACTS.RemotionRender.riskLevel).toBe('medium');
    expect(TOOL_CONTRACTS.RemotionStatus.riskLevel).toBe('low');
  });

  test('合法输入通过校验', () => {
    expect(validateToolInput('RemotionRender', { composition: 'WeeklyReport' }).valid).toBe(true);
    expect(validateToolInput('RemotionRender', { composition: 'X', props: { a: 1 }, wait_seconds: 120 }).valid).toBe(true);
    expect(validateToolInput('RemotionStatus', {}).valid).toBe(true);
    expect(validateToolInput('RemotionStatus', { task_id: 'rmo_1' }).valid).toBe(true);
  });

  test('非法输入被契约拦截', () => {
    expect(validateToolInput('RemotionRender', {}).valid).toBe(false);
    expect(validateToolInput('RemotionRender', { composition: 'X', props: 'not-an-object' }).valid).toBe(false);
    expect(validateToolInput('RemotionRender', { composition: 'X', wait_seconds: 5000 }).valid).toBe(false);
    expect(validateToolInput('RemotionRender', { composition: 'X', unknown_param: 1 }).valid).toBe(false);
  });
});

describe('Remotion 工具注册', () => {
  test('registry 里有 RemotionRender/RemotionStatus', () => {
    const render = registry.get('RemotionRender');
    const status = registry.get('RemotionStatus');
    expect(render).toBeTruthy();
    expect(status).toBeTruthy();
    expect(render.riskLevel).toBe('medium');
    expect(render.timeout).toBe(900000);
    expect(typeof render.handler).toBe('function');
  });
});

describe('handler 参数校验（不触网）', () => {
  test('缺 composition 返回错误', async () => {
    const r = await registry.get('RemotionRender').handler({});
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/composition/);
  });

  test('wait_seconds 越界返回错误', async () => {
    const r = await registry.get('RemotionRender').handler({ composition: 'X', wait_seconds: 5000 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/wait_seconds/);
  });

  test('props 传数组返回错误', async () => {
    const r = await registry.get('RemotionRender').handler({ composition: 'X', props: [1, 2] });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/props/);
  });
});

describe('RemotionStatus 任务表', () => {
  test('未知 task_id 返回任务不存在', async () => {
    const r = await registry.get('RemotionStatus').handler({ task_id: 'rmo_not_exist' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/不存在/);
  });

  test('无参数返回最近任务列表', async () => {
    REMOTION_TASKS.set('rmo_test_1', {
      id: 'rmo_test_1', composition: 'Demo', status: 'completed', phase: 'done',
      percent: 100, startedAt: Date.now(), completedAt: Date.now(), options: {},
    });
    const r = await registry.get('RemotionStatus').handler({});
    expect(r.success).toBe(true);
    const found = r.recent_tasks.find((t) => t.id === 'rmo_test_1');
    expect(found).toBeTruthy();
    REMOTION_TASKS.delete('rmo_test_1');
  });
});

describe('脚手架', () => {
  test('模板包含关键文件与合成物注册表模式', () => {
    const files = _buildScaffold();
    for (const key of ['package.json', 'tsconfig.json', 'remotion.config.ts', 'src/index.ts', 'src/Root.tsx', 'src/compositions/index.tsx', 'src/compositions/HelloCrab.tsx', 'render-runner.cjs']) {
      expect(files[key]).toBeTruthy();
    }
    // Root 映射 COMPOSITIONS 数组——新增视频只需改 compositions 目录
    expect(files['src/Root.tsx']).toMatch(/COMPOSITIONS\.map/);
    expect(files['src/compositions/index.tsx']).toMatch(/COMPOSITIONS/);
    // runner 输出 JSON 行协议
    expect(files['render-runner.cjs']).toMatch(/type: "(progress|phase|done|error)"/);
    // 依赖含 bundler+renderer（runner 的 require 目标）
    expect(files['package.json']).toMatch(/@remotion\/bundler/);
    expect(files['package.json']).toMatch(/@remotion\/renderer/);
  });

  test('ensureProject 在临时目录生成文件且跳过安装（预置 node_modules/remotion）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rmo-test-'));
    try {
      fs.mkdirSync(path.join(tmp, 'node_modules', 'remotion'), { recursive: true });
      const steps = [];
      await ensureProject(tmp, (p, t) => steps.push([p, t]));
      for (const key of Object.keys(_buildScaffold())) {
        expect(fs.existsSync(path.join(tmp, key))).toBe(true);
      }
      // 无 install 步骤（预置依赖）→ 不应出现"安装"文案
      expect(steps.some(([, t]) => /安装/.test(t))).toBe(false);
      // runner 属工具托管：再次 ensure 仍覆写
      fs.writeFileSync(path.join(tmp, 'render-runner.cjs'), 'stale', 'utf8');
      await ensureProject(tmp, null);
      expect(fs.readFileSync(path.join(tmp, 'render-runner.cjs'), 'utf8')).not.toBe('stale');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('路径与 URL', () => {
  test('PROJECT_DIR 落在 DATA_DIR/workspace 下', () => {
    const { DATA_DIR } = require('../core/config');
    expect(PROJECT_DIR.startsWith(DATA_DIR)).toBe(true);
    expect(PROJECT_DIR).toMatch(/remotion$/);
  });

  test('_localFileUrl 生成 /files/ 相对链（非 Electron）', () => {
    const { DATA_DIR } = require('../core/config');
    const p = path.join(DATA_DIR, 'generated-videos', 'remotion_1_demo.mp4');
    const url = _localFileUrl(p);
    expect(url).toMatch(/^http:\/\/localhost:\d+\/files\//);
    expect(url).toContain('generated-videos');
  });
});

describe('skill-router 接线', () => {
  const { globalSkillRouter, TASK_CATEGORIES } = require('../core/skill-router');

  test('VIDEO_CREATION 类目存在且指向 remotion-video', () => {
    expect(TASK_CATEGORIES.VIDEO_CREATION).toBeTruthy();
    expect(TASK_CATEGORIES.VIDEO_CREATION.skills).toContain('remotion-video');
  });

  test('视频创作意图命中 skillHint remotion-video', () => {
    const r = globalSkillRouter.classifyTask('帮我做一个产品宣传片视频');
    expect(r.skillHint).toBe('remotion-video');
  });

  test('播放已有视频不被误路由到渲染技能', () => {
    const r = globalSkillRouter.classifyTask('播放这首歌的mv');
    expect(r.skillHint).not.toBe('remotion-video');
  });
});

describe('技能与部门技能包挂载', () => {
  test('skills 目录有 remotion-video 且 frontmatter 完整', () => {
    const skillPath = path.join(__dirname, '..', '..', 'skills', 'remotion-video', 'SKILL.md');
    expect(fs.existsSync(skillPath)).toBe(true);
    const content = fs.readFileSync(skillPath, 'utf8');
    expect(content).toMatch(/^---\n/);
    expect(content).toMatch(/name:\s*remotion-video/);
    expect(content).toMatch(/category:\s*visualization/);
  });

  test('manifest.json 登记 remotion-video（已补执行器移出 noExecutor + productivity bundle）', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'skills', 'manifest.json'), 'utf8'));
    // 2026-09-07: 补 executor.js 后移出 noExecutor——路由对双视频引擎公平对待
    expect(manifest.noExecutor).not.toContain('remotion-video');
    expect(fs.existsSync(path.join(__dirname, '..', '..', 'skills', 'remotion-video', 'executor.js'))).toBe(true);
    expect(manifest.bundles.productivity.skills).toContain('remotion-video');
  });

  test('DEPARTMENT_SKILLS 挂载（marketing/tech_digital）', () => {
    const { DEPARTMENT_SKILLS } = require('../core/experts/departments');
    expect(DEPARTMENT_SKILLS.marketing).toContain('remotion-video');
    expect(DEPARTMENT_SKILLS.tech_digital).toContain('remotion-video');
  });
});
