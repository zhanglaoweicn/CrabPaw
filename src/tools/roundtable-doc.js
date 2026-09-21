/**
 * roundtable-doc.js — 圆桌会纪要/计划书 Word 生成（tools 层实现，2026-09-20）
 *
 * 层契约 R1：core 不得上溯依赖 tools——roundtable.js 只暴露 setRoundtableDocGenerator
 * 注入点，本模块由 server.js 装配注入。职责：会议状态 → 纪要 markdown → docx 落盘
 * → MediaNotifier 文件卡广播（file_generated SSE + 企微投递）。
 */
const fs = require('fs');
const path = require('path');
const { _generateDocx } = require('./document-tools');

/**
 * 生成圆桌会纪要 docx
 * @param {object} state 会议状态（goal/host/members/statements/interventions/conclusion/dataBrief/startedAt）
 * @returns {Promise<{name: string, path: string, size: number}|null>} 文档信息；失败/跳过返回 null
 */
async function generateRoundtableDoc(state) {
  const dateStr = new Date(state.startedAt).toISOString().slice(0, 10);
  const md = [
    `# 圆桌会议纪要：${state.goal}`,
    ``,
    `> 日期：${dateStr} 主持：${state.host ? state.host.name : '—'} 参会：${[state.host, ...(state.members || [])].filter(Boolean).map((e) => e.name).join('、')}`,
    ``,
    `## 一、会议结论`,
    ``,
    state.conclusion ? state.conclusion.text : '（无）',
    ``,
    `## 二、任务清单`,
    ``,
  ];
  if (state.conclusion && state.conclusion.tasks && state.conclusion.tasks.length > 0) {
    md.push('| 负责人 | 任务事项 |', '| --- | --- |');
    state.conclusion.tasks.forEach((t) => md.push(`| ${t.owner} | ${t.task} |`));
  } else {
    md.push('（本次会议未分配任务）');
  }
  md.push('', '## 三、各岗位发言记录', '');
  // 只收录讨论轮（第1/2轮）——第3轮是主持收口，结论已在上文专节，重复罗列是冗余
  (state.statements || []).filter((s) => (s.round || 0) < 3).forEach((s) => {
    md.push(`### 第${s.round}轮 · ${s.expertName}${s.department ? `（${s.department}）` : ''}`, '', s.text || '（未发言）', '');
  });
  (state.interventions || []).forEach((i) => {
    md.push(`> 老板插话：${i.text}`, '');
  });
  if (state.dataBrief) {
    md.push('## 附：会场数据简报（结论引用数字的来源）', '', state.dataBrief, '');
  }
  const goalText = String(state.goal);
  const title = `圆桌纪要-${goalText.slice(0, 24).replace(/[\\/:*?"<>|\n\r]/g, '')}${goalText.length > 24 ? '…' : ''}-${dateStr}`;
  const buffer = await _generateDocx(md.join('\n'), title, '商务报告');
  const dir = path.resolve(__dirname, '..', '..', 'data', 'workspace', 'documents');
  fs.mkdirSync(dir, { recursive: true });
  const safeName = `${title}.docx`.replace(/[\r\n]/g, '');
  const filePath = path.join(dir, safeName);
  fs.writeFileSync(filePath, buffer);
  try {
    const { getMediaNotifier } = require('../core/file-notifier');
    getMediaNotifier().notify({ mediaType: 'docx', filePath, name: safeName, size: buffer.length });
  } catch (e) { console.warn('[RoundtableDoc] 文件卡通知失败:', e.message); }
  return { name: safeName, path: filePath, size: buffer.length };
}

module.exports = { generateRoundtableDoc };
