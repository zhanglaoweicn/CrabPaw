import { useState, useEffect, useCallback } from 'react'
import {
  Activity, Cpu, Clock, Zap, Server, RefreshCw, CheckCircle2, XCircle,
  Play, Square, Settings, Loader2, ArrowRight, History, RotateCcw, Camera,
} from 'lucide-react'
import { apiGet, apiPost, extractApiData } from '../../lib/api'
import { toast } from 'sonner'

interface StatusData {
  hasLark: boolean
  hasWecom: boolean
  hasAI: boolean
  larkRunning: boolean
  wecomRunning: boolean
  pid?: number
  nodeVersion?: string
  uptime?: number
  memoryUsage?: number
}

interface DiagnoseLayer {
  id: string
  name: string
  ok: boolean
  message: string
  suggestion?: string | null
}

interface DiagnoseResult {
  success: boolean
  timestamp: number
  layers: DiagnoseLayer[]
  summary: { healthy: number; total: number; status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown' }
}

interface ServiceCard {
  id: string
  name: string
  icon: typeof Server
  configured: boolean
  running: boolean
  endpoint?: string
}

interface SessionInfo {
  sessionId: string
  lastAccessed: number
  messageCount: number
}

interface ConfigVersion {
  id: string
  ts: number
  size: number
  trigger: string
  label: string
}

const LAYER_DESC: Record<string, string> = {
  'gateway': 'Gateway 进程是否启动',
  'dashboard': 'Dashboard 进程是否启动',
  'http': 'HTTP 接口是否可达',
  'chat-readiness': '能否完成一次最小对话',
  'model-match': '当前 provider 与 model 是否匹配',
  'timeout': '进程是否存在但持续超时',
}

export function Status() {
  const [status, setStatus] = useState<StatusData | null>(null)
  const [diagnose, setDiagnose] = useState<DiagnoseResult | null>(null)
  const [services, setServices] = useState<ServiceCard[]>([])
  const [recentSessions, setRecentSessions] = useState<SessionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [diagnosing, setDiagnosing] = useState(false)
  const [actionPending, setActionPending] = useState<string | null>(null)
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())
  // Gap 8: 配置版本管理
  const [configVersions, setConfigVersions] = useState<ConfigVersion[]>([])
  const [creatingVersion, setCreatingVersion] = useState(false)
  const [restoringId, setRestoringId] = useState<string | null>(null)
  const [snapshotModal, setSnapshotModal] = useState<{ open: boolean; label: string }>({ open: false, label: '' })
  const [confirmModal, setConfirmModal] = useState<{ open: boolean; title: string; message: string; onConfirm: () => void } | null>(null)

  // 轻量加载：服务状态 + 会话（不跑完整诊断）
  const loadLightweight = useCallback(async () => {
    try {
      const [statusResult, sessionsResult] = await Promise.all([
        apiGet<StatusData>('/status'),
        apiGet<{ sessions: SessionInfo[]; total: number }>('/api/sessions?limit=5'),
      ])

      if (statusResult.success) {
        const data = extractApiData<StatusData>(statusResult)
        if (data) {
          setStatus(data)
          setServices([
            // P7(GUI 全量修复): 假端点删除(ws://lark 等硬编码伪造)——不展示
            // 不存在的端点, 运行状态由后端真实字段驱动
            { id: 'lark', name: '飞书桥接', icon: Server, configured: !!data.hasLark, running: !!data.larkRunning },
            { id: 'wecom', name: '企微桥接', icon: Server, configured: !!data.hasWecom, running: !!data.wecomRunning },
            { id: 'ai', name: 'AI 模型', icon: Zap, configured: !!data.hasAI, running: !!data.hasAI },
          ])
        }
      }

      if (sessionsResult.success) {
        const data = extractApiData<{ sessions: SessionInfo[]; total: number }>(sessionsResult)
        if (data) {
          setRecentSessions(Array.isArray(data.sessions) ? data.sessions : [])
        }
      }
    } catch (e) {
      console.error('加载状态失败:', e)
      toast.error('加载状态失败: ' + ((e as any)?.message || '未知错误'))
    } finally {
      setLoading(false)
      setLastRefresh(new Date())
    }
  }, [])

