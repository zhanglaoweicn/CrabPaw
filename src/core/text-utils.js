/**
 * 共享文本清理工具
 * 
 * 统一前端和后端的文本清理逻辑，消除重复代码。
 * 所有进入TTS合成的文本都要先过这里。
 */

/**
 * 清理表情符号
 */
function stripEmojis(text) {
  if (!text) return '';
  return text
    .replace(/[\u{1F600}-\u{1F64F}]/gu, '')
    .replace(/[\u{1F300}-\u{1F5FF}]/gu, '')
    .replace(/[\u{1F680}-\u{1F6FF}]/gu, '')
    .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '')
    .replace(/[\u{1F900}-\u{1F9FF}]/gu, '')
    .replace(/[\u{1FA00}-\u{1FA6F}]/gu, '')
    .replace(/[\u{1FA70}-\u{1FAFF}]/gu, '')
    .replace(/[\u{2600}-\u{26FF}]/gu, '')
    .replace(/[\u{2700}-\u{27BF}]/gu, '')
    .replace(/[\u{FE00}-\u{FE0F}]/gu, '')
    .replace(/\u{200D}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 清理文本用于语音播放
 * 
 * 处理：
 * - 代码块和行内代码
 * - 链接和图片
 * - HTML标签
 * - Markdown格式（标题、粗体、斜体、列表、引用、水平线）
 * - 表格分隔符
 * - 表情符号
 * - 多余空白
 */
function sanitizeTextForSpeech(text) {
  if (!text || typeof text !== 'string') return '';
  let cleaned = text;
  
  // 移除代码块（包括语言标记）
  cleaned = cleaned.replace(/```[\s\S]*?```/g, '');
  
  // 移除行内代码
  cleaned = cleaned.replace(/`[^`]+`/g, '');
  
  // 移除链接，保留文本
  cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  
  // 移除图片
  cleaned = cleaned.replace(/!\[([^\]]*)\]\([^)]+\)/g, '');
  
  // 移除HTML标签
  cleaned = cleaned.replace(/<[^>]+>/g, '');
  
  // 移除Markdown标题标记
  cleaned = cleaned.replace(/^#{1,6}\s+/gm, '');
  
  // 移除粗体和斜体标记
  cleaned = cleaned.replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1');
  
  // 移除列表标记
  cleaned = cleaned.replace(/^[\s]*[-*+]\s+/gm, '');
  cleaned = cleaned.replace(/^[\s]*\d+[.)]\s+/gm, '');
  
  // 移除引用标记
  cleaned = cleaned.replace(/^>\s+/gm, '');
  
  // 移除水平线
  cleaned = cleaned.replace(/^[-*_]{3,}\s*$/gm, '');
  
  // 移除表格分隔符
  cleaned = cleaned.replace(/\|/g, ' ');
  
  // 移除残留的格式字符
  cleaned = cleaned.replace(/[*_~#>[\]()|{}`]/g, '');
  
  // 清理表情符号
  cleaned = stripEmojis(cleaned);
  
  // 移除多余空白字符
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  
  return cleaned;
}

/**
 * 提取关键内容用于语音播放
 * 如果文本过长，只播放摘要部分
 */
function extractSpeechContent(text, maxLength) {
  maxLength = maxLength || 300;
  const cleaned = sanitizeTextForSpeech(text);
  if (!cleaned) return '';
  if (cleaned.length <= maxLength) return cleaned;
  
  // 尝试按句子分割
  const sentences = cleaned.match(/[^。！？；，\n]+[。！？；，\n]+/g) || [cleaned];
  if (sentences.length <= 1) return cleaned.substring(0, maxLength).trim();
  
  // 按重要性评分
  const scored = sentences.map((s, i) => {
    let score = 1;
    if (i === 0) score += 2;
    if (i === sentences.length - 1) score += 1;
    if (s.length > 80) score -= 1;
    if (s.length > 150) score -= 2;
    if (/[。！？，：；、\n]/.test(s)) score += 2;
    return { text: s.trim(), score };
  }).filter(s => s.text.length > 0);
  
  let result = '';
  for (const s of scored) {
    if (result.length + s.text.length > maxLength) break;
    result += s.text;
  }
  
  return result.trim() || cleaned.substring(0, maxLength).trim();
}

module.exports = {
  stripEmojis,
  sanitizeTextForSpeech,
  extractSpeechContent
};