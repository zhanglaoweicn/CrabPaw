/**
 * retire-business-panel2.js — 业务面板退役第二批（2026-08-19，一次性脚本）
 *  VoiceShell/index.tsx：
 *   1. 删除 crabpaw:open/close-business-panel 监听 effect
 *   2. open-search → __filePanel.setVisible(true)（FileGenPanel 文件面板）
 *   3. memory 分支 isDevMode 里去掉 businessVisible 收起
 *   4. 管理舱命令分支（1285 附近）去掉 businessVisible 收起
 *   5. 删除 business_panel 语音命令路由分支
 *   6. 其他散点 businessVisible 收起（1404/1541 deps/1794/1811）
 *   7. 删除顶部「📅 业务」按钮
 *   8. 删除 BusinessPanel 渲染 + ManagementCockpit 补 onInsertToChat
 * 每段校验唯一命中。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'gui', 'src', 'pages', 'VoiceShell', 'index.tsx');
let s = fs.readFileSync(FILE, 'utf8');

const edits = [
  // 1. 删除 business-panel 监听 effect 整段
  [
    `  // crabpaw:open-business-panel —— BusinessPanel.__businessPanel.open(tab) 经 custom event 通知 VoiceShell
  useEffect(() => {
    const onOpenBusinessPanel = (e: Event) => {
      const detail = (e as CustomEvent).detail
      const tab = detail?.tab || 'calendar'
      try {
        if (cockpitVisible) setCockpitVisible(false)
        if (historyDrawerOpen) setHistoryDrawerOpen(false)
        setBusinessTab(tab)
        setBusinessVisible(true)
      } catch (err) { console.error('[shell] 命令面板打开业务面板失败:', err) }
    }
    // 2026-08-13 审查 P1: UiCommandBridge(ControlUI)派发 close_business_panel
    // 此前无监听者——agent 调用关闭命令业务面板纹丝不动,LLM 却收到 success
    const onCloseBusinessPanel = () => {
      try { setBusinessVisible(false) } catch (err) { console.error('[shell] 语音关闭业务面板失败:', err) }
    }
    window.addEventListener('crabpaw:open-business-panel', onOpenBusinessPanel)
    window.addEventListener('crabpaw:close-business-panel', onCloseBusinessPanel)
    return () => {
      window.removeEventListener('crabpaw:open-business-panel', onOpenBusinessPanel)
      window.removeEventListener('crabpaw:close-business-panel', onCloseBusinessPanel)
    }
  }, [cockpitVisible, historyDrawerOpen])

`,
    '',
  ],
  // 2. open-search → FileGenPanel
  [
    `  // crabpaw:open-search —— 语音"帮我找 X/搜索 X"（voice-panel-commands search kind）→
  // 打开业务面板文件 tab + 播报引导（老板可直接说文件名继续找,不依赖 LLM 4-6s 碰运气）
  useEffect(() => {
    const onOpenSearch = (e: Event) => {
      const detail = (e as CustomEvent).detail
      try {
        // 开业务面板时收起管理舱，避免双浮层（与 business_panel open 同口径）
        if (cockpitVisible) setCockpitVisible(false)
        if (historyDrawerOpen) setHistoryDrawerOpen(false)
        setBusinessTab('files')
        setBusinessVisible(true)
        speech.enqueue({ id: \`search_\${Date.now()}\`, text: '已打开文件面板，您可以直接说文件名让我找', kind: 'panel' })
        // UiCommandBridge(agent 命令)派发 detail { query };本地语音命令路径派发 { text }——双兼容读取
        const q = detail?.query ?? detail?.text
        if (q) console.log('[shell] 语音搜索请求:', q)
      } catch (err) { console.error('[shell] 语音打开文件搜索失败:', err) }
    }
    window.addEventListener('crabpaw:open-search', onOpenSearch)
    return () => window.removeEventListener('crabpaw:open-search', onOpenSearch)
  }, [cockpitVisible, historyDrawerOpen, speech])
`,
    `  // crabpaw:open-search —— 语音"帮我找 X/搜索 X"（voice-panel-commands search kind）→
  // 打开文件生成面板 FileGenPanel + 播报引导（老板可直接说文件名继续找,不依赖 LLM 4-6s 碰运气）
  useEffect(() => {
    const onOpenSearch = (e: Event) => {
      const detail = (e as CustomEvent).detail
      try {
        // 开文件面板时收起管理舱，避免双浮层
        if (cockpitVisible) setCockpitVisible(false)
        if (historyDrawerOpen) setHistoryDrawerOpen(false)
        try { (window as any).__filePanel?.setVisible(true) } catch (err) { console.error('[shell] 打开文件面板失败:', err) }
        speech.enqueue({ id: \`search_\${Date.now()}\`, text: '已打开文件面板，您可以直接说文件名让我找', kind: 'panel' })
        // UiCommandBridge(agent 命令)派发 detail { query };本地语音命令路径派发 { text }——双兼容读取
        const q = detail?.query ?? detail?.text
        if (q) console.log('[shell] 语音搜索请求:', q)
      } catch (err) { console.error('[shell] 语音打开文件搜索失败:', err) }
    }
    window.addEventListener('crabpaw:open-search', onOpenSearch)
    return () => window.removeEventListener('crabpaw:open-search', onOpenSearch)
  }, [cockpitVisible, historyDrawerOpen, speech])
`,
  ],
  // 3. memory 分支 isDevMode 收起 businessVisible
  [
    "          if (isDevMode()) {\n            if (businessVisible) setBusinessVisible(false)\n            if (historyDrawerOpen) setHistoryDrawerOpen(false)\n",
    "          if (isDevMode()) {\n            if (historyDrawerOpen) setHistoryDrawerOpen(false)\n",
  ],
  // 4. onOpenCockpit deps
  ["  }, [businessVisible, cockpitVisible, historyDrawerOpen, speech])\n", "  }, [cockpitVisible, historyDrawerOpen, speech])\n"],
  // 5. 管理舱命令分支的 businessVisible 收起
  [
    "            try {\n                if (businessVisible) setBusinessVisible(false)\n                setCockpitTab(targetMap[target] || 'settings')\n",
    "            try {\n                setCockpitTab(targetMap[target] || 'settings')\n",
  ],
  // 6. 删除 business_panel 语音命令分支（1312 起整段 else-if）
  [
    `        } else if (cmd.kind === 'business_panel') {
          // 阶段 C: 业务面板（日程/文件/专家/经营数据/股票）
          const tabMap: Record<string, BusinessTab> = {
            calendar: 'calendar', files: 'files', experts: 'experts',
            business: 'business', stocks: 'stocks',
          }
`,
    '',
  ],
  // 7. 散点 businessVisible 收起（1412 附近 = 其他浮层分支）
  ["            if (businessVisible) setBusinessVisible(false)\n", ''],
  // 8. useMemo deps
  ["  }, [speech, flow, cockpitVisible, businessVisible, historyDrawerOpen, pushChat, applyShellConfig])\n", "  }, [speech, flow, cockpitVisible, historyDrawerOpen, pushChat, applyShellConfig])\n"],
];

let failed = false;
for (const [from, to] of edits) {
  const n = s.split(from).length - 1;
  if (n !== 1) {
    console.error(`✗ 命中 ${n} 次(期望 1): ${JSON.stringify(from.slice(0, 60))}...`);
    failed = true;
    continue;
  }
  s = s.split(from).join(to);
  console.log(`✓ ${from.slice(0, 46).replace(/\n/g, '\\n')}...`);
}

if (failed) {
  console.error('存在未命中替换，未写盘。');
  process.exit(1);
}
fs.writeFileSync(FILE, s);
console.log('✅ 已写盘（第二批：监听/搜索/命令分支/deps）。');
