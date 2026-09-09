/**
 * Bug A 回归测试: /health services.ai.configured 必须以 .api_keys.json(加密存储)
 * 为单一事实源——8-31 密钥剥离后 config.json 不再携带 provider key, 任何只读
 * config.json 原文件的判定恒为 false(界面「AI 模型 未配置」). 回归基线:
 *   bug:      raw config.json 判定 → configured false
 *   fixed:    loadConfig() 合并加密存储 → configured true
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function makeFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'health-ai-kb-'));
  const apiKeys = require('../core/secure-storage').encryptApiKey('sk-test-key-1234567890');
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
    models: {
      currentProvider: 'deepseek',
      providers: { deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' } }
    }
  }, null, 2));
  fs.writeFileSync(path.join(tmp, '.api_keys.json'), JSON.stringify({ deepseek: apiKeys }));
  return tmp;
}

test('health ai.configured: 加密存储有 key 时须为 true (仅 config.json 无 key)', () => {
  const tmp = makeFixture();
  const oldEnv = process.env.CRABPAW_DATA_DIR;
  process.env.CRABPAW_DATA_DIR = tmp;
  try {
    let captured = null;
    let handleHealth = null;
    jest.isolateModules(() => {
      const core = require('../handlers/local-handlers/core.js');
      handleHealth = core.handleHealth;
    });
    const req = { method: 'GET', url: '/health' };
    const res = {
      writeHead(code, headers) { this.status = code; this.headers = headers; },
      end(body) { captured = JSON.parse(body); },
    };
    return Promise.resolve(handleHealth(req, res, {})).then(() => {
      expect(captured).not.toBeNull();
      expect(captured.services.ai.configured).toBe(true);
    });
  } finally {
    if (oldEnv === undefined) delete process.env.CRABPAW_DATA_DIR;
    else process.env.CRABPAW_DATA_DIR = oldEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
