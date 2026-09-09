import React from 'react'
import { RefreshCw, Download } from 'lucide-react'

interface UpdateSectionProps {
  activeSection: string
  updateConfig: {
    updateUrl: string
    autoCheck: boolean
    lastCheck: string
  }
  setUpdateConfig: React.Dispatch<React.SetStateAction<{
    updateUrl: string
    autoCheck: boolean
    lastCheck: string
  }>>
  updateStatus: {
    checking: boolean
    hasUpdate: boolean
    latestVersion: string
    currentVersion: string
    error: string
  }
  onCheckUpdate: () => void
  onDownloadUpdate: () => void
}

export function UpdateSection({ activeSection, updateConfig, setUpdateConfig, updateStatus, onCheckUpdate, onDownloadUpdate }: UpdateSectionProps) {
  return (
    <div className="theme-card p-6" style={{ display: activeSection === 'update' ? 'block' : 'none' }}>
      <h3 className="font-medium mb-4 flex items-center gap-2 theme-text-primary">
        <RefreshCw className="w-5 h-5 theme-accent" />
        更新设置
      </h3>

      <div className="space-y-4">
        <div>
          <label className="block text-sm mb-1 theme-text-secondary">更新服务器地址</label>
          <input
            type="text"
            value={updateConfig.updateUrl}
            onChange={(e) => setUpdateConfig(prev => ({ ...prev, updateUrl: e.target.value }))}
            className="theme-input"
            placeholder="https://your-server.com/crabpaw"
          />
          <p className="text-xs mt-1 theme-text-muted">
            填写官方提供的更新地址后，可自动检查和下载更新
          </p>
        </div>

        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            id="autoCheck"
            checked={updateConfig.autoCheck}
            onChange={(e) => setUpdateConfig(prev => ({ ...prev, autoCheck: e.target.checked }))}
            className="theme-checkbox"
          />
          <label htmlFor="autoCheck" className="theme-text-secondary">启动时自动检查更新</label>
        </div>

        <div className="flex items-center gap-4 pt-2">
          <button
            onClick={onCheckUpdate}
            disabled={updateStatus.checking || !updateConfig.updateUrl}
            className="theme-btn theme-btn-primary"
          >
            <RefreshCw className={`w-4 h-4 ${updateStatus.checking ? 'animate-spin' : ''}`} />
            {updateStatus.checking ? '检查中...' : '检查更新'}
          </button>

          {updateStatus.hasUpdate && (
            <button
              onClick={onDownloadUpdate}
              className="theme-btn theme-bg-tertiary theme-text-primary hover:theme-bg-hover"
            >
              <Download className="w-4 h-4" />
              下载更新 v{updateStatus.latestVersion}
            </button>
          )}
        </div>

        <div className="text-sm theme-text-muted">
          <p>当前版本: v{updateStatus.currentVersion}</p>
          {updateConfig.lastCheck && (
            <p>上次检查 {new Date(updateConfig.lastCheck).toLocaleString()}</p>
          )}
          {updateStatus.hasUpdate && (
            <p className="theme-color-success mt-1">
              发现新版本v{updateStatus.latestVersion}，请点击下载更新
            </p>
          )}
          {updateStatus.error && (
            <p className="theme-color-error mt-1">{updateStatus.error}</p>
          )}
        </div>
      </div>
    </div>
  )
}
