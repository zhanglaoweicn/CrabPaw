import React from 'react'
import { User } from 'lucide-react'

const TIMEZONE_OPTIONS = [
  { value: 'Asia/Shanghai', label: '中国标准时间 (UTC+8)' },
  { value: 'Asia/Tokyo', label: '日本标准时间 (UTC+9)' },
  { value: 'Asia/Singapore', label: '新加坡时间 (UTC+8)' },
  { value: 'America/New_York', label: '美国东部时间 (UTC-5)' },
  { value: 'America/Los_Angeles', label: '美国太平洋时间 (UTC-8)' },
  { value: 'Europe/London', label: '英国时间 (UTC+0)' },
  { value: 'Europe/Berlin', label: '中欧时间 (UTC+1)' },
  { value: 'Australia/Sydney', label: '澳大利亚东部时间 (UTC+11)' },
]

interface UserSectionProps {
  activeSection: string
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
  assistantConfig: {
    name: string
    emoji: string
    vibe: string
    systemPrompt: string
  }
  setAssistantConfig: React.Dispatch<React.SetStateAction<{
    name: string
    emoji: string
    vibe: string
    systemPrompt: string
  }>>
}

export function UserSection({ activeSection, userConfig, setUserConfig, assistantConfig, setAssistantConfig }: UserSectionProps) {
  return (
    <div className="theme-card p-6" style={{ display: activeSection === 'user' ? 'block' : 'none' }}>
      <h3 className="font-medium mb-4 flex items-center gap-2 theme-text-primary">
        <User className="w-5 h-5 theme-accent" />
        用户与智能体配置
      </h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="space-y-4">
          <h4 className="text-sm font-medium theme-text-secondary border-b theme-border pb-2">用户信息</h4>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm mb-1 theme-text-secondary">姓名</label>
              <input
                type="text"
                value={userConfig.name}
                onChange={(e) => setUserConfig(prev => ({ ...prev, name: e.target.value }))}
                className="theme-input"
              />
            </div>
            <div>
              <label className="block text-sm mb-1 theme-text-secondary">称呼</label>
              <input
                type="text"
                value={userConfig.callMe}
                onChange={(e) => setUserConfig(prev => ({ ...prev, callMe: e.target.value }))}
                className="theme-input"
                placeholder="怎么称呼您"
              />
            </div>
            <div>
              <label className="block text-sm mb-1 theme-text-secondary">企业微信 ID</label>
              <input
                type="text"
                value={userConfig.wecomUserId}
                onChange={(e) => setUserConfig(prev => ({ ...prev, wecomUserId: e.target.value }))}
                className="theme-input"
                placeholder="企微后台通讯录成员'账号'，文件发企微的接收人"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm mb-1 theme-text-secondary">时区</label>
            <select
              value={userConfig.timezone}
              onChange={(e) => setUserConfig(prev => ({ ...prev, timezone: e.target.value }))}
              className="theme-input"
            >
              {TIMEZONE_OPTIONS.map(tz => (
                <option key={tz.value} value={tz.value}>{tz.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm mb-1 theme-text-secondary">简介</label>
            <textarea
              value={userConfig.notes}
              onChange={(e) => setUserConfig(prev => ({ ...prev, notes: e.target.value }))}
              className="theme-input resize-none"
              rows={3}
            />
          </div>
          {(userConfig.larkUserId || userConfig.wecomUserId) && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium theme-text-secondary border-b theme-border pb-2">关联账号</h4>
              {userConfig.larkUserId && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="theme-text-muted">飞书 ID:</span>
                  <span className="theme-text-secondary font-mono">{userConfig.larkUserId}</span>
                </div>
              )}
              {userConfig.wecomUserId && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="theme-text-muted">企业微信 ID:</span>
                  <span className="theme-text-secondary font-mono">{userConfig.wecomUserId}</span>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="space-y-4">
          <h4 className="text-sm font-medium theme-text-secondary border-b theme-border pb-2">智能体配置</h4>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm mb-1 theme-text-secondary">名称</label>
              <input
                type="text"
                value={assistantConfig.name}
                onChange={(e) => setAssistantConfig(prev => ({ ...prev, name: e.target.value }))}
                className="theme-input"
              />
            </div>
            <div>
              <label className="block text-sm mb-1 theme-text-secondary">Emoji</label>
              <input
                type="text"
                value={assistantConfig.emoji}
                onChange={(e) => setAssistantConfig(prev => ({ ...prev, emoji: e.target.value }))}
                className="theme-input"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm mb-1 theme-text-secondary">系统提示词</label>
            <textarea
              value={assistantConfig.systemPrompt}
              onChange={(e) => {
                setAssistantConfig(prev => ({ ...prev, systemPrompt: e.target.value }))
                e.target.style.height = 'auto'
                e.target.style.height = e.target.scrollHeight + 'px'
              }}
              className="theme-input resize-none font-mono text-sm"
              rows={3}
              style={{ minHeight: '76px' }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
