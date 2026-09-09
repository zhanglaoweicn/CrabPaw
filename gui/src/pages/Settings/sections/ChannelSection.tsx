import React from 'react'
import { MessageSquare } from 'lucide-react'

interface ChannelSectionProps {
  activeSection: string
  chatChannel: 'none' | 'lark' | 'wecom'
  setChatChannel: React.Dispatch<React.SetStateAction<'none' | 'lark' | 'wecom'>>
  larkConfig: {
    appId: string
    appSecret: string
  }
  setLarkConfig: React.Dispatch<React.SetStateAction<{
    appId: string
    appSecret: string
  }>>
  wecomConfig: {
    corpId: string
    botId: string
    secret: string
  }
  setWecomConfig: React.Dispatch<React.SetStateAction<{
    corpId: string
    botId: string
    secret: string
  }>>
  userConfig: {
    name: string
    callMe: string
    timezone: string
    notes: string
    larkUserId: string
    wecomUserId: string
    syncMode: string
  }
  setUserConfig: React.Dispatch<React.SetStateAction<{
    name: string
    callMe: string
    timezone: string
    notes: string
    larkUserId: string
    wecomUserId: string
    syncMode: 'gui_user' | 'lark_sync' | 'wecom_sync'
  }>>
}

export function ChannelSection({
  activeSection,
  chatChannel,
  setChatChannel,
  larkConfig,
  setLarkConfig,
  wecomConfig,
  setWecomConfig,
  userConfig,
  setUserConfig,
}: ChannelSectionProps) {
  return (
    <div className="theme-card p-6" style={{ display: activeSection === 'channel' ? 'block' : 'none' }}>
      <h3 className="font-medium mb-4 flex items-center gap-2 theme-text-primary">
        <MessageSquare className="w-5 h-5 theme-accent" />
        消息通道配置
      </h3>
      <div className="mb-6">
        <label className="block text-sm mb-2 theme-text-secondary">选择消息通道</label>
        <div className="grid grid-cols-3 gap-3">
          <button
            onClick={() => setChatChannel('none')}
            className={`p-3 rounded-lg border-2 text-center transition-all ${
              chatChannel === 'none'
                ? 'border-[var(--accent-primary)] bg-[var(--accent-muted)]'
                : 'border-[var(--border-primary)] hover:border-[var(--accent-primary)]/50'
            }`}
          >
            <div className="text-lg mb-1">🦀</div>
            <div className="text-sm font-medium theme-text-primary">桌面端</div>
            <div className="text-xs theme-text-muted">仅本地对话</div>
          </button>
          <button
            onClick={() => setChatChannel('lark')}
            className={`p-3 rounded-lg border-2 text-center transition-all ${
              chatChannel === 'lark'
                ? 'border-[var(--accent-primary)] bg-[var(--accent-muted)]'
                : 'border-[var(--border-primary)] hover:border-[var(--accent-primary)]/50'
            }`}
          >
            <div className="text-lg mb-1">🐦</div>
            <div className="text-sm font-medium theme-text-primary">飞书</div>
            <div className="text-xs theme-text-muted">Lark 机器人</div>
          </button>
          <button
            onClick={() => setChatChannel('wecom')}
            className={`p-3 rounded-lg border-2 text-center transition-all ${
              chatChannel === 'wecom'
                ? 'border-[var(--accent-primary)] bg-[var(--accent-muted)]'
                : 'border-[var(--border-primary)] hover:border-[var(--accent-primary)]/50'
            }`}
          >
            <div className="text-lg mb-1">💼</div>
            <div className="text-sm font-medium theme-text-primary">企业微信</div>
            <div className="text-xs theme-text-muted">WeCom 机器人</div>
          </button>
        </div>
      </div>

      {chatChannel === 'lark' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-4">
            <div>
              <label className="block text-sm mb-1 theme-text-secondary">App ID</label>
              <input
                type="text"
                value={larkConfig.appId}
                onChange={(e) => setLarkConfig(prev => ({ ...prev, appId: e.target.value }))}
                className="theme-input"
                placeholder="cli_xxx"
              />
            </div>
            <div>
              <label className="block text-sm mb-1 theme-text-secondary">App Secret</label>
              <input
                type="password"
                value={larkConfig.appSecret}
                onChange={(e) => setLarkConfig(prev => ({ ...prev, appSecret: e.target.value }))}
                className="theme-input"
                placeholder="应用密钥"
              />
            </div>
          </div>
          <div className="space-y-4">
            <div>
              <label className="block text-sm mb-1 theme-text-secondary">同步模式</label>
              <select
                value={userConfig.syncMode}
                onChange={(e) => setUserConfig(prev => ({ ...prev, syncMode: e.target.value as 'gui_user' | 'lark_sync' | 'wecom_sync' }))}
                className="theme-input"
              >
                <option value="gui_user">独立模式 - 使用独立会话历史</option>
                <option value="lark_sync">飞书同步 - 与飞书端共享会话</option>
              </select>
            </div>
            <div className="flex items-start gap-2 p-3 rounded-lg bg-[var(--bg-secondary)]">
              <span className="text-sm">💡</span>
              <p className="text-xs theme-text-muted">飞书用户 ID 将在首次通过飞书发送消息后自动获取，无需手动填写。</p>
            </div>
          </div>
        </div>
      )}

      {chatChannel === 'wecom' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-4">
            <div>
              <label className="block text-sm mb-1 theme-text-secondary">企业 ID (Corp ID)</label>
              <input
                type="text"
                value={wecomConfig.corpId}
                onChange={(e) => setWecomConfig(prev => ({ ...prev, corpId: e.target.value }))}
                className="theme-input"
                placeholder="ww..."
              />
            </div>
            <div>
              <label className="block text-sm mb-1 theme-text-secondary">Bot ID</label>
              <input
                type="text"
                value={wecomConfig.botId}
                onChange={(e) => setWecomConfig(prev => ({ ...prev, botId: e.target.value }))}
                className="theme-input"
                placeholder="企业微信机器人 ID"
              />
            </div>
          </div>
          <div className="space-y-4">
            <div>
              <label className="block text-sm mb-1 theme-text-secondary">Secret</label>
              <input
                type="password"
                value={wecomConfig.secret}
                onChange={(e) => setWecomConfig(prev => ({ ...prev, secret: e.target.value }))}
                className="theme-input"
                placeholder="应用密钥"
              />
            </div>
            <div>
              <label className="block text-sm mb-1 theme-text-secondary">同步模式</label>
              <select
                value={userConfig.syncMode}
                onChange={(e) => setUserConfig(prev => ({ ...prev, syncMode: e.target.value as 'gui_user' | 'lark_sync' | 'wecom_sync' }))}
                className="theme-input"
              >
                <option value="gui_user">独立模式 - 使用独立会话历史</option>
                <option value="wecom_sync">企业微信同步 - 与企业微信端共享会话</option>
              </select>
            </div>
            <div className="flex items-start gap-2 p-3 rounded-lg bg-[var(--bg-secondary)]">
              <span className="text-sm">💡</span>
              <p className="text-xs theme-text-muted">企业 ID 可在企业微信管理后台「我的企业」页面获取。企业微信用户 ID 将在首次通过企业微信发送消息后自动获取。</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