  // 完整诊断：6 层
  const runDiagnose = useCallback(async () => {
    setDiagnosing(true)
    try {
      const result = await apiGet<DiagnoseResult>('/api/diagnose')
      if (result.success) {
        const data = extractApiData<DiagnoseResult>(result)
        if (data) setDiagnose(data)
      }
    } catch (e) {
      console.error('运行诊断失败:', e)
      toast.error('运行诊断失败: ' + ((e as any)?.message || '未知错误'))
    } finally {
      setDiagnosing(false)
    }
  }, [])

  const handleServiceAction = useCallback(async (serviceId: string, action: 'start' | 'stop') => {
    setActionPending(`${serviceId}-${action}`)
    try {
      await apiPost(`/api/services/${serviceId}/${action}`, {})
      // 操作完成后立即刷新状态和诊断
      await Promise.all([loadLightweight(), runDiagnose()])
    } catch (e: any) {
      // P7(GUI 全量修复): 启停失败零反馈——旧实现仅 console.error,
      // 按钮转一圈恢复无任何提示(用户以为成功了)
      console.error(`Service ${action} failed:`, e)
      toast.error(`服务${action === 'start' ? '启动' : '停止'}失败: ${e?.message || '未知错误'}`)
    } finally {
      setActionPending(null)
    }
  }, [loadLightweight, runDiagnose])

