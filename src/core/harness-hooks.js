/**
 * Harness Hooks System — PreToolUse / PostToolUse lifecycle hooks
 *
 * Design:
 * - EventEmitter interface for external subscribers (observability, logging, metrics)
 * - Built-in safety hooks (dangerous command interception, path permissions)
 * - registerIntoRegistry() auto-registers with existing toolSystem hooks
 */

const { EventEmitter } = require('events');
const { getEventBus } = require('./events');

class HookManager extends EventEmitter {
  constructor() {
    super();
    this._preToolUseHooks = [];
    this._postToolUseHooks = [];
    this._commandHooks = [];
    this._httpHooks = [];
    this._promptHooks = [];
    this._agentHooks = [];
    this._stopHooks = [];
    this._unresponsiveHooks = [];
    this.setMaxListeners(30);
  }

  // ── Command Hook (shell command) ─────────────────────────────────

  /**
   * Register a command hook that runs a shell command.
   * @param {object} hook { id, command, timeout, matcher?, events? }
   *   - matcher: fn(toolName, params) => boolean (optional filter)
   *   - events: ['pre', 'post'] (default both)
   */
  registerCommandHook(hook) {
    if (!hook.id || !hook.command) throw new Error('Command hook requires id and command');
    hook.timeout = hook.timeout || 15000;
    hook.events = hook.events || ['pre', 'post'];
    this._commandHooks.push(hook);
    return this;
  }

  async triggerCommandHooks(event, toolName, params, result, session) {
    const results = [];
    for (const hook of this._commandHooks) {
      if (hook.events && !hook.events.includes(event)) continue;
      if (hook.matcher && !hook.matcher(toolName, params)) continue;
      try {
        const exec = require('util').promisify(require('child_process').exec);
        const cmd = hook.command
          .replace(/\$\{toolName\}/g, toolName)
          .replace(/\$\{params\}/g, JSON.stringify(params))
          .replace(/\$\{sessionId\}/g, session?.sessionId || '');
        const { stdout } = await exec(cmd, { timeout: hook.timeout, encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true });
        results.push({ hookId: hook.id, success: true, stdout: stdout.trim() });
      } catch (e) {
        console.warn(`[hooks] Command hook "${hook.id}" failed:`, e.message);
        results.push({ hookId: hook.id, success: false, error: e.message });
      }
    }
    return results;
  }

  // ── HTTP Hook (webhook / API call) ──────────────────────────────

  /**
   * Register an HTTP hook that makes an API call.
   * @param {object} hook { id, url, method?, headers?, bodyTemplate?, matcher?, events? }
   */
  registerHttpHook(hook) {
    if (!hook.id || !hook.url) throw new Error('HTTP hook requires id and url');
    hook.method = hook.method || 'POST';
    hook.headers = hook.headers || {};
    hook.events = hook.events || ['pre', 'post'];
    this._httpHooks.push(hook);
    return this;
  }

  async triggerHttpHooks(event, toolName, params, result, session) {
    const results = [];
    for (const hook of this._httpHooks) {
      if (hook.events && !hook.events.includes(event)) continue;
      if (hook.matcher && !hook.matcher(toolName, params)) continue;
      try {
        const body = hook.bodyTemplate
          ? JSON.parse(hook.bodyTemplate
              .replace(/\$\{toolName\}/g, toolName)
              .replace(/\$\{params\}/g, JSON.stringify(params))
              .replace(/\$\{result\}/g, JSON.stringify(result || {})))
          : JSON.stringify({ toolName, params, result, event, sessionId: session?.sessionId });
        const resp = await fetch(hook.url, {
          method: hook.method,
          headers: { 'Content-Type': 'application/json', ...hook.headers },
          body,
          signal: AbortSignal.timeout(hook.timeout || 10000),
        });
        const respBody = await resp.text().catch(() => '');
        results.push({ hookId: hook.id, success: resp.ok, status: resp.status, body: respBody.slice(0, 5000) });
      } catch (e) {
        console.warn(`[hooks] HTTP hook "${hook.id}" failed:`, e.message);
        results.push({ hookId: hook.id, success: false, error: e.message });
      }
    }
    return results;
  }

  // ── Prompt Hook (LLM call) ──────────────────────────────────────

  /**
   * Register a prompt hook that calls an LLM.
   * @param {object} hook { id, promptTemplate, model?, matcher?, events? }
   */
  registerPromptHook(hook) {
    if (!hook.id || !hook.promptTemplate) throw new Error('Prompt hook requires id and promptTemplate');
    hook.model = hook.model || 'default';
    hook.events = hook.events || ['pre', 'post'];
    this._promptHooks.push(hook);
    return this;
  }

