import React from 'react'
import { Shield } from 'lucide-react'

const LEVEL_LABELS: Record<string, string> = {
  disabled: '🔒 最少限制',
  standard: '⚖ 平衡模式',
  strict: '🛡 严格模式',
}
const APPROVAL_LABELS: Record<string, string> = {
  off: '关闭 - 无需审批',
  smart: '智能 - 自动评估风险',
  manual: '手动 - 全部需确认',
}

function getCascadedConfig(level: string) {
  switch (level) {
    case 'disabled': return { approvalMode: 'off', promptInjectionEnabled: false, filesystemEnabled: false, sessionIsolationEnabled: false }
    // 2026-08-26 审计 P1: standard 应开启提示注入检测——后端 standard 实际
    // promptInjection.enabled:true，此前级联 false 会在切等级保存后静默关闭检测
    case 'standard': return { approvalMode: 'smart', promptInjectionEnabled: true, filesystemEnabled: true, sessionIsolationEnabled: false }
    case 'strict': return { approvalMode: 'manual', promptInjectionEnabled: true, filesystemEnabled: true, sessionIsolationEnabled: true }
    default: return {}
  }
}

interface SecuritySectionProps {
  activeSection: string
  securityConfig: {
    enableWhitelist: boolean
    allowedUsers: string[]
    level: string
    approvalMode: string
    promptInjectionEnabled: boolean
    filesystemEnabled: boolean
    sessionIsolationEnabled: boolean
    remoteInstallEnabled: boolean
  }
  setSecurityConfig: React.Dispatch<React.SetStateAction<{
    enableWhitelist: boolean
    allowedUsers: string[]
    level: string
    approvalMode: string
    promptInjectionEnabled: boolean
    filesystemEnabled: boolean
    sessionIsolationEnabled: boolean
    remoteInstallEnabled: boolean
  }>>
}

export function SecuritySection({ activeSection, securityConfig, setSecurityConfig }: SecuritySectionProps) {
  return (
    <div className="theme-card p-6" style={{ display: activeSection === 'security' ? 'block' : 'none' }}>
      <h3 className="font-medium mb-4 flex items-center gap-2 theme-text-primary">
        <Shield className="w-5 h-5 theme-accent" />
        安全配置
      </h3>
      <div className="flex items-start gap-2 p-3 rounded-lg bg-[var(--color-info-bg)] mb-4">
        <span className="text-sm">ℹ️</span>
        <p className="text-xs theme-text-secondary">安全配置修改后将在下次保存时立即生效，无需重启服务。</p>
      </div>
      <div className="space-y-4">
        <div>
          <label className="block text-sm mb-1 theme-text-secondary">安全等级</label>
          <select
            value={securityConfig.level}
            onChange={(e) => {
              const newLevel = e.target.value
              const cascade = getCascadedConfig(newLevel)
              setSecurityConfig(prev => ({ ...prev, level: newLevel, ...cascade }))
            }}
            className="theme-input"
          >
            {Object.entries(LEVEL_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <p className="text-xs mt-1 theme-text-muted">
            {securityConfig.level === 'disabled' && '关闭所有安全防护'}
            {securityConfig.level === 'standard' && '启用命令审批（智能模式）+ 文件系统保护'}
            {securityConfig.level === 'strict' && '启用全部防护，命令需手动确认'}
          </p>
        </div>
        <div>
          <label className="block text-sm mb-1 theme-text-secondary">危险命令审批</label>
          <select
            value={securityConfig.approvalMode}
            onChange={(e) => setSecurityConfig(prev => ({ ...prev, approvalMode: e.target.value }))}
            className="theme-input"
          >
            {Object.entries(APPROVAL_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
        <div className="flex items-end">
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-sm theme-text-secondary">
              <input
                type="checkbox"
                checked={securityConfig.promptInjectionEnabled}
                onChange={(e) => setSecurityConfig(prev => ({ ...prev, promptInjectionEnabled: e.target.checked }))}
                className="theme-checkbox"
              />
              提示注入检测
            </label>
            <label className="flex items-center gap-2 text-sm theme-text-secondary">
              <input
                type="checkbox"
                checked={securityConfig.filesystemEnabled}
                onChange={(e) => setSecurityConfig(prev => ({ ...prev, filesystemEnabled: e.target.checked }))}
                className="theme-checkbox"
              />
              文件系统保护
            </label>
            <label className="flex items-center gap-2 text-sm theme-text-secondary">
              <input
                type="checkbox"
                checked={securityConfig.sessionIsolationEnabled}
                onChange={(e) => setSecurityConfig(prev => ({ ...prev, sessionIsolationEnabled: e.target.checked }))}
                className="theme-checkbox"
              />
              会话隔离
            </label>
            <label className="flex items-center gap-2 text-sm theme-text-secondary">
              <input
                type="checkbox"
                checked={securityConfig.remoteInstallEnabled}
                onChange={(e) => setSecurityConfig(prev => ({ ...prev, remoteInstallEnabled: e.target.checked }))}
                className="theme-checkbox"
              />
              远程技能安装
            </label>
          </div>
          {securityConfig.remoteInstallEnabled && (
            <p className="text-xs mt-1 text-[var(--color-warning-text,#d97706)]">
              ⚠️ 安装的技能等同本机用户权限（完全信任域）——仅对来源可信的技能开启。
            </p>
          )}
        </div>
        <div className="border-t theme-border pt-4 mt-2">
          <h4 className="text-sm font-medium theme-text-secondary mb-3">用户权限</h4>
          <div className="space-y-3">
            <div>
              <div className="flex items-center gap-3 mb-2">
                <input
                  type="checkbox"
                  id="enableWhitelist"
                  checked={securityConfig.enableWhitelist}
                  onChange={(e) => setSecurityConfig(prev => ({ ...prev, enableWhitelist: e.target.checked }))}
                  className="theme-checkbox"
                />
                <label htmlFor="enableWhitelist" className="text-sm theme-text-secondary">启用用户白名单</label>
              </div>
              {securityConfig.enableWhitelist && (
                <div>
                  <label className="block text-sm mb-1 theme-text-secondary">允许的用户</label>
                  <input
                    type="text"
                    value={securityConfig.allowedUsers.join(', ')}
                    onChange={(e) => setSecurityConfig(prev => ({
                      ...prev,
                      allowedUsers: e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                    }))}
                    className="theme-input"
                    placeholder="ou_xxx, ou_yyy（多个用逗号分隔）"
                  />
                  <p className="text-xs mt-1 theme-text-muted">仅白名单中的用户可使用机器人</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
