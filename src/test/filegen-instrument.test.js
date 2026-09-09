/**
 * filegen-instrument.test.js — file-tools 插桩回归（2026-08-17）
 * 锁定：Write 成功 → ensureFileGenTask(推进 writing)→artifact(file) 广播。
 * 2026-08-17: 插桩契约由 newTaskId+startFileGen 改为 ensureFileGenTask（四步流程
 * 可视化——生成意图请求开始已开任务，Write 复用推进③内容撰写）。
 * 2026-09-06 状态机 v2: Write 不再即 done——改发 artifactFileGen（产物登记），
 * done 只来自转换完成或回合收敛（settleTurn）。
 * 用 jest.mock 注入广播模块 spy（不改真实广播路径）。
 */
jest.mock('../core/filegen-events', () => {
  const actual = jest.requireActual('../core/filegen-events');
  return {
    ...actual,
    ensureFileGenTask: jest.fn(() => 'filegen-test'),
    startFileGen: jest.fn(), phaseFileGen: jest.fn(), doneFileGen: jest.fn(), failFileGen: jest.fn(),
    artifactFileGen: jest.fn(), broadcastDocStructure: jest.fn(),
  };
});
const filegen = require('../core/filegen-events');

const { handleWrite } = require('../tools/file-tools');

beforeEach(() => jest.clearAllMocks());

describe('handleWrite 插桩', () => {
  test('成功写入后 ensureFileGenTask(writing)→artifact(file)，不再即 done', async () => {
    const out = require('path').join(require('os').tmpdir(), `fg-test-${Date.now()}.md`);
    const res = await handleWrite({ file_path: out, content: '# 标题\n正文' });
    // 注：handleWrite 实际返回 { path, size, created: true }（无 success 字段）——按真实契约断言
    expect(res.created).toBe(true);
    expect(filegen.ensureFileGenTask).toHaveBeenCalledTimes(1);
    expect(filegen.ensureFileGenTask.mock.calls[0][0]).toEqual(expect.objectContaining({ format: 'md', phase: 'writing' }));
    // 2026-09-06: 产物登记走 artifactFileGen，doneFileGen 不再被 Write 触发
    expect(filegen.artifactFileGen).toHaveBeenCalledTimes(1);
    const file = filegen.artifactFileGen.mock.calls[0][1];
    expect(file.name).toBe(require('path').basename(out));
    expect(file.format).toBe('md');
    expect(filegen.doneFileGen).not.toHaveBeenCalled();
  });

  test('html 产物加 UTF-8 BOM（WPS 乱码修复），非 html 不加，重复写不重复加', async () => {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const htmlOut = path.join(os.tmpdir(), `fg-bom-${Date.now()}.html`);
    const mdOut = path.join(os.tmpdir(), `fg-bom-${Date.now()}.md`);
    // html：写入后首字节是 BOM（EF BB BF），内容以 <!DOCTYPE 开头
    await handleWrite({ file_path: htmlOut, content: '<!DOCTYPE html>\n<html lang="zh-CN"></html>' });
    const buf = fs.readFileSync(htmlOut);
    expect(buf.slice(0, 3).toString('hex')).toBe('efbbbf');
    expect(buf.toString('utf8')).toContain('<!DOCTYPE html>');
    // 幂等：第二次写（内容不含 BOM）不叠加第二个 BOM
    await handleWrite({ file_path: htmlOut, content: '<!DOCTYPE html>\n改版' });
    expect(fs.readFileSync(htmlOut).slice(0, 3).toString('hex')).toBe('efbbbf');
    // 非 html：不加 BOM
    await handleWrite({ file_path: mdOut, content: '# 标题' });
    expect(fs.readFileSync(mdOut).slice(0, 3).toString('hex')).not.toBe('efbbbf');
  });
});
