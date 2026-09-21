/**
 * UpdateSection — 应用内一键更新（2026-09-22 重写）
 *
 * 旧实现是"自建服务器 version.json + 手填地址"的半成品表单；本版接
 * electronAPI.updater（GitHub Releases 检查 → gh-proxy 下载 → update.bat
 * 覆盖重启），自包含状态机，不再依赖 Settings/index 的更新状态。
 * 仅 Electron 环境可用（浏览器 dev 显示提示，不发无效请求）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw, Download, CheckCircle2, AlertTriangle, Rocket } from 'lucide-react'

type Phase = 'idle' | 'checking' | 'uptodate' | 'available' | 'downloading' | 'ready' | 'applied' | 'error'

interface CheckResult {
  success: boolean
  hasUpdate?: boolean
  currentVersion?: string
  latestVersion?: string
  assetName?: string | null
  assetSize?: number
  downloadUrl?: string | null
  notes?: string
  error?: string
}

export function UpdateSection({ activeSection }: { activeSection: string }) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [current, setCurrent] = useState('')
  const [latest, setLatest] = useState('')
  const [notes, setNotes] = useState('')
  const [pending, setPending] = useState<{ downloadUrl: string; assetSize: number; assetName?: string | null } | null>(null)
  const [progress, setProgress] = useState({ percent: 0, downloadedMb: 0, totalMb: 0 })
  const [error, setError] = useState('')
  const unProgressRef = useRef<(() => void) | undefined>(undefined)

  const isElectron = !!window.electronAPI?.updater

  const check = useCallback(async () => {
    if (!window.electronAPI?.updater) return
    setPhase('checking')
    setError('')
    try {
      const r: CheckResult = await window.electronAPI.updater.check()
      if (!r.success) {
        setError(r.error || '检查失败')
        setPhase('error')
        return
      }
      setCurrent(r.currentVersion || '')
      if (r.hasUpdate) {
        setLatest(r.latestVersion || '')
        setNotes(r.notes || '')
        setPending({ downloadUrl: r.downloadUrl || '', assetSize: r.assetSize || 0, assetName: r.assetName })
        setPhase('available')
      } else {
        setPhase('uptodate')
      }
    } catch (e: any) {
      setError(e?.message || '检查失败')
      setPhase('error')
    }
  }, [])

  // 挂载时静默检查一次（失败不打扰，状态停回可手动重试）
  useEffect(() => {
    if (!isElectron) return
    check()
    return () => { try { unProgressRef.current?.() } catch { /* 已卸载 */ } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const startDownload = useCallback(async () => {
    if (!pending || !window.electronAPI?.updater) return
    setPhase('downloading')
    setProgress({ percent: 0, downloadedMb: 0, totalMb: 0 })
    try { unProgressRef.current?.() } catch { /* 重复清理无害 */ }
    unProgressRef.current = window.electronAPI.updater.onProgress((p) => setProgress(p))
    const r = await window.electronAPI.updater.download(pending)
    try { unProgressRef.current?.() } catch { /* 已清理 */ }
    if (!r.success) {
      setError(r.error || '下载失败')
      setPhase('error')
      return
    }
    setPhase('ready')
  }, [pending])

  const applyUpdate = useCallback(async () => {
    if (!window.electronAPI?.updater) return
    const r = await window.electronAPI.updater.apply()
    if (r.success) {
      setPhase('applied')
      // 主进程 300ms 后 quit，update.bat 接管（等待退出→覆盖→重启）
    } else {
      setError(r.error || '启动更新失败')
      setPhase('error')
    }
  }, [])

  const btnStyle: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 8,
    padding: '8px 18px', borderRadius: 10, border: 'none', cursor: 'pointer',
    background: 'linear-gradient(135deg, #5c6bc0, #7e57c2)', color: '#fff',
    fontSize: 13.5, fontWeight: 600,
  }
  const ghostBtn: React.CSSProperties = {
    ...btnStyle, background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.14)',
  }

  if (activeSection !== 'update') return null

  return (
    <div className="theme-card p-6" style={{ display: 'block' }}>
      <h3 className="font-medium mb-4" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <RefreshCw size={18} />
        软件更新
      </h3>

      {!isElectron ? (
        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>应用内更新仅桌面版支持（当前为浏览器模式）。</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              当前版本：<strong style={{ color: 'var(--text-primary)' }}>v{current || '…'}</strong>
            </span>
            {(phase === 'idle' || phase === 'uptodate' || phase === 'error') && (
              <button type="button" style={ghostBtn} onClick={check}>
                <RefreshCw size={14} />
                检查更新
              </button>
            )}
          </div>

          {phase === 'checking' && (
            <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>正在检查 GitHub 最新版本…</p>
          )}

          {phase === 'uptodate' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, color: '#34d399' }}>
              <CheckCircle2 size={16} /> 已是最新版本。
            </div>
          )}

          {phase === 'available' && (
            <div style={{ border: '1px solid rgba(122,211,158,.35)', borderRadius: 12, padding: 16, background: 'rgba(52,211,153,.06)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14.5, fontWeight: 650, color: '#34d399', marginBottom: 6 }}>
                <Rocket size={16} /> 发现新版本 v{latest}
              </div>
              {notes && (
                <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 12, whiteSpace: 'pre-wrap', maxHeight: 120, overflowY: 'auto' }}>
                  {notes}
                </div>
              )}
              <button type="button" style={btnStyle} onClick={startDownload}>
                <Download size={14} /> 下载更新包（约 {(pending!.assetSize / 1048576).toFixed(0)} MB）
              </button>
            </div>
          )}

          {phase === 'downloading' && (
            <div>
              <div style={{ fontSize: 13, marginBottom: 8, color: 'var(--text-muted)' }}>
                正在下载 {progress.downloadedMb} / {progress.totalMb} MB …
              </div>
              <div style={{ height: 10, borderRadius: 6, background: 'rgba(255,255,255,.08)', overflow: 'hidden' }}>
                <div style={{
                  width: `${progress.percent}%`, height: '100%', transition: 'width .2s',
                  background: 'linear-gradient(90deg, #5c6bc0, #7e57c2)',
                }} />
              </div>
              <div style={{ fontSize: 12, marginTop: 6, textAlign: 'right', color: 'var(--text-muted)' }}>{progress.percent}%</div>
            </div>
          )}

          {phase === 'ready' && (
            <div style={{ border: '1px solid rgba(122,211,158,.35)', borderRadius: 12, padding: 16, background: 'rgba(52,211,153,.06)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 650, color: '#34d399', marginBottom: 8 }}>
                <CheckCircle2 size={16} /> 更新包下载完成
              </div>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
                点击下方按钮后，应用将退出并自动完成覆盖更新，随后自动重新启动。你的对话与数据全部保留。
              </p>
              <button type="button" style={btnStyle} onClick={applyUpdate}>
                <Rocket size={14} /> 退出并自动更新
              </button>
            </div>
          )}

          {phase === 'applied' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, color: '#34d399' }}>
              <CheckCircle2 size={16} /> 正在退出应用并执行更新…
            </div>
          )}

          {phase === 'error' && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13.5, color: '#ff8a7a' }}>
              <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
              <div>{error}（可点击「检查更新」重试）</div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
