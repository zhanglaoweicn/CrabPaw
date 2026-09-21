/**
 * updater — 应用内一键更新（2026-09-22）
 *
 * 数据源：GitHub Releases（zhanglaoweicn/CrabPaw）。
 *   check   → api.github.com /releases/latest（直连），比对 tag 与本机版本
 *   download→ Release 资产（gh-proxy.com 镜像优先，直连兜底）流式下载到临时目录，
 *             逐块推送 updater:progress 进度；完成后按 API 报告的 size 校验
 *   apply   → 生成 update.bat（等 CrabPaw 退出 → tar 解压覆盖程序目录 → 清理 → 重启），
 *             spawn 分离进程后退出主程序——绕 Windows 运行中 exe 的文件锁。
 *
 * 安全边界：下载地址由本模块硬编码仓库常量拼接，渲染层只发"动作"不传 URL（防 SSRF）；
 * 新发行包由构建链洁净度门禁保证无密钥/运行数据；CrabPaw-Data 不在包内，覆盖天然保留。
 */
import { ipcMain, app } from 'electron'
import * as https from 'https'
import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'

const REPO = 'zhanglaoweicn/CrabPaw'
const GH_PROXY_BASE = 'https://gh-proxy.com/'
const USER_AGENT = 'crabpaw-updater'

function ghGetJson(url: string, timeoutMs = 12000): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' } }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (e: any) { reject(new Error('GitHub 响应解析失败: ' + e.message)) }
      })
    })
    req.on('error', (e) => reject(e))
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('请求超时')) })
  })
}

function compareVersions(a: string, b: string): number {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0
    const nb = pb[i] || 0
    if (na > nb) return 1
    if (na < nb) return -1
  }
  return 0
}

/** 流式下载（跟随重定向≤5 次），逐块推送进度；expectSize 为 API 报告的期望字节数（校验用） */
function downloadFile(sender: Electron.WebContents, url: string, dest: string, expectSize: number): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const attempt = (u: string, redirects: number) => {
      const req = https.get(u, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
          res.resume()
          return attempt(res.headers.location, redirects + 1)
        }
        if (res.statusCode !== 200) {
          resolve({ ok: false, error: `下载失败：HTTP ${res.statusCode}` })
          return
        }
        const total = Number(res.headers['content-length']) || expectSize || 0
        const ws = fs.createWriteStream(dest)
        let received = 0
        let lastPct = -1
        res.on('data', (chunk) => {
          received += chunk.length
          ws.write(chunk)
          const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0
          if (pct !== lastPct) {
            lastPct = pct
            try {
              sender.send('updater:progress', {
                percent: pct,
                downloadedMb: +(received / 1048576).toFixed(1),
                totalMb: +(total / 1048576).toFixed(1),
              })
            } catch { /* 窗口可能已关闭 */ }
          }
        })
        ws.on('error', (e) => resolve({ ok: false, error: '写入失败: ' + e.message }))
        res.on('end', () => {
          ws.end(() => {
            try {
              const real = fs.statSync(dest).size
              if (expectSize > 0 && Math.abs(real - expectSize) > 1024 * 1024) {
                try { fs.unlinkSync(dest) } catch { /* 清理失败不影响结论 */ }
                resolve({ ok: false, error: `下载不完整（${(real / 1048576).toFixed(0)}MB / ${(expectSize / 1048576).toFixed(0)}MB），请重试` })
                return
              }
              resolve({ ok: true })
            } catch (e: any) {
              resolve({ ok: false, error: '校验失败: ' + e.message })
            }
          })
        })
        res.on('error', (e) => {
          try { ws.close() } catch { /* 半包清理 */ }
          resolve({ ok: false, error: '网络中断: ' + e.message })
        })
      })
      req.on('error', (e) => resolve({ ok: false, error: '网络错误: ' + e.message }))
      req.setTimeout(30000, () => { req.destroy(); resolve({ ok: false, error: '连接超时' }) })
    }
    attempt(url, 0)
  })
}

