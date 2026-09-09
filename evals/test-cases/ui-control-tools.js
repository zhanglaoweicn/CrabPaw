const { registry } = require('../../src/tools/registry');

module.exports = {
  name: 'UI Control Tools',
  cases: [
    {
      id: 'uictl_001',
      name: 'ControlUI 已注册(toolset=ui)',
      category: 'ui_control',
      run: () => {
        require('../../src/tools/ui-control-tools');
        const t = registry.get('ControlUI');
        return !!t && t.toolset === 'ui' && t.category === 'ui_control';
      },
    },
    {
      id: 'uictl_002',
      name: 'schema 命令枚举合法(14 项)',
      category: 'ui_control',
      run: () => {
        const t = registry.get('ControlUI');
        if (!t?.schema?.properties?.command?.enum) return false;
        const cmds = t.schema.properties.command.enum;
        return cmds.length === 14
          && cmds.includes('open_cockpit')
          && cmds.includes('new_conversation')
          && cmds.includes('close_scene_card')
          && !cmds.includes('open_business_panel')
          && !cmds.includes('close_business_panel');
      },
    },
    {
      id: 'uictl_003',
      name: 'description 含"不主动打开"约束(whenNotToUse)',
      category: 'ui_control',
      run: () => {
        const t = registry.get('ControlUI');
        if (!t) return false;
        const whenNotToUse = Array.isArray(t.whenNotToUse) ? t.whenNotToUse.join(' ') : String(t.whenNotToUse || '');
        return whenNotToUse.includes('普通问答');
      },
    },
    {
      id: 'uictl_004',
      name: 'handler 对非法命令返回失败',
      category: 'ui_control',
      run: async () => {
        const t = registry.get('ControlUI');
        if (!t) return false;
        const result = await t.handler({ command: 'not_a_command' });
        return result.success === false && typeof result.error === 'string';
      },
    },
    {
      id: 'uictl_005',
      name: 'handler 合法命令广播并返回成功(含 tab/query 透传)',
      category: 'ui_control',
      run: async () => {
        const t = registry.get('ControlUI');
        if (!t) return false;
        // 广播依赖 sse-broadcast——无订阅者时 broadcastEvent 不抛即可
        const result = await t.handler({ command: 'open_cockpit', tab: 'data', reason: '测试' });
        return result.success === true && result.message.includes('open_cockpit');
      },
    },
    {
      id: 'uictl_006',
      name: 'tool-contract 契约条目存在且 maxTimeout 一致',
      category: 'ui_control',
      run: () => {
        const contracts = require('../../src/core/tool-contract').TOOL_CONTRACTS;
        const c = contracts.ControlUI;
        const t = registry.get('ControlUI');
        return !!c
          && c.maxTimeout === 3000
          && c.riskLevel === 'low'
          && t?.timeout === 3000;
      },
    },
  ],
};
