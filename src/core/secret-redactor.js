

const REDACT_ENABLED = (process.env.CRABPAW_REDACT_SECRETS || 'true').toLowerCase() in { '1': true, 'true': true, 'yes': true, 'on': true };

const SENSITIVE_QUERY_PARAMS = new Set([
  'access_token', 'refresh_token', 'id_token', 'token',
  'api_key', 'apikey', 'client_secret', 'password',
  'auth', 'jwt', 'session', 'secret', 'key',
  'code', 'signature', 'x-amz-signature',
]);

const SENSITIVE_BODY_KEYS = new Set([
  'access_token', 'refresh_token', 'id_token', 'token',
  'api_key', 'apikey', 'client_secret', 'password',
  'auth', 'jwt', 'secret', 'private_key',
  'authorization', 'key',
]);

const PREFIX_PATTERNS = [
  /sk-[A-Za-z0-9_-]{10,}/g,
  /ghp_[A-Za-z0-9]{10,}/g,
  /github_pat_[A-Za-z0-9_]{10,}/g,
  /gho_[A-Za-z0-9]{10,}/g,
  /ghu_[A-Za-z0-9]{10,}/g,
  /ghs_[A-Za-z0-9]{10,}/g,
  /ghr_[A-Za-z0-9]{10,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AIza[A-Za-z0-9_-]{30,}/g,
  /pplx-[A-Za-z0-9]{10,}/g,
  /fal_[A-Za-z0-9_-]{10,}/g,
  /fc-[A-Za-z0-9]{10,}/g,
  /bb_live_[A-Za-z0-9_-]{10,}/g,
  /gAAAA[A-Za-z0-9_=-]{20,}/g,
  /AKIA[A-Z0-9]{16}/g,
  /sk_live_[A-Za-z0-9]{10,}/g,
  /sk_test_[A-Za-z0-9]{10,}/g,
  /rk_live_[A-Za-z0-9]{10,}/g,
  /SG\.[A-Za-z0-9_-]{10,}/g,
  /hf_[A-Za-z0-9]{10,}/g,
  /r8_[A-Za-z0-9]{10,}/g,
  /npm_[A-Za-z0-9]{10,}/g,
  /pypi-[A-Za-z0-9_-]{10,}/g,
  /dop_v1_[A-Za-z0-9]{10,}/g,
  /doo_v1_[A-Za-z0-9]{10,}/g,
  /am_[A-Za-z0-9_-]{10,}/g,
  /sk_[A-Za-z0-9_]{10,}/g,
  /tvly-[A-Za-z0-9]{10,}/g,
  /exa_[A-Za-z0-9]{10,}/g,
  /gsk_[A-Za-z0-9]{10,}/g,
  /syt_[A-Za-z0-9]{10,}/g,
  /retaindb_[A-Za-z0-9]{10,}/g,
  /hsk-[A-Za-z0-9]{10,}/g,
  /mem0_[A-Za-z0-9]{10,}/g,
  /brv_[A-Za-z0-9]{10,}/g,
  /xai-[A-Za-z0-9]{30,}/g,
];

const SECRET_ENV_NAMES = '(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)';
const ENV_ASSIGN_RE = new RegExp(
  `([A-Z0-9_]{0,50}${SECRET_ENV_NAMES}[A-Z0-9_]{0,50})\\s*=\\s*(['"]?)(\\S+)\\2`,
  'g'
);

const JSON_KEY_NAMES = '(?:api_?[Kk]ey|token|secret|password|access_token|refresh_token|auth_token|bearer|secret_value|raw_secret|secret_input|key_material)';
const JSON_FIELD_RE = new RegExp(
  `("${JSON_KEY_NAMES}")\\s*:\\s*"([^"]+)"`,
  'gi'
);

const AUTH_HEADER_RE = /Authorization:\s*Bearer\s+(\S+)/gi;

const TELEGRAM_RE = /(bot)?(\d{8,}):([-A-Za-z0-9_]{30,})/g;

const PRIVATE_KEY_RE = /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g;

const DB_CONNSTR_RE = /((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:]+:)([^@]+)(@)/gi;

const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_=-]{4,}){0,2}/g;

