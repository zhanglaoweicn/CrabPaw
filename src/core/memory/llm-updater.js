const crypto = require('crypto');
/**
 * LLM-Driven Memory Update System
 * 
 * 借鉴 Deer Flow 的 LLM 驱动记忆更新机制
 * 使用 LLM 分析对话，智能提取和更新记忆
 * 
 * 核心功能：
 * - 结构化反思：错误检测、用户纠正、项目约束发现
 * - 智能提取：从对话中提取 facts、preferences、context
 * - 置信度评估：LLM 自我评估提取内容的可靠性
 * - 增量更新：智能合并新旧记忆
 */

const EventEmitter = require('events');

const MEMORY_UPDATE_PROMPT = `You are a memory management system. Your task is to analyze a conversation and update the user's memory profile.

Current Memory State:
<current_memory>
{current_memory}
</current_memory>

New Conversation to Process:
<conversation>
{conversation}
</conversation>

Instructions:
1. Analyze the conversation for important information about the user
2. Extract relevant facts, preferences, and context with specific details (numbers, names, technologies)
3. Update the memory sections as needed following the detailed length guidelines below

Before extracting facts, perform a structured reflection on the conversation:
1. Error/Retry Detection: Did the agent encounter errors, require retries, or produce incorrect results?
   If yes, record the root cause and correct approach as a high-confidence fact with category "correction".
2. User Correction Detection: Did the user correct the agent's direction, understanding, or output?
   If yes, record the correct interpretation or approach as a high-confidence fact with category "correction".
   Include what went wrong in "sourceError" only when category is "correction" and the mistake is explicit in the conversation.
3. Project Constraint Discovery: Were any project-specific constraints discovered during the conversation?
   If yes, record them as facts with the most appropriate category and confidence.

{correction_hint}

Memory Section Guidelines:

**User Context** (Current state - concise summaries):
- workContext: Professional role, company, key projects, main technologies (2-3 sentences)
  Example: Core contributor, project names with metrics (16k+ stars), technical stack
- personalContext: Languages, communication preferences, key interests (1-2 sentences)
  Example: Bilingual capabilities, specific interest areas, expertise domains
- topOfMind: Multiple ongoing focus areas and priorities (3-5 sentences, detailed paragraph)
  Example: Primary project work, parallel technical investigations, ongoing learning/tracking
  Include: Active implementation work, troubleshooting issues, market/research interests
  Note: This captures SEVERAL concurrent focus areas, not just one task

**History** (Temporal context - rich paragraphs):
- recentMonths: Detailed summary of recent activities (4-6 sentences or 1-2 paragraphs)
  Timeline: Last 1-3 months of interactions
  Include: Technologies explored, projects worked on, problems solved, interests demonstrated
- earlierContext: Important historical patterns (3-5 sentences or 1 paragraph)
  Timeline: 3-12 months ago
  Include: Past projects, learning journeys, established patterns
- longTermBackground: Persistent background and foundational context (2-4 sentences)
  Timeline: Overall/foundational information
  Include: Core expertise, longstanding interests, fundamental working style

**Facts Extraction**:
- Extract specific, quantifiable details (e.g., "16k+ GitHub stars", "200+ datasets")
- Include proper nouns (company names, project names, technology names)
- Preserve technical terminology and version numbers
- Categories:
  * preference: Tools, styles, approaches user prefers/dislikes
  * knowledge: Specific expertise, technologies mastered, domain knowledge
  * context: Background facts (job title, projects, locations, languages)
  * behavior: Working patterns, communication habits, problem-solving approaches
  * goal: Stated objectives, learning targets, project ambitions
  * correction: Explicit agent mistakes or user corrections, including the correct approach
- Confidence levels:
  * 0.9-1.0: Explicitly stated facts ("I work on X", "My role is Y")
  * 0.7-0.8: Strongly implied from actions/discussions
  * 0.5-0.6: Inferred patterns (use sparingly, only for clear patterns)

**What Goes Where**:
- workContext: Current job, active projects, primary tech stack
- personalContext: Languages, personality, interests outside direct work tasks
- topOfMind: Multiple ongoing priorities and focus areas user cares about recently (gets updated most frequently)
  Should capture 3-5 concurrent themes: main work, side explorations, learning/tracking interests
- recentMonths: Detailed account of recent technical explorations and work
- earlierContext: Patterns from slightly older interactions still relevant
- longTermBackground: Unchanging foundational facts about the user

**Multilingual Content**:
- Preserve original language for proper nouns and company names
- Keep technical terms in their original form (DeepSeek, LangGraph, etc.)
- Note language capabilities in personalContext

Output Format (JSON):
{
  "user": {
    "workContext": { "summary": "...", "shouldUpdate": true/false },
    "personalContext": { "summary": "...", "shouldUpdate": true/false },
    "topOfMind": { "summary": "...", "shouldUpdate": true/false }
  },
  "history": {
    "recentMonths": { "summary": "...", "shouldUpdate": true/false },
    "earlierContext": { "summary": "...", "shouldUpdate": true/false },
    "longTermBackground": { "summary": "...", "shouldUpdate": true/false }
  },
  "facts": [
    {
      "content": "The fact content",
      "category": "preference|knowledge|context|behavior|goal|correction",
      "confidence": 0.0-1.0,
      "sourceError": "What went wrong (only for corrections)"
    }
  ],
  "factsToRemove": ["fact_id_1", "fact_id_2"]
}`;

