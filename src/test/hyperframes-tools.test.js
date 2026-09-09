/**
 * hyperframes-tools 单元测试（2026-09-07 HyperFrames 接入轮）
 * 覆盖：契约存在与校验、registry 注册、脚手架生成、合成物清单、任务表、
 * 步骤条、路由接线、技能挂载。不触网：渲染/npm install 分支不在单测范围。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const { TOOL_CONTRACTS, validateToolInput } = require('../core/tool-contract');
const { registry } = require('../tools/registry');
require('../tools/hyperframes-tools');
const {
  HYPERFRAMES_TASKS,
  PROJECT_DIR,
  ensureProject,
  _buildScaffold,
  _listCompositions,
  _buildSteps,
  _localFileUrl,
} = require('../tools/hyperframes-tools');

describe('HyperFrames 素材入库/转写（字幕工作流）', () => {
  test('StageAsset 契约存在且校验 file_path', () => {
    expect(TOOL_CONTRACTS.HyperFramesStageAsset).toBeTruthy();
    expect(TOOL_CONTRACTS.HyperFramesTranscribe).toBeTruthy();
    expect(validateToolInput('HyperFramesStageAsset', {}).valid).toBe(false);
    expect(validateToolInput('HyperFramesStageAsset', { file_path: 'D:/x.mp4' }).valid).toBe(true);
    expect(validateToolInput('HyperFramesTranscribe', { input_path: 'D:/x.mp4' }).valid).toBe(true);
    expect(validateToolInput('HyperFramesTranscribe', { input_path: 'D:/x.mp4', wait_seconds: 9999 }).valid).toBe(false);
  });

  test('StageAsset 复制文件进 assets/ 并返回引用路径', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-stage-'));
    try {
      const srcVideo = path.join(tmp, 'interview.mp4');
      fs.writeFileSync(srcVideo, 'FAKEVIDEO');
      const { handleHyperFramesStageAsset } = require('../tools/hyperframes-tools');
      const r = await handleHyperFramesStageAsset({ file_path: srcVideo });
      expect(r.success).toBe(true);
      expect(r.assets_ref).toBe('assets/interview.mp4');
      expect(fs.existsSync(path.join(PROJECT_DIR, 'assets', 'interview.mp4'))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('StageAsset 对不存在的文件报错', async () => {
    const { handleHyperFramesStageAsset } = require('../tools/hyperframes-tools');
    const r = await handleHyperFramesStageAsset({ file_path: 'D:/no/such/file.mp4' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/不存在/);
  });

  test('Transcribe 对不存在的输入报错', async () => {
    const { handleHyperFramesTranscribe } = require('../tools/hyperframes-tools');
    const r = await handleHyperFramesTranscribe({ input_path: 'D:/no/such.mp4' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/不存在/);
  });
});

describe('HyperFrames 契约', () => {
  test('HyperFramesRender / HyperFramesStatus 契约存在', () => {
    expect(TOOL_CONTRACTS.HyperFramesRender).toBeTruthy();
    expect(TOOL_CONTRACTS.HyperFramesStatus).toBeTruthy();
    expect(TOOL_CONTRACTS.HyperFramesRender.maxTimeout).toBe(900000);
    expect(TOOL_CONTRACTS.HyperFramesRender.riskLevel).toBe('medium');
    expect(TOOL_CONTRACTS.HyperFramesStatus.riskLevel).toBe('low');
  });

  test('合法输入通过校验', () => {
    expect(validateToolInput('HyperFramesRender', { composition: 'hello-crab' }).valid).toBe(true);
    expect(validateToolInput('HyperFramesRender', { composition: 'x', props: { title: 'A' }, format: 'gif' }).valid).toBe(true);
    expect(validateToolInput('HyperFramesStatus', {}).valid).toBe(true);
  });

  test('非法输入被契约拦截', () => {
    expect(validateToolInput('HyperFramesRender', {}).valid).toBe(false);
    expect(validateToolInput('HyperFramesRender', { composition: 'x', props: [1] }).valid).toBe(false);
    expect(validateToolInput('HyperFramesRender', { composition: 'x', wait_seconds: 9999 }).valid).toBe(false);
  });
});

describe('HyperFrames 工具注册', () => {
  test('registry 里有 HyperFramesRender/HyperFramesStatus', () => {
    const render = registry.get('HyperFramesRender');
    const status = registry.get('HyperFramesStatus');
    expect(render).toBeTruthy();
    expect(status).toBeTruthy();
    expect(render.riskLevel).toBe('medium');
    expect(render.timeout).toBe(900000);
  });
});

describe('handler 参数校验（不触网）', () => {
  test('缺 composition 返回错误', async () => {
    const r = await registry.get('HyperFramesRender').handler({});
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/composition/);
  });

  test('props 传数组返回错误', async () => {
    const r = await registry.get('HyperFramesRender').handler({ composition: 'x', props: [1] });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/props/);
  });
});

describe('HyperFramesStatus 任务表', () => {
  test('未知 task_id 返回任务不存在', async () => {
    const r = await registry.get('HyperFramesStatus').handler({ task_id: 'hf_not_exist' });
    expect(r.success).toBe(false);
  });

  test('无参数返回项目路径+合成物清单', async () => {
    HYPERFRAMES_TASKS.set('hf_test_1', {
      id: 'hf_test_1', composition: 'Demo', status: 'completed', phase: 'done',
      percent: 100, startedAt: Date.now(), completedAt: Date.now(), options: {},
    });
    const r = await registry.get('HyperFramesStatus').handler({});
    expect(r.success).toBe(true);
    expect(r.project_dir).toBe(path.resolve(PROJECT_DIR));
    expect(Array.isArray(r.available_compositions)).toBe(true);
    HYPERFRAMES_TASKS.delete('hf_test_1');
  });
});

describe('脚手架与合成物清单', () => {
  test('模板含 package.json(hyperframes 依赖)与示例合成物', () => {
    const files = _buildScaffold();
    expect(files['package.json']).toMatch(/hyperframes/);
    expect(files['compositions/hello-crab.html']).toMatch(/data-composition-id="hello-crab"/);
    expect(files['compositions/hello-crab.html']).toMatch(/data-duration="5"/);
  });

  test('ensureProject 在临时目录生成文件且跳过安装', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-test-'));
    try {
      fs.mkdirSync(path.join(tmp, 'node_modules', 'hyperframes'), { recursive: true });
      const steps = [];
      await ensureProject(tmp, (p, t) => steps.push([p, t]));
      for (const key of Object.keys(_buildScaffold())) {
        expect(fs.existsSync(path.join(tmp, key))).toBe(true);
      }
      expect(steps.some(([, t]) => /安装/.test(t))).toBe(false);
      // 已有合成物不被覆盖
      fs.writeFileSync(path.join(tmp, 'compositions', 'hello-crab.html'), 'CUSTOM', 'utf8');
      await ensureProject(tmp, null);
      expect(fs.readFileSync(path.join(tmp, 'compositions', 'hello-crab.html'), 'utf8')).toBe('CUSTOM');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('_listCompositions 返回不含后缀的合成物名', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-list-'));
    try {
      const dir = path.join(tmp, 'compositions');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'a.html'), 'x');
      fs.writeFileSync(path.join(dir, 'b.htm'), 'x');
      fs.writeFileSync(path.join(dir, 'ignore.css'), 'x');
      expect(_listCompositions(tmp)).toEqual(['a', 'b']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('步骤条', () => {
  test('四阶段：preparing active → 全 done', () => {
    expect(_buildSteps('preparing', 5).map((s) => s.status))
      .toEqual(['active', 'pending', 'pending', 'pending']);
    expect(_buildSteps('done', 100).every((s) => s.status === 'done')).toBe(true);
  });
});

describe('路径与 URL', () => {
  test('PROJECT_DIR 落在 DATA_DIR/workspace 下', () => {
    const { DATA_DIR } = require('../core/config');
    expect(PROJECT_DIR.startsWith(DATA_DIR)).toBe(true);
    expect(PROJECT_DIR).toMatch(/hyperframes$/);
  });

  test('_localFileUrl 生成 /files/ 链', () => {
    const { DATA_DIR } = require('../core/config');
    const url = _localFileUrl(path.join(DATA_DIR, 'generated-videos', 'hyperframes_1_x.mp4'));
    expect(url).toMatch(/^http:\/\/localhost:\d+\/files\//);
  });
});

describe('路由与挂载', () => {
  const { globalSkillRouter, TASK_CATEGORIES } = require('../core/skill-router');

  test('VIDEO_CREATION 类目含两个视频技能', () => {
    expect(TASK_CATEGORIES.VIDEO_CREATION.skills).toContain('remotion-video');
    expect(TASK_CATEGORIES.VIDEO_CREATION.skills).toContain('hyperframes-video');
  });

  test('给已有视频加字幕 → skillHint hyperframes-video', () => {
    const r = globalSkillRouter.classifyTask('帮我把这个视频加上字幕');
    expect(r.skillHint).toBe('hyperframes-video');
  });

  test('技能文件存在且 manifest/部门包已挂载', () => {
    const skillPath = path.join(__dirname, '..', '..', 'skills', 'hyperframes-video', 'SKILL.md');
    expect(fs.existsSync(skillPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'skills', 'manifest.json'), 'utf8'));
    // 2026-09-07: 补 executor.js 后移出 noExecutor——路由对双视频引擎公平对待
    expect(manifest.noExecutor).not.toContain('hyperframes-video');
    expect(fs.existsSync(path.join(__dirname, '..', '..', 'skills', 'hyperframes-video', 'executor.js'))).toBe(true);
    const { DEPARTMENT_SKILLS } = require('../core/experts/departments');
    expect(DEPARTMENT_SKILLS.marketing).toContain('hyperframes-video');
    expect(DEPARTMENT_SKILLS.tech_digital).toContain('hyperframes-video');
  });
});
