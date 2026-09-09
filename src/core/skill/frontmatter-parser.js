/**
 * Canonical YAML frontmatter parser for skill SKILL.md files.
 * Single source of truth — supersedes duplicate implementations in
 * skill-system.js and skills.js.
 *
 * Features:
 * - Extracts YAML frontmatter between --- delimiters
 * - Handles nested YAML structures (indentation-aware)
 * - Parses inline JSON arrays like ["item1", "item2"]
 * - Supports metadata as nested YAML or inline JSON
 * - Normalizes line endings
 */

/**
 * Parse YAML frontmatter from a SKILL.md content string.
 * @param {string} content Raw file content
 * @returns {{ frontmatter: Record<string, any>, body: string }}
 */
function parseFrontmatter(content) {
  if (!content || typeof content !== 'string') {
    return { frontmatter: {}, body: content || '' }
  }

  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!match) return { frontmatter: {}, body: content }

  const frontmatterText = match[1].replace(/\r/g, '')
  const body = match[2]
  const frontmatter = {}

  const lines = frontmatterText.split('\n')
  let currentKey = null
  let currentValue = []
  let baseIndent = null

  for (const line of lines) {
    const colonMatch = line.match(/^(\w+):\s*(.*)$/)
    if (colonMatch) {
      if (currentKey) {
        frontmatter[currentKey] = cleanValue(currentValue.length === 1 ? currentValue[0] : currentValue.join('\n'))
      }
      currentKey = colonMatch[1]
      currentValue = colonMatch[2] ? [colonMatch[2]] : []
      baseIndent = null
    } else if (currentKey && (line.startsWith('  ') || line.startsWith('\t'))) {
      if (baseIndent === null) {
        baseIndent = line.search(/\S/)
      }
      const indent = line.search(/\S/)
      const spaces = Math.max(0, indent - baseIndent)
      currentValue.push(' '.repeat(spaces) + line.slice(indent))
    }
  }
  if (currentKey) {
    frontmatter[currentKey] = cleanValue(currentValue.length === 1 ? currentValue[0] : currentValue.join('\n'))
  }

  // Parse metadata as nested YAML/JSON if present
  if (frontmatter.metadata && typeof frontmatter.metadata === 'string') {
    frontmatter.metadata = parseMetadata(frontmatter.metadata)
  }

  return { frontmatter, body }
}

/**
 * Clean a YAML value: strip enclosing quotes unless it's JSON.
 */
function cleanValue(value) {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  // Don't strip quotes from JSON objects/arrays
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/**
 * Parse metadata field: try JSON first, fall back to YAML.
 */
function parseMetadata(metadataStr) {
  if (!metadataStr) return {}
  if (typeof metadataStr === 'object') return metadataStr

  // Try JSON format first
  if (metadataStr.trim().startsWith('{')) {
    try {
      const cleaned = metadataStr
        .replace(/^\s*\{/, '{')
        .replace(/\}\s*$/, '}')
        .replace(/\n/g, ' ')
        .replace(/\s+/g, ' ')
      return JSON.parse(cleaned)
    } catch (e) {
      console.warn('[frontmatter-parser] Failed to parse metadata JSON, falling through to YAML:', e.message);
    }
  }

  return parseYamlBlock(metadataStr)
}

/**
 * Parse a YAML block into a nested object.
 * Supports nested keys, arrays (- prefix), and inline JSON arrays.
 */
function parseYamlBlock(text) {
  const result = {}
  const lines = text.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'))

  function getIndent(line) {
    return line.search(/\S/)
  }

  function parseLines(lineList, parentIndent) {
    const obj = {}
    let i = 0

    while (i < lineList.length) {
      const line = lineList[i]
      const indent = getIndent(line)
      if (indent <= parentIndent && i > 0) break

      const trimmed = line.trim()
      if (trimmed.startsWith('- ')) { i++; continue }

      const colonMatch = trimmed.match(/^([^:]+?):\s*(.*)$/)
      if (colonMatch) {
        const key = colonMatch[1].trim()
        const value = colonMatch[2].trim()

        if (value === '' || value === '|' || value === '>') {
          const childLines = []
          i++
          while (i < lineList.length) {
            const nextIndent = getIndent(lineList[i])
            const nextTrimmed = lineList[i].trim()
            if (nextIndent < indent) break
            if (nextIndent === indent && !nextTrimmed.startsWith('- ')) break
            childLines.push(lineList[i])
            i++
          }
          if (childLines.length > 0 && childLines[0].trim().startsWith('- ')) {
            obj[key] = childLines.map(l => cleanValue(l.trim().replace(/^- /, '')))
          } else if (childLines.length > 0) {
            obj[key] = parseLines(childLines, indent)
          } else {
            obj[key] = {}
          }
        } else {
          if (value.startsWith('[') && value.endsWith(']')) {
            obj[key] = parseInlineArray(value)
          } else {
            obj[key] = cleanValue(value)
          }
          i++
        }
      } else {
        i++
      }
    }
    return obj
  }

  if (lines.length === 0) return result
  return parseLines(lines, -1)
}

/**
 * Parse a JSON-like inline array string.
 */
function parseInlineArray(str) {
  if (!str || !str.trim().startsWith('[')) return []
  const inner = str.trim().slice(1, -1).trim()
  if (!inner) return []

  // Try JSON.parse first (for quoted strings like ["a", "b"])
  try {
    const parsed = JSON.parse(str.trim())
    return Array.isArray(parsed) ? parsed : []
  } catch {
    // Non-JSON inline array: [foo, bar, baz] → split by comma, trim each
    return inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
  }
}

/**
 * Extract LLM-generated JSON from a response that may be wrapped in markdown.
 * Handles: ```json ... ```, ``` ... ```, and bare JSON.
 */
function extractJsonFromLLMResponse(content) {
  if (!content || typeof content !== 'string') return null

  // Try direct parse first
  try {
    return JSON.parse(content.trim())
  } catch (e) { console.warn('[frontmatter-parser] direct JSON parse failed, trying alternatives:', e.message); }

  // Try extracting from ```json ... ``` fence
  const fenceMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim())
    } catch (e) { console.warn('[frontmatter-parser] Failed to parse JSON from LLM response:', e.message); }
  }

  // Try finding the first balanced {...} or [...] block
  const braceIdx = content.indexOf('{')
  const bracketIdx = content.indexOf('[')
  const startIdx = braceIdx === -1 ? bracketIdx : bracketIdx === -1 ? braceIdx : Math.min(braceIdx, bracketIdx)
  if (startIdx !== -1) {
    const slice = content.slice(startIdx)
    try {
      return JSON.parse(slice)
    } catch (e) { console.warn('[frontmatter-parser] Failed to parse JSON from LLM response:', e.message); }
  }

  return null
}

module.exports = {
  parseFrontmatter,
  parseYamlBlock,
  parseMetadata,
  parseInlineArray,
  cleanValue,
  extractJsonFromLLMResponse,
}
