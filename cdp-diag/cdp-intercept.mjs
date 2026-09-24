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
console.log('[0] 包装proxy:', await ev(`(()=>{if(!window.electronAPI?.api?.proxy) return 'NO-PROXY';const orig=window.electronAPI.api.proxy.bind(window.electronAPI.api);window.__proxyLog=[];window.electronAPI.api.proxy=function(...args){try{window.__proxyLog.push({endpoint:String(args[1]),bodySearch:JSON.stringify(args[2]?.search||null).slice(0,200)})}catch(e){}return orig(...args)};return 'wrapped'})()`))
console.log('[1] 开管理舱:', await ev(`window.dispatchEvent(new CustomEvent('crabpaw:open-cockpit',{detail:{tab:'settings'}})); 1`))
await sleep(3000)
console.log('[2] 搜索配置:', await clickByText('搜索配置'))
await sleep(1000)
console.log('[3] 填key:', await ev(`(()=>{const i=document.querySelector('input[placeholder^="bce-v3"]');if(!i)return 'NO-INPUT';const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,'intercept-key-777');i.dispatchEvent(new Event('input',{bubbles:true}));return 'filled'})()`))
await sleep(300)
console.log('[4] 保存:', await clickByText('保存所有'))
await sleep(3500)
console.log('[5] proxy调用记录:', await ev(`JSON.stringify(window.__proxyLog||[])`))
console.log('[6] 读回显:', await ev(`(()=>{const i=document.querySelector('input[placeholder^="bce-v3"]');return i?('value='+JSON.stringify(i.value)):'NO-INPUT'})()`))
ws.close(); process.exit(0)
