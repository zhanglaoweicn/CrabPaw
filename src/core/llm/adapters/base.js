const { EventEmitter } = require('events');

class ProviderAdapter extends EventEmitter {
  constructor(config = {}) {
    super();
    this._providerId = config.providerId || 'unknown';
    this._apiKey = config.apiKey || '';
    this._baseUrl = config.baseUrl || '';
    this._defaultModel = config.defaultModel || '';
    this._supportedModels = config.supportedModels || [];
    this._capabilities = {
      streaming: true,
      toolUse: true,
      vision: false,
      reasoning: false,
      maxTokens: 4096,
      ...config.capabilities,
    };
  }

  get providerId() { return this._providerId; }
  get supportedModels() { return this._supportedModels; }
  get capabilities() { return this._capabilities; }

  isModelSupported(modelId) {
    return this._supportedModels.some(m =>
      m.id === modelId || m.id.startsWith(modelId.split('-').slice(0, 2).join('-'))
    );
  }

  getModelConfig(modelId) {
    return this._supportedModels.find(m => m.id === modelId) ||
           this._supportedModels.find(m => modelId.startsWith(m.id.split('-').slice(0, 2).join('-'))) ||
           null;
  }

  async chat(params) {
    const {
      messages,
      model,
      temperature,
      maxTokens,
      tools,
      toolChoice,
      stream,
      systemPrompt,
    } = params;

    const requestPayload = this.buildRequestPayload({
      messages,
      model: model || this._defaultModel,
      temperature,
      maxTokens,
      tools,
      toolChoice,
      stream,
      systemPrompt,
    });

    const url = this.getRequestUrl(model || this._defaultModel);

    if (stream) {
      return this.streamChat(url, requestPayload);
    }

    const response = await this.makeRequest(url, requestPayload);
    return this.parseResponse(response);
  }

  buildRequestPayload(params) {
    const { messages, model, temperature, maxTokens, tools, toolChoice, stream, systemPrompt } = params;

    const payload = {
      model,
      messages: this.formatMessages(messages, systemPrompt),
      stream: !!stream,
    };

    if (temperature !== undefined) {
      payload.temperature = this.clampTemperature(temperature);
    }

    if (maxTokens !== undefined) {
      payload.max_tokens = maxTokens;
    }

    if (tools && tools.length > 0 && this._capabilities.toolUse) {
      payload.tools = this.formatTools(tools);
      if (toolChoice) {
        payload.tool_choice = this.formatToolChoice(toolChoice);
      }
    }

    return payload;
  }

  formatMessages(messages, systemPrompt) {
    const formatted = [];

    if (systemPrompt) {
      formatted.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of messages) {
      formatted.push(this.formatSingleMessage(msg));
    }

    return formatted;
  }

  formatSingleMessage(msg) {
    if (msg.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: msg.tool_call_id,
        content: msg.content,
      };
    }

    if (msg.tool_calls) {
      return {
        role: 'assistant',
        content: msg.content || null,
        tool_calls: msg.tool_calls,
      };
    }

    if (Array.isArray(msg.content)) {
      return {
        role: msg.role,
        content: this.formatMultiModalContent(msg.content),
      };
    }

    return {
      role: msg.role,
      content: msg.content,
    };
  }

  formatMultiModalContent(content) {
    return content.map(item => {
      if (item.type === 'text') {
        return { type: 'text', text: item.text };
      }
      if (item.type === 'image_url') {
        return this.formatImageContent(item);
      }
      return item;
    });
  }

  formatImageContent(item) {
    return {
      type: 'image_url',
      image_url: { url: item.image_url?.url || item.url },
    };
  }

  formatTools(tools) {
    return tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.function?.name || tool.name,
        description: tool.function?.description || tool.description,
        parameters: tool.function?.parameters || tool.parameters,
      },
    }));
  }

  formatToolChoice(toolChoice) {
    if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') {
      return toolChoice;
    }
    if (typeof toolChoice === 'object' && toolChoice.function) {
      return {
        type: 'function',
        function: { name: toolChoice.function.name },
      };
    }
    return 'auto';
  }

  clampTemperature(temp) {
    return Math.max(0, Math.min(2, temp));
  }

  getRequestUrl(_model) {
    return `${this._baseUrl}/chat/completions`;
  }

  getRequestHeaders() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this._apiKey}`,
    };
  }

  async makeRequest(url, payload) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000);

    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: this.getRequestHeaders(),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      if (fetchErr.name === 'AbortError') {
        throw new Error(`${this._providerId} request timed out`);
      }
      throw fetchErr;
    }
    clearTimeout(timeoutId);

    if (!resp.ok) {
      const errorBody = await resp.text();
      const sanitized = this._sanitizeErrorMessage(errorBody);
      throw new Error(`${this._providerId} API error ${resp.status}: ${sanitized}`);
    }

    return resp.json();
  }

  _sanitizeErrorMessage(msg) {
    if (!msg || !this._apiKey) return msg;
    return msg.replace(new RegExp(this._apiKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '***');
  }

  parseResponse(response) {
    const choice = response.choices?.[0];
    if (!choice) {
      throw new Error(`${this._providerId} 返回空响应`);
    }

    const result = {
      id: response.id,
      model: response.model,
      content: choice.message?.content || '',
      role: choice.message?.role || 'assistant',
      finishReason: choice.finish_reason,
      usage: response.usage || {},
      toolCalls: choice.message?.tool_calls || [],
    };

    return result;
  }

  async *streamChat(url, payload) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000);

    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: this.getRequestHeaders(),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      if (fetchErr.name === 'AbortError') {
        throw new Error(`${this._providerId} stream request timed out`);
      }
      throw fetchErr;
    }
    clearTimeout(timeoutId);

    if (!resp.ok) {
      const errorBody = await resp.text();
      const sanitized = this._sanitizeErrorMessage(errorBody);
      throw new Error(`${this._providerId} stream error ${resp.status}: ${sanitized}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        if (data === '[DONE]') return;

        try {
          const parsed = JSON.parse(data);
          const chunk = this.parseStreamChunk(parsed);
          if (chunk) yield chunk;
        } catch (e) {

          // skip malformed chunks

          console.warn('[base.js] 空 catch 补日志:', e && e.message);
        }

      }
    }
  }

  parseStreamChunk(chunk) {
    const choice = chunk.choices?.[0];
    if (!choice) return null;

    const delta = choice.delta || {};
    return {
      id: chunk.id,
      model: chunk.model,
      content: delta.content || '',
      toolCalls: delta.tool_calls || [],
      finishReason: choice.finish_reason,
    };
  }

  validate() {
    if (!this._apiKey) {
      return { valid: false, error: `${this._providerId}: API key not configured` };
    }
    if (!this._baseUrl) {
      return { valid: false, error: `${this._providerId}: base URL not configured` };
    }
    return { valid: true };
  }
}

module.exports = { ProviderAdapter };
