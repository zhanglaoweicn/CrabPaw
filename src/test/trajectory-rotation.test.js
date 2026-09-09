/**
 * Task 4（Eval 隔离轮）: 轨迹大文件轮转
 * 背景: cleanup(maxAgeDays) 只按 mtime 删——trajectory_samples.jsonl 追加型恒新，
 * 710MB 永不被清。本套件验证超上限轮转归档 + 归档继承 mtime 清理。
 *
 * 注意: DATA_DIR 在 config require 期固化，故本文件在 require trajectory 之前
 * 设置 CRABPAW_DATA_DIR 指向临时目录（与 evals 隔离同款机制）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ei4-traj-'));
process.env.CRABPAW_DATA_DIR = TMP_ROOT;

const { TrajectorySaver } = require('../core/trajectory');

// A3(Runtime差距分析): trajectory.js 归并到单层 DATA_DIR/trajectories(不再双重嵌套)
const TRAJ_DIR = path.join(TMP_ROOT, 'trajectories');
const ROTATED_RE = /\.jsonl\.rotated-\d{8}-\d{6}-\d{3}$/;

function writeFile(name, content) {
  fs.writeFileSync(path.join(TRAJ_DIR, name), content, 'utf-8');
}
function statSize(name) {
  try {
    return fs.statSync(path.join(TRAJ_DIR, name)).size;
  } catch {
    return -1;
  }
}

afterAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe('TrajectorySaver 大小上限轮转', () => {
  test('超上限 jsonl → 原文件截断为空 + 归档出现（名带时间戳）+ 归档内容完整', () => {
    const saver = new TrajectorySaver();
    const body = 'x'.repeat(4096);
    writeFile('trajectory_samples.jsonl', body);

    const result = saver.cleanup(30, { maxSizeBytes: 1024 });

    // 原文件截断为空（重建）
    expect(statSize('trajectory_samples.jsonl')).toBe(0);

    // 归档出现且名字带时间戳
    const archives = fs.readdirSync(TRAJ_DIR).filter((f) => ROTATED_RE.test(f));
    expect(archives.length).toBe(1);
    expect(archives[0].startsWith('trajectory_samples.jsonl.rotated-')).toBe(true);

    // 归档内容完整
    expect(statSize(archives[0])).toBe(Buffer.byteLength(body, 'utf-8'));
    expect(fs.readFileSync(path.join(TRAJ_DIR, archives[0]), 'utf-8')).toBe(body);

    expect(result.rotated).toBe(1);
  });

  test('未超上限文件不轮转', () => {
    const saver = new TrajectorySaver();
    writeFile('small.jsonl', 'y'.repeat(100));

    const result = saver.cleanup(30, { maxSizeBytes: 1024 });

    expect(statSize('small.jsonl')).toBe(100);
    // 各用例共享临时目录，只查 small 自己的归档（test 1 的归档会残留）
    const archives = fs.readdirSync(TRAJ_DIR).filter((f) => f.startsWith('small.jsonl.rotated-'));
    expect(archives.length).toBe(0);
    expect(result.rotated).toBe(0);
  });

  test('轮转后原路径可继续追加（appendFileSync 续写新文件）', () => {
    const saver = new TrajectorySaver();
    writeFile('append_case.jsonl', 'z'.repeat(2048));
    saver.cleanup(30, { maxSizeBytes: 1024 });

    fs.appendFileSync(path.join(TRAJ_DIR, 'append_case.jsonl'), '{"ts":1}\n', 'utf-8');

    expect(statSize('append_case.jsonl')).toBe(Buffer.byteLength('{"ts":1}\n', 'utf-8'));
  });

  test('归档文件继承 mtime 清理（归档时刻起算 30 天后随 cleanup 删除）', () => {
    const saver = new TrajectorySaver();
    writeFile('aged.jsonl', 'a'.repeat(2048));
    saver.cleanup(30, { maxSizeBytes: 1024 }); // 轮转生成 aged.jsonl.rotated-*

    // 归档 mtime 应为归档时刻（新鲜，未被删）
    const archives = fs.readdirSync(TRAJ_DIR).filter((f) => f.startsWith('aged.jsonl.rotated-'));
    expect(archives.length).toBe(1);
    const archivePath = path.join(TRAJ_DIR, archives[0]);
    const mtime = fs.statSync(archivePath).mtimeMs;
    expect(mtime).toBeGreaterThan(Date.now() - 60 * 1000); // 刚归档，不是原文件旧 mtime 也非未来

    // 伪造 40 天前 → cleanup 删除
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    fs.utimesSync(archivePath, old, old);
    const result = saver.cleanup(30, { maxSizeBytes: 1024 * 1024 }); // 上限调高避免再轮转干扰

    expect(fs.existsSync(archivePath)).toBe(false);
    expect(result.removed).toBeGreaterThanOrEqual(1);
  });

  test('过期普通 jsonl 仍按原逻辑删除（回归）', () => {
    const saver = new TrajectorySaver();
    writeFile('expired.jsonl', 'old data');
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    fs.utimesSync(path.join(TRAJ_DIR, 'expired.jsonl'), old, old);

    const result = saver.cleanup(30, { maxSizeBytes: 1024 * 1024 });

    expect(fs.existsSync(path.join(TRAJ_DIR, 'expired.jsonl'))).toBe(false);
    expect(result.removed).toBeGreaterThanOrEqual(1);
  });
});
