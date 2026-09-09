/**
 * retire-business-panel3.js — 业务面板退役第三批（2026-08-19，一次性脚本）
 *  VoiceShell/index.tsx：
 *   1. 删除 business_panel 语音命令分支残留开/关逻辑体
 *   2. search 分支注释更新（文件面板）
 *   3. 管理舱/历史按钮里收起业务面板逻辑删除
 *   4. 删除顶部「📅 业务」按钮整段
 *   5. 删除 BusinessPanel 渲染整段 + ManagementCockpit 补 onInsertToChat
 * 每段校验唯一命中。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'gui', 'src', 'pages', 'VoiceShell', 'index.tsx');
let s = fs.readFileSync(FILE, 'utf8');

const edits = [
  // 1. business_panel 命令分支残留逻辑体（search 分支内的孤儿 if/else，整块删除）
  [
    `          } catch (err) { console.error('[shell] 派发打开搜索事件失败:', err); hasPanel = false }
          if (cmd.action === 'open') {
            const target = cmd.target || 'calendar'
            try {
              // 开业务面板时收起管理舱，避免双浮层
              if (cockpitVisible) setCockpitVisible(false)
              if (historyDrawerOpen) setHistoryDrawerOpen(false)
              setBusinessTab(tabMap[target] || 'calendar')
              setBusinessVisible(true)
              hasPanel = true
            } catch (err) { console.error('[shell] 打开业务面板失败:', err); hasPanel = false }
          } else {
            try { setBusinessVisible(false) } catch (err) { console.error('[shell] 关闭业务面板失败:', err) }
            hasPanel = false
          }
        } else if (cmd.kind === 'guidance') {`,
    `          } catch (err) { console.error('[shell] 派发打开搜索事件失败:', err); hasPanel = false }
        } else if (cmd.kind === 'guidance') {`,
  ],
  // 2. search 分支注释
  [
    "          // 2026-08-12 (搜索落地 4a): 语音\"帮我找 X/搜索 X\"——本地直达,不落 LLM 等 4-6s 碰运气。\n          // 派发 crabpaw:open-search 事件,由下方监听打开业务面板文件 tab 并播报引导\n          //（detail 携带剥离前缀后的原文,预留后续透传搜索词到 FileBrowser）\n",
    "          // 2026-08-12 (搜索落地 4a): 语音\"帮我找 X/搜索 X\"——本地直达,不落 LLM 等 4-6s 碰运气。\n          // 派发 crabpaw:open-search 事件,由下方监听打开文件面板(FileGenPanel)并播报引导\n          //（detail 携带剥离前缀后的原文,预留后续透传搜索词）\n",
  ],
  // 3a. 管理舱按钮收起业务面板
  [
    "            onClick={() => {\n              // 打开管理舱时收起业务面板，避免双浮层\n              if (businessVisible) { try { setBusinessVisible(false) } catch (err) { console.error('[shell] 关闭业务面板失败:', err) } }\n              // 2026-08-14 数据链审计 C-11: 同时收起历史抽屉(与其他浮层同口径单浮层)\n",
    "            onClick={() => {\n              // 2026-08-14 数据链审计 C-11: 同时收起历史抽屉(与其他浮层同口径单浮层)\n",
  ],
  // 3b. 历史按钮收起业务面板
  [
    "            onClick={() => {\n              // 2026-08-14 数据链审计 C-11: 开历史抽屉时收起业务面板与管理舱,保持单浮层\n              if (businessVisible) { try { setBusinessVisible(false) } catch (err) { console.error('[shell] 关闭业务面板失败:', err) } }\n              if (cockpitVisible) { try { setCockpitVisible(false) } catch (err) { console.error('[shell] 关闭管理舱失败:', err) } }\n",
    "            onClick={() => {\n              // 2026-08-14 数据链审计 C-11: 开历史抽屉时收起管理舱,保持单浮层\n              if (cockpitVisible) { try { setCockpitVisible(false) } catch (err) { console.error('[shell] 关闭管理舱失败:', err) } }\n",
  ],
  // 4. 删除顶部「📅 业务」按钮
  [
    `          {/* 阶段 C: 业务面板按钮——打开时收起管理舱，避免双浮层 */}
          <button
            type="button"
            className={\`voice-shell-console-btn\${businessVisible ? ' is-active' : ''}\`}
            onClick={() => {
              if (cockpitVisible) { try { setCockpitVisible(false) } catch (err) { console.error('[shell] 关闭管理舱失败:', err) } }
              // 2026-08-14 数据链审计 C-11: 同时收起历史抽屉(与抽屉遮罩互斥,避免堆叠)
              if (historyDrawerOpen) setHistoryDrawerOpen(false)
              setBusinessTab('calendar')
              setBusinessVisible(true)
            }}
            title="业务面板（日程/文件/专家）"
          >
            📅 业务
          </button>
`,
    '',
  ],
  // 5. 删除 BusinessPanel 渲染 + ManagementCockpit 补 onInsertToChat
  [
    `      {/* 阶段 C: 业务面板浮层 */}
      <BusinessPanel
        visible={businessVisible}
        initialTab={businessTab}
        onReferenceFile={(name: string, path: string) => {
          // 文件"引用到对话"（真实 path）→ 只插入聊天输入，用户可编辑后再发送
          if (path) {
            try { setTextInput(name) } catch (err) { console.error('[shell] 引用文件到对话失败:', err) }
            return
          }
          // 专家召唤（BusinessPanel 传空 path）→ 填充后自动发送（P2-5: 省二次交互）。
          // 走 handleUserInput 与输入框回车发送同一条链路（面板命令匹配 → rearm → flow.sendText），
          // 不直接 setTextInput 让用户再点一次"发送"。
          try { handleUserInput(name) } catch (err) { console.error('[shell] 专家召唤自动发送失败:', err) }
        }}
        onClose={() => { try { setBusinessVisible(false) } catch (err) { console.error('[shell] 业务面板关闭失败:', err) } }}
        onNavigateChat={() => { try { setBusinessVisible(false) } catch (err) { console.error('[shell] 业务面板跳转关闭失败:', err) } }}
      />
`,
    '',
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
  console.log(`✓ ${from.slice(0, 46).replace(/\n/g, '\\n')}...`);
}

if (failed) {
  console.error('存在未命中替换，未写盘。');
  process.exit(1);
}
fs.writeFileSync(FILE, s);
console.log('✅ 已写盘（第三批：按钮/渲染/命令残留）。');
