/** 诊断: 当前 scene 有 stock surface → 启动即打开面板, 查三区块 */
import { chromium, Page } from '@playwright/test'
import fs from 'fs'
import path from 'path'
const TOKEN = fs.readFileSync(path.resolve(__dirname, '../../data/.crabpaw/.api_token'), 'utf-8').trim()
const cfgJson = fs.readFileSync(path.resolve(__dirname, '../../data/.crabpaw/config.json'), 'utf-8')
async function main() {
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const initScript = `(() => { const token=${JSON.stringify(TOKEN)}; const config=${cfgJson}; window.electronAPI={ app:{getVersion:async()=>'2.2.0'}, api:{proxy:async(m,e,b)=>{try{const r=await fetch('http://127.0.0.1:38767'+e,{method:m,headers:{'Content-Type':'application/json','X-Api-Key':token},body:b!==undefined?JSON.stringify(b):undefined});const p=await r.json();return{success:r.status<400&&p.success!==false,status:r.status,data:p&&typeof p==='object'&&'data'in p?p.data:p,error:p.error||p.message}}catch(x){return{success:false,status:0,data:null,error:String(x)}}},credentials:async()=>({port:38767})},config:{get:async()=>config,set:async()=>({ok:true}),reloadBridges:async()=>({ok:true})}}})()`
  await ctx.addInitScript({ content: initScript })
  const page: Page = await ctx.newPage()
  page.on('console', m => { if (m.type() === 'error') console.log('[cerr]', m.text().slice(0, 130)) })
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.voice-shell-stage', { timeout: 45000 })
  await page.waitForTimeout(10000)
  await page.evaluate(async () => {
    await (window as any).electronAPI.api.proxy('GET', '/panels/stock?queries=002415&refresh=1')
  })
  await page.waitForTimeout(12000)
  const open = await page.locator('.side-sheet--stock[data-open="true"]').count()
  console.log('stock 面板打开:', open)
  const t = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.side-sheet--stock .stock-analysis-card')).map(c => (c.textContent || '').replace(/\s+/g, ' ').slice(0, 160))
    return { cards }
  })
  console.log('四卡:', JSON.stringify(t.cards, null, 1))
  const t2 = await page.evaluate(() => {
    const sheet = document.querySelector('.side-sheet--stock')
    if (!sheet) return null
    const txt = sheet.textContent || ''
    return {
      len: txt.length,
      hasAnalysis: txt.includes('技术面') && txt.includes('估值') && txt.includes('资金流'),
      hasDeep: txt.includes('深度分析'),
      hasFund: txt.includes('基本面'),
      sample: txt.slice(0, 180),
    }
  })
  console.log('主内容:', JSON.stringify(t2))
  const t3 = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('.side-sheet--stock *')).find(e => (e.textContent||'').includes('技术面'))
    return { found: !!el, html: el ? el.outerHTML.slice(0, 300) : null }
  })
  console.log('技术面节点:', JSON.stringify(t3))
  const t4 = await page.evaluate(() => ({
    analysisCls: Array.from(document.querySelectorAll('.side-sheet--stock [class*="stock-analysis"]')).map(e => e.className).slice(0, 8),
    grid: !!document.querySelector('.side-sheet--stock .stock-analysis-grid'),
  }))
  console.log('analysis类:', JSON.stringify(t4))
  console.log('内容:', JSON.stringify(t))
  await page.screenshot({ path: 'stock-diag.png' })
  await browser.close()
}
main().catch((e) => { console.error('DIAG FAILED:', String(e)); process.exit(1) })
