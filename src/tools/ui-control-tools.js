/**
 * ui-control-tools.js — UI 控制工具(P2-3, ag-ui Frontend Tools 借鉴)
 *
 * agent 通过 ControlUI 工具操作 CrabPaw 界面(打开/关闭面板、切换 tab、新对话等)——
 * 从"只会说话"变成"会操作应用"。handler 经 /events SSE 广播 crabpaw_ui 命令,
 * 前端 UiCommandBridge(唯一订阅者)映射到 window.__* 全局接口/custom event。
 *
 * 设计约束(panel-tools.js 同款措辞):
 * - 只在用户明确要求打开/关闭界面时调用,普通问答不主动开面板
 * - 一次性动作(打开/切换)语义,不承载持续状态(持续状态走 scene surface)
 */

const { registry } = require('./registry');

// 2026-08-19: 业务面板退役——open/close_business_panel 从命令表删除
//（专家/数据库/经营数据迁入管理舱 data tab,经 open_cockpit(tab=data) 直达;
//  日程/股票/文件由各自卡片承担,无浮层命令）
const UI_COMMANDS = [
  'open_cockpit', 'close_cockpit',
  'open_search', 'open_doc', 'open_music', 'close_music',
  'open_hotspot', 'close_hotspot', 'open_weather', 'close_weather',
  'open_task_panel', 'close_task_panel', 'close_scene_card', 'new_conversation',
];

registry.register({
  name: 'ControlUI',
  toolset: 'ui',
  category: 'ui_control',
  riskLevel: 'low',
  isReadOnly: true,
  timeout: 3000,
  description: '控制 CrabPaw 界面元素(打开/关闭面板、切换面板 tab、开始新对话)。当用户明确要求打开/关闭某个界面或面板时调用。不要在普通问答中主动打开任何界面。界面未就绪时命令可能无效果。',
  whenNotToUse: [
    '普通问答中不得主动开关界面',
    '用户未提及界面操作时',
  ],
  schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        enum: UI_COMMANDS,
        description: '界面操作: open/close_cockpit(管理舱,含专家/数据 tab)、open_search(搜索)、open_doc(文档舱)、open/close_music(音乐)、open/close_hotspot(热点)、open/close_weather(天气)、open/close_task_panel(任务面板)、close_scene_card(关闭最上层场景卡)、new_conversation(开始新对话)',
      },
      tab: {
        type: 'string',
        description: '面板目标 tab(可选): cockpit 支持 settings/expert/model/mcp/cost/skills',
      },
      query: {
        type: 'string',
        description: 'open_search 时的搜索词(可选)',
      },
      reason: {
        type: 'string',
        description: '执行该界面操作的原因',
      },
    },
    required: ['command'],
  },
  handler: async (params) => {
    const command = String(params?.command || '').trim();
    if (!UI_COMMANDS.includes(command)) {
      return { success: false, error: `不支持的 command，可选值: ${UI_COMMANDS.join('/')}` };
    }

    const tab = typeof params?.tab === 'string' ? params.tab : undefined;
    const query = typeof params?.query === 'string' ? params.query : undefined;

    try {
      const { broadcastEvent } = require('../core/sse-broadcast');
      broadcastEvent('crabpaw_ui', {
        command,
        tab,
        query,
        reason: typeof params?.reason === 'string' ? params.reason : undefined,
        ts: Date.now(),
      });
    } catch (e) {
      console.warn('[ControlUI] 广播 crabpaw_ui 失败:', e?.message || e);
      return { success: false, error: '界面指令广播失败' };
    }

    return {
      success: true,
      message: `已发送界面指令: ${command}${tab ? ` (${tab})` : ''}`,
    };
  },
});