  // Gap 8: 配置版本管理
  const loadConfigVersions = useCallback(async () => {
    try {
      const result = await apiGet<{ versions: ConfigVersion[] }>('/api/config-versions')
      if (result.success) {
        const data = extractApiData<{ versions: ConfigVersion[] }>(result)
        setConfigVersions(data?.versions || [])
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('Load config versions failed:', e)
    }
  }, [])

  const handleCreateVersion = useCallback(async (label: string) => {
    setCreatingVersion(true)
    try {
      const result = await apiPost<{ success?: boolean; id?: string; message?: string }>('/api/config-versions', {
        action: 'create',
        trigger: 'manual',
        label,
      })
      // A2 fix: apiPost 统一返回 ApiResult<T>，内部数据在 .data 中
      const id = result.data?.id
      if (id) {
        toast.success(`已创建版本 ${id}`)
        await loadConfigVersions()
      } else {
        toast.error('创建失败: 未返回版本 ID')
      }
    } catch (e: any) {
      toast.error(`创建失败: ${e?.message || '未知错误'}`)
    } finally {
      setCreatingVersion(false)
    }
  }, [loadConfigVersions])

  const handleRestoreVersion = useCallback((id: string) => {
    setConfirmModal({
      open: true,
      title: '回滚配置',
      message: `确定要回滚到版本 ${id} 吗？\n当前配置会自动备份。`,
      onConfirm: async () => {
        setConfirmModal(null)
        setRestoringId(id)
        try {
          const result = await apiPost<{ success?: boolean; message?: string; backupId?: string }>(
            '/api/config-versions',
            { action: 'restore', id }
          )
          // A2 fix: apiPost 统一返回 ApiResult<T>，success 字段始终在顶层
          if (result.success) {
            toast.success(result.data?.message || '回滚成功')
            await loadConfigVersions()
            await loadLightweight()
          } else {
            toast.error(result.error || result.data?.message || '回滚失败')
          }
        } catch (e: any) {
          toast.error(`回滚失败: ${e?.message || '未知错误'}`)
        } finally {
          setRestoringId(null)
        }
      },
    })
  }, [loadConfigVersions, loadLightweight])

  // 全部 useCallback 定义完成后，再注册 useEffect
  // 避免 TDZ：loadConfigVersions 等 useCallback 必须在 useEffect 之前
  useEffect(() => { loadLightweight() }, [loadLightweight])
  useEffect(() => { loadConfigVersions() }, [loadConfigVersions])

  // 自动轻量刷新 15s（不跑完整诊断）
  useEffect(() => {
    const timer = setInterval(loadLightweight, 15000)
    return () => clearInterval(timer)
  }, [loadLightweight])

  const timeAgo = (ts: number) => {
    if (!ts) return '-'
    const diff = Date.now() - ts
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return '刚刚'
    if (mins < 60) return `${mins}分钟前`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}小时前`
    return `${Math.floor(hours / 24)}天前`
  }

  const formatUptime = (seconds?: number) => {
    if (!seconds) return '-'
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    if (h > 0) return `${h}小时${m}分钟`
    return `${m}分钟`
  }

  const summaryBadge = (status?: string) => {
    const map: Record<string, { color: string; label: string }> = {
      healthy: { color: 'bg-green-500/20 text-green-400 border-green-500/30', label: '健康' },
      degraded: { color: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30', label: '降级' },
      unhealthy: { color: 'bg-red-500/20 text-red-400 border-red-500/30', label: '异常' },
      unknown: { color: 'bg-gray-500/20 text-gray-400 border-gray-500/30', label: '未知' },
    }
    const cfg = map[status || 'unknown']
    return (
      <span className={`px-2 py-0.5 text-xs rounded border ${cfg.color}`}>{cfg.label}</span>
    )
  }

  if (loading) {
    return <div className="flex items-center justify-center h-full theme-text-muted">加载状态中...</div>
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* 标题栏 */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold theme-text-primary flex items-center gap-2">
          <Activity className="w-5 h-5 theme-accent" />
          系统状态
        </h2>
        <div className="flex items-center gap-2 text-xs theme-text-muted">
          <Clock className="w-3.5 h-3.5" />
          {lastRefresh.toLocaleTimeString('zh-CN', { hour12: false })}
          <button onClick={loadLightweight} className="p-1 rounded hover:theme-bg-tertiary" title="刷新">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 6 层真诊断 */}
      <div className="theme-card p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <h3 className="font-medium theme-text-primary">真诊断</h3>
            {diagnose && (
              <div className="flex items-center gap-2">
                {summaryBadge(diagnose.summary.status)}
                <span className="text-xs theme-text-muted">
                  {diagnose.summary.healthy}/{diagnose.summary.total} 通过
                </span>
              </div>
            )}
          </div>
          <button
            onClick={runDiagnose}
            disabled={diagnosing}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded theme-btn-secondary disabled:opacity-50"
          >
            {diagnosing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Activity className="w-3.5 h-3.5" />}
            {diagnosing ? '诊断中...' : '运行诊断'}
          </button>
        </div>

        {!diagnose ? (
          <div className="text-sm theme-text-muted py-6 text-center">
            点击「运行诊断」开始 6 层健康检查
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            {diagnose.layers.map((layer) => (
              <div
                key={layer.id}
                className={`p-3 rounded border ${
                  layer.ok
                    ? 'border-green-500/20 theme-bg-tertiary'
                    : 'border-red-500/30 theme-bg-tertiary'
                }`}
              >
                <div className="flex items-start gap-2.5">
                  {layer.ok ? (
                    <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />
                  ) : (
                    <XCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium theme-text-primary">{layer.name}</span>
                    </div>
                    <div className="text-xs theme-text-muted mt-0.5">{LAYER_DESC[layer.id]}</div>
                    <div className={`text-xs mt-1 ${layer.ok ? 'text-green-400' : 'text-red-400'}`}>
                      {layer.message}
                    </div>
                    {layer.suggestion && (
                      <div className="text-xs theme-text-muted mt-1 flex items-center gap-1">
                        <ArrowRight className="w-3 h-3" />
                        {layer.suggestion}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 服务卡并列 */}
      <div>
        <h3 className="text-sm font-medium theme-text-primary mb-3 flex items-center gap-2">
          <Server className="w-4 h-4 theme-accent" />
          服务管理
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {services.map((svc) => {
            const Icon = svc.icon
            const pending = actionPending === `${svc.id}-start` || actionPending === `${svc.id}-stop`
            return (
              <div key={svc.id} className="theme-card p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Icon className="w-4 h-4 theme-accent" />
                    <span className="font-medium theme-text-primary">{svc.name}</span>
                  </div>
                  <div className={`w-2.5 h-2.5 rounded-full ${
                    svc.running
                      ? 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.5)]'
                      : svc.configured
                      ? 'bg-yellow-400'
                      : 'bg-gray-500'
                  }`} />
                </div>

                <div className="text-xs theme-text-muted mb-3 space-y-1">
                  <div>状态: <span className={svc.running ? 'text-green-400' : 'theme-text-secondary'}>
                    {svc.running ? '运行中' : svc.configured ? '已配置未启动' : '未配置'}
                  </span></div>
                  {svc.endpoint && <div>端点: <span className="font-mono theme-text-secondary">{svc.endpoint}</span></div>}
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => handleServiceAction(svc.id, 'start')}
                    disabled={pending || svc.running}
                    className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-xs rounded theme-btn-primary disabled:opacity-40"
                  >
                    {actionPending === `${svc.id}-start` ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Play className="w-3 h-3" />
                    )}
                    启动
                  </button>
                  <button
                    onClick={() => handleServiceAction(svc.id, 'stop')}
                    disabled={pending || !svc.running}
                    className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-xs rounded theme-btn-secondary disabled:opacity-40"
                  >
                    {actionPending === `${svc.id}-stop` ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Square className="w-3 h-3" />
                    )}
                    停止
                  </button>
                  <button
                    onClick={() => window.dispatchEvent(new CustomEvent('crabpaw:navigate', { detail: { tab: 'settings', section: 'channel' } }))}
                    className="p-1.5 text-xs rounded theme-btn-secondary"
                    title="配置"
                  >
                    <Settings className="w-3 h-3" />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Gap 8: 配置版本管理 + 一键回滚 */}
      <div className="theme-card p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 theme-accent" />
            <h3 className="font-medium theme-text-primary">配置版本管理</h3>
            <span className="text-xs theme-text-muted">（最近 {configVersions.length} 个）</span>
          </div>
          <button
            onClick={() => setSnapshotModal({ open: true, label: '' })}
            disabled={creatingVersion}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded theme-btn-secondary disabled:opacity-50"
          >
            {creatingVersion ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Camera className="w-3.5 h-3.5" />}
            {creatingVersion ? '创建中...' : '创建快照'}
          </button>
        </div>

        {configVersions.length === 0 ? (
          <div className="text-sm theme-text-muted py-4 text-center">
            暂无历史版本。点击「创建快照」保存当前配置。
          </div>
        ) : (
          <div className="space-y-1.5 max-h-64 overflow-y-auto">
            {configVersions.map((v) => (
              <div
                key={v.id}
                className="flex items-center justify-between p-2.5 rounded border theme-bg-tertiary"
                style={{ borderColor: 'var(--border-secondary)' }}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-mono theme-text-primary">{v.id}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                      v.trigger === 'manual' ? 'bg-blue-500/20 text-blue-400' :
                      v.trigger === 'auto-rollback-backup' ? 'bg-yellow-500/20 text-yellow-400' :
                      'bg-gray-500/20 theme-text-muted'
                    }`}>
                      {v.trigger}
                    </span>
                  </div>
                  <div className="text-xs theme-text-muted mt-0.5">
                    {new Date(v.ts).toLocaleString('zh-CN')} · {(v.size / 1024).toFixed(1)} KB
                    {v.label && <span className="ml-2">· {v.label}</span>}
                  </div>
                </div>
                <button
                  onClick={() => handleRestoreVersion(v.id)}
                  disabled={restoringId === v.id}
                  className="flex items-center gap-1 px-2.5 py-1 text-xs rounded theme-btn-secondary disabled:opacity-50"
                  title="恢复到此版本（当前会自动备份）"
                >
                  {restoringId === v.id ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="w-3.5 h-3.5" />
                  )}
                  恢复
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 快照说明输入弹窗（替代 window.prompt，Electron 渲染层不支持） */}
      {snapshotModal.open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setSnapshotModal({ open: false, label: '' })}
        >
          <div
            className="theme-card p-5 w-[420px] max-w-[90vw]"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-medium theme-text-primary mb-3">创建配置快照</h3>
            <p className="text-xs theme-text-muted mb-3">为此快照添加说明（可选），便于以后识别。</p>
            <input
              autoFocus
              type="text"
              value={snapshotModal.label}
              onChange={(e) => setSnapshotModal({ open: true, label: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const label = snapshotModal.label.trim() || '手动备份'
                  setSnapshotModal({ open: false, label: '' })
                  handleCreateVersion(label)
                } else if (e.key === 'Escape') {
                  setSnapshotModal({ open: false, label: '' })
                }
              }}
              placeholder="如：切换供应商前备份"
              className="theme-input w-full mb-4"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setSnapshotModal({ open: false, label: '' })}
                className="px-3 py-1.5 text-xs rounded theme-btn-secondary"
              >
                取消
              </button>
              <button
                onClick={() => {
                  const label = snapshotModal.label.trim() || '手动备份'
                  setSnapshotModal({ open: false, label: '' })
                  handleCreateVersion(label)
                }}
                className="px-3 py-1.5 text-xs rounded theme-btn-primary"
              >
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 通用确认弹窗（替代 window.confirm，Electron 渲染层不支持） */}
      {confirmModal?.open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setConfirmModal(null)}
        >
          <div
            className="theme-card p-5 w-[420px] max-w-[90vw]"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-medium theme-text-primary mb-2">{confirmModal.title}</h3>
            <p className="text-sm theme-text-secondary mb-4 whitespace-pre-line">{confirmModal.message}</p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmModal(null)}
                className="px-3 py-1.5 text-xs rounded theme-btn-secondary"
              >
                取消
              </button>
              <button
                onClick={() => confirmModal.onConfirm()}
                className="px-3 py-1.5 text-xs rounded theme-btn-primary"
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 运行信息 + 会话概览 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="theme-card p-4">
          <div className="flex items-center gap-2 mb-3">
            <Cpu className="w-4 h-4 theme-accent" />
            <span className="font-medium theme-text-primary">运行信息</span>
          </div>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="theme-text-muted">PID</span>
              <span className="theme-text-primary font-mono">{status?.pid || '-'}</span>
            </div>
            <div className="flex justify-between">
              <span className="theme-text-muted">Node.js</span>
              <span className="theme-text-primary font-mono">{status?.nodeVersion || '-'}</span>
            </div>
            <div className="flex justify-between">
              <span className="theme-text-muted">运行时间</span>
              <span className="theme-text-primary">{formatUptime(status?.uptime)}</span>
            </div>
            <div className="flex justify-between">
              <span className="theme-text-muted">内存</span>
              <span className="theme-text-primary">{status?.memoryUsage ? `${status.memoryUsage} MB` : '-'}</span>
            </div>
          </div>
        </div>

        <div className="theme-card p-4">
          <div className="flex items-center gap-2 mb-3">
            <Zap className="w-4 h-4 theme-accent" />
            <span className="font-medium theme-text-primary">会话概览</span>
          </div>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="theme-text-muted">活跃会话</span>
              <span className="theme-text-primary font-mono">{recentSessions.length}</span>
            </div>
            <div className="flex justify-between">
              <span className="theme-text-muted">AI 配置</span>
              <span className={status?.hasAI ? 'text-green-400' : 'text-yellow-400'}>
                {status?.hasAI ? '已配置' : '未配置'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="theme-text-muted">飞书</span>
              <span className={status?.larkRunning ? 'text-green-400' : status?.hasLark ? 'text-yellow-400' : 'theme-text-muted'}>
                {status?.larkRunning ? '已连接' : status?.hasLark ? '未启动' : '未配置'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="theme-text-muted">企微</span>
              <span className={status?.wecomRunning ? 'text-green-400' : status?.hasWecom ? 'text-yellow-400' : 'theme-text-muted'}>
                {status?.wecomRunning ? '已连接' : status?.hasWecom ? '未启动' : '未配置'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* 最近会话 */}
      <div className="theme-card p-4">
        <div className="flex items-center gap-2 mb-3">
          <Clock className="w-4 h-4 theme-accent" />
          <span className="font-medium theme-text-primary">最近会话</span>
        </div>
        {recentSessions.length === 0 ? (
          <div className="text-sm theme-text-muted py-4 text-center">暂无会话记录</div>
        ) : (
          <div className="space-y-2">
            {recentSessions.map((s, i) => (
              <div key={s.sessionId || i} className="flex items-center justify-between p-2 rounded theme-bg-tertiary">
                <div className="flex-1 min-w-0">
                  <div className="text-sm theme-text-primary truncate">{s.sessionId}</div>
                </div>
                <div className="flex items-center gap-3 text-xs theme-text-muted shrink-0 ml-3">
                  <span>{s.messageCount || 0} 条消息</span>
                  <span>{timeAgo(s.lastAccessed)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
