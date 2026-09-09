/**
 * Scene Tools — Agent-accessible scene manipulation tools
 *
 * Registers tools with the central ToolRegistry so the AI agent
 * can inspect and modify the scene declaratively.
 *
 * Tools:
 *   SceneSet   — upsert or remove a single surface
 *   SceneGet   — retrieve the current scene manifest
 *   SceneClear — remove all surfaces
 *
 * Auto-registers when required() via the tool system import chain.
 * Follows the same pattern as all other CrabPaw tool modules.
 */

const { getSceneStore } = require('./scene-store');
// 2026-08-16: 面板关闭链路同步——panel-state.js 为依赖零模块（无 require 环），
// SURFACE_PANEL_MAP 自 2026-08-16 起由 panel-state.js 单一事实源导出。
const { SURFACE_PANEL_MAP, setPanelState } = require('../panel-state');

// ── Constants ────────────────────────────────────────────────

const TOOLSET = 'scene';
const CATEGORY = 'scene';

// ── Tool Definitions ─────────────────────────────────────────

const sceneTools = [
  {
    name: 'SceneSet',
    description: `Set (create or update) a UI surface in the scene — 向用户展示可视化卡片，让任务过程透明化。

每个 surface 对应一张浮动卡片，可用于展示进度、代码编写过程、结果预览等。

【关闭已知面板】传 data=null 可关闭已知面板 surface（同步面板状态）：
  - "stock-panel": 股票行情面板
  - "weather-panel": 天气面板
  - "hotspot-panel": 热点面板
  - "music-player": 音乐播放器
  - "file-panel": 文件生成面板
  - "typhoon-panel": 台风面板
  - "meeting-panel": 会议记录面板
  - "schedule-panel": 日程卡片（展示近 7 天日程）

【可用的卡片种类 (kind)】
  - "progress":   进度条卡片。data: { label, progress(0-100), text }. 适合展示文件写入/任务执行进度。
  - "selfcheck":  自检扫描卡片。data: { title, items: [{ label, status: "checking"|"ok"|"warn"|"error" }] }. 适合展示诊断/检查过程。
  - "text"/"info": 纯文本卡片。data: { text/content }. 适合展示中间结果、代码片段预览。
  - "metric":      指标卡片。data: { value, label, unit?, trend?, subtitle? }. 适合展示关键数据点。
  - "weather":     天气卡片。data: { city, temp, condition, forecast? }.
  - "choice":      选择卡片。data: { question, options }.
  - "image":       图片卡片。data: { src, alt?, caption? }.
  - "awakening":   通知卡片。data: { text, type? }.
  - "meeting_recording": 会议记录场景卡（静态纪要展示；实时录音记录走宿主会议面板，由 meeting_mode 工具控制，不要用本 kind 模拟）。

【业务可视化 kind（用于让 Agent 看到 Home / Memory / Skills 等页面的状态）】
  - "memory_graph": 记忆节点图（首页全景）。data: { nodes, edges, stats, intent: 'ambient'|'inform' }.
  - "memory_list":  记忆列表（Memory 页面摘要）。data: { items, total, intent }.
  - "session_list": 会话列表（侧边栏/首页）。data: { sessions, active, total, intent }.
  - "tree_view":    记忆树 / 主题树视图。data: { root, children, intent }.
  - "kanban":       任务/技能看板。data: { columns, intent }.
  - "timeline":     时间线/历史。data: { events, intent }.
  - "chart":        数据图表。data: { type: 'line'|'bar'|'pie', data, intent }.

【使用场景指南】
  1. 编写 HTML/代码文件时：
     - 先用 "selfcheck" 显示检测状态（扫描检测中…→ 完成）
     - 再用 "progress" 显示写入进度
     - 然后 "text" 显示代码片段预览
     - 最后清除或用 "text" 显示完成信息
  2. 搜索/获取信息时：
     - 用 "text"/"info" 显示搜索结果摘要
  3. 展示系统状态时：
     - 用 "metric" 显示关键指标
     - 用 "progress" 显示进度百分比

【intent 含义】
  - "ambient": 柔和展示，不打扰用户（适合进度/自检）
  - "inform": 正常展示（默认）
  - "confront": 高亮突出（适合需要用户注意的重要信息）

【操作原则】
  - id 是唯一标识符，更新同一个 id 会替换之前的卡片
  - 任务完成时调用 SceneSet(id, null) 移除不需要的卡片
  - 使用 SceneGet 查看当前场景后再修改`,
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: '唯一标识符。更新相同 id 会替换之前的卡片',
        },
        data: {
          oneOf: [
            {
              type: 'object',
              description: '卡片数据',
              properties: {
                kind: {
                  type: 'string',
                  description: '卡片种类（见 description 中的可用种类）',
                },
                data: { description: '卡片数据负载，不同 kind 有不同的数据格式' },
                intent: {
                  type: 'string',
                  enum: ['ambient', 'inform', 'confront'],
                  description: '展示意图：ambient(柔和) / inform(正常) / confront(高亮)',
                },
                focus: { type: 'boolean', description: '是否获得焦点' },
                order: { type: 'number', description: '排序（小在前）' },
              },
            },
            { type: 'null', description: '传 null 移除该卡片' },
          ],
          description: '卡片数据对象，或 null 移除',
        },
      },
      required: ['id', 'data'],
    },
    handler: async (args, _context) => {
      const store = getSceneStore();
      const { id, data } = args;

      if (data === null || data === undefined) {
        const result = store.removeSurface(id);
        // 2026-08-16: 已知面板 surface 关闭（SceneSet null 删除语义，实机 07:54:33
        // AI 曾用此形态关股票面板）→ 同步 panel-state closed，避免 surface 消失但
        // 面板状态残留 open 导致下一轮注入幻觉"已打开"。
        if (SURFACE_PANEL_MAP[id]) {
          try {
            setPanelState(SURFACE_PANEL_MAP[id], 'closed');
          } catch (e) { console.warn('[scene-tools.js] SceneSet 关闭面板状态同步失败:', e && e.message); }
        }
        return {
          success: true,
          rev: result.rev,
          op: 'remove',
          id,
          display: `Surface "${id}" removed (rev ${result.rev})`,
        };
      }

      const result = store.upsertSurface(id, data);
      // 2026-08-29: open 对称——null 分支写 closed(2026-08-16), upsert 分支却漏写 open,
      // 面板重开后 closed TTL(120s) 内 AI 上下文仍注入"已关闭"→ 误报。
      if (SURFACE_PANEL_MAP[id]) {
        try { setPanelState(SURFACE_PANEL_MAP[id], 'open'); }
        catch (e) { console.warn('[scene-tools.js] SceneSet 打开面板状态同步失败:', e && e.message); }
      }
      return {
        success: true,
        rev: result.rev,
        op: 'upsert',
        id,
        surface: {
          id: result.surface.id,
          kind: result.surface.kind,
          intent: result.surface.intent,
          focus: result.surface.focus,
          order: result.surface.order,
        },
        display: `Surface "${id}" ${result.surface.kind} updated (rev ${result.rev})`,
      };
    },
  },

  {
    name: 'SceneGet',
    description: `Get the current scene manifest — a compact overview of all surfaces.

Returns the revision number and a manifest array with each surface's id, kind,
data summary, and intent. Use this before SceneSet to understand the current layout.`,
    parameters: {
      type: 'object',
      properties: {},
    },
    // eslint-disable-next-line no-unused-vars
    handler: async (_args, context) => {
      const store = getSceneStore();
      const manifest = store.getManifest();
      return {
        success: true,
        rev: manifest.rev,
        surfaceCount: manifest.manifest.length,
        manifest: manifest.manifest,
        display: manifest.manifest.length > 0
          ? `Scene rev ${manifest.rev}: ${manifest.manifest.length} surfaces\n` +
            manifest.manifest.map(s =>
              `  [${s.id}] ${s.kind} (${s.intent}): ${s.dataSummary}`
            ).join('\n')
          : `Scene rev ${manifest.rev}: empty`,
      };
    },
  },

  {
    name: 'SceneClear',
    description: `Remove all surfaces from the scene, returning to an empty state.

Use carefully — this will dismiss all UI elements the agent has placed.`,
    parameters: {
      type: 'object',
      properties: {},
    },
    // eslint-disable-next-line no-unused-vars
    handler: async (_args, context) => {
      const store = getSceneStore();
      const result = store.clear();
      return {
        success: true,
        rev: result.rev,
        opsCount: result.ops.length,
        display: `All surfaces cleared (rev ${result.rev})`,
      };
    },
  },
];

