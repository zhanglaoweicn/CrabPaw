/**
 * experts-manifest-validate.test.js — 内置专家清单校验（Phase 3d 收编）
 */
const { validateExpertManifest } = require('../core/experts/manifest-validate');
const { BUILTIN_EXPERTS } = require('../core/experts/index');

describe('experts manifest-validate（内置专家清单约束）', () => {
  test('真实内置专家集通过校验（防收编即挂）', () => {
    const r = validateExpertManifest(BUILTIN_EXPERTS);
    expect(r.valid).toBe(true);
    expect(r.problems).toEqual([]);
  });

  test('id 重复 → 点名', () => {
    const r = validateExpertManifest([
      { id: 'a', name: 'A', description: 'd', category: 'c', capabilities: ['x'], routingKeywords: ['q'] },
      { id: 'a', name: 'A2', description: 'd', category: 'c', capabilities: ['x'], routingKeywords: ['q'] },
    ]);
    expect(r.valid).toBe(false);
    expect(r.problems.join(' ')).toContain('id 重复');
  });

  test('缺字段 / collab 孤儿引用 → 点名', () => {
    const r = validateExpertManifest([
      { id: 'a', name: 'A', description: '', category: 'c', capabilities: ['x'], routingKeywords: ['q'], collaborationChain: ['ghost'] },
    ]);
    expect(r.valid).toBe(false);
    expect(r.problems.join(' ')).toContain('缺失必填字段: description');
    expect(r.problems.join(' ')).toContain('引用不存在: ghost');
  });
});
