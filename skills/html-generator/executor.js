/**
 * html-generator — 独立 HTML 报告生成
 * 用法：execute({ title, content, style?, template?, inputType? })
 * 基于 document-tools _generateHtml(content, options) —— 同步返回 HTML 字符串
 */
const path = require('path');
const fs = require('fs');
const { _generateHtml } = require('../../src/tools/document-tools');

async function execute(params = {}) {
  try {
    const title = String(params.title || '报告').trim();
    const content = String(params.content || '').trim();
    if (!content) return { success: false, error: '缺少内容 content' };

    // _generateHtml 签名：(content, { style, title, inputType }) —— 同步，两参数
    // style 为中文枚举：商务报告 | 技术文档 | 博客文章 | 落地页 | 简约暗色
    // 兼容旧参数名 template → style
    const style = params.style || params.template || '商务报告';
    const inputType = params.inputType || 'markdown';
    const html = _generateHtml(content, { style, title, inputType });

    return { success: true, html, title, style, size: html.length };
  } catch (err) {
    console.error('[html-generator] 失败:', err);
    return { success: false, error: `HTML 生成失败: ${err.message}` };
  }
}

module.exports = { execute };
