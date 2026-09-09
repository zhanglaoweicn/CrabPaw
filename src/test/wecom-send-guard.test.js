/**
 * 发布 S-2b — wecom send 服务 chatId 授权集单测。
 * loadAllowedChatIds: user.wecomUserId + defaultChatId + defaultUserId，缺失/损坏 fail-closed。
 * isAllowedChatId: 空值拒、非 Set 拒、字符串归一化。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadAllowedChatIds, isAllowedChatId } = require('../channels/wecom/send-guard');

function makeDataDir(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-send-guard-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

describe('loadAllowedChatIds', () => {
  test('配置齐全：user.wecomUserId + defaultChatId + defaultUserId', () => {
    const dir = makeDataDir({
      'config/user.json': JSON.stringify({ wecomUserId: 'me' }),
      'config.json': JSON.stringify({ wecom: { defaultChatId: 'boss', defaultUserId: 'boss2' } }),
    });
    const set = loadAllowedChatIds(dir);
    expect(set).toEqual(new Set(['me', 'boss', 'boss2']));
  });

  test('只配置 user.wecomUserId', () => {
    const dir = makeDataDir({ 'config/user.json': JSON.stringify({ wecomUserId: 'me' }) });
    expect(loadAllowedChatIds(dir)).toEqual(new Set(['me']));
  });

  test('只配置 defaultChatId', () => {
    const dir = makeDataDir({ 'config.json': JSON.stringify({ wecom: { defaultChatId: 'boss' } }) });
    expect(loadAllowedChatIds(dir)).toEqual(new Set(['boss']));
  });

  test('无任何配置 → 空集合（fail-closed）', () => {
    const dir = makeDataDir({});
    expect(loadAllowedChatIds(dir).size).toBe(0);
  });

  test('配置损坏不抛错 → 空集合', () => {
    const dir = makeDataDir({
      'config/user.json': '{bad json',
      'config.json': 'not-json',
    });
    expect(loadAllowedChatIds(dir).size).toBe(0);
  });
});

describe('isAllowedChatId', () => {
  const allowed = new Set(['me', 'boss']);

  test('白名单内允许（含数字形态归一化）', () => {
    expect(isAllowedChatId('me', allowed)).toBe(true);
    expect(isAllowedChatId('boss', allowed)).toBe(true);
    expect(isAllowedChatId(123, new Set(['123']))).toBe(true);
  });

  test('白名单外拒绝', () => {
    expect(isAllowedChatId('evil', allowed)).toBe(false);
  });

  test('空值拒绝', () => {
    expect(isAllowedChatId('', allowed)).toBe(false);
    expect(isAllowedChatId(null, allowed)).toBe(false);
    expect(isAllowedChatId(undefined, allowed)).toBe(false);
  });

  test('集合缺失/非集合拒绝', () => {
    expect(isAllowedChatId('me', null)).toBe(false);
    expect(isAllowedChatId('me', undefined)).toBe(false);
    expect(isAllowedChatId('me', ['me'])).toBe(false);
  });
});
