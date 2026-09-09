/**
 * corsMiddleware 单元测试（2026-08-14 新增）
 * 背景: server.js 主服务此前未挂载 CORS,跨源 fetch 无 ACAO 头被浏览器拦截。
 * 修复后主服务在 authGuard 前挂载本中间件——此处覆盖其全部行为分支。
 */
const { corsMiddleware } = require('../core/http-middleware')

function makeRes() {
  const headers = {}
  return {
    setHeader: (k, v) => { headers[k.toLowerCase()] = v },
    get headers() { return headers },
    writeHead: () => {},
    end: () => {},
  }
}

describe('corsMiddleware', () => {
  test('localhost origin 反射 ACAO(默认 allowedOrigin="")', () => {
    const res = makeRes()
    const next = jest.fn()
    corsMiddleware()({ headers: { origin: 'http://localhost:5173' } }, res, {}, next)
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173')
    expect(next).toHaveBeenCalled()
  })

  test('127.0.0.1 与 ::1 origin 同样反射', () => {
    for (const origin of ['http://127.0.0.1:5173', 'http://[::1]:5173']) {
      const res = makeRes()
      corsMiddleware()({ headers: { origin } }, res, {}, () => {})
      expect(res.headers['access-control-allow-origin']).toBe(origin)
    }
  })

  test('file:// 打包模式 origin=null 放行 *', () => {
    const res = makeRes()
    corsMiddleware()({ headers: { origin: 'null' } }, res, {}, () => {})
    expect(res.headers['access-control-allow-origin']).toBe('*')
  })

  test('非 localhost 外部 origin 不设 ACAO(默认配置)', () => {
    const res = makeRes()
    corsMiddleware()({ headers: { origin: 'https://evil.example.com' } }, res, {}, () => {})
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  test('allowedOrigin 精确匹配才反射,不匹配不反射', () => {
    const mw = corsMiddleware({ allowedOrigin: 'https://app.example.com' })
    const ok = makeRes()
    mw({ headers: { origin: 'https://app.example.com' } }, ok, {}, () => {})
    expect(ok.headers['access-control-allow-origin']).toBe('https://app.example.com')
    const bad = makeRes()
    mw({ headers: { origin: 'https://other.example.com' } }, bad, {}, () => {})
    expect(bad.headers['access-control-allow-origin']).toBeUndefined()
  })

  test('allowedOrigin="*" 直接放行 *', () => {
    const res = makeRes()
    corsMiddleware({ allowedOrigin: '*' })({ headers: {} }, res, {}, () => {})
    expect(res.headers['access-control-allow-origin']).toBe('*')
  })

  test('OPTIONS 请求 200 短路', () => {
    const res = makeRes()
    const next = jest.fn()
    corsMiddleware()({ headers: { origin: 'http://localhost:5173' }, method: 'OPTIONS' }, res, {}, next)
    expect(next).not.toHaveBeenCalled()
  })

  test('总是设置 methods/headers 允许头', () => {
    const res = makeRes()
    corsMiddleware()({ headers: {} }, res, {}, () => {})
    expect(res.headers['access-control-allow-methods']).toContain('GET')
    expect(res.headers['access-control-allow-headers']).toContain('X-Api-Key')
  })
})
