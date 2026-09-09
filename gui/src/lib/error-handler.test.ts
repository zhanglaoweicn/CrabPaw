/**
 * toUserFriendlyError — 后端操作指引文案透传（2026-08-28 CK2）
 *
 * 远程技能安装默认关闭门的 403 message 含「去哪里开启」指引——此前被通用映射
 * 吞成「操作失败，请稍后重试」，用户无法得知解锁路径。
 */
import { toUserFriendlyError } from './error-handler'

describe('toUserFriendlyError — 指引文案透传（CK2）', () => {
  it('含「远程技能安装」的后端指引原样透传', () => {
    const guidance = '远程技能安装默认关闭（安装的技能等同本机用户权限）。如确认来源可信，可在 设置 → 安全 → 远程技能安装 中开启。'
    expect(toUserFriendlyError(guidance)).toBe(guidance)
  })

  it('通用错误仍走既有映射（守卫不扩大透传面）', () => {
    expect(toUserFriendlyError('404')).toBe('请求的资源不存在')
    expect(toUserFriendlyError('ECONNREFUSED: x')).toBe('无法连接到服务器，请确认服务已启动')
    expect(toUserFriendlyError('random failure')).toBe('操作失败，请稍后重试')
  })
})
