/**
 * attachment.test.ts — fileUrlFor / isImageAttachment / baseNameOf / formatFileSize
 */
import { isImageAttachment, baseNameOf, fileUrlFor, formatFileSize } from './attachment'
import type { Mock } from 'vitest'
import * as api from './api'

vi.mock('./api', () => ({
  isElectron: vi.fn(() => false),
}))

const mockedIsElectron = api.isElectron as Mock

describe('isImageAttachment', () => {
  test('常见图片扩展名命中', () => {
    expect(isImageAttachment('a.png')).toBe(true)
    expect(isImageAttachment('b.JPG')).toBe(true)
    expect(isImageAttachment('c.webp')).toBe(true)
    expect(isImageAttachment('d.svg')).toBe(true)
  })
  test('非图片扩展名不命中', () => {
    expect(isImageAttachment('a.pdf')).toBe(false)
    expect(isImageAttachment('b.txt')).toBe(false)
    expect(isImageAttachment('c.docx')).toBe(false)
    expect(isImageAttachment('')).toBe(false)
    expect(isImageAttachment('noext')).toBe(false)
  })
})

describe('baseNameOf', () => {
  test('正反斜杠均可解析', () => {
    expect(baseNameOf('D:/bossagent/data/workspace/uploads/1_a.png')).toBe('1_a.png')
    expect(baseNameOf('D:\\bossagent\\data\\workspace\\uploads\\2_b.txt')).toBe('2_b.txt')
  })
  test('空串 → 空串', () => {
    expect(baseNameOf('')).toBe('')
  })
})

describe('fileUrlFor', () => {
  test('浏览器模式 → /files/workspace/uploads/{basename}', () => {
    mockedIsElectron.mockReturnValue(false)
    expect(fileUrlFor('D:/bossagent/data/.crabpaw/workspace/uploads/123_a.png'))
      .toBe('/files/workspace/uploads/123_a.png')
  })
  test('浏览器模式文件名编码（空格等）', () => {
    mockedIsElectron.mockReturnValue(false)
    expect(fileUrlFor('D:/x/uploads/1 my file.png')).toBe('/files/workspace/uploads/1%20my%20file.png')
  })
  test('Electron 模式 → local:// 绝对路径', () => {
    mockedIsElectron.mockReturnValue(true)
    expect(fileUrlFor('D:\\bossagent\\data\\.crabpaw\\workspace\\uploads\\123_a.png'))
      .toBe('local:///D:/bossagent/data/.crabpaw/workspace/uploads/123_a.png')
  })
  test('空路径 → 空串', () => {
    expect(fileUrlFor('')).toBe('')
  })
})

describe('formatFileSize', () => {
  test('B/KB/MB 三档', () => {
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(2048)).toBe('2 KB')
    expect(formatFileSize(3 * 1024 * 1024)).toBe('3.0 MB')
  })
  test('缺失/非法 → 空串', () => {
    expect(formatFileSize(undefined)).toBe('')
    expect(formatFileSize(0)).toBe('')
    expect(formatFileSize(NaN)).toBe('')
  })
})
