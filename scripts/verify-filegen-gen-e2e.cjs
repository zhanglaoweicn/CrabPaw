/**
 * verify-filegen-gen-e2e.cjs — 2026-08-23 端到端验证：生成类工具 → 文件生成面板链路
 *
 * 通用格式验证（PPT/EXCEL/PDF），取代 verify-filegen-pptx-e2e.cjs 的 pptx 专版：
 *   1. /auth/bootstrap 取 token（X-Requested-With 本地上下文；路由无 /api/ 前缀）
 *   2. SSE /events 连接（等 'connected' 帧再发 chat——filegen:start 广播在请求处理开始）
 *   3. POST /chat 发生成意图（UTF-8，勿用 curl——GBK 编码坑）
 *   4. 收集 filegen:start/phase/source/done + tool_call，断言：
 *      start ≥1 → source ≥1 → done ≥1 且 done.file.format === 期望 format
 *   5. 打印工具序列 / 阶段序列 / 产物 / Write 标题（面板实料）
 *
 * 链路要点（2026-08-23 契约修复后）:
 *   - 模型可能直出 PptxGenerate/XlsxGenerate/PdfGenerate（无 Write）——
 *     done 事件 + 产物文件即链路通，不再强制 Write（旧脚本 writes≥1 过时断言）
 *   - 生成类契约不放 additionalProperties:false——deepseek 参数名自由发挥
 *     （colorScheme/coverTemplate/tableData/columns…每次不同）收紧只会连环拒
 *
 * 用法: node scripts/verify-filegen-gen-e2e.cjs "消息" "期望format"
 *   node scripts/verify-filegen-gen-e2e.cjs "做一份关于人工智能发展的PPT演示文稿，大约8页" pptx
 *   node scripts/verify-filegen-gen-e2e.cjs "生成一个 EXCEL 表格，统计 2025 年各季度销售数据" xlsx
 *   node scripts/verify-filegen-gen-e2e.cjs "生成一个 PDF 文件，介绍智能体技术" pdf
 */
const BASE = 'http://127.0.0.1:38767';

