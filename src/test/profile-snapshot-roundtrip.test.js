/**
 * Profile 配置系统 3 缺陷回归测试:
 *   T1 创建自定义 Profile 时快照应为空壳 → 应携带"当前有效配置"(剥离敏感键)
 *      (缺陷1: 快照填充路径 updateProfileConfig 零调用, 创建即空壳)
 *   T2 自定义 Profile 激活时保存设置 → 应写入 Profile 快照而非主 config.json,
 *      且快照剥离 apiKey/secret(缺陷2: 保存只写主配置, 旧快照遮蔽新设置;
 *      缺陷3 关联: 主配置不再被固化写回)
 *   T3 默认 Profile(=默认)激活时保存 → 行为不变, 仍写主 config.json(回归对照)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'profile-fix-'));
}

function writeProfileDir(root, id, meta, snapshot = {}) {
  const dir = path.join(root, 'profiles', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ id, isDefault: false, ...meta }, null, 2));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(snapshot));
}

test('T1 创建 Profile 携带当前配置快照并剥离敏感键', () => {
  jest.isolateModules(() => {
    const pm = require('../core/profile-manager');
    const tmp = mkTmp();
    pm.init(tmp);
    const r = pm.createProfile('work', {
      description: '工作档',
      config: {
        models: { providers: { deepseek: { apiKey: 'sk-secret', baseUrl: 'https://api.deepseek.com/v1' } } },
        wecom: { secret: 'wecom-shimi' },
        voice: { provider: 'volcengine' },
      },
    });
    const snap = JSON.parse(fs.readFileSync(path.join(tmp, 'profiles', r.profile, 'config.json'), 'utf-8'));
    expect(snap.models.providers.deepseek.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(snap.voice.provider).toBe('volcengine');
    // 敏感键必须剥离——快照绝不能落盘明文密钥
    expect(snap.models.providers.deepseek.apiKey).toBeUndefined();
    expect(snap.wecom).toBeUndefined();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

test('T2 自定义 Profile 激活时保存 → 写快照、不碰主配置、无遮蔽', () => {
  const oldEnv = process.env.CRABPAW_DATA_DIR;
  const tmp = mkTmp();
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
    models: { currentProvider: 'deepseek', providers: { deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' } } },
    voice: {},
  }));
  fs.writeFileSync(path.join(tmp, '.api_keys.json'), JSON.stringify({}));
  writeProfileDir(tmp, 'work_abcd12', { name: 'work' });
  fs.writeFileSync(path.join(tmp, 'profiles', '.active_profile'), JSON.stringify({ id: 'work_abcd12' }));
  process.env.CRABPAW_DATA_DIR = tmp;
  try {
    jest.isolateModules(() => {
      const pm = require('../core/profile-manager');
      // 真实启动时序: 首次 init 会补建默认档(并设标记=default), 之后用户
      // 建自定义档并切换到它——默认档已存在, 此后 init 不再改写标记。
      pm.init(tmp);
      writeProfileDir(tmp, 'work_abcd12', { name: 'work' });
      fs.writeFileSync(path.join(tmp, 'profiles', '.active_profile'), JSON.stringify({ id: 'work_abcd12' }));
      const cfg = require('../core/config');
      cfg.saveConfig({
        models: { currentProvider: 'deepseek', providers: { deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-new-123' } } },
        voice: { provider: 'volcengine' },
        wecom: { secret: 'x' },
      });
      // 1) 主 config.json 不被污染: 无 apiKey 落盘, voice 不变化
      const main = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf-8'));
      expect(main.models.providers.deepseek.apiKey).toBeUndefined();
      expect(main.voice).toEqual({});
      // 2) 快照已更新且剥敏感键
      const snap = JSON.parse(fs.readFileSync(path.join(tmp, 'profiles', 'work_abcd12', 'config.json'), 'utf-8'));
      expect(snap.models.providers.deepseek.baseUrl).toBe('https://api.deepseek.com/v1');
      expect(snap.models.providers.deepseek.apiKey).toBeUndefined();
      expect(snap.voice.provider).toBe('volcengine');
      // 3) 重载后保存值生效, 不被旧快照遮蔽
      const loaded = cfg.loadConfig();
      expect(loaded.voice.provider).toBe('volcengine');
    });
  } finally {
    if (oldEnv === undefined) delete process.env.CRABPAW_DATA_DIR;
    else process.env.CRABPAW_DATA_DIR = oldEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('T3 默认 Profile 激活时保存 → 主配置正常写盘(回归对照)', () => {
  const oldEnv = process.env.CRABPAW_DATA_DIR;
  const tmp = mkTmp();
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ voice: {} }));
  fs.writeFileSync(path.join(tmp, '.api_keys.json'), JSON.stringify({}));
  process.env.CRABPAW_DATA_DIR = tmp;
  try {
    jest.isolateModules(() => {
      const pm = require('../core/profile-manager');
      pm.init(tmp); // ensureDefaultProfile 创建默认档, 无自定义激活
      const cfg = require('../core/config');
      cfg.saveConfig({ models: { currentProvider: 'deepseek', providers: { deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-new-123' } } } });
      const main = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf-8'));
      expect(main.models.providers.deepseek.baseUrl).toBe('https://api.deepseek.com/v1');
      expect(main.models.providers.deepseek.apiKey).toBeUndefined();
    });
  } finally {
    if (oldEnv === undefined) delete process.env.CRABPAW_DATA_DIR;
    else process.env.CRABPAW_DATA_DIR = oldEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
