'use strict';
// 文档产物注册表（SP-4）——register 去重/touch/cap/持久化/list。
const os = require('os');
const path = require('path');
const fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'da-'));
process.env.CRABPAW_DATA_DIR = tmp;

const da = require('../core/doc-artifacts/registry');

afterAll(() => {
  // 测试隔离: 清理 env 注入与临时目录——同 worker 后续套件(config.js 重新求值)不受污染
  delete process.env.CRABPAW_DATA_DIR;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.warn('[doc-artifacts.test] 清理临时目录失败:', e.message); }
});

describe('doc-artifacts registry', () => {
  test('register 后 list 可查 + 持久化文件存在', async () => {
    da.resetForTest?.();
    const r = await da.registerArtifact({ path: path.join(tmp, 'a.docx'), name: 'a.docx', size: 12, format: 'docx', url: 'local:///a.docx', taskId: 't1' });
    expect(r.ok).toBe(true);
    const list = da.listArtifacts();
    expect(list.length).toBe(1);
    expect(list[0].name).toBe('a.docx');
    expect(fs.existsSync(path.join(tmp, 'doc-artifacts.json'))).toBe(true);
  });
  test('path 去重: 同 path 再注册 → 只更新不追加', async () => {
    await da.registerArtifact({ path: path.join(tmp, 'b.docx'), name: 'b.docx', size: 1, format: 'docx', url: '', taskId: 't1' });
    await da.registerArtifact({ path: path.join(tmp, 'b.docx'), name: 'b.docx', size: 99, format: 'docx', url: '', taskId: 't2' });
    expect(da.listArtifacts().length).toBe(2);   // a + b(更新)
    expect(da.listArtifacts().find(x => x.name === 'b.docx').size).toBe(99);
    expect(da.listArtifacts().find(x => x.name === 'b.docx').taskId).toBe('t2');
  });
  test('cap 500: 501 注册后列表裁剪为 500 且保留最新', async () => {
    da.resetForTest?.();
    for (let i = 0; i < 501; i++) await da.registerArtifact({ path: path.join(tmp, `c${i}.md`), name: `c${i}.md`, size: 1, format: 'md', url: '', taskId: 'x' });
    // listArtifacts 默认 limit=20（API 口径）——cap 验证须显式传入大 limit（断言与计划参考实现的默认值对齐, 见 SA-1 报告披露）
    expect(da.listArtifacts(1000).length).toBe(500);
    expect(da.listArtifacts()[0].name).toBe('c500.md');
  });

  // ── Artifact 深化轮（2026-09-03）: 版本/状态/血缘 ──
  test('版本化: 同名同格式再生成(路径变化) → version+1 + versions 入档 + 旧文件归档', async () => {
    da.resetForTest?.();
    const v1 = path.join(tmp, 'report.docx');
    fs.writeFileSync(v1, 'v1-content');
    await da.registerArtifact({ path: v1, name: '报告.docx', size: 10, format: 'docx', url: '', taskId: 't1', runId: 'run_1' });
    const v2 = path.join(tmp, 'report-v2.docx');
    fs.writeFileSync(v2, 'v2-content-longer');
    const r2 = await da.registerArtifact({ path: v2, name: '报告.docx', size: 17, format: 'docx', url: '', taskId: 't2', runId: 'run_2' });
    expect(r2.ok).toBe(true);
    expect(r2.version).toBe(2);
    const entry = da.listArtifacts(10).find(x => x.name === '报告.docx');
    expect(entry.version).toBe(2);
    expect(entry.runId).toBe('run_2');
    expect(entry.versions.length).toBe(1);
    expect(entry.versions[0].version).toBe(1);
    expect(entry.versions[0].runId).toBe('run_1');
    // 旧物理文件已归档到 .versions/<id>/v1.docx
    expect(fs.existsSync(entry.versions[0].path)).toBe(true);
    expect(fs.readFileSync(entry.versions[0].path, 'utf-8')).toBe('v1-content');
  });

  test('防虚增: 同路径同大小重复登记 → 仅 touch 不升版本', async () => {
    da.resetForTest?.();
    const f = path.join(tmp, 'same.docx');
    await da.registerArtifact({ path: f, name: 'same.docx', size: 5, format: 'docx', url: '', taskId: 't1' });
    await da.registerArtifact({ path: f, name: 'same.docx', size: 5, format: 'docx', url: '', taskId: 't1' });
    const entry = da.listArtifacts(10).find(x => x.name === 'same.docx');
    expect(entry.version).toBe(1);
    expect(entry.versions.length).toBe(0);
  });

  test('状态字段: 新登记默认 completed; 可显式标记 failed', async () => {
    da.resetForTest?.();
    await da.registerArtifact({ path: path.join(tmp, 'ok.md'), name: 'ok.md', size: 1, format: 'md', url: '', taskId: 't' });
    await da.registerArtifact({ path: path.join(tmp, 'bad.md'), name: 'bad.md', size: 1, format: 'md', url: '', taskId: 't', status: 'failed' });
    expect(da.listArtifacts(10).find(x => x.name === 'ok.md').status).toBe('completed');
    expect(da.listArtifacts(10).find(x => x.name === 'bad.md').status).toBe('failed');
  });
});
