/**
 * 发布 S-2b — isAllowedUploadPath 单测：uploads 内允许 / 外部拒 / 绝对相对形态。
 * 纯路径逻辑，不建真实目录。
 */
const path = require('path');
const os = require('os');
const { isAllowedUploadPath } = require('../core/upload-path');

const dataDir = path.join(os.tmpdir(), 'cp-upload-test-' + process.pid);

describe('isAllowedUploadPath', () => {
  test('uploads 内文件允许（含子目录）', () => {
    expect(isAllowedUploadPath(path.join(dataDir, 'uploads', 'a.txt'), dataDir)).toBe(true);
    expect(isAllowedUploadPath(path.join(dataDir, 'uploads', 'sub', 'b.pdf'), dataDir)).toBe(true);
  });

  test('uploads 根本身允许（目录语义落在白名单内）', () => {
    expect(isAllowedUploadPath(path.join(dataDir, 'uploads'), dataDir)).toBe(true);
  });

  test('数据目录外部文件拒绝（config.json 等）', () => {
    expect(isAllowedUploadPath(path.join(dataDir, 'config.json'), dataDir)).toBe(false);
    expect(isAllowedUploadPath(dataDir, dataDir)).toBe(false);
  });

  test('前缀相似目录拒绝（uploads_backup 不是 uploads）', () => {
    expect(isAllowedUploadPath(path.join(dataDir, 'uploads_backup', 'x.txt'), dataDir)).toBe(false);
  });

  test('路径遍历逃逸拒绝', () => {
    expect(isAllowedUploadPath(path.join(dataDir, 'uploads', '..', 'config.json'), dataDir)).toBe(false);
    expect(isAllowedUploadPath(path.join(dataDir, 'uploads', '..', '..', 'secret.txt'), dataDir)).toBe(false);
  });

  test('绝对外部路径拒绝（系统盘/项目盘）', () => {
    expect(isAllowedUploadPath('C:\\Users\\Public\\secret.txt', dataDir)).toBe(false);
    expect(isAllowedUploadPath('/etc/passwd', dataDir)).toBe(false);
  });

  test('相对路径按 cwd 解析——不落 uploads 即拒绝', () => {
    // jest cwd = 仓库根；相对路径不会解析进 tmp 的 uploads
    expect(isAllowedUploadPath('uploads/notes.txt', dataDir)).toBe(false);
    expect(isAllowedUploadPath('config.json', dataDir)).toBe(false);
  });

  test('非法输入拒绝', () => {
    expect(isAllowedUploadPath('', dataDir)).toBe(false);
    expect(isAllowedUploadPath(null, dataDir)).toBe(false);
    expect(isAllowedUploadPath(undefined, dataDir)).toBe(false);
    expect(isAllowedUploadPath(123, dataDir)).toBe(false);
    expect(isAllowedUploadPath(path.join(dataDir, 'uploads', 'a.txt'), '')).toBe(false);
    expect(isAllowedUploadPath(path.join(dataDir, 'uploads', 'a.txt'), null)).toBe(false);
  });

  // ─── 2026-09-07 白名单扩展：data/workspace 产物目录可发送 ───
  const repoDataDir = path.resolve(dataDir, '..');

  test('data/workspace 产物目录允许（documents/看板 html 等）', () => {
    expect(isAllowedUploadPath(path.join(repoDataDir, 'workspace', 'documents', '报告.docx'), dataDir)).toBe(true);
    expect(isAllowedUploadPath(path.join(repoDataDir, 'workspace', '销售看板.html'), dataDir)).toBe(true);
    expect(isAllowedUploadPath(path.join(repoDataDir, 'workspace'), dataDir)).toBe(true);
  });

  test('前缀相似目录拒绝（workspace_backup 不是 workspace）', () => {
    expect(isAllowedUploadPath(path.join(repoDataDir, 'workspace_backup', 'x.txt'), dataDir)).toBe(false);
  });

  test('敏感文件黑名单——即使位于白名单目录也拒绝', () => {
    expect(isAllowedUploadPath(path.join(dataDir, 'uploads', 'config.json'), dataDir)).toBe(false);
    expect(isAllowedUploadPath(path.join(dataDir, 'uploads', '.env'), dataDir)).toBe(false);
    expect(isAllowedUploadPath(path.join(dataDir, 'uploads', 'approval.key'), dataDir)).toBe(false);
    expect(isAllowedUploadPath(path.join(repoDataDir, 'workspace', 'server.pem'), dataDir)).toBe(false);
  });
});
