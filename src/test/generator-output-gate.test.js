/**
 * 生成器 outputPath 权限门控测试（2026-08-28 发布 M1）
 *
 * 覆盖：
 *  1. path-rules.canWriteGeneratorOutput 三模式语义（PLAN 全拦/DEFAULT 保护清单/FULL_AUTO 放行）
 *  2. 接线守卫——全部生成器落盘点必须真实调用门控（防纸面接线）
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const { setPermissionMode } = require('../core/permissions/path-rules');

afterEach(() => {
  // 全局模式状态复位，防串套件
  setPermissionMode('default');
});

describe('canWriteGeneratorOutput（M1 生成器写入门控）', () => {
  test('非法入参拒绝', () => {
    const { canWriteGeneratorOutput } = require('../core/permissions/path-rules');
    expect(canWriteGeneratorOutput(null)).toBe(false);
    expect(canWriteGeneratorOutput('')).toBe(false);
    expect(canWriteGeneratorOutput(123)).toBe(false);
  });

  test('PLAN 模式：一切写入拒绝', () => {
    setPermissionMode('plan');
    const { canWriteGeneratorOutput } = require('../core/permissions/path-rules');
    expect(canWriteGeneratorOutput(path.join(os.tmpdir(), 'ok.html'))).toBe(false);
  });

  test('FULL_AUTO 模式：一切写入放行', () => {
    setPermissionMode('full_auto');
    const { canWriteGeneratorOutput } = require('../core/permissions/path-rules');
    expect(canWriteGeneratorOutput(path.join(os.tmpdir(), 'ok.html'))).toBe(true);
  });

  test('DEFAULT 模式：系统保护目录拒绝（.ssh）', () => {
    const { canWriteGeneratorOutput } = require('../core/permissions/path-rules');
    expect(canWriteGeneratorOutput(path.join(os.homedir(), '.ssh', 'evil.docx'))).toBe(false);
  });

  test('DEFAULT 模式：CRABPAW_WRITE_SAFE_ROOT 约束生效', () => {
    const safeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-safe-'));
    process.env.CRABPAW_WRITE_SAFE_ROOT = safeDir;
    try {
      // file-safety safe-root 缓存按 home 失效，safe root 变化需重取——直接断言两次调用
      const { canWriteGeneratorOutput } = require('../core/permissions/path-rules');
      const outside = path.join(os.tmpdir(), 'gate-outside.docx');
      const inside = path.join(safeDir, 'ok.docx');
      const outsideDenied = !canWriteGeneratorOutput(outside);
      const insideAllowed = canWriteGeneratorOutput(inside);
      expect(outsideDenied).toBe(true);
      expect(insideAllowed).toBe(true);
    } finally {
      delete process.env.CRABPAW_WRITE_SAFE_ROOT;
    }
  });

  test('DEFAULT 模式：普通临时路径放行', () => {
    const { canWriteGeneratorOutput } = require('../core/permissions/path-rules');
    expect(canWriteGeneratorOutput(path.join(os.tmpdir(), 'gate-normal.md.html'))).toBe(true);
  });
});

describe('M1 接线守卫——生成器落盘点必须过门', () => {
  test('file-tools.js 五个生成器均调用 assertGeneratorOutputAllowed', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'file-tools.js'), 'utf8');
    // 五生成器: MarkdownToWord/Xlsx/PPT/PDF/HTML
    // 正则锚定分号——只匹配调用点, 排除 line29 的函数定义本身(否则计成 6)
    expect(src.match(/assertGeneratorOutputAllowed\(outputPath\);/g) || []).toHaveLength(5);
  });

  test('image/video/multimodal 工具均真实调用 canWriteGeneratorOutput', () => {
    for (const f of ['image-tools.js', 'video-tools.js', 'multimodal-tools.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'tools', f), 'utf8');
      expect(src).toMatch(/canWriteGeneratorOutput\(/);
    }
  });
});
