/**
 * 唤醒词词表生成器 — 中文唤醒词 → sherpa KWS keywords.txt 内容
 *
 * 词表格式（sherpa KWS 要求）: 每行 "声母 韵母(带调) ... @标签"
 * 示例: "x iǎo p áng x iè @小螃蟹"
 */
const { pinyin } = require('pinyin-pro')

// 声母表（双字母优先匹配）
const INITIALS = ['zh', 'ch', 'sh', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h', 'j', 'q', 'x', 'r', 'z', 'c', 's', 'y', 'w']

/** 单个带调音节 → "声母 韵母" 分片；无韵头（如 "èr"）原样返回 */
function splitSyllable(syllable) {
  for (const init of INITIALS) {
    if (syllable.startsWith(init) && syllable.length > init.length) {
      return `${init} ${syllable.slice(init.length)}`
    }
  }
  return syllable
}

/** 中文唤醒词 → 词表内容（含 @标签 后缀行）
 * 2026-08-03: 支持多词（数组）——默认词表同时含品牌词"小螃蟹"与用户自定义词，
 * sherpa KWS 词表每行一个词，多词 = 多行。 */
function buildKeywordsFile(wakeWord) {
  const words = Array.isArray(wakeWord) ? wakeWord : [wakeWord]
  const lines = words.map((w) => {
    const check = validateWakeWord(w)
    if (!check.ok) throw new Error(check.error)
    const syllables = pinyin(w, { toneType: 'symbol', type: 'array' })
    const base = syllables.map(splitSyllable).join(' ')
    return `${base} @${w}`
  })
  return lines.join('\n') + '\n'
}

/** 校验: 支持单个词或数组（多唤醒词），每个 2-6 个中文字符 */
function validateWakeWord(word) {
  const words = Array.isArray(word) ? word : [word]
  if (words.length === 0) {
    return { ok: false, error: '唤醒词不能为空' }
  }
  for (const w of words) {
    if (typeof w !== 'string' || w.length === 0) {
      return { ok: false, error: '唤醒词不能为空' }
    }
    if (w.length < 2 || w.length > 6) {
      return { ok: false, error: `唤醒词"${w}"需为 2-6 个汉字` }
    }
    if (!/^[一-龥]+$/.test(w)) {
      return { ok: false, error: `唤醒词"${w}"只能包含汉字` }
    }
  }
  return { ok: true }
}

module.exports = { splitSyllable, buildKeywordsFile, validateWakeWord }