  async triggerPromptHooks(event, toolName, params, result, session, llmCallFn) {
    if (!llmCallFn) return [];
    const results = [];
    for (const hook of this._promptHooks) {
      if (hook.events && !hook.events.includes(event)) continue;
      if (hook.matcher && !hook.matcher(toolName, params)) continue;
      try {
        const prompt = hook.promptTemplate
          .replace(/\$\{toolName\}/g, toolName)
          .replace(/\$\{params\}/g, JSON.stringify(params))
          .replace(/\$\{result\}/g, JSON.stringify(result || {}));
        const llmResult = await llmCallFn(prompt, hook.model);
        results.push({ hookId: hook.id, success: true, response: llmResult });
      } catch (e) {
        console.warn(`[hooks] Prompt hook "${hook.id}" failed:`, e.message);
        results.push({ hookId: hook.id, success: false, error: e.message });
      }
    }
    return results;
  }

  // ── Agent Hook (sub-agent delegation) ───────────────────────────

  /**
   * Register an agent hook that delegates to a sub-agent.
   * @param {object} hook { id, agentDef, matcher?, events? }
   *   - agentDef: { name, systemPrompt, model, tools, skills }
   */
  registerAgentHook(hook) {
    if (!hook.id || !hook.agentDef) throw new Error('Agent hook requires id and agentDef');
    hook.events = hook.events || ['pre'];
    this._agentHooks.push(hook);
    return this;
  }

  async triggerAgentHooks(event, toolName, params, result, session, spawnAgentFn) {
    if (!spawnAgentFn) return [];
    const results = [];
    for (const hook of this._agentHooks) {
      if (hook.events && !hook.events.includes(event)) continue;
      if (hook.matcher && !hook.matcher(toolName, params)) continue;
      try {
        const agentResult = await spawnAgentFn(hook.agentDef, {
          toolName, params, result, session,
        });
        results.push({ hookId: hook.id, success: true, agentResult });
      } catch (e) {
        console.warn(`[hooks] Agent hook "${hook.id}" failed:`, e.message);
        results.push({ hookId: hook.id, success: false, error: e.message });
      }
    }
    return results;
  }

  // ── Get counts ──────────────────────────────────────────────────

  getHookCounts() {
    return {
      preToolUse: this._preToolUseHooks.length,
      postToolUse: this._postToolUseHooks.length,
      command: this._commandHooks.length,
      http: this._httpHooks.length,
      prompt: this._promptHooks.length,
      agent: this._agentHooks.length,
      stop: this._stopHooks.length,
      unresponsive: this._unresponsiveHooks.length,
    };
  }

  registerPreToolUse(hook) {
    this._preToolUseHooks.push({ fn: hook, priority: hook.priority || 50 });
    this._sortByPriority(this._preToolUseHooks);
    return this;
  }

  registerPostToolUse(hook) {
    this._postToolUseHooks.push({ fn: hook, priority: hook.priority || 50 });
    this._sortByPriority(this._postToolUseHooks);
    return this;
  }

  registerPreToolUsePriority(hook, priority) {
    this._preToolUseHooks.push({ fn: hook, priority });
    this._sortByPriority(this._preToolUseHooks);
    return this;
  }

  registerStopHook(hook, priority = 50) {
    this._stopHooks.push({ fn: hook, priority });
    this._sortByPriority(this._stopHooks);
    return this;
  }

  registerUnresponsiveHook(hook, priority = 50) {
    this._unresponsiveHooks.push({ fn: hook, priority });
    this._sortByPriority(this._unresponsiveHooks);
    return this;
  }

  _sortByPriority(arr) {
    arr.sort((a, b) => b.priority - a.priority);
  }

  async triggerPreToolUse(toolName, params, session) {
    let currentParams = { ...params };
    for (const { fn: hook } of this._preToolUseHooks) {
      try {
        const result = await hook(toolName, currentParams, session);
        if (result === false || (result && result.allowed === false)) {
          this.emit('toolBlocked', {
            toolName, params,
            reason: result?.blockReason || 'Blocked by hook',
            blockedBy: 'hook',
          });
          getEventBus().publish('tool', 'blocked', {
            tool: toolName,
            reason: result?.blockReason || 'Blocked by hook',
            blockedBy: 'hook',
          });
          return {
            allowed: false,
            blockReason: result?.blockReason || 'Blocked by hook',
            blockedBy: 'hook',
          };
        }
        if (result && result.modifiedParams) {
          currentParams = result.modifiedParams;
        }
      } catch (e) {
        console.warn('[hooks] PreToolUse hook error:', e.message);
      }
    }
    // Fire complementary hook types (pre event)
    this.triggerCommandHooks('pre', toolName, currentParams, null, session).catch(e => console.debug('[hooks] Hook trigger failed:', e?.message));
    this.triggerHttpHooks('pre', toolName, currentParams, null, session).catch(e => console.debug('[hooks] Hook trigger failed:', e?.message));
    if (session?.llmCallFn) {
      this.triggerPromptHooks('pre', toolName, currentParams, null, session, session.llmCallFn).catch(e => console.debug('[hooks] Hook trigger failed:', e?.message));
    }
    if (session?.spawnAgentFn) {
      this.triggerAgentHooks('pre', toolName, currentParams, null, session, session.spawnAgentFn).catch(e => console.debug('[hooks] Hook trigger failed:', e?.message));
    }
    this.emit('preToolUse', { toolName, params: currentParams });
    return { allowed: true, params: currentParams };
  }