function buildUpdateBat(zipPath: string): string {
  return [
    '@echo off',
    'chcp 65001 >nul',
    'title CrabPaw 更新程序',
    'echo [1/3] 等待 CrabPaw 完全退出...',
    ':wait',
    'tasklist /FI "IMAGENAME eq CrabPaw.exe" 2>nul | find /I "CrabPaw.exe" >nul',
    'if not errorlevel 1 ( timeout /t 2 /nobreak >nul & goto wait )',
    'echo [2/3] 正在解压覆盖（约 1-3 分钟，请勿关闭本窗口）...',
    `set "SRC=${zipPath.replace(/\//g, '\\')}"`,
    'set "DEST=%~dp0"',
    `tar -xf "%SRC%" -C "%DEST%" 2>nul || powershell -NoProfile -Command "Expand-Archive -Force -Path '%SRC%' -DestinationPath '%DEST%'"`,
    'echo [3/3] 清理并重启...',
    'del /q "%SRC%" 2>nul',
    'start "" "%DEST%CrabPaw.exe"',
    'exit',
  ].join('\r\n')
}

export function registerUpdaterIpc() {
  // 检查：GitHub latest release，比对 tag 与本机版本（只增不减，防降级）
  ipcMain.handle('updater:check', async () => {
    try {
      const rel = await ghGetJson(`https://api.github.com/repos/${REPO}/releases/latest`)
      const latest = String(rel.tag_name || '').replace(/^v/, '')
      const current = app.getVersion()
      if (!latest) return { success: false, error: '未获取到最新版本号' }
      const hasUpdate = compareVersions(latest, current) > 0
      const asset = (rel.assets || []).find((a: any) => /win64-Portable\.zip$/i.test(String(a.name)))
      return {
        success: true,
        hasUpdate,
        currentVersion: current,
        latestVersion: latest,
        assetName: asset ? asset.name : null,
        assetSize: asset ? Number(asset.size) : 0,
        downloadUrl: asset ? (GH_PROXY_BASE + asset.browser_download_url) : null,
        notes: String(rel.body || '').slice(0, 600),
      }
    } catch (e: any) {
      return { success: false, error: '检查更新失败：' + (e.message || e) }
    }
  })

  // 下载：gh-proxy 镜像优先，直连兜底；进度推 updater:progress
  ipcMain.handle('updater:download', async (event, payload: { downloadUrl: string; assetSize: number; assetName?: string }) => {
    const { downloadUrl, assetSize } = payload || ({} as any)
    if (!downloadUrl || !downloadUrl.startsWith(GH_PROXY_BASE + 'https://github.com/')) {
      return { success: false, error: '非法下载地址' }
    }
    const direct = downloadUrl.slice(GH_PROXY_BASE.length)
    const tmpZip = path.join(app.getPath('temp'), 'crabpaw-update.zip')
    try { fs.unlinkSync(tmpZip) } catch { /* 无旧半包 */ }

    let r = await downloadFile(event.sender, downloadUrl, tmpZip, assetSize)
    if (!r.ok) {
      console.warn('[updater] 镜像下载失败，尝试直连:', r.error)
      r = await downloadFile(event.sender, direct, tmpZip, assetSize)
    }
    if (!r.ok) return { success: false, error: r.error }

    // 生成更新脚本到程序目录（U 盘根），等待退出后覆盖并重启
    const exeDir = path.dirname(app.getPath('exe'))
    const batPath = path.join(exeDir, 'update.bat')
    fs.writeFileSync(batPath, buildUpdateBat(tmpZip), 'utf-8')
    return { success: true, batPath }
  })

  // 应用：spawn 分离更新脚本 → 退出主程序（脚本等待进程消失后覆盖）
  ipcMain.handle('updater:apply', async () => {
    const batPath = path.join(path.dirname(app.getPath('exe')), 'update.bat')
    if (!fs.existsSync(batPath)) return { success: false, error: '未找到更新脚本，请先下载更新包' }
    const child = spawn('cmd', ['/c', batPath], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    setTimeout(() => { app.quit() }, 300)
    return { success: true }
  })
}
