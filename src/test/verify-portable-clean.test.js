'use strict'
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const CLI = path.join(__dirname, '..', '..', 'scripts', 'verify-portable-clean.js')

function mkTree(root, files) {
  for (const f of files) {
    const p = path.join(root, f)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, 'x')
  }
}

describe('verify-portable-clean.js', () => {
  let tmp
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crabpaw-clean-')) })
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  test('干净目录 exit 0', () => {
    mkTree(tmp, ['CrabPaw.exe', 'resources/node_modules/sharp/lib/index.js', 'README.txt'])
    expect(() => execFileSync('node', [CLI, tmp], { stdio: 'pipe' })).not.toThrow()
  })

  test('含违禁文件 exit 1 且打印命中', () => {
    mkTree(tmp, ['CrabPaw.exe', 'src/ai/ai.test.js', 'node_modules/.bin/x'])
    let out = ''
    try {
      execFileSync('node', [CLI, tmp], { stdio: 'pipe' })
      throw new Error('应 exit 1')
    } catch (e) {
      out = String(e.stdout || '') + String(e.stderr || '')
    }
    expect(out).toContain('ai.test.js')
    expect(out).toContain('违禁')
  })
})