  async triggerPostToolUse(toolName, params, result, session) {
    for (const { fn: hook } of this._postToolUseHooks) {
      try {
        await hook(toolName, params, result, session);
      } catch (e) {
        console.warn('[hooks] PostToolUse hook error:', e.message);
      }
    }
    // Fire complementary hook types (post event)
    this.triggerCommandHooks('post', toolName, params, result, session).catch(e => console.debug('[hooks] Hook trigger failed:', e?.message));
    this.triggerHttpHooks('post', toolName, params, result, session).catch(e => console.debug('[hooks] Hook trigger failed:', e?.message));
    if (session?.llmCallFn) {
      this.triggerPromptHooks('post', toolName, params, result, session, session.llmCallFn).catch(e => console.debug('[hooks] Hook trigger failed:', e?.message));
    }
    if (session?.spawnAgentFn) {
      this.triggerAgentHooks('post', toolName, params, result, session, session.spawnAgentFn).catch(e => console.debug('[hooks] Hook trigger failed:', e?.message));
    }
    this.emit('postToolUse', {
      toolName, params,
      resultType: typeof result === 'object' ? Object.keys(result || {}) : 'scalar',
    });
  }

  async triggerStopHooks(session) {
    for (const { fn: hook } of this._stopHooks) {
      try { await hook(session); } catch (e) { console.warn('[hooks] Stop hook error:', e.message); }
    }
    this.emit('stop', { sessionId: session?.sessionId });
    getEventBus().publish('session', 'end', { sessionId: session?.sessionId, trigger: 'stop_hook' });
  }

  async triggerUnresponsiveHooks(session, hangDurationMs) {
    for (const { fn: hook } of this._unresponsiveHooks) {
      try { await hook(session, hangDurationMs); } catch (e) { console.warn('[hooks] Unresponsive hook error:', e.message); }
    }
    this.emit('unresponsive', { sessionId: session?.sessionId, hangDurationMs });
    getEventBus().publish('session', 'anomaly', { sessionId: session?.sessionId, hangDurationMs, type: 'unresponsive' });
  }

