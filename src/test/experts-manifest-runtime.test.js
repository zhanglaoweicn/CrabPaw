'use strict';
// B1-5: buildExpertsListWithManifestFlags 纯函数直测——validateExpertManifest(真实实现)
// 的 problems 按「专家 <id> 」前缀归属 per-expert(manifestValid/manifestIssues),
// 无前缀全局问题(缺 id 条目/id 重复)分流到顶层 expertManifestIssues。
// experts.js 模块级依赖(协作编排/http 工具)与被测函数无关, mock 掉防加载重模块。

jest.mock('../core/experts/collaboration', () => ({}));
jest.mock('../handlers/http-utils', () => ({ readJsonBody: jest.fn(), sendJson: jest.fn() }));

const { buildExpertsListWithManifestFlags } = require('../handlers/local-handlers/experts');

const fullExpert = (id, extra = {}) => ({
  id, name: `N-${id}`, description: 'd', category: 'c', capabilities: ['x'], routingKeywords: ['q'], ...extra,
});

describe('buildExpertsListWithManifestFlags — 专家清单校验接运行时', () => {
  test('全部通过 → 每项 manifestValid:true 且无全局问题', () => {
    const r = buildExpertsListWithManifestFlags([fullExpert('a'), fullExpert('b')]);
    expect(r.experts).toHaveLength(2);
    expect(r.experts.every(e => e.manifestValid === true && e.manifestIssues.length === 0)).toBe(true);
    expect(r.expertManifestIssues).toEqual([]);
  });

  test('缺失必填字段 → 前缀匹配到该专家, manifestIssues 带原文(工具提示用)', () => {
    const r = buildExpertsListWithManifestFlags([fullExpert('a', { description: '' }), fullExpert('b')]);
    expect(r.experts[0].manifestValid).toBe(false);
    expect(r.experts[0].manifestIssues.some(p => p.includes('缺失必填字段'))).toBe(true);
    expect(r.experts[1].manifestValid).toBe(true);
    expect(r.expertManifestIssues).toEqual([]);
  });

  test('collaborationChain 孤儿引用 → 归属发起专家', () => {
    const r = buildExpertsListWithManifestFlags([fullExpert('a', { collaborationChain: ['ghost'] })]);
    expect(r.experts[0].manifestValid).toBe(false);
    expect(r.experts[0].manifestIssues.some(p => p.includes('引用不存在: ghost'))).toBe(true);
  });

  test('id 前缀不串台: 「专家 ab 」问题不误伤专家 a(前缀含尾随空格)', () => {
    const r = buildExpertsListWithManifestFlags([fullExpert('a'), fullExpert('ab', { routingKeywords: [] })]);
    expect(r.experts.find(e => e.id === 'a').manifestValid).toBe(true);
    expect(r.experts.find(e => e.id === 'ab').manifestValid).toBe(false);
  });

  test('全局问题(缺 id / id 重复) → 顶层 expertManifestIssues, 不落到个体', () => {
    const r = buildExpertsListWithManifestFlags([fullExpert('a'), { name: 'no-id' }]);
    expect(r.expertManifestIssues.some(p => p.includes('缺 id'))).toBe(true);
    expect(r.experts[0].manifestValid).toBe(true);

    const r2 = buildExpertsListWithManifestFlags([fullExpert('a'), fullExpert('a')]);
    expect(r2.expertManifestIssues.some(p => p.includes('id 重复'))).toBe(true);
  });

  test('空列表 → 空专家空问题', () => {
    expect(buildExpertsListWithManifestFlags([])).toEqual({ experts: [], expertManifestIssues: [] });
  });

  test('原字段透传(不改动既有响应形状)', () => {
    const r = buildExpertsListWithManifestFlags([fullExpert('a')]);
    expect(r.experts[0].name).toBe('N-a');
    expect(r.experts[0].category).toBe('c');
  });
});