const DISCORD_MENTION_RE = /<@!?(\d{17,20})>/g;

const SIGNAL_PHONE_RE = /(\+[1-9]\d{6,14})(?![A-Za-z0-9])/g;

const URL_USERINFO_RE = /(https?|wss?|ftp):\/\/([^/\s:@]+):([^/\s@]+)@/gi;

function _maskToken(token) {
  if (!token || token.length < 18) return '***';
  return token.slice(0, 6) + '***' + token.slice(-4);
}

function redactText(text, options = {}) {
  if (!REDACT_ENABLED && !options.force) return text;
  if (typeof text !== 'string') return text;

  let result = text;

  result = result.replace(PRIVATE_KEY_RE, '-----REDACTED PRIVATE KEY-----');

  for (const pattern of PREFIX_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match) => _maskToken(match));
  }

  ENV_ASSIGN_RE.lastIndex = 0;
  result = result.replace(ENV_ASSIGN_RE, (match, key, quote, value) => {
    return `${key}=${quote}${_maskToken(value)}${quote}`;
  });

  JSON_FIELD_RE.lastIndex = 0;
  result = result.replace(JSON_FIELD_RE, (match, key, value) => {
    return `${key}: "${_maskToken(value)}"`;
  });

  AUTH_HEADER_RE.lastIndex = 0;
  result = result.replace(AUTH_HEADER_RE, (match, token) => {
    return `Authorization: Bearer ${_maskToken(token)}`;
  });

  DB_CONNSTR_RE.lastIndex = 0;
  result = result.replace(DB_CONNSTR_RE, (match, prefix, password, suffix) => {
    return `${prefix}***${suffix}`;
  });

  TELEGRAM_RE.lastIndex = 0;
  result = result.replace(TELEGRAM_RE, (match, bot, id, _token) => {
    return `${bot || ''}${id}:***`;
  });

  JWT_RE.lastIndex = 0;
  result = result.replace(JWT_RE, (match) => _maskToken(match));

  DISCORD_MENTION_RE.lastIndex = 0;
  result = result.replace(DISCORD_MENTION_RE, '<@!REDACTED>');

  SIGNAL_PHONE_RE.lastIndex = 0;
  result = result.replace(SIGNAL_PHONE_RE, (match) => _maskToken(match));

  URL_USERINFO_RE.lastIndex = 0;
  result = result.replace(URL_USERINFO_RE, (match, scheme, user, _password) => {
    return `${scheme}://${user}:***@`;
  });

  return result;
}

function redactUrl(url, options = {}) {
  if (!REDACT_ENABLED && !options.force) return url;
  if (typeof url !== 'string') return url;

  try {
    const parsed = new URL(url);
    const params = parsed.searchParams;

    for (const key of [...params.keys()]) {
      if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
        params.set(key, '***');
      }
    }

    return parsed.toString();
  } catch {
    return redactText(url, options);
  }
}

function redactObject(obj, options = {}) {
  if (!REDACT_ENABLED && !options.force) return obj;
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') return redactText(obj, options);
  if (typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(item => redactObject(item, options));
  }

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const keyLower = key.toLowerCase();
    if (SENSITIVE_BODY_KEYS.has(keyLower)) {
      result[key] = typeof value === 'string' ? _maskToken(value) : '***';
    } else {
      result[key] = redactObject(value, options);
    }
  }
  return result;
}

function redactToolResult(toolName, result, options = {}) {
  if (!REDACT_ENABLED && !options.force) return result;

  if (typeof result === 'string') {
    return redactText(result, options);
  }

  if (typeof result === 'object' && result !== null) {
    if (result.content && typeof result.content === 'string') {
      return { ...result, content: redactText(result.content, options) };
    }
    return redactObject(result, options);
  }

  return result;
}

function isRedactionEnabled() {
  return REDACT_ENABLED;
}

module.exports = {
  redactText,
  redactUrl,
  redactObject,
  redactToolResult,
  isRedactionEnabled,
  _maskToken,
  SENSITIVE_QUERY_PARAMS,
  SENSITIVE_BODY_KEYS,
};
