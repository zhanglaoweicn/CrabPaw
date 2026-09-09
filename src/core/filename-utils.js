/**
 * filename-utils.js — 产物文件名统一清洗（2026-08-22）
 *
 * 背景（实测根因）：旧规则手写字符类 `[^a-zA-Z0-9_-一-鿿]` 中 `_`、`-`、`一`
 * 相邻时，V8 把 `_-一` 解析成范围 U+005F~U+4E00，吞掉「一-鿿」中文范围——
 * 「智能体的 Harness 插件」→「_____Harness______AI______」（全下划线灾难）。
 *
 * 统一规则：
 *   1. 删除路径/Windows 非法字符 <>:"/\|?* 与控制符
 *   2. 其余非 字母/数字/汉字/点/下划线/连字符 → 空格（避免连串 _）
 *   3. 空白 → 单下划线；压缩连续 _/-；去两端分隔符
 *   4. 截断 60 字符；空结果 → fallback
 *
 * \p{L}\p{N}（u 标志）覆盖全部语言字母与数字（含 CJK），不再手写中文字段。
 * 保留 '.'：版本号（v2.0）等常见场景，Windows 文件名安全。
 */

const ILLEGAL = /[<>:"/\\|?*\x00-\x1f]/g; // eslint-disable-line no-control-regex
const NOT_KEEP = /[^\p{L}\p{N}._\-\s]/gu;
const WS = /\s+/g;
const COLLAPSE_UNDER = /_+/g;
const COLLAPSE_DASH = /-+/g;
const TRIM_SEP = /^[_-]+|[_-]+$/g;

function sanitizeFilename(name, fallback = 'document') {
  const s = String(name ?? '')
    .replace(ILLEGAL, '')
    .replace(NOT_KEEP, ' ')
    .replace(WS, '_')
    .replace(COLLAPSE_UNDER, '_')
    .replace(COLLAPSE_DASH, '-')
    .replace(TRIM_SEP, '')
    .slice(0, 60);
  return s || fallback;
}

module.exports = { sanitizeFilename };
