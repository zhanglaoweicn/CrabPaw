import React, { useState } from 'react'
import { Users, Search, Pencil, Copy, FileDown, Trash2, FileUp } from 'lucide-react'

const COMMON_EMOJIS = ['🤖', '💼', '🎮', '🎨', '📚', '🔬', '🚀', '💻', '📱', '🎯', '⚡', '🛠', '🧪', '🎭', '🌙', '☀️', '🏠', '🌟', '🎵', '📷']

interface ProfileSectionProps {
  activeSection: string
  profiles: Array<{ id: string; name: string; description: string; icon: string; createdAt: number | null; isDefault: boolean }>
  activeProfile: string
  profileLoading: boolean
  searchQuery: string
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>
  newProfileName: string
  setNewProfileName: React.Dispatch<React.SetStateAction<string>>
  newProfileDesc: string
  setNewProfileDesc: React.Dispatch<React.SetStateAction<string>>
  newProfileIcon: string
  setNewProfileIcon: React.Dispatch<React.SetStateAction<string>>
  onSwitchProfile: (id: string) => void
  onDeleteProfile: (id: string) => void
  onOpenEditDialog: (profile: { id: string; name: string; description: string; icon: string }) => void
  onCloneProfile: (id: string) => void
  onExportProfile: (id: string) => void
  onImportProfileFromFile: (file: File) => Promise<void>
  onCreateProfile: () => Promise<void>
}