const REFLECTION_PROMPT = `Analyze this conversation segment for memory-worthy information:

<conversation>
{conversation}
</conversation>

Provide a structured reflection:

1. **Error/Retry Detection**: Were there any errors, retries, or incorrect results?
   - What was the error?
   - What was the root cause?
   - What was the correct approach?

2. **User Correction Detection**: Did the user correct the agent?
   - What was misunderstood?
   - What was the correct interpretation?
   - Is this a pattern or one-time correction?

3. **Project Constraint Discovery**: Were any project-specific constraints discovered?
   - What constraints?
   - Why do they exist?
   - How should they affect future work?

4. **Preference Signals**: Did the user express preferences?
   - What do they prefer?
   - What do they dislike?
   - How strongly?

5. **Knowledge Gaps**: What did the user demonstrate knowledge of?
   - What are they expert in?
   - What are they learning?
   - What context do they have?

Output as JSON:
{
  "errors": [...],
  "corrections": [...],
  "constraints": [...],
  "preferences": [...],
  "knowledge": [...],
  "shouldUpdateMemory": true/false,
  "updatePriority": "high|medium|low"
}`;

class LLMMemoryUpdater extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = {
      model: config.model || null,
      maxTokens: config.maxTokens || 4000,
      temperature: config.temperature || 0.3,
      maxFactsPerUpdate: config.maxFactsPerUpdate || 10,
      confidenceThreshold: config.confidenceThreshold || 0.5,
      ...config,
    };
    this._updateQueue = [];
    this._processing = false;
  }

  setModel(model) {
    this.config.model = model;
  }

  async analyzeConversation(messages, currentMemory = null) {
    if (!this.config.model) {
      throw new Error('Model not set. Call setModel() first.');
    }

    const conversation = this._formatConversation(messages);
    const memoryStr = currentMemory
      ? JSON.stringify(currentMemory, null, 2)
      : '{}';

    const prompt = MEMORY_UPDATE_PROMPT
      .replace('{current_memory}', memoryStr)
      .replace('{conversation}', conversation)
      .replace('{correction_hint}', this._getCorrectionHint(messages));

    try {
      const response = await this._callLLM(prompt);
      const update = this._parseUpdateResponse(response);

      this.emit('analysis:complete', {
        messageCount: messages.length,
        factsExtracted: update.facts?.length || 0,
        sectionsUpdated: this._countSectionUpdates(update),
      });

      return update;
    } catch (error) {
      this.emit('analysis:error', {
        error: error.message,
        messageCount: messages.length,
      });
      throw error;
    }
  }

  async reflectOnConversation(messages) {
    if (!this.config.model) {
      throw new Error('Model not set. Call setModel() first.');
    }

    const conversation = this._formatConversation(messages);
    const prompt = REFLECTION_PROMPT.replace('{conversation}', conversation);

    try {
      const response = await this._callLLM(prompt);
      const reflection = this._parseReflectionResponse(response);

      this.emit('reflection:complete', {
        messageCount: messages.length,
        shouldUpdate: reflection.shouldUpdateMemory,
        priority: reflection.updatePriority,
      });

      return reflection;
    } catch (error) {
      this.emit('reflection:error', {
        error: error.message,
      });
      throw error;
    }
  }

  _formatConversation(messages) {
    return messages
      .map(m => {
        const role = m.role || 'unknown';
        const content = typeof m.content === 'string'
          ? m.content
          : JSON.stringify(m.content);
        return `[${role.toUpperCase()}]: ${content}`;
      })
      .join('\n\n');
  }

  _getCorrectionHint(messages) {
    const lastMessages = messages.slice(-5);
    const text = lastMessages
      .map(m => typeof m.content === 'string' ? m.content : '')
      .join(' ')
      .toLowerCase();

    const correctionKeywords = [
      'wrong', 'incorrect', 'mistake', 'error', 'not what',
      '不对', '错了', '不是', '重新', '改',
    ];

    const hasCorrection = correctionKeywords.some(kw => text.includes(kw));

    if (hasCorrection) {
      return `IMPORTANT: A user correction was detected in this conversation. Pay special attention to:
1. What the agent got wrong
2. What the correct approach should be
3. Record this as a high-confidence "correction" fact`;
    }

    return '';
  }

  async _callLLM(prompt) {
    if (!this.config.model) {
      throw new Error('No model available');
    }

    if (typeof this.config.model === 'function') {
      return await this.config.model(prompt, {
        maxTokens: this.config.maxTokens,
        temperature: this.config.temperature,
      });
    }

    if (this.config.model.messages) {
      const response = await this.config.model.messages.create({
        model: this.config.model.modelName || 'claude-3-sonnet-20240229',
        max_tokens: this.config.maxTokens,
        messages: [{ role: 'user', content: prompt }],
      });
      return response.content[0].text;
    }

    throw new Error('Invalid model configuration');
  }

  _parseUpdateResponse(response) {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { facts: [], user: {}, history: {} };
      }

      const parsed = JSON.parse(jsonMatch[0]);

      if (parsed.facts && Array.isArray(parsed.facts)) {
        parsed.facts = parsed.facts
          .filter(f => f.confidence >= this.config.confidenceThreshold)
          .slice(0, this.config.maxFactsPerUpdate)
          .map(f => ({
            ...f,
            id: `fact_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 6)}`,
            createdAt: Date.now(),
          }));
      }

      return parsed;
    } catch (error) {
      this.emit('parse:error', { error: error.message, response });
      return { facts: [], user: {}, history: {} };
    }
  }

  _parseReflectionResponse(response) {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return {
          errors: [],
          corrections: [],
          constraints: [],
          preferences: [],
          knowledge: [],
          shouldUpdateMemory: false,
          updatePriority: 'low',
        };
      }

      return JSON.parse(jsonMatch[0]);
    } catch (error) {
      this.emit('parse:error', { error: error.message, response });
      return {
        errors: [],
        corrections: [],
        constraints: [],
        preferences: [],
        knowledge: [],
        shouldUpdateMemory: false,
        updatePriority: 'low',
      };
    }
  }

  _countSectionUpdates(update) {
    let count = 0;
    
    if (update.user) {
      for (const section of Object.values(update.user)) {
        if (section.shouldUpdate) count++;
      }
    }
    
    if (update.history) {
      for (const section of Object.values(update.history)) {
        if (section.shouldUpdate) count++;
      }
    }

    return count;
  }

  queueUpdate(messages, options = {}) {
    const update = {
      id: `upd_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 6)}`,
      messages,
      options,
      queuedAt: Date.now(),
    };

    this._updateQueue.push(update);
    this._processQueue();

    return update.id;
  }

  async _processQueue() {
    if (this._processing || this._updateQueue.length === 0) {
      return;
    }

    this._processing = true;

    while (this._updateQueue.length > 0) {
      const update = this._updateQueue.shift();

      try {
        const result = await this.analyzeConversation(
          update.messages,
          update.options.currentMemory
        );

        this.emit('update:processed', {
          id: update.id,
          result,
        });
      } catch (error) {
        this.emit('update:failed', {
          id: update.id,
          error: error.message,
        });
      }
    }

    this._processing = false;
  }

  getQueueLength() {
    return this._updateQueue.length;
  }

  isProcessing() {
    return this._processing;
  }
}

