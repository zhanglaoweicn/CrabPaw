/* eslint-env browser */
const { EventEmitter } = require('events');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');
const { CRABPAW_HOME } = require('../path-utils');

let _playwright = null;
let _cloakbrowser = null;
let _browserAvailability = null; // 缓存检测结果

// 便携部署：优先使用 app 目录下的浏览器，而非系统 AppData
const APP_DATA_DIR = path.join(__dirname, '..', '..', '..', 'data');
const PORTABLE_BROWSERS_DIR = path.join(APP_DATA_DIR, 'playwright-browsers');
const PORTABLE_CLOAKBROWSER_DIR = path.join(APP_DATA_DIR, 'cloakbrowser');

function _setPlaywrightBrowsersPath() {
  // 优先使用 app 本地目录（便携），其次系统默认位置
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
    if (fs.existsSync(PORTABLE_BROWSERS_DIR)) {
      process.env.PLAYWRIGHT_BROWSERS_PATH = PORTABLE_BROWSERS_DIR;
    }
  }
}

function _setCloakBrowserCacheDir() {
  // 缓存三级解析(取第一个存在的):
  //   1) CrabPaw-Data/cloakbrowser —— 默认下载目标(随盘走、换机不重下)
  //   2) resources/data/cloakbrowser —— 仅 -WithCloakBinary 自用构建放置(免首启下载);
  //      对外分发含此目录违反 BINARY-LICENSE.md(捆绑需 OEM 授权)
  //   3) 都不存在 → 下载落 1)(发行包默认路径)
  // 无 CRABPAW_DATA_DIR(开发版)时退回程序树 data/cloakbrowser(开发机预下载位, 既有行为不变)
  if (process.env.CLOAKBROWSER_CACHE_DIR) return;
  if (process.env.CRABPAW_DATA_DIR) {
    const dataCache = path.join(process.env.CRABPAW_DATA_DIR, 'cloakbrowser');
    if (fs.existsSync(dataCache)) {
      process.env.CLOAKBROWSER_CACHE_DIR = dataCache;
    } else if (fs.existsSync(PORTABLE_CLOAKBROWSER_DIR)) {
      process.env.CLOAKBROWSER_CACHE_DIR = PORTABLE_CLOAKBROWSER_DIR;
    } else {
      process.env.CLOAKBROWSER_CACHE_DIR = dataCache;
    }
    return;
  }
  if (fs.existsSync(PORTABLE_CLOAKBROWSER_DIR)) {
    process.env.CLOAKBROWSER_CACHE_DIR = PORTABLE_CLOAKBROWSER_DIR;
  }
}

async function _getPlaywright() {
  if (_playwright) return _playwright;
  _setPlaywrightBrowsersPath();
  try {
    _playwright = require('playwright-core');
    return _playwright;
  } catch (e) {
    throw new Error('Playwright未安装，请运行: npm install playwright-core');
  }
}

async function _getCloakBrowser() {
  if (_cloakbrowser) return _cloakbrowser;
  _setCloakBrowserCacheDir();
  try {
    _cloakbrowser = await import('cloakbrowser');
    return _cloakbrowser;
  } catch (e) {
    return null;
  }
}

/**
 * 检测可用的浏览器（按优先级）：
 *   1. CloakBrowser 自带隐身 Chromium（全平台自动下载）
 *   2. 系统 Chrome  — 0MB，最常见
 *   3. 系统 Edge   — 0MB，Win10+ 自带
 *   4. 便携 Chromium — {APP_DATA}/playwright-browsers/
 *   5. 系统 Chromium — %LOCALAPPDATA%/ms-playwright/
 *
 * 返回 { best: 'chrome'|'edge'|'chromium_portable'|'chromium_system'|null, config }
 */
function _detectAvailableBrowsers() {
  if (_browserAvailability) return _browserAvailability;

  const result = { available: [], best: null, config: {} };

  // 1) 检测系统 Chrome
  let chromePath = null;
  try {
    if (process.platform === 'win32') {
      const regOut = execSync(
        'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe" /ve 2>nul',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
      );
      const match = regOut.match(/REG_SZ\s+(.+\.exe)/i);
      if (match) chromePath = match[1].trim();
    } else if (process.platform === 'darwin') {
      chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    } else {
      chromePath = '/usr/bin/google-chrome' ;
    }
    if (chromePath && fs.existsSync(chromePath)) {
      result.available.push('chrome');
      result.config.chrome = { channel: 'chrome', executablePath: undefined, source: 'system' };
    }
  } catch (e) { console.warn("[browser-detect] Chrome not found:", e.message); }

  // 2) 检测系统 Edge
  let edgePath = null;
  try {
    if (process.platform === 'win32') {
      const regOut = execSync(
        'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe" /ve 2>nul',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
      );
      const match = regOut.match(/REG_SZ\s+(.+\.exe)/i);
      if (match) edgePath = match[1].trim();
    }
    // Win10/11 always has edge, even without registry entry
    if (!edgePath && process.platform === 'win32') {
      const defaultEdge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
      if (fs.existsSync(defaultEdge)) edgePath = defaultEdge;
    }
    if (edgePath && fs.existsSync(edgePath)) {
      result.available.push('edge');
      result.config.edge = { channel: 'msedge', executablePath: edgePath, source: 'system' };
    }
  } catch (e) { console.warn("[browser-detect] Edge not found:", e.message); }

  // 3) 检测便携 Chromium
  if (fs.existsSync(PORTABLE_BROWSERS_DIR)) {
    try {
      const dirs = fs.readdirSync(PORTABLE_BROWSERS_DIR).filter(d => d.startsWith('chromium-'));
      if (dirs.length > 0) {
        const chromeExe = path.join(PORTABLE_BROWSERS_DIR, dirs[0], 'chrome-win64', 'chrome.exe');
        if (fs.existsSync(chromeExe)) {
          result.available.push('chromium_portable');
          result.config.chromium_portable = { executablePath: chromeExe, source: 'portable' };
        }
      }
    } catch (e) {
      /* portable chromium not found */
      console.warn('[index.js] 空 catch 补日志:', e && e.message);
    }

  }

  // 4) 检测系统 Chromium (Playwright 默认安装位置)
  try {
    const pw = require('playwright-core');
    const execPath = pw.chromium.executablePath();
    if (fs.existsSync(execPath)) {
      result.available.push('chromium_system');
      result.config.chromium_system = { executablePath: execPath, source: 'system' };
    }
  } catch (e) {
    /* system chromium not found */
    console.warn('[index.js] 空 catch 补日志:', e && e.message);
  }


  // 选定最佳
  result.best = result.available[0] || null;

  _browserAvailability = result;
  return result;
}

/** 获取最佳浏览器启动配置 */
function _getBestBrowserConfig() {
  const detected = _detectAvailableBrowsers();
  if (!detected.best) return null;
  return detected.config[detected.best];
}

/** 检查是否有任何浏览器可用 */
function isAnyBrowserAvailable() {
  const detected = _detectAvailableBrowsers();
  return detected.best !== null;
}

/** 获取浏览器可用性报告（供前端展示） */
function getBrowserAvailabilityReport() {
  const detected = _detectAvailableBrowsers();
  return {
    available: detected.available.length > 0,
    browsers: detected.available,
    best: detected.best,
    details: detected.config,
    portableDir: PORTABLE_BROWSERS_DIR,
  };
}

// ─── 隐身/反检测管理器 ──────────────────────────────────────

class StealthManager {
  constructor(config = {}) {
    this._enabled = config.enabled ?? true;
    this._userAgentRotation = config.userAgentRotation ?? true;
    this._viewportRandomization = config.viewportRandomization ?? false;
    this._webDriverRemoval = config.webDriverRemoval ?? true;
    this._pluginMasking = config.pluginMasking ?? true;
  }

