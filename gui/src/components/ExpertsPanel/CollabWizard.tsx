import { useEffect, useRef, useState } from 'react'
import './collab-wizard.css'
import { startCollab, getCollabStatus, fetchExperts } from './api'

interface Props { onClose: () => void }

export default function CollabWizard({ onClose }: Props) {
  const [experts, setExperts] = useState<any[]>([])
  const [goal, setGoal] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [prompts, setPrompts] = useState<Record<string, string>>({})
  const [collabId, setCollabId] = useState('')
  const [status, setStatus] = useState<any>(null)
  const [error, setError] = useState('')
  const mountedRef = useRef(true)

  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])
  useEffect(() => {
    // 2026-09-04 部门化 P3: 只列在编岗位(泊车=外部人才库, 走显式召唤不经协作编排)
    fetchExperts().then(list => setExperts((list || []).filter(e => e.status !== 'parked'))).catch(() => setExperts([]))
  }, [])

  const toggle = (id: string) => {
    setSelected(s => s.includes(id) ? s.filter(x => x !== id) : (s.length >= 4 ? s : [...s, id]))
  }

  const start = async () => {
    setError('')
    if (!goal.trim()) { setError('请填写协作目标'); return }
    if (selected.length < 2) { setError('至少选择 2 个专家'); return }
    try {
      const tasks = selected.map(id => ({ expertId: id, prompt: prompts[id] || '' }))
      const r = await startCollab(goal, tasks)
      if (!r?.collabId) { setError('启动失败：未返回协作 ID'); return }
      setCollabId(r.collabId)
    } catch (e: any) {
      setError(e?.message || '启动失败')
    }
  }

  // 轮询状态直到结束
  useEffect(() => {
    if (!collabId) return
    let timer: any
    let errStreak = 0
    const tick = async () => {
      // 2026-09-05 修复: 卸载守卫前置——旧实现 setStatus 在守卫之前, 卸载后仍 setState
      if (!mountedRef.current) return
      try {
        const s = await getCollabStatus(collabId)
        if (!mountedRef.current) return
        errStreak = 0
        setStatus(s)
        if (s?.status !== 'done' && s?.status !== 'error') timer = setTimeout(tick, 1500)
      } catch (e) {
        console.error('[CollabWizard] poll error:', e)
        // 2026-09-05 修复: 单次网络抖动不再永久停摆——连续 8 次失败才放弃
        if (!mountedRef.current) return
        errStreak += 1
        if (errStreak >= 8) { setError('状态查询连续失败，请关闭后重开查看'); return }
        timer = setTimeout(tick, 2500)
      }
    }
    tick()
    return () => clearTimeout(timer)
  }, [collabId])

  if (collabId && status) {
    return (
      <div className="collab-wizard">
        <div className="collab-head">
          <button onClick={onClose}>关闭</button>
          <h3>协作进行中：{status.goal}</h3>
        </div>
        {status.tasks?.map((t: any) => (
          <div key={t.taskId} className={`collab-task collab-${t.status}`}>
            <span>{t.expertName}</span>
            <span>{t.status === 'queued' ? '排队中' : t.status === 'running' ? '执行中' : t.status === 'done' ? '已完成' : '失败'}</span>
            {t.result ? <details><summary>产出</summary><pre>{t.result}</pre></details> : null}
            {t.error ? <div className="collab-error">错误：{t.error}</div> : null}
          </div>
        ))}
        {status.summary ? <details className="collab-summary"><summary>汇总报告</summary><pre>{status.summary}</pre></details> : null}
      </div>
    )
  }

  return (
    <div className="collab-wizard">
      <div className="collab-head">
        <button onClick={onClose}>返回</button>
        <h3>专家协作编排</h3>
      </div>
      <input value={goal} onChange={e => setGoal(e.target.value)} placeholder="协作目标，如：制定公司年度市场推广方案" />
      <div className="collab-experts">
        {experts.map(e => (
          <label key={e.id} className={`collab-expert ${selected.includes(e.id) ? 'selected' : ''}`}>
            <input type="checkbox" checked={selected.includes(e.id)} onChange={() => toggle(e.id)} />
            {e.name}（{e.title}）
          </label>
        ))}
      </div>
      {selected.map(id => {
        const ex = experts.find(e => e.id === id)
        return (
          <div key={id} className="collab-task-input">
            <label>{ex?.name} 的子任务</label>
            <textarea value={prompts[id] || ''} onChange={e => setPrompts({ ...prompts, [id]: e.target.value })} placeholder={`给 ${ex?.name} 的任务说明，留空则按目标自动展开`} />
          </div>
        )
      })}
      {error ? <div className="collab-error">{error}</div> : null}
      <button onClick={start} disabled={selected.length < 2}>启动协作（已选 {selected.length}/4）</button>
    </div>
  )
}