  /**
   * 规范化 shell 命令用于黑名单匹配：
   * - 小写 + 去首尾空白
   * - 剥除引号（'rm -rf "/"' → rm -rf /）
   * - ${IFS} / $IFS 变量展开为空格（'rm -rf ${IFS}/' → rm -rf /）
   * - 折叠连续空白（'rm   -rf   /' → 'rm -rf /'）
   */
  static _normalizeCommand(cmd) {
    return String(cmd || '')
      .toLowerCase()
      .trim()
      .replace(/['"`]/g, '')
      .replace(/\$\{?ifs\}?/g, ' ')
      .replace(/\s+/g, ' ');
  }

  /**
   * rm 专项检测：拆分参数形态（-r -f / -fr / --recursive --force）不落入
   * 子串黑名单，按 shell 语义解析 —— 出现 rm 且 flag 集合同时含 r 与 f，
   * 且目标为根 / 根通配 / 家目录时判为破坏性命令。
   *
   * 2026-08 审查修复：
   * - I1 长 flag：`--recursive`/`--force` 与短 flag `-r`/`-f` 语义等价归一
   *   （`--no-preserve-root` 本身不具 r/f 语义，但搭配长 flag r/f 后同样
   *   被拦，见测试 `rm --recursive --force --no-preserve-root /`）。
   * - I2 `~/` 尾斜杠形态；M1 `$home` 变量展开（规范化已剥引号/转小写，
   *   `"$HOME"` → `$home`，与已处理的 `$IFS` 展开同一层口径）。
   */
  static _isDestructiveRm(normalized) {
    if (!/(^|\s)rm(\s|$)/.test(normalized)) return false;
    const flagChars = new Set();
    const longFlagShorts = { recursive: 'r', force: 'f' };
    // 短 flag `-rf` 逐字符归入；长 flag `--recursive`/`--force` 查表归入。
    const flagRe = /(?:^|\s)(-{1,2})([a-z][a-z-]*)/g;
    let m;
    while ((m = flagRe.exec(normalized))) {
      if (m[1] === '--') {
        const short = longFlagShorts[m[2]];
        if (short) flagChars.add(short);
      } else {
        for (const ch of m[2]) flagChars.add(ch);
      }
    }
    if (!flagChars.has('r') || !flagChars.has('f')) return false;
    // 目标集合：`/` `/*` `//` `~` `~/` `~/*` `*` `$home`（含尾斜杠/通配变体）
    return /(^|\s)(\/+|\/\*+|~\/?\*?|\*+|\$home\/?\*?)(\s|$)/.test(normalized)
      || /(^|\s)\/\*?\s*$/.test(normalized);
  }

  static createSafetyHooks() {
    const forbiddenPatterns = [
      'rm -rf /',
      'rm -rf /*',
      'rm -rf ~',
      'dd if=',
      'mkfs.',
      ':(){ :|:& };:',
      'chmod 777 /',
      '> /dev/sda',
      'format c:',
      'del /f /s c:\\',
    ];
    // shell 类工具注册名集合（以 src/tools registry 实际注册名为准：
    // bash-tools.js 注册 Bash；persistent-shell-tool.js 注册 ShellExec）。
    // Cmd/PowerShell 预留（permission-enforce.js 的 exec 分类同款名单）。
    // 大小写不敏感归一后比较。
    const shellToolNames = new Set(['bash', 'shellexec', 'cmd', 'powershell']);

    return [
      async (toolName, params) => {
        if (!shellToolNames.has(String(toolName || '').toLowerCase())) return { allowed: true };
        // 先规范化再匹配：剥引号/${IFS}/折叠空白，堵子串绕过。
        // 注意：此黑名单是纵深防御的一层（PathPermission/审批/registry
        // 危险标记仍是主门），不承诺完备，绕过形态持续收集。
        const cmd = HookManager._normalizeCommand(params && params.command);
        if (HookManager._isDestructiveRm(cmd)) {
          return {
            allowed: false,
            blockReason: '[Safety Hook] Command blocked: destructive rm targeting / or ~',
          };
        }
        for (const pattern of forbiddenPatterns) {
          if (cmd.includes(pattern)) {
            return {
              allowed: false,
              blockReason: '[Safety Hook] Command blocked: matches forbidden pattern "' + pattern + '"',
            };
          }
        }
        return { allowed: true };
      },
    ];
  }

  static createPathPermissionHooks(pathRules) {
    if (!pathRules) return [];
    return [
      async (toolName, params) => {
        const fileTools = ['read', 'Write', 'Edit', 'apply_patch', 'DeleteFile'];
        if (!fileTools.includes(toolName)) return { allowed: true };
        const filePath = params.file_path || params.filePath;
        if (!filePath) return { allowed: true };

        // 2026-08-15 P1-1: 改用 WithMode 变体,使 PLAN/FULL_AUTO 权限模式生效。
        // DEFAULT 模式放行集合与接线前一致(permissions/path-rules.js 内部委托
        // file-safety.isWriteDenied 同源拦截),接线前后净效果不变。
        if (['read'].includes(toolName) && !pathRules.canReadWithMode(filePath)) {
          return { allowed: false, blockReason: '[PathRule] Read denied: ' + filePath };
        }
        if (['Write', 'Edit', 'apply_patch', 'DeleteFile'].includes(toolName) && !pathRules.canWriteWithMode(filePath)) {
          return { allowed: false, blockReason: '[PathRule] Write denied: ' + filePath };
        }
        return { allowed: true };
      },
    ];
  }

  registerIntoRegistry(toolRegistry) {
    if (!toolRegistry || typeof toolRegistry.addPreExecuteHook !== 'function') {
      console.warn('[hooks] toolRegistry does not support addPreExecuteHook');
      return this;
    }

    const self = this;
    toolRegistry.addPreExecuteHook(async (toolName, params, context) => {
      const result = await self.triggerPreToolUse(toolName, params, context || {});
      if (!result.allowed) {
        return {
          blocked: true,
          reason: result.blockReason,
          errorCode: 'HOOK_BLOCKED',
        };
      }
      return { blocked: false, modifiedInput: result.params !== params ? result.params : undefined };
    });

    if (typeof toolRegistry.addPostExecuteHook === 'function') {
      toolRegistry.addPostExecuteHook(async (toolName, params, result, context) => {
        await self.triggerPostToolUse(toolName, params, result, context || {});
      });
    }

    console.log(
      '[hooks] Registered into toolRegistry (' +
      self._preToolUseHooks.length + ' pre, ' +
      self._postToolUseHooks.length + ' post hooks)'
    );
    return this;
  }
}

const globalHooks = new HookManager();

module.exports = { HookManager, globalHooks };