// ── Registration ─────────────────────────────────────────────

/**
 * Register all scene tools with the central ToolRegistry.
 * Safe to call multiple times — existing tools are overwritten.
 * @param {import('../../tools/registry').ToolRegistry} registry
 * @returns {number} Number of tools registered
 */
function registerSceneTools(registry) {
  if (!registry || typeof registry.register !== 'function') {
    console.warn('[scene-tools] Invalid registry, cannot register scene tools');
    return 0;
  }

  let count = 0;
  for (const tool of sceneTools) {
    registry.register({
      name: tool.name,
      toolset: TOOLSET,
      category: CATEGORY,
      schema: tool.parameters,
      handler: tool.handler,
      description: tool.description,
      isDangerous: false,
      isReadOnly: tool.name === 'SceneGet',
    });
    count++;
  }

  console.log(`[scene-tools] Registered ${count} scene tool(s)`);
  return count;
}

// ── Auto-registration ──────────────────────────────────────
try {
  const { registry } = require('../../tools/registry');
  if (registry) registerSceneTools(registry);
} catch (e) {

  // Registry not available yet — will be registered manually if needed

  console.warn('[scene-tools.js] 空 catch 补日志:', e && e.message);
}


module.exports = {
  sceneTools,
  registerSceneTools,
};
