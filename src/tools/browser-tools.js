const { registry } = require('./registry');
const { logDesktopControl, logSecurityBlock, RISK_LEVELS, redactToolParams } = require('../core/audit-log');
const { getBrowserControlManager } = require('../core/browser-control');
const { buildRegistryParameters } = require('../core/browser-control/schema');

const BROWSER_TIMEOUT = 60000;

async function handleBrowserControl(params) {
  const { action } = params;
  // 智能profile选择：如果没指定profile，优先使用已有活跃会话的profile
  let profile = params.profile || undefined;
  if (!profile) {
    const mgr = getBrowserControlManager();
    // 检查persistent profile是否有活跃会话（已登录）
    const persistentSession = await mgr.getSession('persistent');
    if (persistentSession) {
      profile = 'persistent';
    }
    // 否则检查default profile
    if (!profile) {
      const defaultSession = await mgr.getSession('default');
      if (defaultSession) {
        profile = 'default';
      }
    }
  }
  const mgr = getBrowserControlManager();

  try {
    let result;
    switch (action) {
      case 'status':
        result = await mgr.status(profile);
        break;
      case 'start':
        await mgr.start(profile);
        result = await mgr.status(profile);
        break;
      case 'stop':
        await mgr.stop(profile);
        result = { running: false, profile: profile || 'default' };
        break;
      case 'profiles':
        result = { profiles: mgr.listProfiles() };
        break;
      case 'navigate':
        result = await mgr.navigate(params.url, profile);
        break;
      case 'snapshot':
        result = await mgr.snapshot(profile, { mode: params.mode, maxChars: params.maxChars });
        break;
      case 'screenshot':
        result = await mgr.screenshot(profile, {
          type: params.imageType,
          fullPage: params.fullPage,
          selector: params.selector,
        });
        break;
      case 'click':
        result = await mgr.click(params.ref, profile, {
          selector: params.selector,
          x: params.x,
          y: params.y,
        });
        break;
      case 'click_at_cdp':
        result = await mgr.clickAtCDP(params.x, params.y, profile, {
          button: params.button,
          clickCount: params.clickCount,
        });
        break;
      case 'raw_cdp':
        result = await mgr.rawCDP(params.method, params.params || {}, profile);
        break;
      case 'screenshot_with_coords':
        result = await mgr.screenshotWithCoords(profile);
        break;
      case 'type':
        result = await mgr.type(params.ref, params.text, profile, {
          selector: params.selector,
          delay: params.delay,
        });
        break;
      case 'fill':
        result = await mgr.fill(params.ref, params.value, profile, {
          selector: params.selector,
        });
        break;
      case 'select':
        result = await mgr.select(params.ref, params.values, profile, {
          selector: params.selector,
        });
        break;
      case 'hover':
        result = await mgr.hover(params.ref, profile, {
          x: params.x,
          y: params.y,
        });
        break;
      case 'scroll':
        result = await mgr.scroll(params.direction || 'down', params.amount || 3, profile);
        break;
      case 'press':
        result = await mgr.press(params.key, profile, {
          modifiers: params.modifiers,
        });
        break;
      case 'evaluate':
        result = await mgr.evaluate(params.expression, profile);
        break;
      case 'tabs':
        result = await mgr.tabs(profile);
        break;
      case 'open_tab':
        result = await mgr.openTab(params.url, profile, { label: params.label });
        break;
      case 'focus_tab':
        result = await mgr.focusTab(params.targetId, profile);
        break;
      case 'close_tab':
        result = await mgr.closeTab(params.targetId, profile);
        break;
      case 'go_back':
        result = await mgr.goBack(profile);
        break;
      case 'go_forward':
        result = await mgr.goForward(profile);
        break;
      case 'wait_for_selector':
        result = await mgr.waitForSelector(params.selector, profile, {
          timeout: params.timeout,
          state: params.state,
        });
        break;
      case 'console':
        result = await mgr.consoleMessages(profile);
        break;
      case 'extract_data':
        result = await mgr.extractData({
          containerSelector: params.containerSelector,
          fields: params.fields,
          limit: params.limit,
        }, profile);
        break;
      case 'scroll_collect':
        result = await mgr.scrollAndCollect({
          containerSelector: params.containerSelector,
          fields: params.fields,
          maxScrolls: params.maxScrolls,
          scrollDelay: params.scrollDelay,
          limit: params.limit,
          scrollSelector: params.scrollSelector,
        }, profile);
        break;
      case 'paginate_collect':
        result = await mgr.paginateAndCollect({
          containerSelector: params.containerSelector,
          fields: params.fields,
          nextButton: params.nextButton,
          maxPages: params.maxPages,
          pageDelay: params.pageDelay,
          limit: params.limit,
        }, profile);
        break;
      case 'wait_for_login':
        result = await mgr.waitForLogin(params.url, {
          timeout: params.timeout,
          loginSignal: params.loginSignal,
          profileName: profile || 'persistent',
        });
        break;
      case 'connect_cdp':
        result = await mgr.connectCDP(params.wsEndpoint, {
          profileName: params.profile || 'cdp',
        });
        break;
      case 'disconnect_cdp':
        result = await mgr.disconnectCDP(params.profile || 'cdp');
        break;
      case 'cdp_status':
        result = mgr.cdpStatus(params.profile || 'cdp');
        break;
      case 'vision':
        result = await mgr.vision(profile, {
          prompt: params.prompt,
          fullPage: params.fullPage,
          selector: params.selector,
          analyzeFn: params._analyzeFn,
          maxTokens: params.maxTokens,
        });
        break;
      case 'stealth_status':
        result = {
          enabled: mgr.stealth._enabled,
          userAgentRotation: mgr.stealth._userAgentRotation,
          viewportRandomization: mgr.stealth._viewportRandomization,
          webDriverRemoval: mgr.stealth._webDriverRemoval,
          pluginMasking: mgr.stealth._pluginMasking,
          currentUserAgent: mgr.stealth._enabled ? mgr.stealth.generateUserAgent() : null,
        };
        break;
      case 'stealth_toggle':
        if (params.enabled === false) {
          mgr.stealth._enabled = false;
        } else {
          mgr.stealth._enabled = true;
        }
        result = { action: 'stealth_toggle', enabled: mgr.stealth._enabled };
        break;
      case 'recording_toggle':
        if (params.enabled === false) {
          mgr.recorder.disable();
        } else {
          mgr.recorder.enable();
        }
        result = { action: 'recording_toggle', enabled: mgr.recorder.enabled };
        break;
      default:
        result = { success: false, error: `未知的浏览器操作: ${action}` };
    }

    logDesktopControl('system', `browser_${action}`, params, {
      success: !result.error,
      _risk: _getRiskLevel(action),
    });

    return result;
  } catch (e) {
    const riskLevel = _getRiskLevel(action);
    logDesktopControl('system', `browser_${action}`, params, {
      success: false,
      error: e.message,
      _risk: riskLevel,
    });

    if (e.message.includes('SSRF防护') || e.message.includes('禁止的模式') || e.message.includes('不允许')) {
      logSecurityBlock('system', 'BrowserControl', e.message, { action, params: redactToolParams(params) });
    }

    return { success: false, error: e.message, action };
  }
}