export function ProfileSection({
  activeSection,
  profiles,
  activeProfile,
  profileLoading,
  searchQuery,
  setSearchQuery,
  newProfileName,
  setNewProfileName,
  newProfileDesc,
  setNewProfileDesc,
  newProfileIcon,
  setNewProfileIcon,
  onSwitchProfile,
  onDeleteProfile,
  onOpenEditDialog,
  onCloneProfile,
  onExportProfile,
  onImportProfileFromFile,
  onCreateProfile,
}: ProfileSectionProps) {
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)

  return (
    <div className="theme-card p-6" style={{ display: activeSection === 'profile' ? 'block' : 'none' }}>
      <h3 className="font-medium mb-4 flex items-center gap-2 theme-text-primary">
        <Users className="w-5 h-5 theme-accent" />
        Profile 配置文件
      </h3>
      <p className="text-sm theme-text-muted mb-4">创建多套独立配置（工作/个人/开发等），实现配置隔离与快速切换</p>

      {/* 当前活跃 Profile */}
      <div className="flex items-center gap-3 mb-4 p-3 rounded-lg theme-bg-tertiary">
        <span className="text-2xl">{profiles.find(p => p.id === activeProfile)?.icon || '🦀'}</span>
        <div>
          <div className="text-sm font-medium theme-text-primary">
            当前: {activeProfile === 'default' ? '默认配置' : profiles.find(p => p.id === activeProfile)?.name || activeProfile}
          </div>
          <div className="text-xs theme-text-muted">
            {activeProfile === 'default' ? '系统默认配置' : profiles.find(p => p.id === activeProfile)?.description || ''}
          </div>
        </div>
      </div>

      {/* Profile 搜索 */}
      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 theme-text-muted" />
        <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="搜索 Profile..." className="theme-input pl-9 text-sm" />
      </div>

      {/* Profile 列表 */}
      <div className="space-y-2 mb-4">
        {/* 默认 Profile */}
        <div className={`flex items-center justify-between p-3 rounded-lg border-2 transition-all ${
          activeProfile === 'default' ? 'border-[var(--color-accent)] bg-[var(--accent-muted)]' : 'border-[var(--border-primary)] hover:border-[var(--color-accent)]/30'
        }`}>
          <div className="flex items-center gap-3">
            <span className="text-xl">🦀</span>
            <div>
              <div className="text-sm font-medium theme-text-primary">默认配置</div>
              <div className="text-xs theme-text-muted">系统默认配置文件</div>
            </div>
          </div>
          {activeProfile === 'default' && <span className="text-xs px-2 py-1 rounded bg-green-500/20 text-green-500">活跃</span>}
          {activeProfile !== 'default' && (
            <button onClick={() => onSwitchProfile('default')} disabled={profileLoading} className="text-xs px-3 py-1 rounded theme-btn theme-btn-secondary disabled:opacity-50">切换</button>
          )}
        </div>

        {/* 自定义Profile 列表 */}
        {profiles.filter(p => !p.isDefault && (!searchQuery.trim() || p.name.toLowerCase().includes(searchQuery.toLowerCase()) || (p.description || '').toLowerCase().includes(searchQuery.toLowerCase()))).sort((a, b) => ((b as any).lastUsedAt || 0) - ((a as any).lastUsedAt || 0)).map(p => (
          <div key={p.id} className={`flex items-center justify-between p-3 rounded-lg border-2 transition-all ${
            activeProfile === p.id ? 'border-[var(--color-accent)] bg-[var(--accent-muted)]' : 'border-[var(--border-primary)] hover:border-[var(--color-accent)]/30'
          }`}>
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <span className="text-xl shrink-0">{p.icon}</span>
              <div className="min-w-0">
                <div className="text-sm font-medium theme-text-primary truncate">{p.name}</div>
                <div className="text-xs theme-text-muted truncate">{p.description || '无描述'}</div>
                {(p as any).lastUsedAt && <div className="text-[10px] theme-text-muted mt-0.5">上次使用: {new Date((p as any).lastUsedAt).toLocaleDateString()}</div>}
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0 ml-2">
              {activeProfile === p.id && <span className="text-xs px-2 py-1 rounded bg-green-500/20 text-green-500">活跃</span>}
              {activeProfile !== p.id && (
                <button onClick={() => onSwitchProfile(p.id)} disabled={profileLoading} className="text-xs px-2.5 py-1 rounded theme-btn theme-btn-secondary disabled:opacity-50">切换</button>
              )}
              <button onClick={() => onOpenEditDialog(p)} className="p-1.5 rounded theme-text-muted hover:theme-accent transition-colors" title="编辑"><Pencil className="w-3.5 h-3.5" /></button>
              <button onClick={() => onCloneProfile(p.id)} disabled={profileLoading} className="p-1.5 rounded theme-text-muted hover:theme-accent transition-colors" title="克隆"><Copy className="w-3.5 h-3.5" /></button>
              <button onClick={() => onExportProfile(p.id)} className="p-1.5 rounded theme-text-muted hover:theme-accent transition-colors" title="导出"><FileDown className="w-3.5 h-3.5" /></button>
              <button onClick={() => onDeleteProfile(p.id)} className="p-1.5 rounded theme-text-muted hover:text-red-500 transition-colors" title="删除"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          </div>
        ))}
        {profiles.filter(p => !p.isDefault).length === 0 && (
          <div className="text-center py-4 text-sm theme-text-muted">暂无自定义 Profile，在上方创建一个</div>
        )}
      </div>

      {/* 新建 Profile */}
      <div className="p-4 rounded-lg theme-bg-tertiary">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-medium theme-text-secondary">新建 Profile</h4>
          <label className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs theme-btn-ghost cursor-pointer">
            <FileUp className="w-3.5 h-3.5" /> 导入
            <input type="file" accept=".json" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { await onImportProfileFromFile(f); e.target.value = '' } }} />
          </label>
        </div>
        <div className="flex gap-2 items-end">
          <div className="w-16 relative">
            <label className="block text-xs mb-1 theme-text-muted">图标</label>
            <button type="button" onClick={() => setShowEmojiPicker(!showEmojiPicker)} className="theme-input text-center text-lg cursor-pointer w-full">{newProfileIcon}</button>
            {showEmojiPicker && (
              <div className="absolute top-full left-0 mt-1 z-20 p-2 rounded-lg theme-card shadow-lg grid grid-cols-5 gap-1 w-52 border theme-border">
                {COMMON_EMOJIS.map(emoji => (
                  <button key={emoji} type="button" onClick={() => { setNewProfileIcon(emoji); setShowEmojiPicker(false) }} className={`w-9 h-9 flex items-center justify-center rounded hover:theme-bg-hover text-lg ${newProfileIcon === emoji ? 'ring-2 ring-[var(--color-accent)] theme-bg-active' : ''}`}>{emoji}</button>
                ))}
              </div>
            )}
          </div>
          <div className="flex-1">
            <label className="block text-xs mb-1 theme-text-muted">名称</label>
            <input type="text" value={newProfileName} onChange={e => setNewProfileName(e.target.value)} placeholder="如：工作模式" className="theme-input" />
          </div>
          <div className="flex-1">
            <label className="block text-xs mb-1 theme-text-muted">描述</label>
            <input type="text" value={newProfileDesc} onChange={e => setNewProfileDesc(e.target.value)} placeholder="如：专注代码开发" className="theme-input" />
          </div>
          <button onClick={onCreateProfile} disabled={!newProfileName.trim() || profileLoading} className="px-4 py-2 rounded-lg text-sm font-medium theme-btn theme-btn-primary disabled:opacity-50">创建</button>
        </div>
      </div>
    </div>
  )
}
