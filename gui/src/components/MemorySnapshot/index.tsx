import { useState } from 'react'
import { Sparkles, Zap, User, Trash2 } from 'lucide-react'

interface SnapshotUsage {
  agent?: { chars?: number; limit?: number; usage?: number; entries?: number; needsMerge?: boolean }
  user?: { chars?: number; limit?: number; usage?: number; entries?: number; needsMerge?: boolean }
}

interface Props {
  usage: SnapshotUsage | null
  agentEntries: string[]
  userEntries: string[]
  onAdd: (type: 'agent' | 'user', entry: string) => void
  onRemove: (type: 'agent' | 'user', entry: string) => void
}

// ── 用量进度条（组件外定义——组件内定义会在每次渲染时创建新组件类型，
// 触发 React 卸载/重挂载，破坏输入框焦点）──
function UsageBar({ label, data, limit: defaultLimit, accentColor }: {
  label: string; data: { chars?: number; limit?: number; usage?: number; entries?: number; needsMerge?: boolean } | undefined; limit: number; accentColor: string
}) {
  const usagePct = data?.usage ?? 0
  return (
    <div className="theme-card p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium theme-text-secondary">{label}</span>
        <span className="text-xs theme-text-muted">{data?.chars || 0} / {data?.limit || defaultLimit}</span>
      </div>
      <div className="w-full h-2 rounded-full theme-bg-tertiary overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{
          width: `${Math.min(100, usagePct * 100)}%`,
          backgroundColor: usagePct >= 0.8 ? '#ef4444' : usagePct >= 0.5 ? '#f59e0b' : accentColor,
        }} />
      </div>
      <div className="mt-2 text-xs theme-text-muted">
        {data?.entries || 0} 条 · {Math.round(usagePct * 100)}% 已用
        {data?.needsMerge && <span className="text-yellow-500 ml-1">· 建议合并</span>}
      </div>
    </div>
  )
}

