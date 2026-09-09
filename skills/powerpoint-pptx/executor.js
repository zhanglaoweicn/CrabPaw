/**
 * powerpoint-pptx — PPT 生成
 * 用法：execute({ title, slides: [{ title, type?, bullets?, ... }], style?, theme? })
 * 基于 document-tools _generatePptx({ slides, style, title }) —— 异步返回 Buffer
 */
const path = require('path');
const fs = require('fs');
const { _generatePptx } = require('../../src/tools/document-tools');

async function execute(params = {}) {
  try {
    const title = String(params.title || '演示文稿').trim();
    const slides = Array.isArray(params.slides) && params.slides.length > 0
      ? params.slides
      : [{ title: '示例', type: 'content', bullets: ['双击编辑内容'] }];

    // _generatePptx 签名：(spec) → Promise<Buffer>
    // spec = { slides, style, title }  —— style 不是 theme（兼容 theme → style）
    const style = params.style || params.theme || 'business_blue';
    const buffer = await _generatePptx({ slides, style, title });

    // 写入工作区
    const workspaceDir = process.env.CRABPAW_DATA_DIR
      || path.join(__dirname, '..', '..', 'data', 'workspace', 'documents');
    if (!fs.existsSync(workspaceDir)) {
      fs.mkdirSync(workspaceDir, { recursive: true });
    }
    // 2026-08-22: 与 src/core/filename-utils.js sanitizeFilename 保持一致的内联规则
    // （旧规则不剥离 <>:"/\|?* 非法字符，且 `_`/`-`/`一` 相邻时 V8 会把 `_-一` 解析成
    // 范围 U+005F~U+4E00——中文全变下划线；改用 \p{L}\p{N}（u 标志））
    const safeName = String(title || '')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
      .replace(/[^\p{L}\p{N}._\-\s]/gu, ' ')
      .replace(/\s+/g, '_').replace(/_+/g, '_').replace(/-+/g, '-')
      .replace(/^[_-]+|[_-]+$/g, '').slice(0, 60) || 'presentation';
    const filePath = path.join(workspaceDir, `${safeName}_${Date.now()}.pptx`);
    fs.writeFileSync(filePath, buffer);

    const sizeKB = (buffer.length / 1024).toFixed(1);
    return { success: true, filePath, title, slideCount: slides.length, sizeKB, style };
  } catch (err) {
    console.error('[powerpoint-pptx] 失败:', err);
    return { success: false, error: `PPT 生成失败: ${err.message}` };
  }
}

module.exports = { execute };
