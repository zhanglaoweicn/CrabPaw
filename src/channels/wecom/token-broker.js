/**
 * token-broker — 企微 access_token 单飞管理（2026-09-06）
 *
 * 此前六处（wecom-tools/approval-handler/approval-submitter/contacts-sync/
 * calendar-client/external-contact）各自为政拿 token：无 in-flight 合并
 * （并发同时刷，放大 gettoken 频率限制风险）；且 `expires_in - 300` 在
 * API 未返回 expires_in 时会算出负数 → 每次请求都刷。统一收口到这里。
 *
 * 缓存键 = corpId + kind（不同 secret 的应用各自独立：approval/contacts/...）
 */

const _tokens = new Map();   // key -> { token, expire }
const _inflight = new Map(); // key -> Promise<token>

async function getWecomToken(corpId, secret, kind = '') {
  const key = `${corpId || ''}:${kind}`;
  const entry = _tokens.get(key);
  if (entry && entry.expire > Date.now() + 300000) return entry.token;
  if (_inflight.has(key)) return _inflight.get(key);

  const p = (async () => {
    const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId || '')}&corpsecret=${encodeURIComponent(secret || '')}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.errcode !== 0) {
      let msg = `获取access_token失败: [${data.errcode}] ${data.errmsg}`;
      // 2026-09-19: 凭证类错误给出可操作指引——此前模型收到裸错误后盲目重试
      // (实测同一轮里 WeComSendText 连发 3 次全 40001, 浪费轮次且用户得不到原因)
      if (data.errcode === 40001) {
        msg += '（企业微信凭证无效——请在 管理舱→系统设置 重新录入企业微信 Secret；若近期在企微管理后台重置过应用密钥，旧 Secret 已立即失效。修复前请勿重复尝试发送）';
      } else if (data.errcode === 60020) {
        msg += '（访问 IP 不在应用可信 IP 列表——请在企微管理后台将该出口 IP 加入可信 IP）';
      }
      throw new Error(msg);
    }
    const expireSec = Math.max(Number(data.expires_in) || 7200, 600);
    _tokens.set(key, { token: data.access_token, expire: Date.now() + (expireSec - 300) * 1000 });
    return data.access_token;
  })();

  _inflight.set(key, p);
  try {
    return await p;
  } catch (e) {
    _tokens.delete(key);
    throw e;
  } finally {
    _inflight.delete(key);
  }
}

/** 测试隔离 */
function resetWecomTokens() {
  _tokens.clear();
  _inflight.clear();
}

module.exports = { getWecomToken, resetWecomTokens };
