import { Archive, Upload, Download, RefreshCw, Trash2 } from 'lucide-react'

export interface BackupItem {
  name?: string
  createdAt?: number | string
  size?: number
}

interface Props {
  backups: BackupItem[] | null
  loading: boolean
  onCreate: () => void
  onDownload: (name: string) => void
  onRestore: (name: string) => void
  onDelete: (name: string) => void
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function SettingsBackup({ backups, loading, onCreate, onDownload, onRestore, onDelete }: Props) {
  return (
    <div className="theme-card p-6 settings-section">
      <h3 className="font-medium mb-4 flex items-center gap-2 theme-text-primary">
        <Archive className="w-5 h-5 theme-accent" />
        数据备份
      </h3>

      <div className="flex gap-4 mb-6">
        <button onClick={onCreate} disabled={loading} className="theme-btn theme-btn-primary">
          <Upload className="w-4 h-4" />
          {loading ? '处理中...' : '创建备份'}
        </button>
      </div>

      {backups && backups.length > 0 ? (
        <div className="space-y-2">
          <label className="block text-sm mb-2 theme-text-secondary">已有备份</label>
          {backups.map((backup, index) => (
            <div key={backup?.name || index} className="flex items-center justify-between p-3 rounded-lg theme-bg-tertiary">
              <div>
                <div className="text-sm theme-text-primary">{backup?.name || '未知备份'}</div>
                <div className="text-xs theme-text-muted">
                  {backup?.createdAt ? new Date(backup.createdAt).toLocaleString() : '-'}
                  {' · '}{formatSize(backup?.size || 0)}
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={() => onDownload(backup?.name || '')}
                  className="p-2 theme-text-muted hover:theme-text-primary transition-colors" title="下载">
                  <Download className="w-4 h-4" />
                </button>
                <button onClick={() => onRestore(backup?.name || '')}
                  className="p-2 theme-text-muted hover:theme-accent transition-colors" title="恢复">
                  <RefreshCw className="w-4 h-4" />
                </button>
                <button onClick={() => onDelete(backup?.name || '')}
                  className="p-2 theme-text-muted theme-color-error-hover transition-colors" title="删除">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-6 theme-text-muted">
          <Archive className="w-8 h-8 mb-2 opacity-50" />
          <span className="text-sm">暂无备份</span>
        </div>
      )}
    </div>
  )
}
