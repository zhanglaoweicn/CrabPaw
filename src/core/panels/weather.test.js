/**
 * weather.js 测试 — cleanCityName 城市名清理（voice-interrupt-panels-analysis 问题 #3）。
 *
 * 背景："海口的天气"经预投影贪婪正则提取为"海口的"（尾部"的"被吃进城市名）
 * → wttr.in 无效城市 500 → 天气工具持续失败/熔断。getWeather 是 wttr.in 唯一入口，
 * 内部清理可覆盖 chat-handler 预投影与全部 Weather 工具调用。
 */

const { cleanCityName } = require('./weather');

describe('cleanCityName（城市名清理）', () => {
  test('去尾部"的"："海口的" → "海口"', () => {
    expect(cleanCityName('海口的')).toBe('海口');
  });

  test('去首尾与内部空白', () => {
    expect(cleanCityName(' 海口 ')).toBe('海口');
    expect(cleanCityName(' 海 口 ')).toBe('海口');
  });

  test('正常城市名保持不变', () => {
    expect(cleanCityName('北京')).toBe('北京');
    expect(cleanCityName('Shanghai')).toBe('Shanghai');
  });

  test('空值兜底北京', () => {
    expect(cleanCityName('')).toBe('北京');
    expect(cleanCityName(undefined)).toBe('北京');
    expect(cleanCityName(null)).toBe('北京');
  });

  test('末尾正常字符不受影响（"哈尔滨"不以"的"结尾）', () => {
    expect(cleanCityName('哈尔滨')).toBe('哈尔滨');
  });
});
