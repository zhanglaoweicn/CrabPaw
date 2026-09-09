const fs = require('fs')
const os = require('os')
const path = require('path')

const { buildWecomMessagePayload } = require('./wecom-payload')

describe('buildWecomMessagePayload', () => {
  let tmpFile
  beforeAll(() => {
    tmpFile = path.join(os.tmpdir(), `crabpaw-wecom-payload-${Date.now()}.txt`)
    fs.writeFileSync(tmpFile, 'x'.repeat(1234))
  })
  afterAll(() => { try { fs.unlinkSync(tmpFile) } catch (e) { console.error(e?.message || e) } })

  test('无附件 → 无 file 字段', () => {
    const p = buildWecomMessagePayload('u1', '你好', [])
    expect(p.senderId).toBe('u1')
    expect(p.content).toBe('你好')
    expect(p.file).toBeUndefined()
  })

  test('单附件 → file 带 name/path/size', () => {
    const p = buildWecomMessagePayload('u1', '查这个', [{ fileName: '报表.xlsx', fileKey: tmpFile }])
    expect(p.file).toEqual({ name: '报表.xlsx', path: tmpFile, size: 1234 })
    expect(p.fileCount).toBe(1)
  })

  test('多附件 → 取第一个 + fileCount 计数', () => {
    const p = buildWecomMessagePayload('u1', '俩文件', [{ fileName: 'a.txt', fileKey: tmpFile }, { fileName: 'b.txt', fileKey: tmpFile }])
    expect(p.file.name).toBe('a.txt')
    expect(p.fileCount).toBe(2)
  })

  test('缺 fileName/fileKey 的项被跳过', () => {
    const p = buildWecomMessagePayload('u1', 'hmm', [{ fileName: '', fileKey: tmpFile }, { fileName: 'ok.txt', fileKey: tmpFile }])
    expect(p.fileCount).toBe(1)
    expect(p.file.name).toBe('ok.txt')
  })

  test('statSync 失败 → warn 且保留元数据 size 0', () => {
    const spy = jest.spyOn(fs, 'statSync').mockImplementationOnce(() => { throw new Error('boom') })
    const p = buildWecomMessagePayload('u1', 'hi', [{ fileName: 'a.txt', fileKey: '/nonexistent' }])
    expect(p.file).toEqual({ name: 'a.txt', path: '/nonexistent', size: 0 })
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
