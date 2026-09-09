const fs = require('fs');
const path = require('path');
// eslint-disable-next-line no-unused-vars -- require 解构中 execSync 未用（不可删 require）
const { execSync } = require('child_process');
const execAsync = require('util').promisify(require('child_process').exec);
const { DATA_DIR } = require('./config');

const HOOKS_DIR = path.join(DATA_DIR, 'hooks');
const ALLOWLIST_FILE = path.join(DATA_DIR, 'shell-hooks-allowlist.json');

const VALID_EVENTS = new Set([
  'pre_tool_call',
  'post_tool_call',
  'pre_llm_call',
  'post_llm_call',
  'on_session_start',
  'on_session_end',
  'on_session_reset',
  'on_error',
]);

class ShellHooksBridge {
  constructor(config) {
    this.config = config || {};
    this._allowlist = this._loadAllowlist();
    this._hooks = [];
    this._loaded = false;
  }

  _loadAllowlist() {
    try {
      if (fs.existsSync(ALLOWLIST_FILE)) {
        return JSON.parse(fs.readFileSync(ALLOWLIST_FILE, 'utf-8'));
      }
    } catch { console.warn('[shell-hooks] silent catch, error swallowed'); }
    return {};
  }

  _saveAllowlist() {
    try {
      const dir = path.dirname(ALLOWLIST_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmp = ALLOWLIST_FILE + '.tmp.' + Date.now();
      fs.writeFileSync(tmp, JSON.stringify(this._allowlist, null, 2), 'utf-8');
      fs.renameSync(tmp, ALLOWLIST_FILE);
    } catch (e) {
      console.error('[ShellHooks] 保存白名单失败?', e.message);
    }
  }

  discoverAndLoad() {
    this._hooks = [];
    if (!fs.existsSync(HOOKS_DIR)) {
      this._loaded = true;
      return;
    }
    const autoAccept = this.config.autoAccept
      || process.env.CRABPAW_ACCEPT_HOOKS === 'true'
      || this.config.hooksAutoAccept === true;
    try {
      const entries = fs.readdirSync(HOOKS_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const hookDir = path.join(HOOKS_DIR, entry.name);
        const yamlPath = path.join(hookDir, 'HOOK.yaml');
        const jsPath = path.join(hookDir, 'handler.js');
        if (!fs.existsSync(yamlPath) || !fs.existsSync(jsPath)) continue;
        try {
          const yamlContent = fs.readFileSync(yamlPath, 'utf-8');
          const metadata = this._parseSimpleYaml(yamlContent);
          if (!metadata.name || !metadata.events) continue;
          const events = Array.isArray(metadata.events) ? metadata.events : [metadata.events];
          const validEvents = events.filter(e => VALID_EVENTS.has(e));
          if (validEvents.length === 0) continue;
          const command = `node "${jsPath}"`;
          const allowKey = `${entry.name}:${command}`;
          if (!autoAccept && !this._allowlist[allowKey]) {
            console.log(`[ShellHooks] 首次发现钩子 "${metadata.name}"，需要用户确认`);
            this._allowlist[allowKey] = 'pending';
            this._saveAllowlist();
            continue;
          }
          this._hooks.push({
            name: metadata.name,
            description: metadata.description || '',
            events: validEvents,
            command,
            jsPath,
            dir: hookDir,
          });
        } catch (e) {
          console.error(`[ShellHooks] 加载钩子 ${entry.name} 失败:`, e.message);
        }
      }
    } catch { console.warn('[shell-hooks] silent catch, error swallowed'); }
    this._loaded = true;
  }

  acceptHook(hookName) {
    for (const hook of this._hooks) {
      if (hook.name === hookName) return true;
    }
    for (const [key, status] of Object.entries(this._allowlist)) {
      if (status === 'pending' && key.startsWith(hookName + ':')) {
        this._allowlist[key] = 'accepted';
        this._saveAllowlist();
        this.discoverAndLoad();
        return true;
      }
    }
    return false;
  }

  rejectHook(hookName) {
    for (const [key, status] of Object.entries(this._allowlist)) {
      if (status === 'pending' && key.startsWith(hookName + ':')) {
        this._allowlist[key] = 'rejected';
        this._saveAllowlist();
        return true;
      }
    }
    return false;
  }

  async invokeHook(eventType, context) {
    if (!this._loaded) this.discoverAndLoad();
    const matching = this._hooks.filter(h => h.events.includes(eventType));
    const results = [];
    for (const hook of matching) {
      try {
        const result = await this._executeHook(hook, eventType, context);
        if (result) {
          results.push({ hook: hook.name, result });
          if (result.decision === 'block' || result.action === 'block') {
            return {
              blocked: true,
              reason: result.reason || result.message || `被钩- ?${hook.name} 拦截`,
              hook: hook.name,
            };
          }
        }
      } catch (e) {
        console.error(`[ShellHooks] 钩子 ${hook.name} 执行失败:`, e.message);
      }
    }
    return { blocked: false, results };
  }

  async _executeHook(hook, eventType, context) {
    const input = JSON.stringify({
      hook_event_name: eventType,
      tool_name: context.toolName || '',
      tool_input: context.toolInput || {},
      session_id: context.sessionId || '',
      cwd: context.cwd || process.cwd(),
      extra: context.extra || {},
    });
    try {
      const { stdout } = await execAsync(hook.command, {
        input,
        timeout: 30000,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
        shell: true,
        cwd: hook.dir,
      });
      if (!stdout || !stdout.trim()) return null;
      try {
        return JSON.parse(stdout.trim());
      } catch {
        return null;
      }
    } catch (err) {
      console.error(`[ShellHooks] 执行 ${hook.name} 失败:`, err.message);
      return null;
    }
  }

  _parseSimpleYaml(content) {
    const result = {};
    let currentKey = null;
    let inList = false;
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (trimmed.startsWith('- ') && inList && currentKey) {
        if (!Array.isArray(result[currentKey])) result[currentKey] = [];
        result[currentKey].push(trimmed.substring(2).trim());
        continue;
      }
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx === -1) continue;
      const key = trimmed.substring(0, colonIdx).trim();
      const val = trimmed.substring(colonIdx + 1).trim();
      if (!val) {
        currentKey = key;
        inList = true;
        result[key] = [];
      } else {
        currentKey = key;
        inList = false;
        result[key] = val.replace(/^["']|["']$/g, '');
      }
    }
    return result;
  }

  getLoadedHooks() {
    return this._hooks.map(h => ({
      name: h.name,
      description: h.description,
      events: h.events,
    }));
  }

  getPendingHooks() {
    const pending = [];
    for (const [key, status] of Object.entries(this._allowlist)) {
      if (status === 'pending') {
        const colonIdx = key.indexOf(':');
        pending.push({
          name: colonIdx > 0 ? key.substring(0, colonIdx) : key,
          command: colonIdx > 0 ? key.substring(colonIdx + 1) : '',
        });
      }
    }
    return pending;
  }
}

let _instance = null;

function getShellHooksBridge(config) {
  if (!_instance || config) {
    _instance = new ShellHooksBridge(config);
  }
  return _instance;
}

module.exports = {
  ShellHooksBridge,
  getShellHooksBridge,
  VALID_EVENTS,
  HOOKS_DIR,
};
