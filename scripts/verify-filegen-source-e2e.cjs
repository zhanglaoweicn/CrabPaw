/**
 * verify-filegen-source-e2e.cjs — 2026-08-23 端到端验证：文章生成 → 搜索资料 → Write → 产物
 *
 * 验证链路（用户三问：①搜集资料是否用搜索+显示来源 ②deep-research 是否生效 ③loop 是否可见）：
 *   1. /api/auth/bootstrap 取 token（X-Requested-With 本地上下文）
 *   2. SSE /events 连接，收集 filegen:start/phase/source/done + tool_call 帧
 *   3. POST /api/chat 发生成意图（UTF-8，勿用 curl——GBK 编码坑见记忆）
 *   4. 等待 done 事件，断言：filegen:start → filegen:source（WebSearch 插桩）→ Write → done
 *
 * 用法: node scripts/verify-filegen-source-e2e.cjs ["写一份关于OPC的演讲稿，面向刚毕业的大学生"]
 */
const BASE = 'http://127.0.0.1:38767';

async function main() {
  const message = process.argv[2] || '写一份关于OPC的演讲稿，面向刚毕业的大学生';
  console.log(`[e2e] 消息: ${message}`);

  // 1. bootstrap token（本地浏览器上下文：X-Requested-With；路由无 /api/ 前缀）
  const boot = await fetch(`${BASE}/auth/bootstrap`, {
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
  }).then(r => r.json()).catch(e => ({ success: false, error: String(e) }));
  if (!boot.success || !boot.token) {
    console.error('[e2e] ❌ bootstrap 取 token 失败:', boot);
    process.exit(1);
  }
  const token = boot.token;
  const auth = { Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' };

  // 2. SSE /events——收集 filegen:* 事件。
  // 2026-08-23 实测教训: filegen:start 在 POST /chat 处理一开始就广播——SSE 连接
  // 若未建立（固定 1.2s 等待不够，后端忙时握手慢），start 事件丢失（source/phase/done 仍在）。
  // 必须等 SSE 'connected' 帧确认连接建立后再发 chat。
  const events = [];
  let sseConnectedResolve;
  const sseConnected = new Promise((r) => { sseConnectedResolve = r; });
  const sseDone = new Promise((resolve) => setTimeout(resolve, 30000));
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
            else if (ev === 'tool_call' && d && (d.toolName === 'WebSearch' || d.toolName === 'Write')) events.push({ ev, d });
          }
        }
      }
    } catch (e) { console.warn('[e2e] SSE 连接断开:', e.message); }
  })();
  // 等 SSE 连接确认（5s 兜底），再发 chat——确保不丢开头的 filegen:start
  await Promise.race([sseConnected, new Promise(r => setTimeout(r, 5000))]);

  // 3. POST /chat（stream——路由无 /api/ 前缀，与前端 useChatStream 一致）
  console.log('[e2e] 发送生成请求…');
  const chatP = fetch(`${BASE}/chat`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, stream: true }),
  });
  const chatRes = await chatP;
  if (!chatRes.ok) {
    const t = await chatRes.text();
    console.error(`[e2e] ❌ /api/chat 失败 ${chatRes.status}:`, t.slice(0, 400));
    process.exit(1);
  }
  // 消费 chat SSE 流直到结束（tool_call 帧可在 events 通道观察；chat 流读完为止）
  const reader = chatRes.body.getReader();
  const dec = new TextDecoder();
  let chatBuf = '';
  let sawWrite = false, sawSearch = false;
  const watch = (frame) => {
    const ev = frame.split('\n').find(l => l.startsWith('event: '))?.slice(7).trim();
    const data = frame.split('\n').find(l => l.startsWith('data: '))?.slice(6).trim();
    if (ev && data) {
      let d; try { d = JSON.parse(data); } catch { return; }
      if (ev === 'tool_call') {
        const name = d.toolName || d.name;
        if (name === 'WebSearch') { sawSearch = true; console.log(`[e2e] ⚙️ WebSearch: ${JSON.stringify(d.toolArgs || d.args || d.call?.args || {}).slice(0, 120)}`); }
        if (name === 'Write') { sawWrite = true; console.log(`[e2e] ⚙️ Write: ${(d.toolArgs?.path || d.args?.path || '').slice(0, 90)}`); }
      }
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chatBuf += dec.decode(value, { stream: true });
    const frames = chatBuf.split('\n\n');
    chatBuf = frames.pop() || '';
    for (const f of frames) watch(f);
  }
  await sseDone;

  // 4. 汇总断言
  console.log('\n========== [e2e] 结果 ==========');
  const starts = events.filter(e => e.ev === 'filegen:start');
  const sources = events.filter(e => e.ev === 'filegen:source');
  const dones = events.filter(e => e.ev === 'filegen:done');
  const writes = events.filter(e => e.ev === 'tool_call' && (e.d?.toolName === 'Write' || e.d?.name === 'Write'));
  console.log(`filegen:start ×${starts.length} | filegen:source ×${sources.length} | filegen:done ×${dones.length}`);
  for (const s of sources.slice(0, 5)) {
    console.log(`  🔍 ${s.d.query} → ${s.d.sources.length} 条来源`);
    for (const src of s.d.sources.slice(0, 3)) console.log(`      - ${src.title} (${src.url})`);
  }
  const pass = starts.length >= 1 && sources.length >= 1 && dones.length >= 1 && writes.length >= 1;
  console.log(pass ? '\n✅ 链路通：start → 搜索资料(source×' + sources.length + ') → Write → done' : '\n❌ 链路缺口（见上方明细）');
  process.exit(pass ? 0 : 1);
}

main().catch(e => { console.error('[e2e] 异常:', e); process.exit(1); });
