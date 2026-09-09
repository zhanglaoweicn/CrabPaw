/**
 * prompt-loader 单元测试
 */
const fs = require('fs');
const path = require('path');
const { loadPrompt, loadPromptBlocks, invalidatePromptCache, PROMPTS_DIR } = require('../core/prompt-loader');

describe('prompt-loader', () => {
  beforeEach(() => {
    // 每个测试前清空缓存，确保测试隔离
    invalidatePromptCache();
  });

  describe('loadPrompt', () => {
    it('加载已存在的提示词文件', () => {
      const content = loadPrompt('stable-safety');
      expect(content).toBeTruthy();
      expect(content).toContain('## 安全规则');
      expect(content).toContain('### 身份保护');
    });

    // 2026-09-06: platform-*.md 文件族已删除——buildPlatformPrompt 为 system-prompt.js
    // 内嵌表, loadPrompt('platform-*') 从无生产调用方, 微信通道退役后一并清理。

    it('不存在的文件返回空串', () => {
      const content = loadPrompt('nonexistent-prompt-xyz');
      expect(content).toBe('');
    });

    it('空名称返回空串', () => {
      expect(loadPrompt('')).toBe('');
      expect(loadPrompt(null)).toBe('');
      expect(loadPrompt(undefined)).toBe('');
      expect(loadPrompt(123)).toBe('');
    });

    it('剥离 BOM', () => {
      // 创建临时带 BOM 的测试文件
      const testFile = path.join(PROMPTS_DIR, '_test-bom.md');
      const bomContent = '\uFEFF## BOM Test\n内容';
      fs.writeFileSync(testFile, bomContent, 'utf8');
      try {
        invalidatePromptCache();
        const result = loadPrompt('_test-bom');
        expect(result.charCodeAt(0)).not.toBe(0xFEFF);
        expect(result).toContain('## BOM Test');
      } finally {
        fs.unlinkSync(testFile);
      }
    });

    it('统一 CRLF 为 LF', () => {
      const testFile = path.join(PROMPTS_DIR, '_test-crlf.md');
      fs.writeFileSync(testFile, '## Line1\r\n## Line2\r\n', 'utf8');
      try {
        invalidatePromptCache();
        const result = loadPrompt('_test-crlf');
        expect(result).not.toContain('\r\n');
        expect(result).toContain('## Line1\n## Line2');
      } finally {
        fs.unlinkSync(testFile);
      }
    });

    it('剥离文件末尾多余换行', () => {
      const testFile = path.join(PROMPTS_DIR, '_test-trail.md');
      fs.writeFileSync(testFile, '## Content\n\n\n', 'utf8');
      try {
        invalidatePromptCache();
        const result = loadPrompt('_test-trail');
        expect(result).toBe('## Content');
      } finally {
        fs.unlinkSync(testFile);
      }
    });
  });

  describe('占位符替换', () => {
    it('替换单个占位符', () => {
      const testFile = path.join(PROMPTS_DIR, '_test-var.md');
      fs.writeFileSync(testFile, '你好 {{name}}，今天是 {{day}}', 'utf8');
      try {
        invalidatePromptCache();
        const result = loadPrompt('_test-var', { name: 'CrabPaw', day: '周三' });
        expect(result).toBe('你好 CrabPaw，今天是 周三');
      } finally {
        fs.unlinkSync(testFile);
      }
    });

    it('未提供变量时保留占位符', () => {
      const testFile = path.join(PROMPTS_DIR, '_test-missing-var.md');
      fs.writeFileSync(testFile, '你好 {{name}}', 'utf8');
      try {
        invalidatePromptCache();
        const result = loadPrompt('_test-missing-var', {});
        expect(result).toBe('你好 {{name}}');
      } finally {
        fs.unlinkSync(testFile);
      }
    });

    it('支持数字类型变量', () => {
      const testFile = path.join(PROMPTS_DIR, '_test-num.md');
      fs.writeFileSync(testFile, '数量: {{count}}', 'utf8');
      try {
        invalidatePromptCache();
        const result = loadPrompt('_test-num', { count: 42 });
        expect(result).toBe('数量: 42');
      } finally {
        fs.unlinkSync(testFile);
      }
    });

    it('无 vars 参数时不做替换', () => {
      const testFile = path.join(PROMPTS_DIR, '_test-novar.md');
      fs.writeFileSync(testFile, '你好 {{name}}', 'utf8');
      try {
        invalidatePromptCache();
        const result = loadPrompt('_test-novar');
        expect(result).toBe('你好 {{name}}');
      } finally {
        fs.unlinkSync(testFile);
      }
    });
  });

  describe('缓存机制', () => {
    it('第二次调用使用缓存（不读盘）', () => {
      const testFile = path.join(PROMPTS_DIR, '_test-cache.md');
      fs.writeFileSync(testFile, '原始内容', 'utf8');
      try {
        invalidatePromptCache();
        // 第一次加载
        const result1 = loadPrompt('_test-cache');
        expect(result1).toBe('原始内容');

        // 修改文件内容
        fs.writeFileSync(testFile, '修改后内容', 'utf8');

        // 第二次加载应返回缓存（仍是"原始内容"）
        const result2 = loadPrompt('_test-cache');
        expect(result2).toBe('原始内容');
      } finally {
        fs.unlinkSync(testFile);
      }
    });

    it('invalidatePromptCache 清空缓存后重新读盘', () => {
      const testFile = path.join(PROMPTS_DIR, '_test-invalidate.md');
      fs.writeFileSync(testFile, 'v1', 'utf8');
      try {
        invalidatePromptCache();
        expect(loadPrompt('_test-invalidate')).toBe('v1');

        fs.writeFileSync(testFile, 'v2', 'utf8');
        // 缓存仍是 v1
        expect(loadPrompt('_test-invalidate')).toBe('v1');

        // 清空缓存后重新读盘
        invalidatePromptCache();
        expect(loadPrompt('_test-invalidate')).toBe('v2');
      } finally {
        fs.unlinkSync(testFile);
      }
    });

    it('文件不存在时缓存空串避免重复读盘告警', () => {
      invalidatePromptCache();
      // 第一次调用会产生 warn 日志
      const result1 = loadPrompt('_nonexistent-cache-test');
      expect(result1).toBe('');
      // 第二次调用应使用缓存（不再 warn）
      const result2 = loadPrompt('_nonexistent-cache-test');
      expect(result2).toBe('');
    });
  });

  describe('loadPromptBlocks', () => {
    it('拼接多个提示词块', () => {
      const result = loadPromptBlocks(['stable-safety', 'stable-writing']);
      expect(result).toContain('## 安全规则');
      expect(result).toContain('## ✍️ 人性化写作规则');
      // 两个块都存在，且 safety 在 writing 之前
      const safetyIdx = result.indexOf('## 安全规则');
      const writingIdx = result.indexOf('## ✍️ 人性化写作规则');
      expect(safetyIdx).toBeGreaterThan(-1);
      expect(writingIdx).toBeGreaterThan(safetyIdx);
    });

    it('过滤空块', () => {
      const result = loadPromptBlocks(['stable-safety', 'nonexistent', 'stable-writing']);
      expect(result).toContain('## 安全规则');
      expect(result).toContain('## ✍️ 人性化写作规则');
    });

    it('空数组返回空串', () => {
      expect(loadPromptBlocks([])).toBe('');
    });

    it('全部不存在的块返回空串', () => {
      expect(loadPromptBlocks(['no1', 'no2', 'no3'])).toBe('');
    });

    it('传递 vars 给每个块', () => {
      const testFile = path.join(PROMPTS_DIR, '_test-blocks-var.md');
      fs.writeFileSync(testFile, 'Hello {{name}}', 'utf8');
      try {
        invalidatePromptCache();
        const result = loadPromptBlocks(['_test-blocks-var'], { name: 'World' });
        expect(result).toBe('Hello World');
      } finally {
        fs.unlinkSync(testFile);
      }
    });
  });

  describe('PROMPTS_DIR', () => {
    it('指向正确的 prompts 目录', () => {
      expect(PROMPTS_DIR).toContain('prompts');
      expect(fs.existsSync(PROMPTS_DIR)).toBe(true);
    });
  });
});