  /**
   * 生成随机 User-Agent
   */
  generateUserAgent() {
    const chromeVersions = ['120.0.0.0', '121.0.0.0', '122.0.0.0', '123.0.0.0', '124.0.0.0', '125.0.0.0', '126.0.0.0', '127.0.0.0', '128.0.0.0', '129.0.0.0', '130.0.0.0', '131.0.0.0'];
    const platforms = [
      { platform: 'Windows NT 10.0; Win64; x64', weight: 5 },
      { platform: 'Windows NT 10.0; WOW64', weight: 2 },
      { platform: 'Macintosh; Intel Mac OS X 10_15_7', weight: 3 },
    ];
    const totalWeight = platforms.reduce((s, p) => s + p.weight, 0);
    let r = Math.random() * totalWeight;
    let chosen = platforms[0];
    for (const p of platforms) {
      r -= p.weight;
      if (r <= 0) { chosen = p; break; }
    }
    const version = chromeVersions[Math.floor(Math.random() * chromeVersions.length)];
    return `Mozilla/5.0 (${chosen.platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
  }

  /**
   * 生成随机视口尺寸
   */
  generateViewport() {
    const viewports = [
      { width: 1280, height: 720 }, { width: 1280, height: 800 },
      { width: 1366, height: 768 }, { width: 1440, height: 900 },
      { width: 1536, height: 864 }, { width: 1600, height: 900 },
      { width: 1920, height: 1080 },
    ];
    return viewports[Math.floor(Math.random() * viewports.length)];
  }

  /**
   * 获取隐身启动参数
   */
  getLaunchArgs() {
    if (!this._enabled) return [];
    return [
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--disable-extensions',
      '--disable-component-update',
      '--disable-default-apps',
      '--no-first-run',
      '--no-default-browser-check',
    ];
  }

  /**
   * 在页面上下文中注入反检测脚本
   * 在每个新页面/导航前调用
   */
  getInitScript() {
    if (!this._enabled) return '';
    const scripts = [];
    if (this._webDriverRemoval) {
      scripts.push(`
        // 移除 webdriver 标志
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        // 移除 Playwright/Automation 标志
        delete window.__playwright;
        delete window.__pw_manual;
        // 伪装 chrome 对象
        if (!window.chrome) {
          window.chrome = { runtime: {}, loadTimes: function(){}, csi: function(){} };
        }
        // 伪装 permissions query
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) => (
          parameters.name === 'notifications' ?
            Promise.resolve({ state: Notification.permission }) :
            originalQuery(parameters)
        );
        // 伪装 plugins
        Object.defineProperty(navigator, 'plugins', {
          get: () => [1, 2, 3, 4, 5],
        });
        // 伪装 languages
        Object.defineProperty(navigator, 'languages', {
          get: () => ['zh-CN', 'zh', 'en-US', 'en'],
        });
      `);
    }
    if (this._pluginMasking) {
      scripts.push(`
        // 伪装 navigator.connection
        if (!navigator.connection) {
          Object.defineProperty(navigator, 'connection', {
            get: () => ({ effectiveType: '4g', rtt: 50, downlink: 10, saveData: false }),
          });
        }
      `);
    }
    return scripts.join('\n');
  }

  /**
   * 为 BrowserContext 应用隐身配置
   */
  getContextOptions(baseOptions = {}) {
    if (!this._enabled) return baseOptions;
    const opts = { ...baseOptions };
    if (this._userAgentRotation) {
      opts.userAgent = this.generateUserAgent();
    }
    if (this._viewportRandomization) {
      opts.viewport = this.generateViewport();
    }
    return opts;
  }
}

// ─── 会话录制器 ──────────────────────────────────────────────

class SessionRecorder {
  constructor(config = {}) {
    this._enabled = config.enabled ?? false;
    this._outputDir = config.outputDir || path.join(CRABPAW_HOME, 'browser_recordings');
    this._maxAgeMs = config.maxAgeMs || 72 * 60 * 60 * 1000; // 72小时
    this._recordings = new Map(); // sessionKey → { startTime, frames: [] }
  }

  get enabled() { return this._enabled; }

  enable() { this._enabled = true; }
  disable() { this._enabled = false; }

  /**
   * 开始录制会话
   */
  startRecording(sessionKey) {
    if (!this._enabled) return;
    this._recordings.set(sessionKey, {
      startTime: Date.now(),
      frames: [],
    });
  }

  /**
   * 记录一帧（截图数据）
   */
  addFrame(sessionKey, screenshotData) {
    if (!this._enabled) return;
    const rec = this._recordings.get(sessionKey);
    if (!rec) return;
    rec.frames.push({
      timestamp: Date.now(),
      data: screenshotData,
    });
  }

  /**
   * 停止录制并保存
   */
  async stopRecording(sessionKey) {
    if (!this._enabled) return null;
    const rec = this._recordings.get(sessionKey);
    if (!rec || rec.frames.length === 0) {
      this._recordings.delete(sessionKey);
      return null;
    }

    fs.mkdirSync(this._outputDir, { recursive: true });
    const filename = `session-${sessionKey}-${Date.now()}.jsonl`;
    const filepath = path.join(this._outputDir, filename);

    const ws = fs.createWriteStream(filepath);
    for (const frame of rec.frames) {
      ws.write(JSON.stringify({ timestamp: frame.timestamp, dataLength: frame.data?.length || 0 }) + '\n');
    }
    ws.end();

    this._recordings.delete(sessionKey);
    return { path: filepath, frames: rec.frames.length, duration: Date.now() - rec.startTime };
  }

  /**
   * 清理过期录制文件
   */
  cleanup() {
    if (!fs.existsSync(this._outputDir)) return;
    const now = Date.now();
    try {
      for (const file of fs.readdirSync(this._outputDir)) {
        const filepath = path.join(this._outputDir, file);
        const stat = fs.statSync(filepath);
        if (now - stat.mtimeMs > this._maxAgeMs) {
          fs.unlinkSync(filepath);
        }
      }
    } catch (e) {

      // 忽略清理错误

      console.warn('[index.js] 空 catch 补日志:', e && e.message);
    }

  }
}

class BrowserProfile {
  constructor(name, config = {}) {
    this.name = name;
    this.userDataDir = config.userDataDir || path.join(os.tmpdir(), 'crabpaw-browser', name);
    this.headless = config.headless ?? false;
    this.executablePath = config.executablePath || undefined;
    this.noSandbox = config.noSandbox ?? false;
    this.extraArgs = config.extraArgs || [];
    this.viewport = config.viewport || { width: 1280, height: 720 };
    this.locale = config.locale || 'zh-CN';
    this.timezone = config.timezone || 'Asia/Shanghai';
  }
}

class BrowserSession {
  constructor(profile, browser, context, page) {
    this.profile = profile;
    this.browser = browser;
    this.context = context;
    this.page = page;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this._refMap = new Map();
    this._refCounter = 0;
    this._snapshotCache = null;
    this._snapshotCacheTime = 0;
  }

  touch() {
    this.lastActivity = Date.now();
    this._snapshotCache = null;
  }

  isIdle(idleMs = 120 * 60 * 1000) {
    return Date.now() - this.lastActivity > idleMs;
  }

  async close() {
    try {
      if (this.context) await this.context.close().catch(e => console.debug('[BrowserControl] Cleanup failed:', e?.message));
      // persistent context: browser === context，不需要再关一次
      if (this.browser && this.browser !== this.context) await this.browser.close().catch(e => console.debug('[BrowserControl] Cleanup failed:', e?.message));
    } catch (e) {
      console.warn('[BrowserSession] close error:', e.message);
    }
    this.browser = null;
    this.context = null;
    this.page = null;
  }
}

class BrowserControlManager extends EventEmitter {
  constructor(config = {}) {
    super();
    this._sessions = new Map();
    this._profiles = new Map();
    this._defaultProfileName = config.defaultProfile || 'default';
    this._actionTimeout = config.actionTimeout || 30000;
    this._maxSessions = config.maxSessions || 5;
    this._idleTimeoutMs = config.idleTimeoutMs || 120 * 60 * 1000;
    this._evaluateEnabled = config.evaluateEnabled ?? true;
    this._ssrfPolicy = config.ssrfPolicy || {};
    // 2026-09-06 安全收紧: raw CDP 不再是绕过第一方动作安全门的通道。
    // cookieAccess 默认拒绝（connect_cdp 接入外部浏览器时，Network.get*Cookies 可直接
    // 读走真实登录态）；cdpAllowedHosts 默认仅本机，远程端点必须显式白名单。
    this._rawCDPCookieAccess = config.rawCDPAllowCookies ?? false;
    this._cdpAllowedHosts = config.cdpAllowedHosts || [];
    this._cleanupInterval = null;
    this._started = false;

    this._leakWarningMs = config.leakWarningMs || 2 * 60 * 60 * 1000;
    this._leakForceCloseMs = config.leakForceCloseMs || 4 * 60 * 60 * 1000;
    this._leakCheckInterval = null;

    this._stealth = new StealthManager(config.stealth || {});
    this._recorder = new SessionRecorder(config.recorder || {});
    this._cdpConnections = new Map();

    this._registerDefaultProfiles();

    // SIGTERM 只挂一次（静态标记）——生产单例语义不变；多实例场景（测试）不再
    // 触发 MaxListenersExceededWarning (2026-09-06)
    if (process.on && !BrowserControlManager._sigtermHooked) {
      BrowserControlManager._sigtermHooked = true;
      process.on('SIGTERM', () => {
        this.shutdown().catch(e => console.debug('[BrowserControl] SIGTERM shutdown failed:', e?.message));
      });
    }

    this._leakCheckInterval = setInterval(() => {
      this._checkLeakedSessions().catch(e => console.debug('[BrowserControl] Leak check failed:', e?.message));
    }, 10 * 60 * 1000);
    if (this._leakCheckInterval.unref) this._leakCheckInterval.unref();
  }

  /**
   * 获取隐身管理器
   */
  get stealth() { return this._stealth; }

  /**
   * 获取录制器
   */
  get recorder() { return this._recorder; }

  _registerDefaultProfiles() {
    this._profiles.set('default', new BrowserProfile('default', {
      headless: false,
      viewport: { width: 1280, height: 720 },
    }));
    this._profiles.set('headless', new BrowserProfile('headless', {
      headless: true,
      viewport: { width: 1280, height: 720 },
    }));
    // 持久化Profile：登录状态保存在稳定目录，跨会话保留（桌面端=数据目录，随盘）
    const persistentDir = path.join(CRABPAW_HOME, 'browser-data');
    this._profiles.set('persistent', new BrowserProfile('persistent', {
      headless: false,
      userDataDir: persistentDir,
      viewport: { width: 1280, height: 720 },
    }));
  }

  registerProfile(name, config = {}) {
    this._profiles.set(name, new BrowserProfile(name, config));
  }

  getProfile(name) {
    return this._profiles.get(name || this._defaultProfileName);
  }

  listProfiles() {
    return Array.from(this._profiles.entries()).map(([name, profile]) => ({
      name,
      headless: profile.headless,
      userDataDir: profile.userDataDir,
      viewport: profile.viewport,
    }));
  }

  async start(profileName) {
    const profile = this.getProfile(profileName);
    if (!profile) {
      throw new Error(`浏览器Profile不存在: ${profileName || this._defaultProfileName}`);
    }

    const sessionKey = profile.name;
    const existing = this._sessions.get(sessionKey);
    if (existing && existing.browser && existing.browser.isConnected()) {
      existing.touch();
      return existing;
    }

    if (this._sessions.size >= this._maxSessions) {
      let victim = null;
      for (const session of this._sessions.values()) {
        if (session.isIdle(this._idleTimeoutMs)) {
          victim = session;
          break;
        }
      }
      if (!victim) {
        victim = this._findIdleSession();
      }
      if (victim) {
        console.warn(`[BrowserControl] 达到会话上限(${this._maxSessions})，关闭最旧会话: ${victim.profile.name}`);
        await this.stop(victim.profile.name);
      } else {
        throw new Error(`浏览器会话数已达上限(${this._maxSessions})，请先关闭其他会话`);
      }
    }

    // 尝试使用 CloakBrowser（C++ 源码级隐身 Chromium）
    const cb = await _getCloakBrowser();

    if (cb !== null) {
      // 检查 CloakBrowser 二进制是否已缓存（避免首次启动等待 10 分钟下载）
      let cbCached = false;
      try {
        const info = cb.binaryInfo();
        cbCached = info && info.installed === true;
      } catch (e) {

        // binaryInfo 不可用, 视为未缓存

        console.warn('[index.js] 空 catch 补日志:', e && e.message);
      }


      if (cbCached) {
        try {
          const launchArgs = [...this._stealth.getLaunchArgs(), ...profile.extraArgs];
          if (profile.noSandbox) {
            launchArgs.push('--no-sandbox');
          }

          const stealthOpts = this._stealth.getContextOptions({
            viewport: profile.viewport,
            locale: profile.locale,
            timezoneId: profile.timezone,
          });

          if (profile.userDataDir) {
            fs.mkdirSync(profile.userDataDir, { recursive: true });

            const context = await cb.launchPersistentContext({
              userDataDir: profile.userDataDir,
              headless: profile.headless,
              args: launchArgs,
              ...stealthOpts,
            });

            const initScript = this._stealth.getInitScript();
            if (initScript) {
              await context.addInitScript(initScript);
            }

            const page = context.pages()[0] || await context.newPage();
            page.setDefaultTimeout(this._actionTimeout);
            page.setDefaultNavigationTimeout(this._actionTimeout);

            const session = new BrowserSession(profile, context, context, page);
            this._sessions.set(sessionKey, session);
            this._recorder.startRecording(sessionKey);

            context.on('close', () => {
              this._recorder.stopRecording(sessionKey).catch(e => console.debug('[BrowserControl] Cleanup failed:', e?.message));
              this._sessions.delete(sessionKey);
              this.emit('session-closed', { profileName: sessionKey });
            });

            this.emit('session-started', { profileName: sessionKey });
            return session;
          }

          const browser = await cb.launch({
            headless: profile.headless,
            args: launchArgs,
          });

          const context = await browser.newContext(stealthOpts);

          const initScript = this._stealth.getInitScript();
          if (initScript) {
            await context.addInitScript(initScript);
          }

          const page = await context.newPage();
          page.setDefaultTimeout(this._actionTimeout);
          page.setDefaultNavigationTimeout(this._actionTimeout);

          const session = new BrowserSession(profile, browser, context, page);
          this._sessions.set(sessionKey, session);
          this._recorder.startRecording(sessionKey);

          browser.on('disconnected', () => {
            this._recorder.stopRecording(sessionKey).catch(e => console.debug('[BrowserControl] Cleanup failed:', e?.message));
            this._sessions.delete(sessionKey);
            this.emit('session-closed', { profileName: sessionKey });
          });

          this.emit('session-started', { profileName: sessionKey });
          return session;
        } catch (cbErr) {
          console.warn(`[BrowserControl] CloakBrowser 启动失败 (${cbErr.message}), 回退到 Playwright`);
        }
      } else {
        // 2026-09-08 许可合规: BINARY-LICENSE.md 禁止再分发, 发行 zip 不捆绑二进制——
        // 首次浏览器任务后台从官方渠道/国内镜像预下载(约500MB,一次), 完成前回退系统 Chrome/Edge
        console.log('[BrowserControl] CloakBrowser 二进制未缓存——后台预下载(约500MB,一次), 本次任务回退系统 Chrome/Edge');
        const { ensureCloakBinary } = require('./cloak-installer');
        ensureCloakBinary(cb).then((channel) => {
          console.log(`[BrowserControl] CloakBrowser 二进制就绪(渠道: ${channel}), 后续会话启用隐身模式`);
        }).catch(e => console.warn('[BrowserControl] CloakBrowser 后台下载失败(本次任务不受影响, 下次会话重试):', e?.message));
      }
    }

    // 回退：使用原生 Playwright（无 CloakBrowser、未缓存或启动失败时）
    const pw = await _getPlaywright();

    // 便携部署：自动检测最佳可用浏览器
    const bestBrowser = _getBestBrowserConfig();
    if (!bestBrowser && !profile.executablePath) {
      const report = getBrowserAvailabilityReport();
      throw new Error(
        `没有可用的浏览器。请安装以下任一浏览器：\n` +
        `1. 安装 CloakBrowser: npm install cloakbrowser\n` +
        `2. 或安装 Chrome 浏览器（推荐，0MB额外下载）\n` +
        `3. 或运行: npx playwright-core install chromium（下载到便携目录 ${PORTABLE_BROWSERS_DIR}）\n` +
        `当前检测结果: ${JSON.stringify(report)}`
      );
    }

    const browserChannel = profile.executablePath ? undefined : (bestBrowser?.channel || undefined);
    const browserExecPath = profile.executablePath || (bestBrowser?.executablePath || undefined);

    const launchArgs = [...this._stealth.getLaunchArgs(), ...profile.extraArgs];
    if (profile.noSandbox) {
      launchArgs.push('--no-sandbox');
    }

    const stealthOpts = this._stealth.getContextOptions({
      viewport: profile.viewport,
      locale: profile.locale,
      timezoneId: profile.timezone,
    });

    if (profile.userDataDir) {
      fs.mkdirSync(profile.userDataDir, { recursive: true });

      const launchOpts = {
        headless: profile.headless,
        executablePath: browserExecPath,
        channel: browserChannel,
        args: launchArgs,
        ...stealthOpts,
      };
      if (!launchOpts.executablePath) delete launchOpts.executablePath;
      if (!launchOpts.channel) delete launchOpts.channel;

      const context = await pw.chromium.launchPersistentContext(profile.userDataDir, launchOpts);

      const initScript = this._stealth.getInitScript();
      if (initScript) {
        await context.addInitScript(initScript);
      }

      const page = context.pages()[0] || await context.newPage();
      page.setDefaultTimeout(this._actionTimeout);
      page.setDefaultNavigationTimeout(this._actionTimeout);

      const session = new BrowserSession(profile, context, context, page);
      this._sessions.set(sessionKey, session);
      this._recorder.startRecording(sessionKey);

      context.on('close', () => {
        this._recorder.stopRecording(sessionKey).catch(e => console.debug('[BrowserControl] Cleanup failed:', e?.message));
        this._sessions.delete(sessionKey);
        this.emit('session-closed', { profileName: sessionKey });
      });

      this.emit('session-started', { profileName: sessionKey });
      return session;
    }

    const launchOpts = {
      headless: profile.headless,
      executablePath: browserExecPath,
      channel: browserChannel,
      args: launchArgs,
    };
    if (!launchOpts.executablePath) delete launchOpts.executablePath;
    if (!launchOpts.channel) delete launchOpts.channel;

    const browser = await pw.chromium.launch(launchOpts);

    const context = await browser.newContext(stealthOpts);

    // 注入反检测脚本
    const initScript = this._stealth.getInitScript();
    if (initScript) {
      await context.addInitScript(initScript);
    }

    const page = await context.newPage();
    page.setDefaultTimeout(this._actionTimeout);
    page.setDefaultNavigationTimeout(this._actionTimeout);

    const session = new BrowserSession(profile, browser, context, page);
    this._sessions.set(sessionKey, session);

    // 开始录制
    this._recorder.startRecording(sessionKey);

    browser.on('disconnected', () => {
      this._recorder.stopRecording(sessionKey).catch(e => console.debug('[BrowserControl] Cleanup failed:', e?.message));
      this._sessions.delete(sessionKey);
      this.emit('session-closed', { profileName: sessionKey });
    });

    this.emit('session-started', { profileName: sessionKey });
    return session;
  }

  async stop(profileName) {
    const sessionKey = profileName || this._defaultProfileName;
    const session = this._sessions.get(sessionKey);
    if (session) {
      await session.close();
      this._sessions.delete(sessionKey);
      this.emit('session-stopped', { profileName: sessionKey });
    }
  }

  async getSession(profileName) {
    const sessionKey = profileName || this._defaultProfileName;
    const session = this._sessions.get(sessionKey);
    if (!session) return null;
    // persistent context: browser === context，检查 context 是否还有页面
    if (session.profile.userDataDir) {
      if (session.context && session.context.pages && session.context.pages().length > 0) {
        return session;
      }
      this._sessions.delete(sessionKey);
      return null;
    }
    if (!session.browser || !session.browser.isConnected()) {
      this._sessions.delete(sessionKey);
      return null;
    }
    return session;
  }

  async getOrStartSession(profileName) {
    // 首次创建会话时自动启动清理定时器
    if (!this._cleanupInterval) {
      this.startCleanup();
    }
    const session = await this.getSession(profileName);
    if (session) return session;
    return this.start(profileName);
  }

  _findIdleSession() {
    let oldest = null;
    for (const session of this._sessions.values()) {
      if (!oldest || session.lastActivity < oldest.lastActivity) {
        oldest = session;
      }
    }
    return oldest;
  }

  async _checkLeakedSessions() {
    const now = Date.now();
    const leaked = [];
    const forceClose = [];

    for (const [key, session] of this._sessions.entries()) {
      const age = now - session.createdAt;
      if (age > this._leakForceCloseMs) {
        forceClose.push({ key, age, session });
      } else if (age > this._leakWarningMs) {
        leaked.push({ key, age });
      }
    }

    for (const { key, age } of leaked) {
      console.warn(`[BrowserControl] 会话泄漏警告: ${key} 已打开 ${Math.round(age / 3600000)}小时`);
    }

    for (const { key, session } of forceClose) {
      console.warn(`[BrowserControl] 强制关闭泄漏会话: ${key}`);
      await session.close().catch(e => console.debug('[BrowserControl] Cleanup failed:', e?.message));
      this._sessions.delete(key);
    }

    if (forceClose.length > 0) {
      this.emit('session-leak-force-closed', { count: forceClose.length });
    }
  }

  getSessionHealth() {
    const now = Date.now();
    const sessions = [];
    let totalAge = 0;
    let maxAge = 0;
    let leakedCount = 0;

    for (const [key, session] of this._sessions.entries()) {
      const age = now - session.createdAt;
      const idleTime = now - session.lastActivity;
      totalAge += age;
      if (age > maxAge) maxAge = age;
      if (age > this._leakWarningMs) leakedCount++;

      sessions.push({
        key,
        ageMs: age,
        ageHours: Math.round(age / 3600000 * 100) / 100,
        idleMs: idleTime,
        idleMinutes: Math.round(idleTime / 60000),
        isIdle: session.isIdle(this._idleTimeoutMs),
        hasContext: !!session.context,
        hasBrowser: !!session.browser,
        isCDP: !!session._isCDP,
      });
    }

    const count = this._sessions.size;

    return {
      totalSessions: count,
      maxSessions: this._maxSessions,
      usagePercent: Math.round((count / this._maxSessions) * 100),
      leakedCount,
      leakWarningThresholdMs: this._leakWarningMs,
      leakForceCloseThresholdMs: this._leakForceCloseMs,
      avgAgeMs: count > 0 ? Math.round(totalAge / count) : 0,
      maxAgeMs: maxAge,
      sessions,
      memoryUsage: typeof process.memoryUsage === 'function' ? process.memoryUsage() : null,
      uptime: process.uptime ? process.uptime() : null,
    };
  }

  async status(profileName) {
    const session = await this.getSession(profileName);
    if (!session) {
      return { running: false, profile: profileName || this._defaultProfileName };
    }
    const page = session.page;
    return {
      running: true,
      profile: session.profile.name,
      url: page.url(),
      title: await page.title().catch(() => ''),
      viewport: session.profile.viewport,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
      _hint: page.url() === 'about:blank'
        ? '浏览器已启动，当前在空白页。下一步：请执行 navigate 导航到目标URL，然后 snapshot 获取页面内容。'
        : '浏览器正在运行。下一步：请执行 snapshot 获取页面内容，然后继续操作。',
    };
  }

  async navigate(url, profileName) {
    this._validateUrl(url);
    const session = await this.getOrStartSession(profileName);
    session.touch();
    await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this._actionTimeout });
    // 对SPA页面额外等待网络空闲，确保JS渲染完成
    try {
      await session.page.waitForLoadState('networkidle', { timeout: 10000 });
    } catch (e) {

      // networkidle超时不影响，页面可能还在后台加载

      console.warn('[index.js] 空 catch 补日志:', e && e.message);
    }

    return {
      url: session.page.url(),
      title: await session.page.title().catch(() => ''),
      _hint: '页面已加载。下一步：请执行 snapshot 获取页面快照，找到需要操作的元素ref，然后继续操作（如 fill/click/type 等）。不要在这里停下来，用户需要你完成整个任务！',
    };
  }

  // ─── CDP 连接模式 ──────────────────────────────────────────

  /**
   * 通过 CDP 连接到用户本地 Chrome 实例
   * @param {string} wsEndpoint - WebSocket 端点，如 ws://localhost:9222
   * @param {Object} options
   * @param {string} [options.profileName] - 会话名称，默认 'cdp'
   * @returns {Object} 连接结果
   */
  async connectCDP(wsEndpoint, options = {}) {
    const profileName = options.profileName || 'cdp';

    // 如果已有 CDP 连接，先断开
    const existing = this._sessions.get(profileName);
    if (existing) {
      await existing.close().catch(e => console.debug('[BrowserControl] Cleanup failed:', e?.message));
      this._sessions.delete(profileName);
    }

    // 默认端点
    if (!wsEndpoint) {
      wsEndpoint = 'ws://localhost:9222';
    }

    // 规范化端点格式
    if (!wsEndpoint.startsWith('ws://') && !wsEndpoint.startsWith('wss://')) {
      wsEndpoint = `ws://${wsEndpoint}`;
    }

    // 2026-09-06 安全收紧: 在加载 Playwright/任何连接/自动拉起浏览器动作之前
    // 先做主机边界校验，拒绝时不产生任何加载与连接副作用
    this._cdpHostAllowed(wsEndpoint);

    const pw = await _getPlaywright();

    try {
      // 尝试通过 CDP 连接
      const browser = await pw.chromium.connectOverCDP(wsEndpoint, {
        timeout: 10000,
      });

      // 获取已有上下文和页面
      const contexts = browser.contexts();
      let context, page;

      if (contexts.length > 0) {
        context = contexts[0];
        const pages = context.pages();
        if (pages.length > 0) {
          page = pages[0];
        } else {
          page = await context.newPage();
        }
      } else {
        context = await browser.newContext();
        page = await context.newPage();
      }

      page.setDefaultTimeout(this._actionTimeout);
      page.setDefaultNavigationTimeout(this._actionTimeout);

      // 创建 CDP 专用 profile
      const cdpProfile = new BrowserProfile(profileName, {
        headless: false, // CDP 连接的是有头浏览器
        viewport: page.viewportSize() || { width: 1280, height: 720 },
      });

      const session = new BrowserSession(cdpProfile, browser, context, page);
      session._isCDP = true;
      session._wsEndpoint = wsEndpoint;
      this._sessions.set(profileName, session);

      // 记录 CDP 连接状态
      this._cdpConnections.set(profileName, {
        wsEndpoint,
        connected: true,
        connectedAt: Date.now(),
      });

      // 开始录制
      this._recorder.startRecording(profileName);

      browser.on('disconnected', () => {
        this._recorder.stopRecording(profileName).catch(e => console.debug('[BrowserControl] Cleanup failed:', e?.message));
        this._sessions.delete(profileName);
        this._cdpConnections.delete(profileName);
        this.emit('session-closed', { profileName });
        this.emit('cdp-disconnected', { profileName, wsEndpoint });
      });

      this.emit('session-started', { profileName });
      this.emit('cdp-connected', { profileName, wsEndpoint });

      return {
        action: 'connectCDP',
        connected: true,
        wsEndpoint,
        profile: profileName,
        url: page.url(),
        title: await page.title().catch(() => ''),
        _hint: '已通过CDP连接到本地Chrome。你可以看到Agent的实时操作。下一步：执行 snapshot 获取页面内容，或 navigate 到目标URL。',
      };
    } catch (e) {
      // 连接失败，尝试自动启动 Chrome
      if (e.message.includes('ECONNREFUSED') || e.message.includes('connect') || e.message.includes('timeout')) {
        const launched = await this._tryLaunchChromeWithCDP(wsEndpoint, profileName);
        if (launched) return launched;
      }
      throw new Error(`CDP连接失败: ${e.message}。请确保Chrome已启动并开启远程调试: chrome --remote-debugging-port=9222`);
    }
  }

  /**
   * 尝试自动启动 Chrome 并开启 CDP
   */
  async _tryLaunchChromeWithCDP(wsEndpoint, profileName) {
    const { exec } = require('child_process');
    const http = require('http');

    // 从 wsEndpoint 提取端口
    const portMatch = wsEndpoint.match(/:(\d+)/);
    const port = portMatch ? parseInt(portMatch[1]) : 9222;

    // 尝试查找 Chrome 可执行文件
    const chromePaths = [];
    if (process.platform === 'win32') {
      const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
      const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
      const localAppData = process.env['LOCALAPPDATA'] || '';
      chromePaths.push(
        path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      );
    } else if (process.platform === 'darwin') {
      chromePaths.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    } else {
      chromePaths.push('google-chrome', 'google-chrome-stable', 'chromium-browser');
    }

    let chromePath = null;
    for (const p of chromePaths) {
      try {
        if (fs.existsSync(p)) { chromePath = p; break; }
      } catch (e) {
        /* ignore */
        console.warn('[index.js] 空 catch 补日志:', e && e.message);
      }

    }

    if (!chromePath) return null;

    // 启动 Chrome
    try {
      const child = exec(`"${chromePath}" --remote-debugging-port=${port} --no-first-run`, {
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
      });
      child.unref();
    } catch (e) {
      return null;
    }

    // 等待 Chrome 启动并尝试连接
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        // 检查 CDP 端点是否可用
        const info = await new Promise((resolve, reject) => {
          http.get(`http://localhost:${port}/json/version`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
          }).on('error', reject);
        });

        if (info.webSocketDebuggerUrl) {
          return this.connectCDP(info.webSocketDebuggerUrl, { profileName });
        }
      } catch (e) {

        // 继续等待

        console.warn('[index.js] 空 catch 补日志:', e && e.message);
      }

    }

    return null;
  }

  /**
   * 断开 CDP 连接
   */
  async disconnectCDP(profileName) {
        const sessionKey = profileName || 'cdp';
        const session = this._sessions.get(sessionKey);
        if (session && session._isCDP) {
        // CDP 连接模式下，断开但不关闭浏览器
        const browser = session.browser;
        if (browser) {
        try {
        browser.disconnect(); // 仅断开连接，不关闭浏览器
        } catch (e) {
          // 忽略
          console.warn('[index.js] 空 catch 补日志:', e && e.message);
        }
        }
        this._recorder.stopRecording(sessionKey).catch(e => console.debug('[BrowserControl] Cleanup failed:', e?.message));
        this._sessions.delete(sessionKey);
        this._cdpConnections.delete(sessionKey);
        this.emit('cdp-disconnected', { profileName: sessionKey });
        this.emit('session-closed', { profileName: sessionKey });
        return { action: 'disconnectCDP', profile: sessionKey, disconnected: true };
      }
    return { action: 'disconnectCDP', profile: sessionKey, disconnected: false, error: '无CDP连接' };
  }

  /**
   * 获取 CDP 连接状态
   */
  cdpStatus(profileName) {
    const sessionKey = profileName || 'cdp';
    const cdp = this._cdpConnections.get(sessionKey);
    const session = this._sessions.get(sessionKey);
    return {
      connected: !!cdp?.connected && !!session?.browser?.isConnected(),
      wsEndpoint: cdp?.wsEndpoint || null,
      connectedAt: cdp?.connectedAt || null,
      profile: sessionKey,
    };
  }

  // ─── 视觉分析 ──────────────────────────────────────────────

  /**
   * 截图 + AI 视觉分析
   * @param {string} profileName - Profile 名称
   * @param {Object} options
   * @param {string} [options.prompt] - 分析提示，如"描述图表内容"或"这个验证码是什么"
   * @param {boolean} [options.fullPage] - 是否全页截图
   * @param {string} [options.selector] - 元素选择器
   * @param {Function} [options.analyzeFn] - 外部AI分析函数 (base64Image, prompt) => analysis
   * @returns {Object} 截图数据 + AI 分析结果
   */
  async vision(profileName, options = {}) {
    const session = await this.getOrStartSession(profileName);
    session.touch();
    const page = session.page;

    // 截图
    const screenshotOpts = {
      type: 'png',
      fullPage: options.fullPage || false,
    };

    let buffer;
    let screenshotTarget = 'page';
    if (options.selector) {
      const element = await page.$(options.selector);
      if (!element) throw new Error(`元素未找到: ${options.selector}`);
      buffer = await element.screenshot(screenshotOpts);
      screenshotTarget = options.selector;
    } else {
      buffer = await page.screenshot(screenshotOpts);
    }

    const base64Data = buffer.toString('base64');
    const dataUrl = `data:image/png;base64,${base64Data}`;

    // 保存截图到缓存目录
    const cacheDir = path.join(CRABPAW_HOME, 'cache', 'screenshots');
    fs.mkdirSync(cacheDir, { recursive: true });
    const screenshotPath = path.join(cacheDir, `vision-${Date.now()}.png`);
    fs.writeFileSync(screenshotPath, buffer);

    // 记录到录制器
    this._recorder.addFrame(profileName || this._defaultProfileName, dataUrl);

    const result = {
      action: 'vision',
      screenshot: {
        path: screenshotPath,
        dataUrl,
        target: screenshotTarget,
        url: page.url(),
        title: await page.title().catch(() => ''),
        fullPage: screenshotOpts.fullPage,
        size: { width: buffer.width, height: buffer.height },
        capturedAt: new Date().toISOString(),
      },
    };

    // AI 分析
    const prompt = options.prompt || '请描述这个页面的内容';

    if (options.analyzeFn && typeof options.analyzeFn === 'function') {
      // 外部分析函数
      try {
        const analysis = await options.analyzeFn(base64Data, prompt);
        result.analysis = analysis;
        result.analysisPrompt = prompt;
      } catch (e) {
        result.analysisError = e.message;
      }
    } else {
      // 自动使用 AuxiliaryClient 进行视觉分析
      try {
        const { getAuxiliaryClient } = require('../auxiliary-client');
        const auxClient = getAuxiliaryClient();
        const analysis = await auxClient.analyzeImage(base64Data, prompt, {
          maxTokens: options.maxTokens || 1000,
        });
        result.analysis = analysis.content || analysis;
        result.analysisPrompt = prompt;
        result.analysisModel = analysis.model;
        result.analysisProvider = analysis.provider;
      } catch (e) {
        result.analysisError = e.message;
        result.analysisPrompt = prompt;
        result.analysisHint = '视觉模型不可用，请在设置中配置视觉模型 API Key';
      }
    }

    return result;
  }

  async snapshot(profileName, options = {}) {
    const session = await this.getOrStartSession(profileName);
    session.touch();

    const mode = options.mode || 'aria';
    const maxChars = options.maxChars || 80000;

    if (mode === 'aria') {
      return this._ariaSnapshot(session, maxChars);
    } else if (mode === 'role') {
      return this._roleSnapshot(session, maxChars);
    } else if (mode === 'html') {
      return this._htmlSnapshot(session, maxChars);
    } else if (mode === 'text') {
      return this._textSnapshot(session, maxChars);
    }

    return this._ariaSnapshot(session, maxChars);
  }

  async _ariaSnapshot(session, maxChars) {
    const page = session.page;
    session._refMap.clear();
    session._refCounter = 0;

    let accessibility;
    try {
      accessibility = await page.accessibility.snapshot({ interestingOnly: true });
    } catch (e) {
      console.log(`[BrowserControl] aria snapshot异常: ${e.message}, 切换到text模式`);
      return this._textSnapshot(session, maxChars);
    }

    const lines = this._formatAccessibilityTree(accessibility, session, 0);

    let result = lines.join('\n');

    // 如果aria快照几乎为空（SPA/Canvas页面常见），自动fallback到text模式
    if (result.trim().length < 50) {
      console.log(`[BrowserControl] aria snapshot为空(${result.trim().length}字符)，自动切换到text模式, url=${page.url()}`);
      return this._textSnapshot(session, maxChars);
    }

    if (result.length > maxChars) {
      result = result.slice(0, maxChars) + '\n... [truncated]';
    }

    return {
      mode: 'aria',
      url: page.url(),
      title: await page.title().catch(() => ''),
      snapshot: result,
      refCount: session._refCounter,
    };
  }

  _formatAccessibilityTree(node, session, depth) {
    if (!node) return [];
    const lines = [];
    const indent = '  '.repeat(depth);

    let ref = '';
    if (node.role && node.name && !['generic', 'text'].includes(node.role)) {
      ref = `ref=${session._refCounter}`;
      session._refMap.set(String(session._refCounter), {
        role: node.role,
        name: node.name,
        _node: node,
      });
      session._refCounter++;
    }

    const parts = [];
    if (node.role) parts.push(`role=${node.role}`);
    if (node.name) parts.push(`name="${node.name}"`);
    if (node.value) parts.push(`value="${String(node.value).slice(0, 100)}"`);
    if (node.checked !== undefined) parts.push(`checked=${node.checked}`);
    if (node.disabled) parts.push('disabled');
    if (node.required) parts.push('required');
    if (node.expanded !== undefined) parts.push(`expanded=${node.expanded}`);
    if (node.level) parts.push(`level=${node.level}`);

    if (parts.length > 0) {
      const line = `${indent}[${ref}] ${parts.join(' ')}`;
      lines.push(line);
    }

    if (node.children) {
      for (const child of node.children) {
        lines.push(...this._formatAccessibilityTree(child, session, depth + 1));
      }
    }

    return lines;
  }

  async _roleSnapshot(session, maxChars) {
    return this._ariaSnapshot(session, maxChars);
  }

  async _htmlSnapshot(session, maxChars) {
    const page = session.page;
    const html = await page.evaluate(() => {
      const body = document.body;
      if (!body) return '';
      const clone = body.cloneNode(true);
      clone.querySelectorAll('script, style, noscript, svg').forEach(el => el.remove());
      return clone.innerHTML;
    });

    let result = html;
    if (result.length > maxChars) {
      result = result.slice(0, maxChars) + '\n... [truncated]';
    }

    return {
      mode: 'html',
      url: page.url(),
      title: await page.title().catch(() => ''),
      snapshot: result,
    };
  }

  /**
   * 文本快照 - 提取页面可见文本，适合SPA/Canvas渲染的页面（如抖音、小红书）
   * 优先使用 innerText（最可靠），TreeWalker 作为结构化补充
   */
  async _textSnapshot(session, maxChars) {
    const page = session.page;
    session._refMap.clear();
    session._refCounter = 0;

    // 等待页面有内容
    try {
      await page.waitForFunction(() => document.body && document.body.innerText.trim().length > 10, { timeout: 8000 });
    } catch (e) {

      // 页面可能还在加载，继续尝试提取

      console.warn('[index.js] 空 catch 补日志:', e && e.message);
    }


    const textData = await page.evaluate(() => {
      try {
      // 方法1（主）：直接用 innerText 按行提取 — 最可靠，对SPA页面效果最好
      const allText = document.body?.innerText || '';
      const lines = allText.split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0);
      const results = [];
      const seenTexts = new Set();
      for (const line of lines) {
      // 去重
      const key = line.slice(0, 80);
      if (seenTexts.has(key)) continue;
      seenTexts.add(key);
      // 截断过长行
      const text = line.length > 300 ? line.slice(0, 300) + '...' : line;
      results.push({ tag: 'text', text, isInteractive: false, href: '' });
      }
      // 方法2（补充）：收集可交互元素的额外信息
      try {
      const interactiveEls = document.querySelectorAll('a, button, [role="button"], [role="link"], input, select');
      for (const el of interactiveEls) {
      const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
      if (!text || text.length > 100) continue;
      const key = `[交互]${text.slice(0, 80)}`;
      if (seenTexts.has(key)) continue;
      seenTexts.add(key);
      results.push({
      tag: el.tagName?.toLowerCase() || 'interactive',
      text,
      isInteractive: true,
      href: el.href || '',
      });
      }
      } catch (e) {
        // 忽略
        console.warn('[index.js] 空 catch 补日志:', e && e.message);
      }
      return results;
    } catch (e) {
        return [{ tag: 'error', text: '页面文本提取失败: ' + e.message, isInteractive: false, href: '' }];
      }
    });

    // 格式化输出
    const lines = [];
    for (const item of textData) {
      const prefix = item.isInteractive ? '[可点击]' : '';
      const href = item.href ? ` href="${item.href}"` : '';
      lines.push(`${prefix}<${item.tag}>${item.text}${href}`);
    }

    let result = lines.join('\n');
    if (result.length > maxChars) {
      result = result.slice(0, maxChars) + '\n... [truncated]';
    }

    console.log(`[BrowserControl] text snapshot: ${textData.length}个元素, ${result.length}字符, url=${page.url()}`);

    return {
      mode: 'text',
      url: page.url(),
      title: await page.title().catch(() => ''),
      snapshot: result,
      itemCount: textData.length,
      _hint: '文本快照模式。此模式适合SPA/Canvas渲染页面（如抖音、小红书）。如需交互元素ref，请用aria模式。',
    };
  }

  async click(ref, profileName, options = {}) {
    const session = await this.getOrStartSession(profileName);
    session.touch();
    const page = session.page;

    if (ref !== undefined && ref !== null) {
      const refData = session._refMap.get(String(ref));
      if (!refData) {
        throw new Error(`ref=${ref} 不存在，请先执行snapshot获取最新的ref列表`);
      }
      const locator = page.locator(`[aria-label="${refData.name}"]`).first();
      try {
        await locator.click({ timeout: 5000, ...options });
      } catch (e) {
        const fallback = page.getByRole(refData.role, { name: refData.name }).first();
        await fallback.click({ timeout: 5000, ...options });
      }
      return { action: 'click', ref, role: refData.role, name: refData.name, _hint: '点击完成。下一步：请执行 snapshot 查看页面变化，然后继续操作。' };
    }

    if (options.selector) {
      await page.click(options.selector, { timeout: 5000 });
      return { action: 'click', selector: options.selector, _hint: '点击完成。下一步：请执行 snapshot 查看页面变化，然后继续操作。' };
    }

    if (options.x !== undefined && options.y !== undefined) {
      await page.mouse.click(options.x, options.y);
      return { action: 'click', x: options.x, y: options.y, _hint: '点击完成。下一步：请执行 snapshot 查看页面变化，然后继续操作。' };
    }

    throw new Error('click需要提供ref、selector或坐标(x,y)');
  }

  async type(ref, text, profileName, options = {}) {
    const session = await this.getOrStartSession(profileName);
    session.touch();
    const page = session.page;

    this._validateInputText(text);

    if (ref !== undefined && ref !== null) {
      const refData = session._refMap.get(String(ref));
      if (!refData) {
        throw new Error(`ref=${ref} 不存在，请先执行snapshot获取最新的ref列表`);
      }
      const locator = page.locator(`[aria-label="${refData.name}"]`).first();
      try {
        await locator.click({ timeout: 3000 });
      } catch (e) {
        const fallback = page.getByRole(refData.role, { name: refData.name }).first();
        await fallback.click({ timeout: 3000 });
      }
      await page.keyboard.type(text, { delay: options.delay || 30 });
      return { action: 'type', ref, role: refData.role, name: refData.name, textLength: text.length, _hint: '输入完成。下一步：请继续操作（如 press Enter 提交，或 snapshot 查看页面）。' };
    }

    if (options.selector) {
      await page.fill(options.selector, text, { timeout: 5000 });
      return { action: 'type', selector: options.selector, textLength: text.length, _hint: '输入完成。下一步：请继续操作（如 press Enter 提交，或 snapshot 查看页面）。' };
    }

    await page.keyboard.type(text, { delay: options.delay || 30 });
    return { action: 'type', textLength: text.length, _hint: '输入完成。下一步：请继续操作（如 press Enter 提交，或 snapshot 查看页面）。' };
  }

  async fill(ref, value, profileName, options = {}) {
    const session = await this.getOrStartSession(profileName);
    session.touch();
    const page = session.page;

    this._validateInputText(value);

    if (ref !== undefined && ref !== null) {
      const refData = session._refMap.get(String(ref));
      if (!refData) {
        throw new Error(`ref=${ref} 不存在，请先执行snapshot获取最新的ref列表`);
      }
      const locator = page.locator(`[aria-label="${refData.name}"]`).first();
      try {
        await locator.fill(value, { timeout: 5000 });
      } catch (e) {
        const fallback = page.getByRole(refData.role, { name: refData.name }).first();
        await fallback.fill(value, { timeout: 5000 });
      }
      return { action: 'fill', ref, role: refData.role, name: refData.name, valueLength: value.length, _hint: '填写完成。下一步：请继续操作（如 press Enter 提交搜索，或 click 搜索按钮）。' };
    }

    if (options.selector) {
      await page.fill(options.selector, value, { timeout: 5000 });
      return { action: 'fill', selector: options.selector, valueLength: value.length, _hint: '填写完成。下一步：请继续操作（如 press Enter 提交搜索，或 click 搜索按钮）。' };
    }

    throw new Error('fill需要提供ref或selector');
  }

  async select(ref, values, profileName, options = {}) {
    const session = await this.getOrStartSession(profileName);
    session.touch();
    const page = session.page;

    if (ref !== undefined && ref !== null) {
      const refData = session._refMap.get(String(ref));
      if (!refData) {
        throw new Error(`ref=${ref} 不存在，请先执行snapshot获取最新的ref列表`);
      }
      const locator = page.locator(`[aria-label="${refData.name}"]`).first();
      await locator.selectOption(values, { timeout: 5000 });
      return { action: 'select', ref, values };
    }

    if (options.selector) {
      await page.selectOption(options.selector, values, { timeout: 5000 });
      return { action: 'select', selector: options.selector, values };
    }

    throw new Error('select需要提供ref或selector');
  }

  async hover(ref, profileName, options = {}) {
    const session = await this.getOrStartSession(profileName);
    session.touch();
    const page = session.page;

    if (ref !== undefined && ref !== null) {
      const refData = session._refMap.get(String(ref));
      if (!refData) {
        throw new Error(`ref=${ref} 不存在，请先执行snapshot获取最新的ref列表`);
      }
      const locator = page.locator(`[aria-label="${refData.name}"]`).first();
      try {
        await locator.hover({ timeout: 5000 });
      } catch (e) {
        const fallback = page.getByRole(refData.role, { name: refData.name }).first();
        await fallback.hover({ timeout: 5000 });
      }
      return { action: 'hover', ref, role: refData.role, name: refData.name };
    }

    if (options.x !== undefined && options.y !== undefined) {
      await page.mouse.move(options.x, options.y);
      return { action: 'hover', x: options.x, y: options.y };
    }

    throw new Error('hover需要提供ref或坐标(x,y)');
  }

  async scroll(direction, amount, profileName) {
    const session = await this.getOrStartSession(profileName);
    session.touch();
    const page = session.page;

    const delta = direction === 'down' ? amount || 3 : -(amount || 3);
    await page.mouse.wheel(0, delta * 100);
    return { action: 'scroll', direction, amount: amount || 3 };
  }

  async press(key, profileName, options = {}) {
    const session = await this.getOrStartSession(profileName);
    session.touch();
    const page = session.page;

    this._validateKey(key);
    const modifiers = options.modifiers || [];
    for (const mod of modifiers) {
      this._validateModifier(mod);
      await page.keyboard.down(mod);
    }
    await page.keyboard.press(key);
    for (const mod of modifiers.reverse()) {
      await page.keyboard.up(mod);
    }
    return { action: 'press', key, modifiers, _hint: '按键完成。下一步：请执行 snapshot 查看页面变化，然后继续操作或汇总结果。' };
  }

  async evaluate(expression, profileName, options = {}) {
    if (!this._evaluateEnabled) {
      throw new Error('JS执行已被安全策略禁用，请联系管理员启用browser.evaluateEnabled');
    }
    this._validateExpression(expression);

    const session = await this.getOrStartSession(profileName);
    session.touch();
    const page = session.page;

    // evaluate 加超时控制，防止死循环表达式阻塞
    const evalTimeout = options.timeout || 30000;
    const result = await Promise.race([
      page.evaluate(expression),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`evaluate执行超时(${evalTimeout}ms)`)), evalTimeout)),
    ]);
    return { action: 'evaluate', result };
  }

  async screenshot(profileName, options = {}) {
    const session = await this.getOrStartSession(profileName);
    session.touch();
    const page = session.page;

    const screenshotOptions = {
      type: options.type || 'png',
      fullPage: options.fullPage || false,
    };

    if (options.selector) {
      const element = await page.$(options.selector);
      if (!element) throw new Error(`元素未找到: ${options.selector}`);
      const buffer = await element.screenshot(screenshotOptions);
      return {
        action: 'screenshot',
        data: `data:image/${screenshotOptions.type};base64,${buffer.toString('base64')}`,
        selector: options.selector,
      };
    }

    const buffer = await page.screenshot(screenshotOptions);
    return {
      action: 'screenshot',
      data: `data:image/${screenshotOptions.type};base64,${buffer.toString('base64')}`,
      url: page.url(),
      title: await page.title().catch(() => ''),
      fullPage: screenshotOptions.fullPage,
    };
  }

  async tabs(profileName) {
    const session = await this.getOrStartSession(profileName);
    session.touch();
    const context = session.context;
    const pages = context.pages();

    return pages.map((p, i) => ({
      index: i,
      targetId: `t${i}`,
      url: p.url(),
      title: p.url() === 'about:blank' ? 'New Tab' : 'Page',
      active: p === session.page,
    }));
  }

  // eslint-disable-next-line no-unused-vars
  async openTab(url, profileName, options = {}) {
    this._validateUrl(url);
    const session = await this.getOrStartSession(profileName);
    session.touch();
    const context = session.context;
    const page = await context.newPage();
    page.setDefaultTimeout(this._actionTimeout);
    page.setDefaultNavigationTimeout(this._actionTimeout);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this._actionTimeout });
    session.page = page;
    return { action: 'openTab', url: page.url(), title: await page.title().catch(() => '') };
  }

  async focusTab(targetId, profileName) {
    const session = await this.getOrStartSession(profileName);
    session.touch();
    const context = session.context;
    const pages = context.pages();

    let index;
    if (targetId.startsWith('t')) {
      index = parseInt(targetId.slice(1), 10);
    } else {
      index = parseInt(targetId, 10);
    }

    if (isNaN(index) || index < 0 || index >= pages.length) {
      throw new Error(`标签页索引无效: ${targetId}，当前共${pages.length}个标签页`);
    }

    session.page = pages[index];
    await pages[index].bringToFront();
    return { action: 'focusTab', targetId, url: pages[index].url() };
  }

  async closeTab(targetId, profileName) {
    const session = await this.getOrStartSession(profileName);
    session.touch();
    const context = session.context;
    const pages = context.pages();

    let index;
    if (targetId.startsWith('t')) {
      index = parseInt(targetId.slice(1), 10);
    } else {
      index = parseInt(targetId, 10);
    }

    if (isNaN(index) || index < 0 || index >= pages.length) {
      throw new Error(`标签页索引无效: ${targetId}`);
    }

    if (pages.length <= 1) {
      throw new Error('不能关闭最后一个标签页');
    }

    const closing = pages[index];
    await closing.close();

    if (session.page === closing) {
      const remaining = context.pages();
      session.page = remaining[remaining.length - 1];
    }

    return { action: 'closeTab', targetId, remaining: context.pages().length };
  }

  async goBack(profileName) {
    const session = await this.getOrStartSession(profileName);
    session.touch();
    await session.page.goBack({ waitUntil: 'domcontentloaded', timeout: this._actionTimeout });
    return { action: 'goBack', url: session.page.url() };
  }

  async goForward(profileName) {
    const session = await this.getOrStartSession(profileName);
    session.touch();
    await session.page.goForward({ waitUntil: 'domcontentloaded', timeout: this._actionTimeout });
    return { action: 'goForward', url: session.page.url() };
  }

  async waitForSelector(selector, profileName, options = {}) {
    const session = await this.getOrStartSession(profileName);
    session.touch();
    await session.page.waitForSelector(selector, {
      timeout: options.timeout || this._actionTimeout,
      state: options.state || 'visible',
    });
    return { action: 'waitForSelector', selector };
  }

  async consoleMessages(profileName) {
    const session = await this.getOrStartSession(profileName);
    if (!session._consoleMessages) {
      session._consoleMessages = [];
      session.page.on('console', msg => {
        session._consoleMessages.push({
          type: msg.type(),
          text: msg.text(),
          timestamp: Date.now(),
        });
        if (session._consoleMessages.length > 100) {
          session._consoleMessages.shift();
        }
      });
    }
    return { messages: session._consoleMessages || [] };
  }

  _validateUrl(url) {
    if (typeof url !== 'string' || !url.trim()) {
      throw new Error('URL不能为空');
    }
    if (url.includes('\0') || url.includes('%00')) {
      throw new Error('URL包含非法字符');
    }
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error(`URL协议不允许: ${parsed.protocol}，仅允许http/https`);
      }
    } catch (e) {
      if (e.message.includes('URL协议不允许') || e.message.includes('非法字符')) throw e;
      throw new Error(`URL格式无效: ${url}`);
    }

    if (this._ssrfPolicy.dangerouslyAllowPrivateNetwork !== true) {
      try {
        const parsed = new URL(url);
        const hostname = parsed.hostname;

        // 阻止的域名列表
        const blocked = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '169.254.169.254'];
        if (blocked.includes(hostname)) {
          if (!this._ssrfPolicy.allowedHostnames?.includes(hostname)) {
            throw new Error(`SSRF防护: 不允许访问内部地址 ${hostname}`);
          }
        }

        // IPv4 私有网段检查
        if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(hostname)) {
          if (!this._ssrfPolicy.allowedHostnames?.includes(hostname)) {
            throw new Error(`SSRF防护: 不允许访问私有网络 ${hostname}`);
          }
        }

        // IPv6 地址检查：阻止 [::1], [::], [fc00::]-[fdff::], [fe80::]
        if (hostname.startsWith('[') && hostname.endsWith(']')) {
          const ipv6 = hostname.slice(1, -1).toLowerCase();
          if (ipv6 === '::1' || ipv6 === '::' || ipv6 === '0:0:0:0:0:0:0:1' || ipv6 === '0:0:0:0:0:0:0:0') {
            if (!this._ssrfPolicy.allowedHostnames?.includes(hostname)) {
              throw new Error(`SSRF防护: 不允许访问IPv6内部地址 ${hostname}`);
            }
          }
          // IPv6 唯一本地地址 fc00::/7 (fc00-fdff)
          if (/^[f][c-d]/.test(ipv6)) {
            if (!this._ssrfPolicy.allowedHostnames?.includes(hostname)) {
              throw new Error(`SSRF防护: 不允许访问IPv6私有网络 ${hostname}`);
            }
          }
          // IPv6 链路本地地址 fe80::/10
          if (/^fe[89ab]/.test(ipv6)) {
            if (!this._ssrfPolicy.allowedHostnames?.includes(hostname)) {
              throw new Error(`SSRF防护: 不允许访问IPv6链路本地地址 ${hostname}`);
            }
          }
        }

        // 阻止纯数字IP（如 0x7f000001 = 2130706433，DNS rebinding 绕过）
        if (/^\d+$/.test(hostname)) {
          const num = parseInt(hostname, 10);
          // 127.x.x.x 范围: 2130706432 - 2147483647
          // 10.x.x.x 范围: 167772160 - 184549375
          // 192.168.x.x 范围: 3232235520 - 3232301055
          // 172.16.x.x - 172.31.x.x: 2886729728 - 2887778303
          if (
            (num >= 2130706432 && num <= 2147483647) ||
            (num >= 167772160 && num <= 184549375) ||
            (num >= 3232235520 && num <= 3232301055) ||
            (num >= 2886729728 && num <= 2887778303)
          ) {
            if (!this._ssrfPolicy.allowedHostnames?.includes(hostname)) {
              throw new Error(`SSRF防护: 不允许访问内部地址 ${hostname}`);
            }
          }
        }
      } catch (e) {
        if (e.message.startsWith('SSRF防护')) throw e;
      }
    }
  }

  _validateInputText(text) {
    if (typeof text !== 'string') {
      throw new Error('输入内容必须为字符串');
    }
    if (text.length > 50000) {
      throw new Error('输入内容超过最大长度限制(50000字符)');
    }
  }

  _validateKey(key) {
    const allowedKeys = new Set([
      'Enter', 'Tab', 'Escape', 'Backspace', 'Delete',
      'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
      'Home', 'End', 'PageUp', 'PageDown', 'Insert',
      'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
      'Control+a', 'Control+c', 'Control+v', 'Control+x', 'Control+z',
      'Control+s', 'Control+f', 'Control+w', 'Control+t',
      'Control+Shift+I', 'Alt+F4', 'Alt+Tab',
    ]);
    if (!allowedKeys.has(key) && !/^[a-zA-Z0-9]$/.test(key)) {
      throw new Error(`按键不允许: ${key}`);
    }
  }

  _validateModifier(mod) {
    const allowed = new Set(['Control', 'Alt', 'Shift', 'Meta']);
    if (!allowed.has(mod)) {
      throw new Error(`修饰键不允许: ${mod}`);
    }
  }

  _validateExpression(expression) {
    if (typeof expression !== 'string') {
      throw new Error('JS表达式必须为字符串');
    }
    if (expression.length > 10000) {
      throw new Error('JS表达式超过最大长度限制(10000字符)');
    }
    const blockedPatterns = [
      // Node.js 模块访问
      /require\s*\(/,
      /import\s+/,
      /child_process/,
      /fs\./,
      /process\./,
      /global\./,
      /__dirname/,
      /__filename/,
      /\.exec\s*\(/,
      /\.spawn\s*\(/,
      // 动态代码执行
      /eval\s*\(/,
      /Function\s*\(/,
      // 原型链攻击
      /constructor\s*\[/,
      /constructor\s*\./,
      /\.constructor\b/,
      /__proto__/,
      /prototype\s*\[/,
      // 编码绕过
      /atob\s*\(/,
      /btoa\s*\(/,
      /String\s*\.\s*fromCharCode/,
      /\\x[0-9a-f]{2}/i,
      /\\u[0-9a-f]{4}/i,
      // 反引号模板字符串（可用于拼接绕过）
      /`[^`]*\$\{/,
    ];
    for (const pattern of blockedPatterns) {
      if (pattern.test(expression)) {
        throw new Error(`JS表达式包含禁止的模式: ${pattern.source}`);
      }
    }
  }

  /**
   * 等待用户登录 - 打开浏览器到指定URL，等待用户手动完成登录
   * 使用 persistent profile 保存登录状态，后续请求可复用
   * @param {string} url - 登录页面URL
   * @param {Object} options
   * @param {number} [options.timeout=120000] - 等待登录超时(ms)，默认2分钟
   * @param {string} [options.loginSignal] - 登录成功信号：URL包含的关键词或CSS选择器
   * @param {string} [options.profileName='persistent'] - 使用的Profile，默认persistent
   */
  async waitForLogin(url, options = {}) {
    const {
      timeout = 120000,
      loginSignal,
      profileName = 'persistent',
    } = options;

    // 确保 persistent profile 存在
    if (!this._profiles.has(profileName)) {
      const persistentDir = path.join(CRABPAW_HOME, 'browser-data');
      this._profiles.set(profileName, new BrowserProfile(profileName, {
        headless: false,
        userDataDir: persistentDir,
        viewport: { width: 1280, height: 720 },
      }));
    }

    const session = await this.getOrStartSession(profileName);
    session.touch();
    const page = session.page;

    // 导航到登录页
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this._actionTimeout });

    // 等待登录完成的策略
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`等待登录超时(${timeout / 1000}秒)，请重试或增加timeout`));
      }, timeout);

      const checkInterval = setInterval(async () => {
        try {
          const currentUrl = page.url();

          // 策略1：URL变化检测（离开登录页 = 登录成功）
          if (loginSignal && currentUrl.includes(loginSignal)) {
            cleanup();
            resolve({
              action: 'waitForLogin',
              success: true,
              url: currentUrl,
              title: await page.title().catch(() => ''),
              profile: profileName,
              _hint: `登录成功！后续所有浏览器操作必须使用 profile="${profileName}" 以复用登录状态。例如：BrowserControl({ action: "navigate", url: "...", profile: "${profileName}" })。现在可以继续操作（如navigate、snapshot、extract_data、scroll_collect等）。`,
            });
            return;
          }

          // 策略2：检测常见登录成功元素（用户头像、用户名等）
          if (!loginSignal) {
            const hasLoginIndicator = await page.evaluate(() => {
              // 常见登录成功标识
              const selectors = [
                '[class*="avatar"]', '[class*="user-info"]', '[class*="nickname"]',
                '[class*="login-success"]', '[data-login="true"]',
                '[class*="account"]', '[class*="profile"]',
              ];
              for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el && el.offsetParent !== null) return true;
              }
              return false;
            });

            if (hasLoginIndicator) {
              cleanup();
              resolve({
                action: 'waitForLogin',
                success: true,
                url: currentUrl,
                title: await page.title().catch(() => ''),
                profile: profileName,
                _hint: `登录成功！后续所有浏览器操作必须使用 profile="${profileName}" 以复用登录状态。例如：BrowserControl({ action: "navigate", url: "...", profile: "${profileName}" })。现在可以继续操作（如navigate、snapshot、extract_data、scroll_collect等）。`,
              });
              return;
            }
          }

          // 策略3：超时前每5秒检查一次
        } catch (e) {

          // 页面可能正在跳转，忽略临时错误

          console.warn('[index.js] 空 catch 补日志:', e && e.message);
        }

      }, 3000);

      function cleanup() {
        clearTimeout(timer);
        clearInterval(checkInterval);
      }
    });
  }

  /**
   * 批量提取页面数据 - 用CSS选择器从当前页面提取结构化数据
   * @param {Object} options
   * @param {string} options.containerSelector - 容器选择器（如 .product-card, .result-item）
   * @param {Object} options.fields - 字段映射 { fieldName: cssSelector }
   * @param {number} [options.limit=100] - 最大提取条数
   * @param {string} [options.profileName] - 浏览器Profile
   */
  async extractData(options, profileName) {
    const { containerSelector, fields, limit = 100 } = options;
    if (!containerSelector || !fields || typeof fields !== 'object') {
      throw new Error('extractData需要提供containerSelector和fields');
    }

    const session = await this.getOrStartSession(profileName);
    session.touch();
    const page = session.page;

    const fieldEntries = Object.entries(fields);
    const data = await page.evaluate(({ containerSelector, fieldEntries, limit }) => {
      const containers = document.querySelectorAll(containerSelector);
      const results = [];
      const max = Math.min(containers.length, limit);
      for (let i = 0; i < max; i++) {
        const container = containers[i];
        const item = {};
        for (const [name, selector] of fieldEntries) {
          const el = container.querySelector(selector);
          if (!el) { item[name] = ''; continue; }
          // 智能提取：根据元素类型选择合适的属性
          if (el.tagName === 'IMG') {
            item[name] = el.src || el.dataset.src || '';
          } else if (el.tagName === 'A') {
            item[name] = el.href || el.textContent?.trim() || '';
          } else if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
            item[name] = el.value || '';
          } else {
            item[name] = el.textContent?.trim() || '';
          }
        }
        results.push(item);
      }
      return results;
    }, { containerSelector, fieldEntries, limit });

    return {
      action: 'extractData',
      containerSelector,
      count: data.length,
      data,
      _hint: data.length > 0
        ? `提取到${data.length}条数据。可继续操作或使用scroll_collect/paginate_collect采集更多。`
        : '未提取到数据，请检查containerSelector是否正确，或先snapshot查看页面结构。',
    };
  }

  /**
   * 无限滚动采集 - 自动滚动页面并收集新出现的数据
   * @param {Object} options
   * @param {string} options.containerSelector - 容器选择器
   * @param {Object} options.fields - 字段映射 { fieldName: cssSelector }
   * @param {number} [options.maxScrolls=20] - 最大滚动次数
   * @param {number} [options.scrollDelay=1000] - 每次滚动间隔(ms)
   * @param {number} [options.limit=500] - 最大采集条数
   * @param {string} [options.scrollSelector] - 滚动容器选择器（默认整个页面）
   * @param {string} [options.profileName] - 浏览器Profile
   */
  async scrollAndCollect(options, profileName) {
    const {
      containerSelector, fields, maxScrolls = 20,
      scrollDelay = 1000, limit = 500, scrollSelector,
    } = options;
    if (!containerSelector || !fields) {
      throw new Error('scrollAndCollect需要提供containerSelector和fields');
    }

    const session = await this.getOrStartSession(profileName);
    session.touch();
    const page = session.page;

    const fieldEntries = Object.entries(fields);
    const allData = [];
    const seenKeys = new Set(); // 用第一个字段值做去重 key
    let noNewCount = 0;
    const maxNoNew = 3; // 连续3次无新数据则停止
    const dedupField = fieldEntries[0]?.[0]; // 用第一个字段做去重

    for (let scrollIdx = 0; scrollIdx < maxScrolls; scrollIdx++) {
      // 提取当前可见数据
      const batch = await page.evaluate(({ containerSelector, fieldEntries, limit }) => {
        const containers = document.querySelectorAll(containerSelector);
        const results = [];
        const max = Math.min(containers.length, limit);
        for (let i = 0; i < max; i++) {
          const container = containers[i];
          const item = {};
          for (const [name, selector] of fieldEntries) {
            const el = container.querySelector(selector);
            if (!el) { item[name] = ''; continue; }
            if (el.tagName === 'IMG') item[name] = el.src || el.dataset.src || '';
            else if (el.tagName === 'A') item[name] = el.href || el.textContent?.trim() || '';
            else if (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) item[name] = el.value || '';
            else item[name] = el.textContent?.trim() || '';
          }
          results.push(item);
        }
        return results;
      }, { containerSelector, fieldEntries, limit });

      // 去重：用第一个字段值做唯一标识，而非位置偏移
      let newCount = 0;
      for (const item of batch) {
        const key = dedupField ? (item[dedupField] || JSON.stringify(item)).toString() : JSON.stringify(item);
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          allData.push(item);
          newCount++;
        }
      }

      if (newCount === 0) {
        noNewCount++;
        if (noNewCount >= maxNoNew) {
          console.log(`[BrowserControl] scrollAndCollect: 连续${maxNoNew}次无新数据，停止滚动`);
          break;
        }
      } else {
        noNewCount = 0;
      }

      if (allData.length >= limit) break;

      // 滚动
      if (scrollSelector) {
        await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el) el.scrollTop = el.scrollHeight;
        }, scrollSelector);
      } else {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      }

      // 等待新内容加载
      await page.waitForTimeout(scrollDelay);
    }

    return {
      action: 'scrollAndCollect',
      containerSelector,
      totalScrolled: Math.min(maxScrolls, allData.length > 0 ? maxScrolls : 0),
      count: allData.length,
      data: allData.slice(0, limit),
      _hint: allData.length > 0
        ? `滚动采集完成，共${allData.length}条数据。`
        : '未采集到数据，请检查containerSelector是否正确。',
    };
  }

  /**
   * 分页采集 - 自动点击"下一页"并收集每页数据
   * @param {Object} options
   * @param {string} options.containerSelector - 容器选择器
   * @param {Object} options.fields - 字段映射 { fieldName: cssSelector }
   * @param {string|Object} options.nextButton - 下一页按钮选择器或ref
   * @param {number} [options.maxPages=10] - 最大翻页次数
   * @param {number} [options.pageDelay=1500] - 翻页间隔(ms)
   * @param {number} [options.limit=500] - 最大采集条数
   * @param {string} [options.profileName] - 浏览器Profile
   */
  async paginateAndCollect(options, profileName) {
    const {
      containerSelector, fields, nextButton,
      maxPages = 10, pageDelay = 1500, limit = 500,
    } = options;
    if (!containerSelector || !fields || !nextButton) {
      throw new Error('paginateAndCollect需要提供containerSelector、fields和nextButton');
    }

    const session = await this.getOrStartSession(profileName);
    session.touch();
    const page = session.page;

    const fieldEntries = Object.entries(fields);
    const allData = [];

    for (let pageIdx = 0; pageIdx < maxPages; pageIdx++) {
      // 等待内容加载
      try {
        await page.waitForSelector(containerSelector, { timeout: 5000 });
      } catch (e) {
        console.log(`[BrowserControl] paginateAndCollect: 第${pageIdx + 1}页未找到容器，停止`);
        break;
      }

      // 提取当前页数据
      const batch = await page.evaluate(({ containerSelector, fieldEntries }) => {
        const containers = document.querySelectorAll(containerSelector);
        const results = [];
        for (const container of containers) {
          const item = {};
          for (const [name, selector] of fieldEntries) {
            const el = container.querySelector(selector);
            if (!el) { item[name] = ''; continue; }
            if (el.tagName === 'IMG') item[name] = el.src || el.dataset.src || '';
            else if (el.tagName === 'A') item[name] = el.href || el.textContent?.trim() || '';
            else if (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) item[name] = el.value || '';
            else item[name] = el.textContent?.trim() || '';
          }
          results.push(item);
        }
        return results;
      }, { containerSelector, fieldEntries });

      allData.push(...batch);

      if (allData.length >= limit) break;

      // 点击下一页
      let clicked = false;
      if (typeof nextButton === 'string') {
        // CSS选择器
        const btn = await page.$(nextButton);
        if (btn) {
          const isDisabled = await btn.getAttribute('disabled');
          const isHidden = await btn.isHidden();
          if (!isDisabled && !isHidden) {
            await btn.click();
            clicked = true;
          }
        }
      } else if (typeof nextButton === 'object' && nextButton.ref !== undefined) {
        // ref方式
        const refData = session._refMap.get(String(nextButton.ref));
        if (refData) {
          try {
            const locator = page.locator(`[aria-label="${refData.name}"]`).first();
            await locator.click({ timeout: 3000 });
            clicked = true;
          } catch (e) {
            const fallback = page.getByRole(refData.role, { name: refData.name }).first();
            await fallback.click({ timeout: 3000 });
            clicked = true;
          }
        }
      }

      if (!clicked) {
        console.log(`[BrowserControl] paginateAndCollect: 第${pageIdx + 1}页后未找到下一页按钮，停止`);
        break;
      }

      // 等待页面刷新
      await page.waitForTimeout(pageDelay);
    }

    return {
      action: 'paginateAndCollect',
      containerSelector,
      pagesScraped: Math.min(maxPages, Math.ceil(allData.length / (allData.length / maxPages || 1))),
      count: allData.length,
      data: allData.slice(0, limit),
      _hint: allData.length > 0
        ? `分页采集完成，共${allData.length}条数据。`
        : '未采集到数据，请检查containerSelector和nextButton是否正确。',
    };
  }

  // ─── CDP 原生操作（Browser Harness 启发） ──────────────────

  /**
   * 使用原生 CDP Input.dispatchMouseEvent 进行坐标点击
   * 绕过了 Playwright 的抽象层，在合成器层级发送鼠标事件，
   * 可以穿透 Shadow DOM、跨域 iframe，比 page.mouse.click() 更可靠。
   *
   * Browser Harness 核心洞察：LLM 训练数据里有数百万行 CDP 命令，
   * 每一层 click()/type() 包装都是 Agent 必须绕过的约束。
   *
   * @param {number} x - X 坐标
   * @param {number} y - Y 坐标
   * @param {string} [profileName] - Profile 名称
   * @param {Object} [options]
   * @param {string} [options.button='left'] - 鼠标按钮
   * @param {number} [options.clickCount=1] - 点击次数
   * @returns {Object} 点击结果
   */
  async clickAtCDP(x, y, profileName, options = {}) {
    const session = await this.getOrStartSession(profileName);
    session.touch();
    const page = session.page;

    const button = options.button || 'left';
    const clickCount = options.clickCount || 1;

    try {
      // 通过 Playwright 获取底层 CDP 会话
      const cdpSession = await page.context().newCDPSession(page);

      // 鼠标按下
      await cdpSession.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x, y,
        button,
        clickCount,
      });

      // 微小延迟，模拟真实点击
      await new Promise(r => setTimeout(r, 50 + Math.random() * 50));

      // 鼠标释放
      await cdpSession.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x, y,
        button,
        clickCount,
      });

      // 关闭 CDP 会话
      await cdpSession.detach();

      return {
        action: 'clickAtCDP',
        x, y, button, clickCount,
        url: page.url(),
        _hint: 'CDP原生坐标点击完成。绕过了DOM/Shadow DOM/iframe限制。下一步：screenshot 验证点击效果，然后继续操作。',
      };
    } catch (e) {
      // CDP 会话不可用时的回退：使用 Playwright mouse.click
      if (e.message.includes('CDPSession') || e.message.includes('Target closed')) {
        await page.mouse.click(x, y);
        return {
          action: 'clickAtCDP',
          x, y,
          fallback: 'playwright_mouse',
          _hint: 'CDP不可用，已回退到Playwright mouse.click。',
        };
      }
      throw e;
    }
  }

  /**
   * 执行原始 CDP 命令（Browser Harness 启发）
   * Agent 可以直接使用 LLM 训练数据中的 CDP 命令，无需包装层。
   *
   * 常用 CDP 命令：
   *   Page.navigate, Page.captureScreenshot, Page.printToPDF
   *   DOM.querySelector, DOM.getDocument, DOM.setFileInputFiles
   *   Runtime.evaluate, Runtime.callFunctionOn
   *   Input.dispatchMouseEvent, Input.dispatchKeyEvent
   *   Emulation.setDeviceMetricsOverride, Emulation.setUserAgentOverride
   *   Network.setCookie, Network.getCookies, Network.enable
   *
   * @param {string} method - CDP 方法，如 "DOM.querySelector"
   * @param {Object} [params={}] - CDP 参数
   * @param {string} [profileName] - Profile 名称
   * @returns {Object} CDP 返回结果
   */
  async rawCDP(method, params = {}, profileName) {
    // 安全校验：仅允许白名单 CDP 域
    const allowedDomains = [
      'Page', 'DOM', 'Runtime', 'Input', 'Emulation',
      'Network', 'Accessibility', 'Performance', 'Tracing',
      'Animation', 'Audits', 'Browser', 'CacheStorage',
      'Console', 'CSS', 'Database', 'Debugger', 'DeviceOrientation',
      'DOMDebugger', 'DOMSnapshot', 'DOMStorage', 'Fetch',
      'HeadlessExperimental', 'HeapProfiler', 'IndexedDB',
      'LayerTree', 'Log', 'Media', 'Memory', 'Overlay',
      'Profiler', 'Security', 'ServiceWorker', 'Storage',
      'SystemInfo', 'Target', 'WebAudio',
    ];
    const domain = method.split('.')[0];
    if (!allowedDomains.includes(domain)) {
      throw new Error(`CDP域不允许: ${domain}。允许的域: ${allowedDomains.join(', ')}`);
    }

    // 阻止危险操作
    const blockedMethods = [
      'Browser.close', 'Browser.crash', 'Target.closeTarget',
      'Storage.clearDataForOrigin', 'Emulation.setScriptExecutionDisabled',
    ];
    if (blockedMethods.includes(method)) {
      throw new Error(`CDP方法被安全策略阻止: ${method}`);
    }

    // 2026-09-06 安全收紧: 导航/JS执行/Cookie 与第一方动作（navigate/evaluate）同一道闸，
    // 此前 Page.navigate 可绕过 _validateUrl 的 SSRF 防护，Runtime.evaluate 可绕过
    // evaluateEnabled 开关与表达式黑名单。必须在 getOrStartSession 之前拦截（不启动会话）。
    this._rawCDPPolicyCheck(method, params);

    const session = await this.getOrStartSession(profileName);
    session.touch();
    const page = session.page;

    const cdpSession = await page.context().newCDPSession(page);
    try {
      const result = await cdpSession.send(method, params);
      return {
        action: 'rawCDP',
        method,
        result,
        _hint: `CDP ${method} 执行成功。`,
      };
    } finally {
      await cdpSession.detach();
    }
  }

  /**
   * raw CDP 策略闸（2026-09-06 安全收紧）
   * 独立成方法以便单测覆盖；在会话启动之前调用，拦截不产生任何浏览器副作用。
   * @param {string} method - CDP 方法名
   * @param {Object} params - CDP 参数
   */
  _rawCDPPolicyCheck(method, params) {
    // 导航：与 navigate() 同一 URL 校验（协议白名单 + SSRF 防护）
    if (method === 'Page.navigate') {
      this._validateUrl(params && params.url);
      return;
    }
    // JS 执行：与 evaluate() 同一开关 + 同一表达式黑名单
    if (method === 'Runtime.evaluate' || method === 'Runtime.callFunctionOn') {
      if (!this._evaluateEnabled) {
        throw new Error('JS执行已被安全策略禁用，请联系管理员启用browser.evaluateEnabled');
      }
      const exprKey = method === 'Runtime.callFunctionOn' ? 'functionDeclaration' : 'expression';
      const expr = params[exprKey];
      if (typeof expr !== 'string' || !expr.trim()) {
        throw new Error(`CDP方法 ${method} 缺少 ${exprKey} 参数`);
      }
      this._validateExpression(expr);
      return;
    }
    // Cookie 读写：默认拒绝，防止经由 connect_cdp 读走外部浏览器真实登录态
    if (!this._rawCDPCookieAccess && /^(Network|Storage)\.(setCookies?|getAllCookies|getCookies)$/.test(method)) {
      throw new Error(`Cookie访问被安全策略阻止: ${method}。如确需放行请配置 browser.rawCDPAllowCookies=true`);
    }
  }

  /**
   * CDP 端点主机边界（2026-09-06 安全收紧）
   * 默认仅允许本机端点（localhost/127.0.0.0/8/[::1]/0.0.0.0）；远程地址必须在
   * config.cdpAllowedHosts 白名单内。独立成方法以便单测覆盖。
   * @param {string} wsEndpoint - 已规范化为 ws:// 开头的端点
   * @returns {string} 校验通过的主机名
   */
  _cdpHostAllowed(wsEndpoint) {
    let hostname;
    try {
      hostname = new URL(wsEndpoint).hostname.toLowerCase();
    } catch (e) {
      throw new Error(`CDP端点格式无效: ${wsEndpoint}`);
    }
    if (hostname === 'localhost' || hostname === '0.0.0.0'
        || /^127\./.test(hostname) || hostname === '[::1]' || hostname === '::1') {
      return hostname;
    }
    const allowed = (this._cdpAllowedHosts || []).map(h => String(h).toLowerCase());
    if (allowed.includes(hostname)) {
      return hostname;
    }
    throw new Error(`CDP连接被安全策略阻止: 仅允许本机端点(localhost/127.0.0.1)，远程地址 ${hostname} 需配置 browser.cdpAllowedHosts 白名单`);
  }

  /**
   * 截图后返回坐标映射信息，供 Agent 做截图→坐标→点击闭环
   * @param {string} [profileName]
   * @returns {Object} { screenshot dataUrl + viewport size + coordinate scale info }
   */
  async screenshotWithCoords(profileName) {
    const session = await this.getOrStartSession(profileName);
    session.touch();
    const page = session.page;

    const viewport = page.viewportSize();
    const buffer = await page.screenshot({ type: 'png' });

    return {
      action: 'screenshotWithCoords',
      data: `data:image/png;base64,${buffer.toString('base64')}`,
      viewport: { width: viewport.width, height: viewport.height },
      url: page.url(),
      title: await page.title().catch(() => ''),
      _hint: `截图尺寸: ${viewport.width}x${viewport.height}。使用 clickAtCDP(x, y) 点击目标，坐标范围: (0,0) - (${viewport.width},${viewport.height})。`,
    };
  }

  async startCleanup() {
    if (this._cleanupInterval) return;
    this._cleanupInterval = setInterval(() => {
      for (const [key, session] of this._sessions.entries()) {
        if (session.isIdle(this._idleTimeoutMs)) {
          console.log(`[BrowserControl] 清理空闲会话: ${key}`);
          session.close().catch(e => console.debug('[BrowserControl] Cleanup failed:', e?.message));
          this._sessions.delete(key);
        }
      }
    }, 5 * 60 * 1000);
    // 允许进程在只剩定时器时正常退出
    if (this._cleanupInterval.unref) this._cleanupInterval.unref();
    this._started = true;
  }

  async stopCleanup() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
  }

  async shutdown() {
    await this.stopCleanup();
    if (this._leakCheckInterval) {
      clearInterval(this._leakCheckInterval);
      this._leakCheckInterval = null;
    }
    // eslint-disable-next-line no-unused-vars
    for (const [key, session] of this._sessions.entries()) {
      await session.close().catch(e => console.debug('[BrowserControl] Cleanup failed:', e?.message));
    }
    this._sessions.clear();
    this._started = false;
  }
}

let _manager = null;

function getBrowserControlManager(config = {}) {
  if (!_manager) {
    _manager = new BrowserControlManager(config);
  }
  return _manager;
}

module.exports = { BrowserControlManager, BrowserProfile, BrowserSession, StealthManager, SessionRecorder, getBrowserControlManager, isAnyBrowserAvailable, getBrowserAvailabilityReport, PORTABLE_BROWSERS_DIR };
