/**
 * filegen-auto-docx.test.js — 文章类意图自动同步 Word 回归（2026-08-22）
 *
 * 用户业务场景: 输入"写一篇关于 harness 的介绍性文章"→ 智能体流式写 md →
 * 用户没提 WORD 也要同步生成 Word 文档（ai.js maybeStartFileGenTask 标记
 * autoDocx → file-tools.js handleWrite 检测 autoDocx → _generateDocx 自动转）。
 * 四步指示器「④文档生成」由此走完闭环（converting 阶段推进）。
 *
 * 设计约束: 仅 Write 触发（Edit 的 new_string 是片段, 转出来是残缺文档）；
 * 转换失败只 log 不阻塞——md 仍是产物, 面板正常。
 */
jest.mock('../core/filegen-events', () => {
  const actual = jest.requireActual('../core/filegen-events');
  return {
    ...actual,
    ensureFileGenTask: jest.fn(() => 'filegen-test'),
    startFileGen: jest.fn(), phaseFileGen: jest.fn(), doneFileGen: jest.fn(), failFileGen: jest.fn(),
    artifactFileGen: jest.fn(), broadcastDocStructure: jest.fn(),
    getFileGenStatus: jest.fn(),
  };
});
// mock _generateDocx——不真打 archiver 打包（惰性 require 在 handleWrite 内, jest.mock 同样拦截）
jest.mock('../tools/document-tools', () => ({ _generateDocx: jest.fn() }));

const filegen = require('../core/filegen-events');
const documentTools = require('../tools/document-tools');
const { handleWrite } = require('../tools/file-tools');
const path = require('path');
const os = require('os');
const fs = require('fs');

beforeEach(() => { jest.clearAllMocks(); });

const writtenMd = (content) => handleWrite({
  file_path: path.join(os.tmpdir(), `fg-autodocx-${Date.now()}-${Math.random().toString(36).slice(2)}.md`),
  content,
});

afterEach(() => {
  // 清理测试写出的 docx 产物（data/workspace/documents/ 下真实文件）
  const calls = filegen.doneFileGen.mock.calls || [];
  for (const [, file] of calls) {
    if (file?.path && file.path.endsWith('.docx')) {
      try { fs.unlinkSync(file.path) } catch (e) { /* 已不存在则忽略 */ }
    }
  }
});

describe('autoDocx 自动同步 Word（Write md 后）', () => {
  test('autoDocx 任务: converting→docx 落盘→doneFileGen(docx)；md 走 artifact（2026-09-06 v2 语义）', async () => {
    filegen.getFileGenStatus.mockReturnValue({ autoDocx: true });
    documentTools._generateDocx.mockResolvedValue(Buffer.from('MOCK-DOCX-BYTES'));
    const mdContent = '# 智能体介绍\n\n正文内容';

    const res = await handleWrite({ file_path: path.join(os.tmpdir(), `fg-ad-${Date.now()}.md`), content: mdContent });
    expect(res.created).toBe(true);

    // 第 1 次 ensureFileGenTask: md 写入推进
    expect(filegen.ensureFileGenTask).toHaveBeenCalledTimes(2);
    expect(filegen.ensureFileGenTask.mock.calls[0][0]).toEqual(expect.objectContaining({ format: 'md', phase: 'writing' }));
    // 第 2 次: converting 阶段（四步指示器 ④文档生成 闭环）
    expect(filegen.ensureFileGenTask.mock.calls[1][0]).toEqual(expect.objectContaining({ format: 'docx', phase: 'converting' }));
    expect(filegen.ensureFileGenTask.mock.calls[1][0].title).not.toMatch(/\.md$/);

    // _generateDocx 收到原始 md 内容
    expect(documentTools._generateDocx).toHaveBeenCalledTimes(1);
    expect(documentTools._generateDocx.mock.calls[0][0]).toBe(mdContent);
    expect(documentTools._generateDocx.mock.calls[0][2]).toBe('商务报告');

    // 2026-09-06 v2: md 登记 artifact（不 done），转换完成发真 done(docx)
    expect(filegen.artifactFileGen).toHaveBeenCalledTimes(1);
    expect(filegen.artifactFileGen.mock.calls[0][1].format).toBe('md');
    expect(filegen.doneFileGen).toHaveBeenCalledTimes(1);
    const docxFile = filegen.doneFileGen.mock.calls[0][1];
    expect(docxFile.format).toBe('docx');
    expect(docxFile.path).toMatch(/\.docx$/);
    expect(fs.existsSync(docxFile.path)).toBe(true);
    expect(docxFile.size).toBe('MOCK-DOCX-BYTES'.length);
  });

  test('无 autoDocx 标记: 不转换, 仅 artifact(md)（done 由回合收敛发出）', async () => {
    filegen.getFileGenStatus.mockReturnValue({});
    documentTools._generateDocx.mockResolvedValue(Buffer.from('x'));

    await handleWrite({ file_path: path.join(os.tmpdir(), `fg-noad-${Date.now()}.md`), content: '# 普通文档' });

    expect(documentTools._generateDocx).not.toHaveBeenCalled();
    expect(filegen.artifactFileGen).toHaveBeenCalledTimes(1);
    expect(filegen.artifactFileGen.mock.calls[0][1].format).toBe('md');
    expect(filegen.doneFileGen).not.toHaveBeenCalled();
  });

  test('_generateDocx 失败: 不阻塞, md 正常 artifact, 错误已 log（done 缺席由 settle 收敛）', async () => {
    filegen.getFileGenStatus.mockReturnValue({ autoDocx: true });
    documentTools._generateDocx.mockRejectedValue(new Error('archiver boom'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(handleWrite({ file_path: path.join(os.tmpdir(), `fg-fail-${Date.now()}.md`), content: '# 失败场景' }))
      .resolves.toBeTruthy();

    expect(filegen.artifactFileGen).toHaveBeenCalledTimes(1); // md 已登记
    expect(filegen.artifactFileGen.mock.calls[0][1].format).toBe('md');
    expect(filegen.doneFileGen).not.toHaveBeenCalled(); // 转换失败无 done——settleTurn 兜底
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('自动生成 Word 失败'), expect.stringContaining('archiver boom'));
    errSpy.mockRestore();
  });
});