export function MemorySnapshot({ usage, agentEntries, userEntries, onAdd, onRemove }: Props) {
  const [showTemplates, setShowTemplates] = useState(false)
  const [entryType, setEntryType] = useState<'agent' | 'user'>('agent')
  const [entryText, setEntryText] = useState('')
  // P13 fix: 模板点击后记录 pending 模板值，显示"直接添加"按钮
  const [pendingTemplate, setPendingTemplate] = useState<string | null>(null)

  const handleSubmit = () => {
    if (!entryText.trim()) return
    onAdd(entryType, entryText.trim())
    setEntryText('')
    setPendingTemplate(null)
  }

  const handleTemplateClick = (type: 'agent' | 'user', value: string) => {
    setEntryType(type)
    setEntryText(value)
    setPendingTemplate(value)
  }

  const handleDirectAdd = () => {
    if (!pendingTemplate) return
    onAdd(entryType, pendingTemplate)
    setEntryText('')
    setPendingTemplate(null)
  }

  const renderEntryList = (type: 'agent' | 'user', entries: string[]) => {
    const lines = entries
    if (!lines.length) {
      return <p className="text-sm theme-text-muted text-center py-4">暂无 {type === 'agent' ? 'Agent' : 'User'} 记忆</p>
    }
    return (
      <div className="space-y-1.5">
        {lines.map((line: string, i: number) => (
          <div key={i} className="flex items-start gap-2 group px-2 py-1.5 rounded hover:theme-bg-hover">
            <span className="text-sm theme-text-primary flex-1">{line}</span>
            <button
              onClick={() => onRemove(type, line)}
              className="p-1 rounded opacity-0 group-hover:opacity-100 text-red-400 hover:bg-red-500/10 transition-all"
              title="删除"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>
    )
  }

  const AGENT_TEMPLATES = [
    { label: '项目技术栈', value: '项目使用 [技术栈] 开发，主要框架为 [框架名]' },
    { label: '代码规范', value: '代码规范：使用 [语言] 编写，缩进 [2/4] 空格，命名采用 [驼峰/下划线]' },
    { label: '部署环境', value: '部署环境：[开发/测试/生产] 服务器地址 [地址]，使用 [Docker/K8s] 部署' },
    { label: 'API约定', value: 'API约定：RESTful风格，响应格式 { success, data, error }，认证使用 Bearer Token' },
    { label: '数据库信息', value: '数据库：使用 [MySQL/PostgreSQL/MongoDB]，库名 [名称]，主要表 [表名]' },
    { label: '团队角色', value: '团队角色：我负责 [职责]，同事 [名字] 负责 [职责]' },
  ]
  const USER_TEMPLATES = [
    { label: '语言偏好', value: '用户偏好使用中文交流，技术术语保留英文' },
    { label: '回复风格', value: '用户喜欢简洁直接的回复，不需要过多解释' },
    { label: '关注重点', value: '用户重点关注 [性能/安全/可维护性]，优先考虑 [方面]' },
    { label: '工作经验', value: '用户是 [初级/中级/高级] 开发者，熟悉 [领域]' },
    { label: '作息习惯', value: '用户工作时间为 [时区/时间段]，通常在 [时间] 活跃' },
    { label: '沟通渠道', value: '用户通过 [飞书/企微/邮件] 接收通知' },
    { label: '代码风格', value: '用户偏好 [函数式/OOP] 编程风格，喜欢 [详细注释/简洁代码]' },
    { label: '测试习惯', value: '用户 [重视/不重视] 单元测试，测试框架使用 [Jest/Vitest/Mocha]' },
    { label: '项目偏好', value: '用户偏好 [Monorepo/多仓库] 管理，包管理器使用 [pnpm/npm/yarn]' },
    { label: '学习偏好', value: '用户偏好通过 [代码示例/文档说明/图解] 学习新技术' },
    { label: '禁忌事项', value: '用户不希望 [自动提交代码/修改配置文件/删除文件]，需先确认' },
    { label: '输出格式', value: '用户偏好代码输出为 [完整文件/仅差异]，解释使用 [中文/英文]' },
  ]

  return (
    <div className="space-y-4">
      {usage && (
        <div className="grid grid-cols-2 gap-4">
          <UsageBar label="AGENT 记忆" data={usage.agent} limit={2200} accentColor="#22c55e" />
          <UsageBar label="USER 记忆" data={usage.user} limit={1375} accentColor="#3b82f6" />
        </div>
      )}

      {/* 添加新记忆 */}
      <div className="theme-card p-4">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-medium theme-text-secondary">添加记忆</h4>
          <button onClick={() => setShowTemplates(!showTemplates)}
            className="text-xs px-2 py-1 rounded theme-bg-tertiary hover:theme-bg-hover theme-text-secondary flex items-center gap-1"
          >
            <Sparkles className="w-3 h-3" />
            {showTemplates ? '收起模板' : '快速模板'}
          </button>
        </div>

        {showTemplates && (
          <div className="mb-3 p-3 rounded-lg theme-bg-tertiary space-y-3">
            <div>
              <p className="text-xs font-medium theme-text-secondary mb-2 flex items-center gap-1">
                <Zap className="w-3 h-3 text-blue-500" /> Agent 记忆模板
              </p>
              <div className="flex flex-wrap gap-1.5">
                {AGENT_TEMPLATES.map(tpl => (
                  <button key={tpl.label} onClick={() => handleTemplateClick('agent', tpl.value)}
                    className="text-xs px-2 py-1 rounded border theme-border-primary hover:theme-bg-hover theme-text-secondary"
                  >{tpl.label}</button>
                ))}
              </div>
            </div>
            <div>
              <p className="text-xs font-medium theme-text-secondary mb-2 flex items-center gap-1">
                <User className="w-3 h-3 text-green-500" /> User 记忆模板
              </p>
              <div className="flex flex-wrap gap-1.5">
                {USER_TEMPLATES.map(tpl => (
                  <button key={tpl.label} onClick={() => handleTemplateClick('user', tpl.value)}
                    className="text-xs px-2 py-1 rounded border theme-border-primary hover:theme-bg-hover theme-text-secondary"
                  >{tpl.label}</button>
                ))}
              </div>
            </div>
            <p className="text-xs theme-text-muted">
              提示：模板中的 [方括号] 内容请替换为实际信息。
            </p>
          </div>
        )}

        <div className="flex gap-2">
          <select value={entryType} onChange={e => setEntryType(e.target.value as 'agent' | 'user')}
            className="px-3 py-2 rounded-lg text-sm theme-bg-tertiary theme-text-primary"
          >
            <option value="agent">Agent 记忆</option>
            <option value="user">User 记忆</option>
          </select>
          <input value={entryText} onChange={e => setEntryText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !(e.nativeEvent as KeyboardEvent).isComposing) handleSubmit() }}
            placeholder="输入记忆内容，或使用上方模板..."
            className="flex-1 px-3 py-2 rounded-lg text-sm theme-bg-tertiary theme-text-primary"
          />
          <button onClick={handleSubmit} disabled={!entryText.trim()}
            className="px-4 py-2 rounded-lg text-sm font-medium theme-btn theme-btn-primary disabled:opacity-50"
          >添加</button>
        </div>
        {/* P13 fix: 模板点击后显示"直接添加"按钮，方便快速添加无需编辑 */}
        {pendingTemplate && (
          <div className="mt-2 flex items-center gap-2">
            <span className="text-xs theme-text-muted">已选择模板，可直接添加：</span>
            <button onClick={handleDirectAdd}
              className="px-3 py-1 rounded-lg text-xs font-medium bg-green-500/20 text-green-400 hover:bg-green-500/30 transition-colors"
            >直接添加模板</button>
            <button onClick={() => { setPendingTemplate(null); setEntryText('') }}
              className="px-3 py-1 rounded-lg text-xs theme-bg-tertiary theme-text-muted hover:theme-bg-hover transition-colors"
            >清除</button>
          </div>
        )}
      </div>

      {/* Agent 记忆列表 */}
      <div className="theme-card p-4">
        <h4 className="text-sm font-medium theme-text-secondary mb-3 flex items-center gap-2">
          <Zap className="w-4 h-4 text-blue-500" />
          AGENT 记忆（环境/经验/项目知识）
        </h4>
        {renderEntryList('agent', agentEntries)}
      </div>

      {/* User 记忆列表 */}
      <div className="theme-card p-4">
        <h4 className="text-sm font-medium theme-text-secondary mb-3 flex items-center gap-2">
          <User className="w-4 h-4 text-green-500" />
          USER 记忆（用户偏好/习惯/画像）
        </h4>
        {renderEntryList('user', userEntries)}
      </div>
    </div>
  )
}