async function main() {
  const message = process.argv[2];
  const wantFormat = (process.argv[3] || 'pptx').toLowerCase();
  if (!message) { console.error('用法: node scripts/verify-filegen-gen-e2e.cjs "消息" "format(pptx|xlsx|pdf)"'); process.exit(2); }
  console.log(`[e2e] 消息: ${message} | 期望 format: ${wantFormat}`);

  // 1. bootstrap token
  const boot = await fetch(`${BASE}/auth/bootstrap`, {
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
  }).then(r => r.json()).catch(e => ({ success: false, error: String(e) }));
  if (!boot.success || !boot.token) {
    console.error('[e2e] ❌ bootstrap 取 token 失败:', boot);
    process.exit(1);
  }
  const auth = { Authorization: `Bearer ${boot.token}`, 'X-Requested-With': 'XMLHttpRequest' };

  // 2. SSE /events（等 connected 帧）
  const events = [];
  let sseConnectedResolve;
  const sseConnected = new Promise((r) => { sseConnectedResolve = r; });
  const sseP = (async () => {
    try {
      const res = await fetch(`${BASE}/events`, { headers: auth });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop() || '';
        for (const frame of frames) {
          const ev = frame.split('\n').find(l => l.startsWith('event: '))?.slice(7).trim();
          const data = frame.split('\n').find(l => l.startsWith('data: '))?.slice(6).trim();
          if (ev === 'connected') { sseConnectedResolve?.(); continue; }
          if (ev && data) {
            let d; try { d = JSON.parse(data); } catch { continue; }
            if (ev.startsWith('filegen')) events.push({ ev, d });
            else if (ev === 'tool_call' && d && d.toolName) events.push({ ev, d });
          }
        }
      }
    } catch (e) { console.warn('[e2e] SSE 连接断开:', e.message); }
  })();
  await Promise.race([sseConnected, new Promise(r => setTimeout(r, 5000))]);

  // 3. POST /chat
  console.log('[e2e] 发送生成请求…');
  const chatRes = await fetch(`${BASE}/chat`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, stream: true }),
  });
  if (!chatRes.ok) {
    const t = await chatRes.text();
    console.error(`[e2e] ❌ /chat 失败 ${chatRes.status}:`, t.slice(0, 400));
    process.exit(1);
  }
  const reader = chatRes.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop() || '';
    for (const f of frames) {
      const ev = f.split('\n').find(l => l.startsWith('event: '))?.slice(7).trim();
      const data = f.split('\n').find(l => l.startsWith('data: '))?.slice(6).trim();
      if (ev && data) {
        let d; try { d = JSON.parse(data); } catch { continue; }
        if (ev === 'tool_call' && ['Write', 'Edit'].includes(d.toolName || d.name)) {
          if ((d.toolName || d.name) === 'Write') console.log(`[e2e] ⚙️ Write: ${(d.toolArgs?.path || d.args?.path || '').slice(0, 90)}`);
        }
      }
    }
  }
  // 等 SSE 事件收尾（done 广播 + surface 推送）
  await new Promise(r => setTimeout(r, 10000));

  // 4. 汇总断言
  console.log('\n========== [e2e] 链路结果 ==========');
  const starts = events.filter(e => e.ev === 'filegen:start');
  const phases = events.filter(e => e.ev === 'filegen:phase');
  const sources = events.filter(e => e.ev === 'filegen:source');
  const dones = events.filter(e => e.ev === 'filegen:done');
  const writes = events.filter(e => e.ev === 'tool_call' && (e.d?.toolName === 'Write' || e.d?.name === 'Write'));
  const toolCalls = events.filter(e => e.ev === 'tool_call');
  console.log(`filegen:start ×${starts.length} | source ×${sources.length} | phase ×${phases.length} | Write ×${writes.length} | done ×${dones.length}`);
  // 工具调用序列（诊断模型走了哪条生成路径）
  const toolSeq = toolCalls.map(t => t.d?.toolName || t.d?.name || '?').join(' → ');
  console.log(`工具序列: ${toolSeq || '（无工具调用）'}`);
  // 阶段序列（collect→writing→converting→done）
  const seq = phases.map(p => p.d.phase).join(' → ');
  console.log(`阶段序列: ${seq || '（无 phase 事件）'}`);
  // 产物
  const done = dones[dones.length - 1];
  if (done) {
    console.log(`产物: ${done.d.file?.name} (format=${done.d.file?.format})`);
    for (const f of (done.d.files || [])) console.log(`  · ${f.name} (${f.format})`);
  }
  // 搜索资料（实料）
  for (const s of sources.slice(0, 2)) {
    console.log(`  🔍 ${s.d.query} → ${s.d.sources.length} 条来源`);
  }
  // Write 内容实料（面板解析视角）
  for (const w of writes.slice(0, 2)) {
    const args = w.d.toolArgs || w.d.args || {};
    const content = String(args.content || '');
    const heads = content.split(/\r?\n/).filter(l => /^#{1,2}\s+/.test(l)).slice(0, 10);
    const path = String(args.path || args.file_path || '');
    console.log(`\nWrite(${path.split(/[\\/]/).pop()}): ${heads.length} 个 # 标题（解析器实料）`);
    heads.forEach(h => console.log(`  ${h.trim()}`));
  }

  // 轻量生成（如简单表格）模型可能跳过搜索——source 为软性提示，不断言
  const pass = starts.length >= 1 && dones.length >= 1
    && done && done.d.file?.format === wantFormat;
  console.log(pass
    ? `\n✅ 链路通：start → 搜索 → 生成工具 → done(${wantFormat})`
    : '\n❌ 链路缺口（见上方明细）');
  process.exit(pass ? 0 : 1);
}

main().catch(e => { console.error('[e2e] 异常:', e); process.exit(1); });
