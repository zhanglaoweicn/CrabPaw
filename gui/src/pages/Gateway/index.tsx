import { useState, useEffect, useCallback } from "react"
import {
  Radio,
  RefreshCw,
  Wifi,
  WifiOff,
  Settings,
  ExternalLink,
  Clock,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Play,
  StopCircle,
} from "lucide-react"
import { apiGet, apiPost, extractApiData } from "../../lib/api"
import { toast } from "sonner"

interface GatewayChannel {
  id: string
  name: string
  icon: string
  enabled: boolean
  connected: boolean
  configured: boolean
  type: "im"
  description: string
}

const CHANNELS: GatewayChannel[] = [
  { id: "lark", name: "飞书", icon: "🐦", enabled: false, connected: false, configured: false, type: "im", description: "通过飞书 App 与 AI 对话" },
  { id: "wecom", name: "企业微信", icon: "💼", enabled: false, connected: false, configured: false, type: "im", description: "通过企业微信与 AI 对话" },
]

export function Gateway() {
  const [channels, setChannels] = useState<GatewayChannel[]>(CHANNELS)
  const [loading, setLoading] = useState(false)
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null)

  const [actionLoading, setActionLoading] = useState(false)

  const handleGatewayStart = async () => {
    setActionLoading(true)
    try {
      const result = await apiPost("/api/gateway/start", {})
      if (result.success) {
        await loadGatewayStatus()
        console.log("Gateway start:", result.data)
      }
    } catch (e) {
      console.error("Gateway start failed:", e)
      toast.error("网关启动失败: " + ((e as any)?.message || String(e)))
    } finally {
      setActionLoading(false)
    }
  }

  const handleGatewayStop = async () => {
    setActionLoading(true)
    try {
      const result = await apiPost("/api/gateway/stop", {})
      if (result.success) {
        await loadGatewayStatus()
        console.log("Gateway stop:", result.data)
      }
    } catch (e) {
      console.error("Gateway stop failed:", e)
      toast.error("网关停止失败: " + ((e as any)?.message || String(e)))
    } finally {
      setActionLoading(false)
    }
  }

  const loadGatewayStatus = useCallback(async () => {
    setLoading(true)
    try {
      const statusResult = await apiGet("/status")
      const statusData = extractApiData<Record<string, any>>(statusResult) || {}

      const larkConfigured = !!statusData?.hasLark
      const wecomConfigured = !!statusData?.hasWecom
      const larkBridge = !!statusData?.larkRunning
      const wecomBridge = !!statusData?.wecomRunning

      setChannels(prev => prev.map(ch => {
        if (ch.id === "lark") return { ...ch, enabled: larkConfigured || larkBridge, connected: larkBridge, configured: larkConfigured }
        if (ch.id === "wecom") return { ...ch, enabled: wecomConfigured || wecomBridge, connected: wecomBridge, configured: wecomConfigured }
        return ch
      }))
    } catch (e) {
      console.error("Load gateway status failed:", e)
    }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { loadGatewayStatus(); const timer = setInterval(loadGatewayStatus, 5000); return () => clearInterval(timer) }, [loadGatewayStatus])

  const connectedCount = channels.filter(c => c.connected).length

  return (
    <div className="p-6 space-y-6">
      {/* 配置入口提示 */}
      <div className="theme-card p-3 flex items-start gap-3 border-l-4" style={{ borderLeftColor: "var(--accent-primary)" }}>
        <AlertCircle className="w-4 h-4 mt-0.5 theme-accent flex-shrink-0" />
        <div className="text-xs theme-text-secondary flex-1">
          <strong className="theme-text-primary">通道配置在「设置」页。</strong>
          本页仅展示启停 / 连接状态，凭证修改请前往
          <button onClick={() => { window.dispatchEvent(new CustomEvent("crabpaw:navigate", { detail: { tab: "settings", section: "channel" } })) }} className="ml-1 underline theme-accent hover:opacity-80">设置 → 飞书 / 企业微信</button>。
        </div>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold theme-text-primary flex items-center gap-2">
            <Radio className="w-6 h-6 theme-accent" />
            消息网关
          </h2>
          <p className="text-sm theme-text-muted mt-1">管理飞书和企业微信桥接，实现跨平台统一对话</p>
        </div>
        <button
          onClick={loadGatewayStatus}
          disabled={loading}
          className="px-3 py-2 rounded-lg text-sm theme-btn theme-btn-secondary disabled:opacity-50 flex items-center gap-2"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          刷新
        </button>
        <div className="flex items-center gap-2">
          <button
            onClick={handleGatewayStart}
            disabled={actionLoading}
            className="px-3 py-2 rounded-lg text-sm theme-btn theme-btn-primary disabled:opacity-50 flex items-center gap-2"
            style={{ background: 'var(--color-success, #22c55e)', color: '#fff' }}
          >
            <Play className="w-4 h-4" />
            启动
          </button>
          <button
            onClick={handleGatewayStop}
            disabled={actionLoading}
            className="px-3 py-2 rounded-lg text-sm theme-btn-ghost disabled:opacity-50 flex items-center gap-2"
            style={{ border: '1px solid var(--color-border)', color: 'var(--color-error, #ef4444)' }}
          >
            <StopCircle className="w-4 h-4" />
            停止
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4">
        <div className="theme-card p-4">
          <div className="flex items-center gap-2 mb-1">
            <Wifi className="w-4 h-4 text-green-500" />
            <span className="text-sm theme-text-secondary">已连接</span>
          </div>
          <div className="text-2xl font-bold theme-text-primary">{connectedCount}</div>
        </div>
        <div className="theme-card p-4">
          <div className="flex items-center gap-2 mb-1">
            <WifiOff className="w-4 h-4 text-gray-400" />
            <span className="text-sm theme-text-secondary">未连接</span>
          </div>
          <div className="text-2xl font-bold theme-text-primary">{channels.length - connectedCount}</div>
        </div>
      </div>

      {/* Channel Cards */}
      <div className="grid grid-cols-2 gap-4">
        {channels.map(channel => (
          <div
            key={channel.id}
            onClick={() => setSelectedChannel(selectedChannel === channel.id ? null : channel.id)}
            className={`theme-card p-4 cursor-pointer transition-all hover:shadow-md ${
              selectedChannel === channel.id ? "ring-2 ring-[var(--accent-primary)]" : ""
            }`}
          >
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-3">
                <span className="text-2xl">{channel.icon}</span>
                <div>
                  <div className="text-sm font-medium theme-text-primary">{channel.name}</div>
                  <div className="text-xs theme-text-muted">{channel.description}</div>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                {channel.connected ? (
                  <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-green-500/20 text-green-500">
                    <CheckCircle2 className="w-3 h-3" /> 已连接
                  </span>
                ) : channel.configured ? (
                  <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400">
                    <Settings className="w-3 h-3" /> 已配置
                  </span>
                ) : channel.enabled ? (
                  <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-500">
                    <AlertCircle className="w-3 h-3" /> 未连接
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-gray-500/20 text-gray-400">
                    <XCircle className="w-3 h-3" /> 未启用
                  </span>
                )}
              </div>
            </div>

            <div className="flex items-center gap-4 text-xs theme-text-muted">
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {channel.connected ? "运行中" : "待连接"}
              </span>
            </div>

            {/* Expanded detail */}
            {selectedChannel === channel.id && (
              <div className="mt-3 pt-3 border-t" style={{ borderColor: "var(--border-primary)" }}>
                {channel.id === "lark" && (
                  <div className="space-y-2 text-xs theme-text-secondary">
                    {channel.configured ? (
                      <>
                        <p>✅ 飞书已配置（App ID + App Secret）。{channel.connected ? "桥接进程运行中。" : "可在「设置 → 飞书」修改配置。"}</p>
                        <div className="flex gap-2">
                          <button
                            onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent("crabpaw:navigate", { detail: { tab: "settings", section: "channel" } })) }}
                            className="px-3 py-1.5 rounded text-xs theme-btn theme-btn-secondary flex items-center gap-1"
                          >
                            <Settings className="w-3 h-3" /> 编辑配置
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <p>飞书桥接需要 App ID 和 App Secret，在「设置 → 飞书」完成配置后即可启用。</p>
                        <button
                          onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent("crabpaw:navigate", { detail: { tab: "settings", section: "channel" } })) }}
                          className="px-3 py-1.5 rounded text-xs theme-btn theme-btn-primary flex items-center gap-1"
                        >
                          <ExternalLink className="w-3 h-3" /> 前往设置
                        </button>
                      </>
                    )}
                  </div>
                )}
                {channel.id === "wecom" && (
                  <div className="space-y-2 text-xs theme-text-secondary">
                    {channel.configured ? (
                      <>
                        <p>✅ 企业微信已配置（Corp ID + Bot ID + Secret）。{channel.connected ? "桥接进程运行中。" : "可在「设置 → 企业微信」修改配置。"}</p>
                        <div className="flex gap-2">
                          <button
                            onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent("crabpaw:navigate", { detail: { tab: "settings", section: "channel" } })) }}
                            className="px-3 py-1.5 rounded text-xs theme-btn theme-btn-secondary flex items-center gap-1"
                          >
                            <Settings className="w-3 h-3" /> 编辑配置
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <p>企业微信桥接需要 Corp ID、Bot ID 和 Secret，在「设置 → 企业微信」完成配置后即可启用。</p>
                        <button
                          onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent("crabpaw:navigate", { detail: { tab: "settings", section: "channel" } })) }}
                          className="px-3 py-1.5 rounded text-xs theme-btn theme-btn-primary flex items-center gap-1"
                        >
                          <ExternalLink className="w-3 h-3" /> 前往设置
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 空状态指引 */}
      {connectedCount === 0 && (
        <div className="theme-card p-6 text-center">
          <Radio className="w-10 h-10 theme-text-muted mx-auto mb-3" />
          <p className="text-sm theme-text-secondary mb-1">尚未连接任何消息平台</p>
          <p className="text-xs theme-text-muted">
            前往
            <button onClick={() => { window.dispatchEvent(new CustomEvent("crabpaw:navigate", { detail: { tab: "settings", section: "channel" } })) }} className="mx-1 underline theme-accent hover:opacity-80">设置页</button>
            配置飞书或企业微信凭证，完成后回到此处即可看到连接状态。
          </p>
        </div>
      )}
    </div>
  )
}
