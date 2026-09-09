'use strict'
const { proxyWrap, findViolations, GH_PROXY_BASE } = require('../../scripts/portable-lib')

describe('proxyWrap', () => {
  test('给 GitHub 基址加 gh-proxy 前缀', () => {
    expect(proxyWrap('https://github.com/electron/electron/releases/download'))
      .toBe('https://gh-proxy.com/https://github.com/electron/electron/releases/download')
  })
  test('幂等: 已带前缀则原样返回', () => {
    const prefixed = GH_PROXY_BASE + 'https://github.com/x/y/releases/download'
    expect(proxyWrap(prefixed)).toBe(prefixed)
  })
})

describe('findViolations', () => {
  // 必须通过(生产文件)
  const GOOD = [
    'CrabPaw.exe', 'dist/index.html', 'dist-electron/main/index.js',
    'src/core/config.js', 'src/cli/index.js', 'src/handlers/chat-handler.js',
    'resources/node_modules/sharp/lib/index.js',
    'resources/node_modules/better-sqlite3/lib/database.js',
    'resources/node_modules/@larksuite/cli/index.js',
    'resources/node_modules/sherpa-onnx-node/build/Release/onnx_kws.node',
    'resources/node_modules/cloakbrowser/dist/config.js',
    // 第三方包仓储自带内容按原样放行(洁净度针对我们的开发残留):
    'resources/node_modules/pg-protocol/src/outbound-serializer.test.ts',
    'resources/node_modules/pptxgenjs/node_modules/@types/node/package.json',
    'resources/node_modules/some-pkg/dist/index.js.map',
    'resources/node_modules/some-pkg/fixtures/test-data.db',
    'resources/data/cloakbrowser/~chrome/shell.exe',
    'resources/kws-model/keys.txt',
    'README.txt', 'LICENSE', 'skills/deeptutor/SKILL.md'
  ]
  const BAD = [
    'src/ai/ai.test.js', 'src/core/config.spec.js', 'src/gui/App.test.tsx',
    'dist/assets/index-abc.js.map', 'dist/index.html.map',
    'resources/node_modules/jest/build/index.js',
    'resources/node_modules/.bin/foo.exe',
    'resources/node_modules/typescript/lib/tsc.js',
    'resources/node_modules/@babel/core/lib/index.js',
    '.env', 'resources/src/.env.local', '.git/HEAD',
    'data/crabpaw.log', 'data/history.db', 'data/unified-memory.db-wal',
    'data/skill-usage.db-shm', 'resources/__pycache__/x.pyc',
    'resources/node_modules/.cache/esbuild/foo'
  ]
  test('生产文件全部通过', () => expect(findViolations(GOOD)).toEqual([]))
  test('违禁文件全部拦截', () => {
    const hits = findViolations(BAD)
    expect(hits.length).toBe(BAD.length)
  })
  test('返回输入原样(不因驱动正反斜杠误伤)', () => {
    const mixed = findViolations(['src\\core\\config.js', 'src\\ai\\ai.test.js'])
    expect(mixed).toEqual(['src\\ai\\ai.test.js'])
  })
})
