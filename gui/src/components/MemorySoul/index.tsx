import { Edit3 } from 'lucide-react'
import { useConfirm } from '../useConfirm'

interface Props {
  content: string
  saving: boolean
  onChange: (val: string) => void
  onSave: () => void
}

export function MemorySoul({ content, saving, onChange, onSave }: Props) {
  const { confirmNode, askConfirm } = useConfirm()
  return (
    <div className="space-y-4">
      {confirmNode}
      <div className="theme-card p-4">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-medium theme-text-secondary flex items-center gap-2">
            <Edit3 className="w-4 h-4 text-purple-500" />
            IDENTITY.md 人格文件
          </h4>
          <div className="flex items-center gap-2">
            <span className="text-xs theme-text-muted">{content.length} 字符</span>
            <button
              onClick={onSave}
              disabled={saving}
              className="px-4 py-1.5 rounded-lg text-sm font-medium theme-btn theme-btn-primary disabled:opacity-50"
            >
              {saving ? '保存中...' : '保存'}
            </button>
          </div>
        </div>
        <p className="text-xs theme-text-muted mb-3">
          编辑 AI 的人格定义文件。此文件内容将作为系统提示的一部分注入到每次对话中，定义 AI 的身份、行为准则和个性特征。
        </p>
        <textarea
          value={content}
          onChange={e => onChange(e.target.value)}
          className="w-full theme-input resize-none font-mono text-sm"
          rows={20}
          style={{ minHeight: '400px' }}
          placeholder="# Identity&#10;&#10;你是一个专业、高效的 AI 助手。&#10;&#10;## 行为准则&#10;- 始终以专业态度回答问题&#10;- 优先使用中文回复"
        />
      </div>

      <div className="theme-card p-4">
        <h4 className="text-sm font-medium theme-text-secondary mb-2">人格模板</h4>
        <p className="text-xs theme-text-muted mb-3">选择一个预设模板快速开始</p>
        <div className="grid grid-cols-3 gap-2">
          {[
            { name: '专业助手', icon: '💼', desc: '严谨专业，注重准确性', content: '# Identity\n\n你是一位严谨专业的 AI 助手。\n\n## 行为准则\n- 始终以专业态度回答问题\n- 注重事实准确性，不确定时明确说明\n- 优先使用中文回复\n- 代码示例附带注释说明\n' },
            { name: '创意伙伴', icon: '🎨', desc: '富有创意，善于头脑风暴', content: '# Identity\n\n你是一位富有创意的 AI 伙伴。\n\n## 行为准则\n- 鼓励创新思维和大胆想法\n- 善于从多角度分析问题\n- 使用生动有趣的语言\n- 主动提供创意建议和灵感\n' },
            { name: '代码专家', icon: '💻', desc: '专注编程，技术导向', content: '# Identity\n\n你是一位资深的全栈开发专家。\n\n## 行为准则\n- 优先提供可运行的代码示例\n- 遵循最佳实践和设计模式\n- 注重代码质量和可维护性\n- 解释技术决策的原因\n- 主动指出潜在的性能和安全问题\n' },
          ].map(tpl => (
            <button
              key={tpl.name}
              onClick={() => {
                if (content.trim() && content !== tpl.content) {
                  askConfirm({ title: '覆盖确认', message: '当前已有人格内容，覆盖将丢失已有修改。确定继续？', confirmLabel: '覆盖', danger: true }).then(ok => {
                    if (ok) onChange(tpl.content)
                  })
                  return
                }
                onChange(tpl.content)
              }}
              className="p-3 rounded-lg border text-left transition-all hover:border-[var(--accent-primary)]/50 theme-bg-tertiary"
              aria-label={`使用「${tpl.name}」模板覆盖当前内容`}
            >
              <div className="text-lg mb-1">{tpl.icon}</div>
              <div className="text-sm font-medium theme-text-primary">{tpl.name}</div>
              <div className="text-xs theme-text-muted">{tpl.desc}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
