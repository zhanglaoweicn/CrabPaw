'use strict';

/**
 * cloak-installer — CloakBrowser 二进制获取统一入口（许可合规层）
 *
 * 为什么存在：BINARY-LICENSE.md 禁止把二进制捆绑进分发给第三方的产品，
 * 豁免模式是「声明依赖 + 终端用户直接从官方渠道下载」。客户机首次浏览器
 * 任务时按网络可达性选择渠道拉取二进制：
 *   official → github.com 直连（海外/有代理用户，包内校验和生效）
 *   mirror   → gh-proxy.com 前缀镜像（国内 GitHub 不可达场景；自定义 URL 下
 *              包内校验和被跳过——包自身行为——但二进制 Ed25519 签名仍由
 *              wrapper 强制校验，完整性不受传输渠道影响）
 *
 * 两渠道均失败时抛错，由调用方决定回退（系统浏览器）或提示稍后重试。
 * 下载缓存位置由调用方经 CLOAKBROWSER_CACHE_DIR 指定（桌面端=CrabPaw-Data，随盘）。
 */

const https = require('https');

const OFFICIAL_PREFIX = 'https://github.com/CloakHQ/cloakbrowser/releases/download';
const MIRROR_BASE = 'https://gh-proxy.com/';
const PROBE_TIMEOUT_MS = 3000;

function _probe(url) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'HEAD', timeout: PROBE_TIMEOUT_MS }, (res) => {
      res.resume();
      resolve(Boolean(res.statusCode && res.statusCode < 500));
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

/** github.com 3 秒内可达 → official（校验和完整生效）；否则 mirror（国内默认路径） */
async function _pickChannel() {
  const officialOk = await _probe('https://github.com/');
  return officialOk ? 'official' : 'mirror';
}

let _inflight = null;

/**
 * 确保 CloakBrowser 二进制就绪。返回实际使用的渠道名（'official'|'mirror'）。
 * 幂等：二进制已缓存时 ensureBinary 直接返回；并发调用共享同一次下载。
 */
function ensureCloakBinary(cb) {
  if (_inflight) return _inflight;
  _inflight = (async () => {
    const order = (await _pickChannel()) === 'official'
      ? ['official', 'mirror']
      : ['mirror', 'official'];
    let lastErr = null;
    for (const channel of order) {
      try {
        if (channel === 'mirror') {
          process.env.CLOAKBROWSER_DOWNLOAD_URL = MIRROR_BASE + OFFICIAL_PREFIX;
        } else {
          delete process.env.CLOAKBROWSER_DOWNLOAD_URL;
        }
        await cb.ensureBinary();
        return channel;
      } catch (e) {
        lastErr = e;
        console.warn(`[cloak-installer] ${channel} 渠道下载失败:`, e && e.message);
      }
    }
    delete process.env.CLOAKBROWSER_DOWNLOAD_URL;
    throw lastErr || new Error('CloakBrowser 二进制下载失败（官方与镜像渠道均不可用）');
  })();
  _inflight.finally(() => { _inflight = null; });
  return _inflight;
}

module.exports = { ensureCloakBinary };
