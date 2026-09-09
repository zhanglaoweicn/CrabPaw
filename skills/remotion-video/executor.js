/**
 * remotion-video — Remotion 代码驱动视频技能执行器
 *
 * 用法（SkillExecute 或程序化调用）：
 *   execute({ action: 'render', composition: 'MyVideo', wait_seconds?: 120 })
 *     → 渲染 src/compositions/index.tsx 已登记的合成物为 MP4（脚手架→构建→渲染→产物登记+文件卡）。
 *       合成物 = React 组件（写组件 + 登记 id，见 SKILL.md），composition 为登记 id。
 *   execute({ action: 'list' })
 *     → 列出当前工作区已登记合成物 id
 *   execute({ action: 'scaffold' })
 *     → 初始化/修复工作区脚手架，返回项目路径
 *
 * 渲染核心复用 tools/remotion-tools 的 handleRemotionRender——与 RemotionRender
 * 工具同一条管线，本执行器只是技能轨的编程式入口。
 *
 * 2026-09-07: 新增——与 hyperframes-video/executor.js 对称（此前两个视频技能
 * 都在 manifest noExecutor 名单，路由对两者不对称处理导致知识注入偏向单边）。
 */
const { handleRemotionRender, ensureProject, PROJECT_DIR, _listCompositions } = require('../../src/tools/remotion-tools');

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
        ? '工作区暂无合成物——可用 action:"scaffold" 初始化；合成物为 React 组件，写好后登记进 src/compositions/index.tsx 再 action:"render"'
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
      error: 'composition 必填（src/compositions/index.tsx 已登记的合成物 id）。可先 action:"list" 查看已登记合成物',
    };
  }
  const result = await handleRemotionRender({
    composition,
    wait_seconds: params.wait_seconds,
  });
  return { ...result, action };
}

module.exports = { execute };
