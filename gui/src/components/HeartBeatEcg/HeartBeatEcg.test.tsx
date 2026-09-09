/**
 * HeartBeatEcg — 心电图画布（2026-08-31 M2 自 AgentRightPanel HeartbeatSection 抽取）
 *   T1 渲染画布 + 无数据时"连接正常·等待任务"覆盖提示
 *   T2 断线时提示"连接中断·重连中"
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HeartBeatEcg } from './index'

describe('HeartBeatEcg', () => {
  it('T1 渲染画布 + 等待任务提示', () => {
    const { container } = render(<HeartBeatEcg active={false} hasData={false} online />)
    expect(container.querySelector('canvas')).toBeTruthy()
    expect(screen.getByText('连接正常 · 等待任务')).toBeTruthy()
  })

  it('T2 断线提示', () => {
    render(<HeartBeatEcg active={false} hasData={false} online={false} />)
    expect(screen.getByText('连接中断 · 重连中')).toBeTruthy()
  })

  it('T3 有数据时不显示覆盖提示', () => {
    render(<HeartBeatEcg active={false} hasData online={false} />)
    expect(screen.queryByText(/连接/)).toBeNull()
  })
})

  it('T4 speaking 属性可渲染（语音播放同步态）', () => {
    const { container } = render(<HeartBeatEcg active hasData online speaking />)
    expect(container.querySelector('canvas')).toBeTruthy()
  })
