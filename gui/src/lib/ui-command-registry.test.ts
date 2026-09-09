/**
 * ui-command-registry 测试(GUI 全量修复 P7, G1 收编; A1 2026-09-05 镜像退役)
 */
import {
  registerCommandHost,
  getCommandHost,
  hasCommandHost,
  executeCommand,
  listRegisteredHosts,
} from './ui-command-registry'

;(globalThis as any).window = globalThis

beforeEach(() => {
  // 清理全部注册
  for (const name of listRegisteredHosts()) {
    const unreg = registerCommandHost(name, {})
    unreg()
  }
})

test('注册/获取/注销闭环', () => {
  const unreg = registerCommandHost('weatherPanel', { setVisible: () => true, isVisible: () => true })

  expect(hasCommandHost('weatherPanel')).toBe(true)
  expect(getCommandHost('weatherPanel')).toBeTruthy()

  unreg()
  expect(hasCommandHost('weatherPanel')).toBe(false)
  expect(getCommandHost('weatherPanel')).toBeUndefined()
})

test('execute 安全降级: 未注册/方法不存在/异常均不抛', () => {
  expect(executeCommand('nope', 'run')).toBeUndefined()

  registerCommandHost('taskPanel', { open: () => 'ok' })
  expect(executeCommand('taskPanel', 'open')).toBe('ok')
  expect(executeCommand('taskPanel', 'missing')).toBeUndefined()

  registerCommandHost('bad', { boom: () => { throw new Error('x') } })
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(executeCommand('bad', 'boom')).toBeUndefined()
  expect(errSpy).toHaveBeenCalled()
  errSpy.mockRestore()
})

test('重复注册覆盖 + 注销只清自己的', () => {
  const u1 = registerCommandHost('cockpit', { open: () => 1 })
  const u2 = registerCommandHost('cockpit', { open: () => 2 })
  expect(executeCommand('cockpit', 'open')).toBe(2)
  u1() // 先注册的先注销——不应删除后注册的
  expect(hasCommandHost('cockpit')).toBe(true)
  expect(executeCommand('cockpit', 'open')).toBe(2)
  u2()
  expect(hasCommandHost('cockpit')).toBe(false)
})

test('listRegisteredHosts 反映当前注册集', () => {
  registerCommandHost('a', {})
  registerCommandHost('b', {})
  const names = listRegisteredHosts()
  expect(names).toContain('a')
  expect(names).toContain('b')
})
