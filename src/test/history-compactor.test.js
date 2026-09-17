/**
 * history-compactor 单元测试（2026-09-18 会话膨胀治理 层1）
 *
 * 覆盖: 长内容落档为预览+引用、短内容原样、幂等(已存档不重复处理)、
 * 装配侧批量压缩保留 id/role、写入失败退化为就地截断。
 *
 * 注意: DATA_DIR 在 config require 期固化,本文件在 require 之前设置
 * CRABPAW_DATA_DIR 指向临时目录(与 tool-result-storage.test.js 同款机制)。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'history-compactor-'));
process.env.CRABPAW_DATA_DIR = TMP_ROOT;

const {
  compactMessageContent,
  compactHistoryMessages,
  isArchivedContent,
  HISTORY_ARCHIVE_THRESHOLD_CHARS,
} = require('../core/history-compactor');

afterAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe('history-compactor 长内容落档', () => {
  test('短内容原样返回,不写文件', () => {
    const short = '你帮我查一下大华股份的股价';
    expect(compactMessageContent(short, 'user')).toBe(short);
  });

  test('超阈值长文落档: 返回预览+存档引用,存档文件可读回原文', () => {
    const long = '文章草稿正文。'.repeat(3000); // 21000 字符 > 8000 阈值
    const out = compactMessageContent(long, 'assistant');

    expect(out.length).toBeLessThan(long.length);
    expect(out).toContain('[长内容已存档');
    expect(out).toContain('助手回复');
    expect(out).toContain('Read');

    // 存档引用里的文件路径真实存在且内容 = 原文
    const match = out.match(/存档至: ([^\s，,。]+)/);
    expect(match).toBeTruthy();
    const filePath = match[1];
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(long);

    // 预览是原文开头
    expect(out.startsWith(long.slice(0, 1200))).toBe(true);
  });

  test('幂等: 已存档内容不重复处理', () => {
    const long = '重复压缩测试。'.repeat(2000);
    const once = compactMessageContent(long, 'user');
    const twice = compactMessageContent(once, 'user');
    expect(twice).toBe(once);
    expect(isArchivedContent(once)).toBe(true);
  });

  test('写入失败退化为就地截断,不整条入库', () => {
    const fsMod = require('fs');
    const spy = jest.spyOn(fsMod, 'writeFileSync').mockImplementation(() => {
      throw new Error('disk full (simulated)');
    });
    try {
      const long = '写不进去的内容。'.repeat(2000);
      const out = compactMessageContent(long, 'user');
      expect(out.length).toBeLessThan(long.length);
      expect(out).toContain('存档失败已就地截断');
    } finally {
      spy.mockRestore();
    }
  });

  test('compactHistoryMessages: 只处理 user/assistant,保留 id 等字段', () => {
    const longUser = '用户粘贴的超长文档。'.repeat(1500); // 15000 字符
    const rows = [
      { role: 'system', id: 1, content: 'x'.repeat(20000) },          // system 不处理
      { role: 'user', id: 2, content: '短消息' },                      // 短,不动
      { role: 'user', id: 3, content: longUser },                      // 压缩
      { role: 'tool', id: 4, content: 'y'.repeat(20000) },             // tool 不处理
    ];
    const { messages, compactedCount } = compactHistoryMessages(rows);

    expect(compactedCount).toBe(1);
    expect(messages[0].content).toBe('x'.repeat(20000));
    expect(messages[1].content).toBe('短消息');
    expect(messages[2].content).toContain('[长内容已存档');
    expect(messages[2].id).toBe(3);
    expect(messages[3].content).toBe('y'.repeat(20000));
  });

  test('阈值常量 sane(8000 字符级)', () => {
    expect(HISTORY_ARCHIVE_THRESHOLD_CHARS).toBe(8000);
  });
});
