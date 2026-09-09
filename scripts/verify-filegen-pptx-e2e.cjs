/**
 * verify-filegen-pptx-e2e.cjs — 2026-08-23 端到端验证：PPT 生成 → 载体感知视图实料
 *
 * 验证链路（双卡片架构 PPT 视图：页面轨道 parseSlides 的实料来源）：
 *   1. /auth/bootstrap 取 token（X-Requested-With 本地上下文；路由无 /api/ 前缀）
 *   2. SSE /events 连接（等 'connected' 帧再发 chat——filegen:start 广播在请求处理开始）
 *   3. POST /chat 发 PPT 生成意图（UTF-8，勿用 curl——GBK 编码坑）
 *   4. 收集 filegen:start/phase/source/done + tool_call(Write/Edit)，断言：
 *      start → source(搜索) → Write(markdown # 标题) → converting(pptx 转换) → done(format=pptx)
 *   5. 打印 Write 内容头部——页面轨道（parseSlides）拆页的实料
 *
 * 用法: node scripts/verify-filegen-pptx-e2e.cjs ["做一份关于人工智能发展的PPT，大约8页"]
 */
const BASE = 'http://127.0.0.1:38767';

async function main() {
  const message = process.argv[2] || '做一份关于人工智能发展的PPT演示文稿，大约8页';
  console.log(`[e2e] 消息: ${message}`);

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
  console.log('[e2e] 发送 PPT 生成请求…');
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
        if (ev === 'tool_call' && ['Write', 'Edit', 'WebSearch'].includes(d.toolName || d.name)) {
          const name = d.toolName || d.name;
          if (name === 'Write') console.log(`[e2e] ⚙️ Write: ${(d.toolArgs?.path || d.args?.path || '').slice(0, 90)}`);
        }
      }
    }
  }
  // 等 SSE 事件收尾（done 广播 + surface 推送——模型写作/转换可能耗时）
  await new Promise(r => setTimeout(r, 10000));

  // 4. 汇总断言
  console.log('\n========== [e2e] PPT 链路结果 ==========');
  const starts = events.filter(e => e.ev === 'filegen:start');
  const phases = events.filter(e => e.ev === 'filegen:phase');
  const sources = events.filter(e => e.ev === 'filegen:source');
  const dones = events.filter(e => e.ev === 'filegen:done');
  const writes = events.filter(e => e.ev === 'tool_call' && (e.d?.toolName === 'Write' || e.d?.name === 'Write'));
  const edits = events.filter(e => e.ev === 'tool_call' && (e.d?.toolName === 'Edit' || e.d?.name === 'Edit'));
  const toolCalls = events.filter(e => e.ev === 'tool_call');
  console.log(`filegen:start ×${starts.length} | source ×${sources.length} | phase ×${phases.length} | Write ×${writes.length} | Edit ×${edits.length} | done ×${dones.length}`);
  // 工具调用序列（全量——诊断模型实际走了哪条生成路径）
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
  for (const s of sources.slice(0, 3)) {
    console.log(`  🔍 ${s.d.query} → ${s.d.sources.length} 条来源`);
    for (const src of s.d.sources.slice(0, 2)) console.log(`      - ${src.title}`);
  }
  // 5. Write 内容实料——页面轨道 parseSlides 拆页依据（# 标题 → 页）
  for (const w of writes.slice(0, 3)) {
    const args = w.d.toolArgs || w.d.args || {};
    const content = String(args.content || '');
    const heads = content.split(/\r?\n/).filter(l => /^#{1,2}\s+/.test(l)).slice(0, 12);
    const path = String(args.path || args.file_path || '');
    console.log(`\nWrite(${path.split(/[\\/]/).pop()}): ${heads.length} 个 # 标题（页面轨道页数）`);
    heads.forEach(h => console.log(`  ${h.trim()}`));
    if (!heads.length) console.log(`  内容前 3 行: ${content.split(/\r?\n/).slice(0, 3).join(' | ').slice(0, 150)}`);
  }

  const pass = starts.length >= 1 && sources.length >= 1 && writes.length >= 1 && dones.length >= 1
    && done && done.d.file?.format === 'pptx';
  console.log(pass
    ? '\n✅ PPT 链路通：start → 搜索 → Write(# 标题) → 转换 → done(pptx)'
    : '\n❌ 链路缺口（见上方明细）——若产物非 pptx 请查看模型实际工具序列');
  process.exit(pass ? 0 : 1);
}

main().catch(e => { console.error('[e2e] 异常:', e); process.exit(1); });
