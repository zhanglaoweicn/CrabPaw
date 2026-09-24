const ws = new WebSocket(process.argv[2])
let id = 0; const pend = new Map()
const send = (m, p = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id) } }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result?.value ?? 'undefined' }
const clickByText = async (text, timeout = 10) => {
  for (let i = 0; i < timeout; i++) {
    const r = await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim().includes('${text}'));if(b){b.click();return 'clicked'}return 'WAIT'})()`)
    if (r === 'clicked') return 'clicked'
    await sleep(1000)
  }
  return 'NOT-FOUND:' + text
}
await new Promise(r => { ws.onopen = r })
console.log('[0] 包装+错误捕获:', await ev(`(()=>{
  if(!window.electronAPI?.api?.proxy) return 'NO-PROXY'
  const orig=window.electronAPI.api.proxy.bind(window.electronAPI.api)
  window.__proxyLog=[]
  window.electronAPI.api.proxy=function(...args){window.__proxyLog.push(String(args[1]));return orig(...args)}
  window.__err=[]
  window.addEventListener('error',e=>window.__err.push('ERR:'+e.message))
  window.addEventListener('unhandledrejection',e=>window.__err.push('REJ:'+String(e.reason).slice(0,150)))
  return 'ready'
})()`))
console.log('[1] 手动调proxy验证包装:', await ev(`window.electronAPI.api.proxy('GET','/health',{}).then(()=>'ok').catch(e=>'err')`))
await sleep(800)
console.log('[1b] __proxyLog:', await ev(`JSON.stringify(window.__proxyLog)`))
console.log('[2] 开管理舱+搜索配置:', await ev(`window.dispatchEvent(new CustomEvent('crabpaw:open-cockpit',{detail:{tab:'settings'}})); 1`))
await sleep(3000)
await ev(`[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='搜索配置')?.click(); 1`)
await sleep(1000)
console.log('[3] 填key:', await ev(`(()=>{const i=document.querySelector('input[placeholder^="bce-v3"]');if(!i)return 'NO-INPUT';const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,'err-test-key-555');i.dispatchEvent(new Event('input',{bubbles:true}));return 'filled'})()`))
await sleep(300)
console.log('[4] 点保存:', await clickByText('保存所有'))
await sleep(4000)
console.log('[5] __proxyLog:', await ev(`JSON.stringify(window.__proxyLog)`))
console.log('[6] __err:', await ev(`JSON.stringify(window.__err||[])`))
console.log('[7] 回显:', await ev(`(()=>{const i=document.querySelector('input[placeholder^="bce-v3"]');return i?JSON.stringify(i.value):'gone'})()`))
ws.close(); process.exit(0)
