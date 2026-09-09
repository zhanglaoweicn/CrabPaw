/**
 * ASR 提供商统一入口 — 自主实现
 * 统一导出所有 ASR 提供商
 */
const { createCloudASRSession, isValidAliyunAsrKey } = require('../cloud-asr');

const PROVIDER_META = {
 aliyun: { name: '阿里云百炼', requiredCreds: ['aliyunApiKey'], langSupport: ['zh', 'en'], defaultLang: 'zh' },
 tencent: { name: '腾讯云 ASR', requiredCreds: ['tencentSecretId', 'tencentSecretKey'], langSupport: ['zh', 'en'], defaultLang: 'zh' },
 xunfei: { name: '科大讯飞 RTASR', requiredCreds: ['xunfeiAppId', 'xunfeiApiKey'], langSupport: ['zh', 'en'], defaultLang: 'zh' },
 volcengine: { name: '火山引擎豆包 ASR', requiredCreds: ['volcAsrApiKey'], langSupport: ['zh', 'en'], defaultLang: 'zh' },
};

function validateCredentials(providerName, config) {
 const meta = PROVIDER_META[providerName];
 if (!meta) return { valid: false, missing: ['unknown provider'] };
 if (providerName === 'volcengine') {
 if (config.apiKey && config.apiKey.trim()) return { valid: true, missing: [] };
 if (config.appId && config.appId.trim() && config.accessToken && config.accessToken.trim()) return { valid: true, missing: [] };
 return { valid: false, missing: ['apiKey 或 appId+accessToken'] };
 }
 const missing = meta.requiredCreds.filter(c => !config[c] || !String(config[c]).trim());
 return { valid: missing.length === 0, missing };
}

function getAvailableProviders(config) {
 const providers = (config && config.models && config.models.providers) || {};
 return Object.entries(PROVIDER_META).map(([id, meta]) => {
 const pConfig = providers[id] || {};
 return { id, name: meta.name, available: meta.requiredCreds.every(c => pConfig[c] && !String(pConfig[c]).includes('***')), langs: meta.langSupport, defaultLang: meta.defaultLang };
 });
}

module.exports = { createCloudASRSession, getAvailableProviders, validateCredentials, PROVIDER_META, isValidAliyunAsrKey };
