const ws = new WebSocket(process.argv[2])
let id = 0; const pend = new Map()
const send = (m, p = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id) } }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result?.value ?? 'undefined' }
const btns = async () => ev(`JSON.stringify([...document.querySelectorAll('button')].map(b=>b.textContent.trim().slice(0,18)).filter(Boolean))`)
const clickText = async (text) => ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim().includes('${text}'));if(b){b.click();return 'clicked:'+b.textContent.trim().slice(0,18)}return 'NO'})()`)
await new Promise(r => { ws.onopen = r })
console.log('[初始按钮]', await btns())
console.log('[点本地模式]', await clickText('或使用本地'))
await sleep(1500)
console.log('[按钮]', await btns())
// 尝试常见推进按钮
for (const t of ['跳过', '下一步', '完成，进入 CrabPaw', '激活并进入']) {
  const r = await clickText(t)
  console.log('[尝试]', t, '→', r)
  if (r !== 'NO') { await sleep(1500); console.log('[按钮]', await btns()) }
}
ws.close(); process.exit(0)
