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
