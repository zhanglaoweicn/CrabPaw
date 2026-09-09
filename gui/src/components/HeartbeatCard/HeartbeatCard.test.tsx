/**
 * HeartbeatCard — 首页左卡片：老板视角"它在干活"三态大字 + 迷你心电图 + 服务状态
 *   状态推导为纯函数 deriveHomeStatus（可单测）：
 *     - 断线        → 红「离线」
 *     - 活跃(有任务)  → 琥珀「正在处理任务」
 *     - 其余        → 绿「已就绪」
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HeartbeatCard, deriveHomeStatus } from './index'

describe('deriveHomeStatus', () => {
  it('断线=离线', () => {
    expect(deriveHomeStatus({ online: false, heartBeatActive: true }).label).toBe('离线')
  })
  it('活跃=正在处理任务', () => {
    expect(deriveHomeStatus({ online: true, heartBeatActive: true }).label).toBe('正在处理任务')
  })
  it('默认=已就绪', () => {
    expect(deriveHomeStatus({ online: true, heartBeatActive: false }).label).toBe('已就绪')
  })
})

describe('HeartbeatCard', () => {
  it('渲染状态大字 + 心电图 + 服务状态行', () => {
    render(
      <HeartbeatCard
        online
        heartBeatActive={false}
        heartBeatCount={12}
        services={{ ai: { configured: true }, wecom: { configured: false } }}
        voiceEngineOk
      />
    )
    expect(screen.getByText('已就绪')).toBeTruthy()
    expect(screen.getByText('主服务')).toBeTruthy()
    expect(screen.getByText('已连接')).toBeTruthy()
    expect(screen.getByText('AI 模型')).toBeTruthy()
    expect(screen.getByText('语音引擎')).toBeTruthy()
  })
})
