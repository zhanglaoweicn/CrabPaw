import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  announce,
  clearNotices,
  countPending,
  getNotices,
  markNoticeHandled,
  notify,
  recordNotice,
  sortNotices,
  subscribeNotices,
  type Notice,
  __resetNoticesForTest,
} from './notices'

const STORAGE_KEY = 'crabpaw.notices.v1'

const base = {
  id: 'approval_a1b2',
  kind: 'approval' as const,
  level: 'action' as const,
  title: '需要你确认一个操作',
}

describe('notices', () => {
  beforeEach(() => {
    localStorage.clear()
    __resetNoticesForTest()
  })

  describe('recordNotice', () => {
    it('新条目置顶（账本是「最近发生的在最上面」）', () => {
      recordNotice({ ...base, id: 'n1', title: '第一件' })
      recordNotice({ ...base, id: 'n2', title: '第二件' })
      expect(getNotices().map(n => n.id)).toEqual(['n2', 'n1'])
    })

    it('同 id 覆盖而不是重复刷屏', () => {
      recordNotice({ ...base, title: '待批准' })
      recordNotice({ ...base, title: '待批准（已更新）' })
      expect(getNotices()).toHaveLength(1)
      expect(getNotices()[0].title).toBe('待批准（已更新）')
    })

    it('同 id 更新时保留 handled 标记（已批复的事不该被后续状态刷新复活）', () => {
      recordNotice(base)
      markNoticeHandled(base.id)
      recordNotice({ ...base, detail: '状态刷新' })
      expect(getNotices()[0].handled).toBe(true)
    })

    it('detail 压缩空白并截断到 120 字（命令原文可能很长）', () => {
      recordNotice({ ...base, id: 'n3', detail: `  删除   今天\n的报表  ${'x'.repeat(200)}` })
      const d = getNotices()[0].detail!
      expect(d.startsWith('删除 今天 的报表')).toBe(true)
      expect(d.endsWith('…')).toBe(true)
      expect(d.length).toBe(121)
    })

    it('超长账本按上限裁剪，保留最新', () => {
      for (let i = 0; i < 70; i++) recordNotice({ ...base, id: `n${i}`, ts: 1000 + i })
      expect(getNotices()).toHaveLength(60)
      expect(getNotices()[0].id).toBe('n69')
    })

    it('订阅者在记录时收到通知', () => {
      const cb = vi.fn()
      const unsub = subscribeNotices(cb)
      recordNotice({ ...base, id: 'n4' })
      expect(cb).toHaveBeenCalledTimes(1)
      unsub()
      recordNotice({ ...base, id: 'n5' })
      expect(cb).toHaveBeenCalledTimes(1)
    })

    it('ref 原样保留——账本行内动作据此定位审批/任务', () => {
      recordNotice({ ...base, id: 'n6', ref: 'req_abc123' })
      expect(getNotices()[0].ref).toBe('req_abc123')
    })
  })

  describe('markNoticeHandled / clearNotices', () => {
    it('标记已处理后置位，重复标记不重复通知', () => {
      recordNotice(base)
      const cb = vi.fn()
      subscribeNotices(cb)
      markNoticeHandled(base.id)
      expect(getNotices()[0].handled).toBe(true)
      expect(cb).toHaveBeenCalledTimes(1)
      markNoticeHandled(base.id)
      expect(cb).toHaveBeenCalledTimes(1)
    })

    it('标记不存在的 id 是空操作', () => {
      recordNotice(base)
      markNoticeHandled('不存在')
      expect(getNotices()[0].handled).toBeUndefined()
    })

    it('清空后账本为空，且落盘同步', () => {
      recordNotice(base)
      clearNotices()
      expect(getNotices()).toEqual([])
      expect(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')).toEqual([])
    })
  })

  describe('sortNotices / countPending', () => {
    const mk = (over: Partial<Notice>): Notice => ({
      id: 'x', ts: 1000, kind: 'system', level: 'info', title: 't', ...over,
    })

    it('待出手排最前，其次失败，最后完成/信息', () => {
      const sorted = sortNotices([
        mk({ id: 'info', level: 'info' }),
        mk({ id: 'done', level: 'done' }),
        mk({ id: 'failed', level: 'failed' }),
        mk({ id: 'action', level: 'action' }),
      ])
      expect(sorted.map(n => n.id)).toEqual(['action', 'failed', 'done', 'info'])
    })

    it('已处理的 action 让位给未处理的', () => {
      const sorted = sortNotices([
        mk({ id: 'handled', level: 'action', handled: true }),
        mk({ id: 'pending', level: 'action' }),
      ])
      expect(sorted.map(n => n.id)).toEqual(['pending', 'handled'])
    })

    it('同档按时间倒序', () => {
      const sorted = sortNotices([
        mk({ id: 'old', level: 'failed', ts: 100 }),
        mk({ id: 'new', level: 'failed', ts: 900 }),
      ])
      expect(sorted.map(n => n.id)).toEqual(['new', 'old'])
    })

    it('不就地修改入参（React 渲染安全）', () => {
      const input = [mk({ id: 'a', level: 'info' }), mk({ id: 'b', level: 'action' })]
      sortNotices(input)
      expect(input.map(n => n.id)).toEqual(['a', 'b'])
    })

    it('countPending 只数未处理的 action', () => {
      expect(countPending([
        mk({ id: 'a', level: 'action' }),
        mk({ id: 'b', level: 'action', handled: true }),
        mk({ id: 'c', level: 'failed' }),
      ])).toBe(1)
    })
  })

  describe('announce', () => {
    it('派发 crabpaw:speak 事件（VoiceShell 是唯一消费方）', () => {
      const spy = vi.fn()
      window.addEventListener('crabpaw:speak', spy)
      announce('有个操作需要你确认')
      expect(spy).toHaveBeenCalledTimes(1)
      const detail = (spy.mock.calls[0][0] as CustomEvent).detail
      expect(detail.text).toBe('有个操作需要你确认')
      expect(detail.id).toMatch(/^announce_system_/)
      window.removeEventListener('crabpaw:speak', spy)
    })

    it('空白文本不出声', () => {
      const spy = vi.fn()
      window.addEventListener('crabpaw:speak', spy)
      announce('   ')
      expect(spy).not.toHaveBeenCalled()
      window.removeEventListener('crabpaw:speak', spy)
    })

    it('可携带岗位音色', () => {
      const spy = vi.fn()
      window.addEventListener('crabpaw:speak', spy)
      announce('财务部已接通', { voice: 'zh-CN-YunxiNeural', kind: 'system' })
      expect((spy.mock.calls[0][0] as CustomEvent).detail.voice).toBe('zh-CN-YunxiNeural')
      window.removeEventListener('crabpaw:speak', spy)
    })
  })

  describe('notify', () => {
    it('既记账又出声', () => {
      const spy = vi.fn()
      window.addEventListener('crabpaw:speak', spy)
      notify({ ...base, id: 'n6' }, '有个操作需要你确认：删除报表')
      expect(getNotices().map(n => n.id)).toEqual(['n6'])
      expect((spy.mock.calls[0][0] as CustomEvent).detail.text).toBe('有个操作需要你确认：删除报表')
      window.removeEventListener('crabpaw:speak', spy)
    })

    it('speech 传 false 时只记账（高频事件不该反复念）', () => {
      const spy = vi.fn()
      window.addEventListener('crabpaw:speak', spy)
      notify({ ...base, id: 'n7', level: 'failed' }, false)
      expect(getNotices()).toHaveLength(1)
      expect(spy).not.toHaveBeenCalled()
      window.removeEventListener('crabpaw:speak', spy)
    })

    it('缺省用 title 作为播报词', () => {
      const spy = vi.fn()
      window.addEventListener('crabpaw:speak', spy)
      notify({ ...base, id: 'n8', title: '报表已经生成好了' })
      expect((spy.mock.calls[0][0] as CustomEvent).detail.text).toBe('报表已经生成好了')
      window.removeEventListener('crabpaw:speak', spy)
    })
  })

  describe('持久化', () => {
    it('记录后写入 localStorage', () => {
      recordNotice({ ...base, id: 'n9', ts: Date.now() })
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
      expect(saved).toHaveLength(1)
      expect(saved[0].id).toBe('n9')
    })

    it('加载时丢弃隔夜条目（账本只服务「今天要办什么」）', async () => {
      const now = Date.now()
      const yesterday = now - 26 * 60 * 60 * 1000
      localStorage.setItem(STORAGE_KEY, JSON.stringify([
        { ...base, id: 'old', ts: yesterday },
        { ...base, id: 'today', ts: now },
      ]))
      vi.resetModules()
      const fresh = await import('./notices')
      expect(fresh.getNotices().map(n => n.id)).toEqual(['today'])
    })

    it('损坏的 localStorage 不炸（降级为空账本）', async () => {
      localStorage.setItem(STORAGE_KEY, '{不是 JSON')
      vi.resetModules()
      const fresh = await import('./notices')
      expect(fresh.getNotices()).toEqual([])
    })
  })
})