function _getRiskLevel(action) {
  const map = {
    status: RISK_LEVELS.LOW,
    start: RISK_LEVELS.LOW,
    stop: RISK_LEVELS.LOW,
    profiles: RISK_LEVELS.LOW,
    navigate: RISK_LEVELS.MEDIUM,
    snapshot: RISK_LEVELS.LOW,
    screenshot: RISK_LEVELS.LOW,
    click: RISK_LEVELS.MEDIUM,
    type: RISK_LEVELS.MEDIUM,
    fill: RISK_LEVELS.MEDIUM,
    select: RISK_LEVELS.MEDIUM,
    hover: RISK_LEVELS.LOW,
    scroll: RISK_LEVELS.LOW,
    press: RISK_LEVELS.MEDIUM,
    evaluate: RISK_LEVELS.HIGH,
    tabs: RISK_LEVELS.LOW,
    open_tab: RISK_LEVELS.MEDIUM,
    focus_tab: RISK_LEVELS.LOW,
    close_tab: RISK_LEVELS.LOW,
    go_back: RISK_LEVELS.LOW,
    go_forward: RISK_LEVELS.LOW,
    wait_for_selector: RISK_LEVELS.LOW,
    console: RISK_LEVELS.LOW,
    extract_data: RISK_LEVELS.LOW,
    scroll_collect: RISK_LEVELS.MEDIUM,
    paginate_collect: RISK_LEVELS.MEDIUM,
    wait_for_login: RISK_LEVELS.MEDIUM,
    connect_cdp: RISK_LEVELS.MEDIUM,
    disconnect_cdp: RISK_LEVELS.LOW,
    cdp_status: RISK_LEVELS.LOW,
    vision: RISK_LEVELS.LOW,
    stealth_status: RISK_LEVELS.LOW,
    stealth_toggle: RISK_LEVELS.LOW,
    recording_toggle: RISK_LEVELS.LOW,
  };
  return map[action] || RISK_LEVELS.MEDIUM;
}

registry.register({
  name: 'BrowserControl',
  toolset: 'browser',
  category: 'browser_control',
  description: '浏览器深度控制：页面快照、DOM元素操作、表单填写、JS执行、标签页管理等',
  schema: {
    description: '深度控制浏览器：获取页面快照/无障碍树，按ref点击DOM元素，填写表单，执行JS，管理标签页等。这是浏览器级控制工具，可精确操作网页内元素。所有操作均经过安全审查。action=vision 时对当前页面截图并用多模态模型理解(复杂网页/图表/海报等视觉承载内容; 纯文本页用 extractData/scrollAndCollect 更省)。',
    parameters: buildRegistryParameters(),
  },
  handler: handleBrowserControl,
  checkFn: (params) => params.action && typeof params.action === 'string',
  timeout: BROWSER_TIMEOUT,
  isDangerous: true,
  isReadOnly: false,
});

console.log('🌐 浏览器控制工具集已注册(含安全审查):', registry.getByToolset('browser').map(t => t.name).join(', '));

module.exports = {
  handleBrowserControl,
  getBrowserControlManager,
  _getRiskLevel,
};
