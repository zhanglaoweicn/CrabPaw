/**
 * 契约命名规范（Task 11, 2026-08-30）
 * ---------------------------------------------------------------
 * HARNESS.md v2.4.0: 契约主名统一 PascalCase。snake_case / kebab-case
 * 旧名只允许作为登记过的别名存在（LEGACY_SNAKE_ALIASES /
 * LEGACY_KEBAB_ALIASES 指向同一契约对象，双向解析不破调用方）。
 *
 * 背景: html-presentation / presentation-builder 是仅有的两个非别名
 * kebab-case 主键（tool-contract.js:693/:699），本轮改为
 * HtmlPresentation / PresentationBuilder 主名 + kebab 别名兜底。
 *
 * Red-Green 记录:
 *   - Red: 改前跑本套件——两键违例（未登记别名的 kebab 主键）→ FAIL
 *   - Green: 主名 PascalCase 化 + LEGACY_KEBAB_ALIASES 登记后 → PASS
 */

describe('契约命名规范', () => {
  test('全部契约主键为 PascalCase 或已登记别名（snake/kebab）', () => {
    const {
      TOOL_CONTRACTS,
      LEGACY_SNAKE_ALIASES,
      LEGACY_KEBAB_ALIASES,
    } = require('../core/tool-contract');

    const aliases = new Set([
      ...Object.keys(LEGACY_SNAKE_ALIASES || {}),
      ...Object.keys(LEGACY_KEBAB_ALIASES || {}),
    ]);

    const offenders = Object.keys(TOOL_CONTRACTS).filter(
      (k) => !/^[A-Z]/.test(k) && !aliases.has(k)
    );
    expect(offenders).toEqual([]);
  });

  test('HtmlPresentation/PresentationBuilder 主名存在且 kebab 别名指向同一契约对象', () => {
    const { TOOL_CONTRACTS } = require('../core/tool-contract');

    const hp = TOOL_CONTRACTS.HtmlPresentation;
    const pb = TOOL_CONTRACTS.PresentationBuilder;
    expect(hp).toBeTruthy();
    expect(pb).toBeTruthy();

    // kebab 别名与主名必须是同一对象（别名兜底，非独立契约）
    expect(TOOL_CONTRACTS['html-presentation']).toBe(hp);
    expect(TOOL_CONTRACTS['presentation-builder']).toBe(pb);

    // 旧名调用校验链不断（registry 执行名仍为 kebab → 契约校验可命中）
    const { validateToolInput } = require('../core/tool-contract');
    expect(validateToolInput('html-presentation', { slides: [] }).valid).toBe(true);
    expect(validateToolInput('presentation-builder', { topic: 'x' }).valid).toBe(true);
  });
});
