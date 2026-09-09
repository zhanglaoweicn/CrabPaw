/**
 * Evolution LLM Adapter
 *
 * Wraps provider config to provide the OpenAI-compatible chat interface
 * expected by ConversationReviewFork._callLLM() and SkillCurator.
 *
 * Interface:
 *   chat({ messages, temperature, max_tokens, tools })
 *     → fetch({baseUrl}/chat/completions with tools support
 *     → { choices: [{ message: { content, tool_calls } }] }
 *
 * Fallback:
 *   fetchCompletion({ messages, temperature, max_tokens })
 *     → same fetch without tools
 *     → { content: "..." }
 */

const { loadConfig } = require('../config');

class EvolutionLlmAdapter {
  constructor(config) {
    this.config = config || loadConfig();
    this._providerCache = null;
  }

  /**
   * Resolve the current provider configuration for evolution tasks.
   * Uses the main provider config, with fallback to deepseek.
   */
  _resolveProvider() {
    if (this._providerCache) return this._providerCache;

    const cfg = this.config;
    const provider = cfg.models?.currentProvider || 'deepseek';
    const providerCfg = cfg.models?.providers?.[provider];

    if (!providerCfg || !providerCfg.apiKey || providerCfg.apiKey.trim() === '') {
      console.warn('[EvolutionLlmAdapter] No configured provider with valid API key');
      return null;
    }

    this._providerCache = {
      provider,
      model: providerCfg.model || 'deepseek-chat',
      baseUrl: (providerCfg.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, ''),
      apiKey: providerCfg.apiKey,
    };
    return this._providerCache;
  }

  /**
   * OpenAI-compatible chat interface with tool support.
   * Returns OpenAI-formatted response for _extractToolCalls and _extractTextContent.
   *
   * @param {object} params
   * @param {Array} params.messages
   * @param {number} params.temperature
   * @param {number} params.max_tokens
   * @param {Array} [params.tools] - Tool definitions for tool calling
   * @returns {Promise<object|null>} OpenAI-compatible response or null on failure
   */
  async chat({ messages, temperature, max_tokens, tools }) {
    const resolved = this._resolveProvider();
    if (!resolved) return null;

    const body = {
      model: resolved.model,
      messages,
      temperature: temperature ?? 0.3,
      max_tokens: max_tokens ?? 2000,
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    try {
      const response = await fetch(`${resolved.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${resolved.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Evolution LLM API error: HTTP ${response.status} ${errText.slice(0, 200)}`);
      }

      return await response.json();
    } catch (err) {
      // Adapter failure — log and return null so caller falls through gracefully
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        console.warn('[EvolutionLlmAdapter] API call timed out after 60s');
      } else {
        console.warn('[EvolutionLlmAdapter] API call failed:', err.message);
      }
      return null;
    }
  }

  /**
   * Simpler completion interface (no tool calls).
   * Returns { content: "..." } for _callLLM's fetchCompletion branch.
   *
   * @param {object} params
   * @param {Array} params.messages
   * @param {number} params.temperature
   * @param {number} params.max_tokens
   * @returns {Promise<object|null>}
   */
  async fetchCompletion({ messages, temperature, max_tokens }) {
    const result = await this.chat({ messages, temperature, max_tokens });
    if (!result) return null;

    return {
      content: result.choices?.[0]?.message?.content || '',
    };
  }
}

module.exports = { EvolutionLlmAdapter };
