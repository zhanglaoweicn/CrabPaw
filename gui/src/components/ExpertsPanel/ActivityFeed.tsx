import { useState, useEffect } from 'react'
import { Activity, ArrowLeft } from 'lucide-react'
import type { Expert } from './types'
import { fetchExperts, getActivities, postActivity } from './api'
import { renderExpertIcon } from './icons'

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}天前`
  return new Date(ts).toLocaleDateString()
}

interface ActivityFeedProps {
  onSummon: (expertId: string) => void
  /** 2026-09-05: 返回专家团首页——此前活动流是死路(无任何返回入口) */
  onBack?: () => void
}

interface ActivityItem {
  id: string
  expertId: string
  expertName: string
  expertIcon: string
  timestamp: number
  action: 'summoned' | 'routed'
  message?: string
}

export async function addActivity(expertId: string, expertName: string, expertIcon: string, action: 'summoned' | 'routed', message?: string) {
  try {
    await postActivity({ expertId, expertName, expertIcon, action, message })
  } catch (e) {
    console.error('[addActivity] post error:', e)
  }
}

function actionLabel(action: string): string {
  if (action === 'summoned') return '被召唤'
  if (action === 'routed') return '被路由匹配'
  // 后端协作流水(action='collab:started/progress/completed' 等)——旧逻辑把
  // 非 summoned 一律显示成「被路由匹配」, 语义错误
  if (typeof action === 'string' && action.startsWith('collab:')) return '协作动态'
  return '动态'
}

export function ActivityFeed({ onSummon, onBack }: ActivityFeedProps) {
  const [activities, setActivities] = useState<ActivityItem[]>([])
  const [expertMap, setExpertMap] = useState<Record<string, Expert>>({})

  useEffect(() => {
    getActivities().then(list => setActivities(list || [])).catch(e => {
      console.error('[ActivityFeed] getActivities error:', e)
    })
    fetchExperts().then(list => {
      const map: Record<string, Expert> = {}
      list.forEach(e => { map[e.id] = e })
      setExpertMap(map)
    }).catch(e => {
      console.warn('[ActivityFeed] fetchExperts error:', e)
    })
  }, [])

  // 每 10s 刷新
  useEffect(() => {
    const timer = setInterval(() => {
      getActivities().then(list => setActivities(list || [])).catch(e => {
        console.warn('[ActivityFeed] poll error:', e)
      })
    }, 10000)
    return () => clearInterval(timer)
  }, [])

  if (activities.length === 0) {
    // P8(GUI 全量修复): 空态非 null——旧实现返回 null 右栏整块空白,
    // 用户以为面板坏了(且 10s 轮询照常空转)
    return (
      <div className="flex items-center justify-center h-full text-sm theme-text-muted">
        暂无专家活动
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1.5 px-4 py-3 border-b theme-border flex-shrink-0">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1 px-2 py-1 rounded text-[11px] theme-text-muted hover:theme-text-primary transition-colors"
            style={{ background: 'var(--bg-tertiary)' }}
            title="返回专家团"
          >
            <ArrowLeft className="w-3 h-3" />
            返回
          </button>
        )}
        <Activity className="w-3.5 h-3.5 theme-accent" />
        <span className="text-xs font-semibold theme-text-primary">活动记录</span>
        <span className="text-[10px] theme-text-muted ml-auto">{activities.length} 条</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="space-y-0.5 p-2">
          {activities.map((a) => {
            const expert = expertMap[a.expertId]
            // 2026-09-05: 专家不在编/记录无关联专家(expertId 空, 如协作流水)的行
            // 不再可点——此前点了必落「未找到该专家，召唤失败」
            const clickable = Boolean(expert)
            return (
              <div key={a.id}
                className={`flex items-start gap-2.5 px-2 py-2 rounded-lg transition-colors ${clickable ? 'hover:theme-bg-tertiary cursor-pointer' : 'opacity-55 cursor-default'}`}
                onClick={() => { if (clickable) onSummon(a.expertId) }}
                title={clickable ? `召唤 ${a.expertName}` : '该专家不在编（泊车或已下线），无法召唤'}
              >
                <div className="w-6 h-6 rounded flex items-center justify-center flex-shrink-0 mt-0.5" style={{ background: 'var(--accent-muted)' }}>
                  {renderExpertIcon(a.expertIcon || expert?.icon || 'Brain', 'w-3 h-3 theme-accent')}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] theme-text-primary">
                    <span className="font-medium">{a.expertName}</span>
                    <span className="theme-text-muted ml-1">{actionLabel(a.action)}</span>
                    {!clickable && <span className="theme-text-muted ml-1 text-[9px] opacity-70">· 不在编</span>}
                  </div>
                  {a.message && <div className="text-[10px] theme-text-muted truncate mt-0.5">"{a.message}"</div>}
                  <div className="text-[9px] theme-text-muted mt-0.5 opacity-60">{formatTimeAgo(a.timestamp)}</div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Quick stats */}
      <div className="px-4 py-2 border-t theme-border text-[10px] theme-text-muted">
        {Object.entries(
          activities.reduce<Record<string, number>>((acc, a) => {
            // 2026-09-05: 协作流水行 expertName 可为 null——此前渲染出「null N次」
            if (!a.expertName) return acc
            acc[a.expertName] = (acc[a.expertName] || 0) + 1
            return acc
          }, {})
        ).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, count]) => (
          <span key={name} className="mr-3">
            {name} <span className="theme-accent">{count}</span>次
          </span>
        ))}
      </div>
    </div>
  )
}
