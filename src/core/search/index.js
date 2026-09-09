/**
 * 搜索模块入口
 */

const { SearchBackend, BaiduBackend, BaiduApiBackend, DuckDuckGoBackend, BingBackend, BingApiBackend, TavilyBackend, ExaBackend, BraveBackend, SearXNGBackend, SearXNGPublicBackend, PlaywrightBackend, SearchBackendManager } = require('./search-backend-manager');
const { ContentExtractor, NOISE_SELECTORS, CONTENT_SELECTORS } = require('./content-extractor');
const { searchViaJina } = require('./jina-search');
const { searchViaBing } = require('./bing-html-search');
const { searchViaDDG } = require('./ddg-search');
const { searchCacheGet, searchCacheSet, searchCacheClear, searchCacheStats } = require('./search-cache');
const { normalizeResults, buildSearchPayload, hasCJK, htmlToText, decodeHtmlEntities, unwrapBingUrl, unwrapDuckDuckGoUrl } = require('./search-utils');

module.exports = {
  // 后端类
  SearchBackend,
  DuckDuckGoBackend,
  BaiduBackend,
  BaiduApiBackend,
  BingBackend,
  SearXNGPublicBackend,
  TavilyBackend,
  ExaBackend,
  BraveBackend,
  SearXNGBackend,
  BingApiBackend,
  PlaywrightBackend,
  // 管理器
  SearchBackendManager,
  // 免费搜索引擎函数
  searchViaJina,
  searchViaBing,
  searchViaDDG,
  // 缓存
  searchCacheGet,
  searchCacheSet,
  searchCacheClear,
  searchCacheStats,
  // 工具函数
  normalizeResults,
  buildSearchPayload,
  hasCJK,
  htmlToText,
  decodeHtmlEntities,
  unwrapBingUrl,
  unwrapDuckDuckGoUrl,
  // 正文提取
  ContentExtractor,
  NOISE_SELECTORS,
  CONTENT_SELECTORS,
};
