// 直接定义 DEFAULT_PORT，避免反向依赖 core/config 造成循环依赖
const DEFAULT_PORT = 38767;

const PRODUCT_NAME = 'CrabPaw';
const PRODUCT_VERSION = '1.0.0';
const PRODUCT_URL = 'https://github.com/linkclaw/crabpaw';

const PORT = process.env.PORT || DEFAULT_PORT;

const SESSION_ID_PREFIX = 'session_';

const DEFAULT_USER_AGENT = `CrabPaw/${PRODUCT_VERSION}`;

module.exports = {
  PRODUCT_NAME,
  PRODUCT_VERSION,
  PRODUCT_URL,
  PORT,
  SESSION_ID_PREFIX,
  DEFAULT_USER_AGENT
};
