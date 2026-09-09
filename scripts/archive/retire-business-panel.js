/**
 * retire-business-panel.js — 业务面板退役接线清理（2026-08-19，一次性脚本）
 * 对 gui/src/pages/VoiceShell/index.tsx 做多段精确替换：
 *   1. 删除 import BusinessPanel
 *   2. 删除 businessVisible/businessTab 状态
 *   3. onOpenCockpit: calendar → SchedulePanel；memory 非开发者 → 管理舱 data tab
 *   4. 删除 crabpaw:open/close-business-panel 监听
 *   5. open-search → FileGenPanel（__filePanel.setVisible）
 *   6. 删除 business_panel 语音命令路由分支
 *   7. 删除顶部「📅 业务」按钮与收起业务面板逻辑
 *   8. 删除 BusinessPanel 渲染，ManagementCockpit 补 onInsertToChat
 * 每段替换校验唯一命中（count===1），失败即报错不落盘。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'gui', 'src', 'pages', 'VoiceShell', 'index.tsx');
let s = fs.readFileSync(FILE, 'utf8');

const edits = [
  // 1. import
  ["import { BusinessPanel, type BusinessTab } from '../../components/BusinessPanel'\n", ''],
  // 2. 状态
  [
    "  // 阶段 C: 业务面板（日程/文件/专家）\n  const [businessVisible, setBusinessVisible] = useState(false)\n  const [businessTab, setBusinessTab] = useState<BusinessTab>('calendar')\n",
    '',
  ],
  // 3. onOpenCockpit 内 calendar 分支（开 SchedulePanel 卡片）
  [
    "        if (tab === 'calendar') {\n          // 日历 → 业务面板日程 tab（单界面下日历在业务面板，与管理舱互斥）\n          if (cockpitVisible) setCockpitVisible(false)\n          setBusinessTab('calendar')\n          setBusinessVisible(true)\n          return\n        }\n",
    "        if (tab === 'calendar') {\n          // 日历 → 日程卡片 SchedulePanel（2026-08-19 业务面板退役后直达卡片）\n          if (cockpitVisible) setCockpitVisible(false)\n          if (historyDrawerOpen) setHistoryDrawerOpen(false)\n          try { (window as any).__schedulePanel?.open() } catch (err) { console.error('[shell] 打开日程卡片失败:', err) }\n          return\n        }\n",
  ],
  // 4. onOpenCockpit 内 memory 非开发者分支 → 管理舱 data tab
  [
    "          // 非开发者: 打开业务面板(经营数据含记忆图谱), 不拒绝用户\n          if (cockpitVisible) setCockpitVisible(false)\n          setBusinessTab('business')\n          setBusinessVisible(true)\n          speech.enqueue({ id: `nav_${Date.now()}`, text: '已打开记忆图谱', kind: 'panel' })\n          return\n",
    "          // 非开发者: 打开管理舱「专家·数据」tab(记忆图谱入口), 不拒绝用户\n          if (cockpitVisible) setCockpitVisible(false)\n          if (historyDrawerOpen) setHistoryDrawerOpen(false)\n          setCockpitTab('data')\n          setCockpitNavSection(null)\n          setCockpitVisible(true)\n          speech.enqueue({ id: `nav_${Date.now()}`, text: '已打开记忆图谱', kind: 'panel' })\n          return\n",
  ],
  // 5. onOpenCockpit 内 home/chat 分支去掉 businessVisible 收起
  [
    "          if (cockpitVisible) setCockpitVisible(false)\n          if (businessVisible) setBusinessVisible(false)\n          setHistoryDrawerOpen(false)\n          speech.enqueue({ id: `nav_${Date.now()}`, text: tab === 'home' ? '已回到首页' : '对话已打开', kind: 'panel' })\n          return\n",
    "          if (cockpitVisible) setCockpitVisible(false)\n          setHistoryDrawerOpen(false)\n          speech.enqueue({ id: `nav_${Date.now()}`, text: tab === 'home' ? '已回到首页' : '对话已打开', kind: 'panel' })\n          return\n",
  ],
  // 6. onOpenCockpit 尾部兜底去 businessVisible
  [
    "        if (businessVisible) setBusinessVisible(false)\n        if (historyDrawerOpen) setHistoryDrawerOpen(false)\n        setCockpitTab(cockpitTabMap[tab] || 'settings')\n",
    "        if (historyDrawerOpen) setHistoryDrawerOpen(false)\n        setCockpitTab(cockpitTabMap[tab] || 'settings')\n",
  ],
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
  console.log(`✓ ${from.slice(0, 40).replace(/\n/g, '\\n')}...`);
}

if (failed) {
  console.error('存在未命中替换，未写盘。');
  process.exit(1);
}
fs.writeFileSync(FILE, s);
console.log('✅ 已写盘（第一批：import/状态/cockpit 导航）。');
