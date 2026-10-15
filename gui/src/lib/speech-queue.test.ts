import { speechQueueReducer, nextToPlay, type SpeechJob } from './speech-queue'

const job = (n: string, kind: SpeechJob['kind'] = 'expert-done'): SpeechJob => ({ id: n, text: n, kind })

describe('speechQueueReducer', () => {
  it('enqueue appends and nothing plays yet', () => {
    let s = speechQueueReducer({ jobs: [], playingId: null }, { type: 'enqueue', job: job('a') })
    s = speechQueueReducer(s, { type: 'enqueue', job: job('b') })
    expect(s.jobs.map(j => j.id)).toEqual(['a', 'b'])
    expect(s.playingId).toBeNull()
    expect(nextToPlay(s)).toBe('a')   // FIFO：队首待播
  })
  it('dequeue moves to next job', () => {
    let s = speechQueueReducer({ jobs: [], playingId: null }, { type: 'enqueue', job: job('a') })
    s = speechQueueReducer(s, { type: 'enqueue', job: job('b') })
    s = speechQueueReducer(s, { type: 'dequeue' })
    expect(s.jobs.map(j => j.id)).toEqual(['b'])
    expect(nextToPlay(s)).toBe('b')
  })
  it('dequeue on empty queue is no-op', () => {
    const s = speechQueueReducer({ jobs: [], playingId: null }, { type: 'dequeue' })
    expect(s).toEqual({ jobs: [], playingId: null })
  })
  it('reset clears everything', () => {
    let s = speechQueueReducer({ jobs: [], playingId: null }, { type: 'enqueue', job: job('a') })
    s = speechQueueReducer(s, { type: 'reset' })
    expect(s).toEqual({ jobs: [], playingId: null })
    expect(nextToPlay(s)).toBeNull()
  })
  it('nextToPlay null when empty', () => {
    expect(nextToPlay({ jobs: [], playingId: null })).toBeNull()
  })
  it('clearByPrefix removes only matching jobs and frees playingId', () => {
    let s = speechQueueReducer({ jobs: [], playingId: null }, { type: 'enqueue', job: job('done_1') })
    s = speechQueueReducer(s, { type: 'enqueue', job: job('panel_1', 'panel') })
    s = speechQueueReducer(s, { type: 'start' })
    expect(s.playingId).toBe('done_1')
    s = speechQueueReducer(s, { type: 'clearByPrefix', prefix: 'done_' })
    expect(s.jobs.map(j => j.id)).toEqual(['panel_1'])
    expect(s.playingId).toBeNull()  // 被清的是当前播放段 → 释放,panel_1 可播
  })
  it('clearByPrefix keeps non-matching playing job', () => {
    let s = speechQueueReducer({ jobs: [], playingId: null }, { type: 'enqueue', job: job('done_1') })
    s = speechQueueReducer(s, { type: 'enqueue', job: job('panel_1', 'panel') })
    s = speechQueueReducer(s, { type: 'start' })
    s = speechQueueReducer(s, { type: 'clearByPrefix', prefix: 'summary_' })
    expect(s.jobs.map(j => j.id)).toEqual(['done_1', 'panel_1'])
    expect(s.playingId).toBe('done_1')
  })
})

/**
 * 2026-09-30 P1-2 音频优先晨报 —— replay 动作（"再说一遍"）
 *
 * 语义要求：把某段插到队首重播，**不影响其余待播顺序**，也不打断正在播的段。
 * 老板在车里听漏一句时，整段晨报重来是最恼人的体验（要重新等几十秒）。
 */
describe('speechQueueReducer · replay（再说一遍）', () => {
  const brief = (i: number, audio?: { audioBase64: string }): SpeechJob =>
    ({ id: `briefing-${i}`, text: `第${i}段`, kind: 'briefing', segmentIndex: i, audio: audio ?? { audioBase64: 'AAA' } })

  it('插到队首，其余顺序不变', () => {
    let s = speechQueueReducer({ jobs: [], playingId: null }, { type: 'enqueue', job: brief(0) })
    s = speechQueueReducer(s, { type: 'enqueue', job: brief(1) })
    s = speechQueueReducer(s, { type: 'enqueue', job: brief(2) })
    s = speechQueueReducer(s, { type: 'replay', job: { ...brief(0), id: 'briefing-0#replay-1' } })
    // 无正在播的段 → 插队首，其余顺序不变
    expect(s.jobs.map(j => j.id)).toEqual(['briefing-0#replay-1', 'briefing-0', 'briefing-1', 'briefing-2'])
    expect(nextToPlay(s)).toBe('briefing-0#replay-1')
  })

  it('同 id 的待播项先被剔除，避免同一段播两遍', () => {
    let s = speechQueueReducer({ jobs: [], playingId: null }, { type: 'enqueue', job: brief(0) })
    s = speechQueueReducer(s, { type: 'enqueue', job: brief(1) })
    s = speechQueueReducer(s, { type: 'replay', job: brief(0) })
    expect(s.jobs.map(j => j.id)).toEqual(['briefing-0', 'briefing-1'])
  })

  it('replay 不改变正在播放的段，且排在它之后（这就是"下一句"）', () => {
    let s = speechQueueReducer({ jobs: [], playingId: null }, { type: 'enqueue', job: brief(0) })
    s = speechQueueReducer(s, { type: 'enqueue', job: brief(1) })
    s = speechQueueReducer(s, { type: 'start' })
    expect(s.playingId).toBe('briefing-0')
    s = speechQueueReducer(s, { type: 'replay', job: { ...brief(0), id: 'briefing-0#replay-1' } })
    expect(s.playingId).toBe('briefing-0')            // 当前段不受影响
    expect(s.jobs[0].id).toBe('briefing-0')           // 队首仍是正在播的那段
    expect(s.jobs[1].id).toBe('briefing-0#replay-1')  // 重播段紧随其后
  })

  it('没有正在播的段时，replay 插到队首（立刻会播）', () => {
    let s = speechQueueReducer({ jobs: [], playingId: null }, { type: 'enqueue', job: brief(1) })
    expect(s.playingId).toBeNull()
    s = speechQueueReducer(s, { type: 'replay', job: { ...brief(0), id: 'briefing-0#replay-1' } })
    expect(s.jobs.map(j => j.id)).toEqual(['briefing-0#replay-1', 'briefing-1'])
  })

  it('playingId 指向的段不在队列里（异常态）也能安全插到队首', () => {
    const s = speechQueueReducer(
      { jobs: [brief(1)], playingId: 'ghost' },
      { type: 'replay', job: brief(0) },
    )
    expect(s.jobs.map(j => j.id)).toEqual(['briefing-0', 'briefing-1'])
  })

  it('带预热音频的段被重播时仍带音频（不再走合成往返）', () => {
    const withAudio = brief(2, { audioBase64: 'PREWARMED' })
    let s = speechQueueReducer({ jobs: [], playingId: null }, { type: 'enqueue', job: withAudio })
    s = speechQueueReducer(s, { type: 'replay', job: { ...withAudio, id: 'briefing-2#replay-1' } })
    expect(s.jobs[0].audio?.audioBase64).toBe('PREWARMED')
    expect(s.jobs[0].segmentIndex).toBe(2)
  })
})
