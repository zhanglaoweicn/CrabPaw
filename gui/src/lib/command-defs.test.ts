/**
 * command-defs 测试(B2 2026-09-05)——三通道命令清单完整性 + toggle 语义
 */
import { COMMAND_DEFS } from './command-defs'
import { registerCommandHost, getCommandHost, listRegisteredHosts } from './ui-command-registry'
import { RULES } from './voice-panel-commands'

beforeEach(() => {
  for (const name of listRegisteredHosts()) {
    const unreg = registerCommandHost(name, {})
    unreg()
  }
})

test('def 完整性: id 唯一、shortcut 唯一、run 可调用', () => {
  const ids = COMMAND_DEFS.map(d => d.id)
  expect(new Set(ids).size).toBe(ids.length)
  const shortcuts = COMMAND_DEFS.filter(d => d.shortcut).map(d => d.shortcut)
  expect(new Set(shortcuts).size).toBe(shortcuts.length)
  for (const d of COMMAND_DEFS) {
    expect(typeof d.run).toBe('function')
    expect(d.label.length).toBeGreaterThan(0)
  }
})

test('快捷键五连 h/t/s/w/m 全部注册且带 toggle', () => {
  for (const key of ['h', 't', 's', 'w', 'm']) {
    const def = COMMAND_DEFS.find(d => d.shortcut === key)
    expect(def, `shortcut ${key}`).toBeTruthy()
    expect(typeof def!.toggle).toBe('function')
  }
})

test('toggleVisible: 按 isVisible 翻转 setVisible(经 registry)', () => {
  let visible = false
  let lastSet: boolean | undefined
  const unreg = registerCommandHost('weatherPanel', {
    setVisible: (v: boolean) => { lastSet = v; visible = v },
    isVisible: () => visible,
  })
  const def = COMMAND_DEFS.find(d => d.id === 'weather-toggle')!
  def.toggle!()
  expect(lastSet).toBe(true)
  visible = true
  def.toggle!()
  expect(lastSet).toBe(false)
  unreg()
  expect(getCommandHost('weatherPanel')).toBeUndefined()
})

test('voiceAliases 引用 voice-panel-commands RULES(单源不复制)', () => {
  const hotspot = COMMAND_DEFS.find(d => d.id === 'hotspot-toggle')!
  expect(hotspot.voiceAliases!.length).toBeGreaterThan(0)
  // 引用同一批正则对象——RULES 变更自动反映到 defs
  const rulePatterns = RULES.filter(r => r.kind === 'hotspot' && r.action === 'open').flatMap(r => r.patterns)
  expect(hotspot.voiceAliases).toEqual(rulePatterns)
})
