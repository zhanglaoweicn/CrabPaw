import { describe, expect, it } from 'vitest'
import { taskNotice, type TaskRun } from './useTaskOrbit'

const run = (over: Partial<TaskRun> = {}): TaskRun => ({
  taskId: 'task_1',
  title: '月度报表',
  source: 'chat',
  lanes: [],
  status: 'done',
  artifacts: [],
  ts: 1_758_556_800_000,
  ...over,
})

describe('taskNotice', () => {
  it('running 不入账——账本记结果，不记进度', () => {
    expect(taskNotice(run({ status: 'running' }))).toBeNull()
  })

  it('缺 taskId 不入账（无法定位实体）', () => {
    expect(taskNotice(run({ taskId: '' }))).toBeNull()
  })

  it('失败：记账 + 出声，且带上原因', () => {
    const d = taskNotice(run({ status: 'failed', error: '连接超时' }))!
    expect(d.notice.level).toBe('failed')
    expect(d.notice.title).toBe('月度报表 没跑成功')
    expect(d.notice.detail).toBe('连接超时')
    expect(d.notice.ref).toBe('task_1')
    expect(d.notice.id).toBe('task_task_1')
    expect(d.speech).toContain('月度报表没跑成功')
    expect(d.speech).toContain('连接超时')
  })

  it('失败无原因时也能出声（不出现 undefined）', () => {
    const d = taskNotice(run({ status: 'failed', error: null }))!
    expect(d.speech).toBe('月度报表没跑成功。要我重试一次吗')
    expect(d.notice.detail).toBeUndefined()
  })

  it('完成：只记账不出声（避免与面板自身播报双声）', () => {
    const d = taskNotice(run({ status: 'done', artifacts: [{ id: 'a', name: 'x.docx' }] }))!
    expect(d.notice.level).toBe('done')
    expect(d.notice.title).toBe('月度报表 做完了')
    expect(d.notice.detail).toBe('产出 1 个文件')
    expect(d.speech).toBe(false)
  })

  it('完成无产物时不写 detail', () => {
    expect(taskNotice(run({ status: 'done' }))!.notice.detail).toBeUndefined()
  })

  it('标题缺失时用兜底名，不出现空标题行', () => {
    expect(taskNotice(run({ title: '   ' }))!.notice.title).toBe('一个任务 做完了')
  })

  it('失败原因是多行时压成一行（账本只做线索）', () => {
    const d = taskNotice(run({ status: 'failed', error: '第 1 行\n  第 2 行' }))!
    expect(d.notice.detail).toBe('第 1 行 第 2 行')
  })

  it('沿用任务时间戳（账本排序与事件时间一致）', () => {
    expect(taskNotice(run())!.notice.ts).toBe(1_758_556_800_000)
  })
})