class MemoryConsolidator extends EventEmitter {
  constructor(config = {}) {
    super();
    this.updater = new LLMMemoryUpdater(config);
    this.config = {
      maxFacts: config.maxFacts || 100,
      deduplicationThreshold: config.deduplicationThreshold || 0.9,
      ...config,
    };
  }

  setModel(model) {
    this.updater.setModel(model);
  }

  async consolidate(currentMemory, newFacts) {
    const allFacts = [
      ...(currentMemory.facts || []),
      ...newFacts,
    ];

    const deduplicated = this._deduplicateFacts(allFacts);

    const sorted = deduplicated.sort((a, b) => {
      if (a.category === 'correction' && b.category !== 'correction') return -1;
      if (a.category !== 'correction' && b.category === 'correction') return 1;
      return (b.confidence || 0.5) - (a.confidence || 0.5);
    });

    const trimmed = sorted.slice(0, this.config.maxFacts);

    return {
      ...currentMemory,
      facts: trimmed,
      lastConsolidatedAt: Date.now(),
      factCount: trimmed.length,
    };
  }

  _deduplicateFacts(facts) {
    const seen = new Map();

    for (const fact of facts) {
      const key = this._normalizeFactContent(fact.content);
      
      if (!seen.has(key)) {
        seen.set(key, fact);
      } else {
        const existing = seen.get(key);
        if ((fact.confidence || 0) > (existing.confidence || 0)) {
          seen.set(key, fact);
        }
      }
    }

    return Array.from(seen.values());
  }

  _normalizeFactContent(content) {
    return content
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async mergeMemorySections(currentMemory, updates) {
    const merged = { ...currentMemory };

    if (updates.user) {
      merged.user = merged.user || {};
      for (const [key, value] of Object.entries(updates.user)) {
        if (value.shouldUpdate && value.summary) {
          merged.user[key] = {
            summary: value.summary,
            updatedAt: Date.now(),
          };
        }
      }
    }

    if (updates.history) {
      merged.history = merged.history || {};
      for (const [key, value] of Object.entries(updates.history)) {
        if (value.shouldUpdate && value.summary) {
          merged.history[key] = {
            summary: value.summary,
            updatedAt: Date.now(),
          };
        }
      }
    }

    if (updates.facts && updates.facts.length > 0) {
      merged.facts = await this.consolidate(merged, updates.facts);
    }

    merged.lastUpdated = Date.now();

    return merged;
  }
}

module.exports = {
  LLMMemoryUpdater,
  MemoryConsolidator,
  MEMORY_UPDATE_PROMPT,
  REFLECTION_PROMPT,
};
