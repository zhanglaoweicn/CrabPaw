/**
 * DSML 解析器回归测试（2026-09-24）
 *
 * 实机 bug：用户"关闭台风卡"时模型输出 `<｜｜DSML｜｜ invoke name="ShowTyphoon">`
 * （｜｜ 与 invoke 之间带空格 + 空参数），旧解析器两个缺陷叠加导致调用蒸发：
 *   ① 正则不容空白 → 整个 invoke 匹配不到；
 *   ② 空参数调用被 `params.length > 0` 守卫静默丢弃。
 * 回合以 0 次工具调用结束，卡片纹丝不动。
 */

const {
  parseDSMLToolCalls,
  stripDSMLTags,
  getMissingRequiredParams,
} = require('../core/ai/dsml');

// 实机原始样本（09:34:03 日志原文）
const LIVE_EMPTY_INVOKE = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="ShowTyphoon">\n\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';

describe('DSML 解析器', () => {
  describe('parseDSMLToolCalls', () => {
    test('实机回归: 带空格 + 空参数的调用不再蒸发', () => {
      const calls = parseDSMLToolCalls(LIVE_EMPTY_INVOKE);
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe('ShowTyphoon');
      expect(calls[0].params).toEqual({});
    });

    test('经典无空格形态向后兼容', () => {
      const text = '<｜｜DSML｜｜invoke name="Bash"><｜｜DSML｜｜parameter name="command" string="true">ls</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke>';
      const calls = parseDSMLToolCalls(text);
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe('Bash');
      expect(calls[0].params.command).toBe('ls');
    });

    test('半角竖线兼容', () => {
      const text = '<||DSML||invoke name="Bash"><||DSML||parameter name="command" string="true">dir</||DSML||parameter></||DSML||invoke>';
      const calls = parseDSMLToolCalls(text);
      expect(calls).toHaveLength(1);
      expect(calls[0].params.command).toBe('dir');
    });

    test('无 DSML 的普通文本 → 空数组', () => {
      expect(parseDSMLToolCalls('今天天气不错')).toEqual([]);
    });
  });

  describe('getMissingRequiredParams', () => {
    test('ShowTyphoon 空参数 → 判定不完整并提示 action（防默认 show 逆用户意图）', () => {
      const missing = getMissingRequiredParams('ShowTyphoon', {});
      expect(missing).toHaveLength(1);
      expect(missing[0]).toContain('action');
    });

    test('ShowTyphoon 带action → 完整', () => {
      expect(getMissingRequiredParams('ShowTyphoon', { action: 'hide' })).toEqual([]);
    });

    test('Bash 缺 command（required）→ 报缺', () => {
      const missing = getMissingRequiredParams('Bash', {});
      expect(missing).toEqual(['command']);
    });

    test('契约外的未知工具 → 不拦（交执行层契约钩子兜底）', () => {
      expect(getMissingRequiredParams('NoSuchTool', {})).toEqual([]);
    });
  });

  describe('stripDSMLTags', () => {
    test('带空格的标签也被清理（用户不看原始标签）', () => {
      const cleaned = stripDSMLTags(LIVE_EMPTY_INVOKE);
      expect(cleaned).not.toContain('DSML');
      expect(cleaned).not.toContain('ShowTyphoon');
    });
  });
});
