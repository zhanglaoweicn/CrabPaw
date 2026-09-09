/**
 * 回归测试: loadConfig 必须读回 config.json 的 lark 节（appId）并从
 * .api_keys.json 补 appSecret。此前合并白名单漏 lark——saveConfig 写入的
 * lark.appId 永远读不回，且 appSecret 覆盖分支被 `if (merged.lark?.appSecret)`
 * 门死（默认空串恒 falsy），LarkAPIClient.isConfigured 恒 false。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function makeFixture({ appId, secretInKeys }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-config-'));
  const configJson = {};
  if (appId) configJson.lark = { appId, appSecret: '' };
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(configJson, null, 2));
  const keys = {};
  if (secretInKeys) keys.lark_appSecret = secretInKeys;
  fs.writeFileSync(path.join(tmp, '.api_keys.json'), JSON.stringify(keys, null, 2));
  return tmp;
}

function loadFreshConfig(tmp) {
  const oldEnv = process.env.CRABPAW_DATA_DIR;
  process.env.CRABPAW_DATA_DIR = tmp;
  try {
    let cfg = null;
    jest.isolateModules(() => { cfg = require('../core/config'); });
    return cfg.loadConfig();
  } finally {
    if (oldEnv === undefined) delete process.env.CRABPAW_DATA_DIR;
    else process.env.CRABPAW_DATA_DIR = oldEnv;
  }
}

test('loadConfig: config.json 的 lark.appId 必须被读回', () => {
  const tmp = makeFixture({ appId: 'cli_real_app_id' });
  try {
    const merged = loadFreshConfig(tmp);
    expect(merged.lark.appId).toBe('cli_real_app_id');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadConfig: appSecret 从 .api_keys.json 补齐（config.json 为空也生效）', () => {
  const tmp = makeFixture({ appId: 'cli_real_app_id', secretInKeys: 'plain-secret-123' });
  try {
    const merged = loadFreshConfig(tmp);
    expect(merged.lark.appId).toBe('cli_real_app_id');
    expect(merged.lark.appSecret).toBe('plain-secret-123');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadConfig: config.json 与密钥库均无 lark 时不炸、字段为空', () => {
  const tmp = makeFixture({});
  try {
    const merged = loadFreshConfig(tmp);
    expect(merged.lark).toBeDefined();
    expect(merged.lark.appId).toBe('');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── wecom 同款回归（2026-09-06 修复：loaded.wecom 从不合并 + secret 空串门死）──

function makeWecomFixture({ config, secretInKeys }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-config-'));
  const configJson = {};
  if (config) configJson.wecom = config;
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(configJson, null, 2));
  const keys = {};
  if (secretInKeys) keys.wecom_secret = secretInKeys;
  fs.writeFileSync(path.join(tmp, '.api_keys.json'), JSON.stringify(keys, null, 2));
  return tmp;
}

test('loadConfig: config.json 的 wecom.corpId/agentId/botUserId 必须被读回', () => {
  const tmp = makeWecomFixture({ config: { corpId: 'ww_demo_corp', agentId: 1000002, botUserId: 'bot_u1' } });
  try {
    const merged = loadFreshConfig(tmp);
    expect(merged.wecom.corpId).toBe('ww_demo_corp');
    expect(String(merged.wecom.agentId)).toBe('1000002');
    expect(merged.wecom.botUserId).toBe('bot_u1');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadConfig: wecom.secret 从 .api_keys.json 补齐（config.json 为空也生效）', () => {
  const tmp = makeWecomFixture({ config: { corpId: 'ww_demo_corp' }, secretInKeys: 'wecom-secret-plain' });
  try {
    const merged = loadFreshConfig(tmp);
    expect(merged.wecom.secret).toBe('wecom-secret-plain');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
