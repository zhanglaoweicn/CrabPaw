/**
 * hyperframes-video — HyperFrames HTML→视频技能执行器
 *
 * 用法（SkillExecute 或程序化调用）：
 *   execute({ action: 'render', composition: 'my_video', props?: {...}, wait_seconds?: 120 })
 *     → 渲染 compositions/<composition>.html 为 MP4（脚手架→静态 lint→渲染→产物登记+文件卡）
 *   execute({ action: 'list' })
 *     → 列出当前工作区可用合成物
 *   execute({ action: 'scaffold' })
 *     → 初始化/修复工作区脚手架（含示例合成物），返回项目路径
 *
 * 渲染核心复用 tools/hyperframes-tools 的 handleHyperFramesRender——与 HyperFramesRender
 * 工具同一条管线（进度经 scene surface 实时可见），本执行器只是技能轨的编程式入口。
 *
 * 2026-09-07: 新增本执行器——此前两个视频技能都只有 SKILL.md 且被列入 manifest
 * noExecutor 名单，skill-router 对 hyperframes-video 硬跳过推荐（知识注入不对称，
 * 实测"讲解视频"需求只注入了 remotion-video 知识）。补执行器后路由公平对待双引擎。
 */
const { handleHyperFramesRender, ensureProject, PROJECT_DIR, _listCompositions } = require('../../src/tools/hyperframes-tools');

async function execute(params = {}) {
  const action = params.action || 'render';

  if (action === 'list') {
    let compositions = [];
    try { compositions = _listCompositions(PROJECT_DIR); } catch (e) { compositions = []; }
    return {
      success: true,
      action,
      projectDir: PROJECT_DIR,
      compositions,
      hint: compositions.length === 0
        ? '工作区暂无合成物——可用 action:"scaffold" 初始化，或直接写 HTML（data-start/data-duration 时序）到 compositions/ 后 action:"render"'
        : undefined,
    };
  }

  if (action === 'scaffold') {
    try {
      await ensureProject(PROJECT_DIR, null);
      const compositions = (() => { try { return _listCompositions(PROJECT_DIR); } catch { return []; } })();
      return { success: true, action, projectDir: PROJECT_DIR, compositions };
    } catch (e) {
      return { success: false, error: '脚手架初始化失败: ' + e.message };
    }
  }

  // 默认 render
  const composition = params.composition || params.name || '';
  if (!composition || typeof composition !== 'string') {
    return {
      success: false,
      error: 'composition 必填（compositions/ 下的合成物名，可不含 .html 后缀）。可先 action:"list" 查看可用合成物',
    };
  }
  const result = await handleHyperFramesRender({
    composition,
    props: params.props,
    wait_seconds: params.wait_seconds,
  });
  return { ...result, action };
}

module.exports = { execute };
