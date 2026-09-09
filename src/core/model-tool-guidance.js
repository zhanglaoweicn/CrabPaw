const MODEL_FAMILIES = {
  deepseek: {
    patterns: [/deepseek/i, /deep-seek/i],
    name: 'DeepSeek',
    strengths: ['代码生成', '逻辑推理', '工具调用'],
    quirks: {
      toolCallFormat: 'deepseek',
      prefersExplicitToolNames: true,
      needsToolCallReminder: true,
      maxToolCallsPerTurn: 5,
      supportsParallelToolCalls: true,
      argumentFormatStrict: true,
      // DeepSeek 特有问题
      proneToDSMLTags: true,        // 容易在文本中生成 DSML 标签
      proneToPrematureStop: true,   // 容易过早停止执行
      proneToDescribeNotAct: false,  // 不太容易只描述不行动
    }
  },
  qwen: {
    patterns: [/qwen/i, /tongyi/i, /通义/i],
    name: 'Qwen/通义千问',
    strengths: ['中文理解', '多模态', '长文本'],
    quirks: {
      toolCallFormat: 'qwen',
      prefersExplicitToolNames: true,
      needsToolCallReminder: true,
      maxToolCallsPerTurn: 3,
      supportsParallelToolCalls: false,
      argumentFormatStrict: true,
      prefersChineseToolNames: true,
      proneToDSMLTags: true,
      proneToPrematureStop: true,
      proneToDescribeNotAct: true,
    }
  },
  glm: {
    patterns: [/glm/i, /chatglm/i, /zhipu/i, /智谱/i],
    name: 'GLM/智谱',
    strengths: ['中文理解', '知识问答', '对话'],
    quirks: {
      toolCallFormat: 'glm',
      prefersExplicitToolNames: true,
      needsToolCallReminder: true,
      maxToolCallsPerTurn: 3,
      supportsParallelToolCalls: false,
      argumentFormatStrict: true,
      needsStepByStepGuidance: true,
      proneToDSMLTags: true,
      proneToPrematureStop: true,
      proneToDescribeNotAct: true,
    }
  },
  moonshot: {
    patterns: [/moonshot/i, /kimi/i, /月之暗面/i],
    name: 'Moonshot/Kimi',
    strengths: ['长文本', '文档理解'],
    quirks: {
      toolCallFormat: 'openai',
      prefersExplicitToolNames: true,
      needsToolCallReminder: true,
      maxToolCallsPerTurn: 3,
      supportsParallelToolCalls: false,
      argumentFormatStrict: false,
      proneToDSMLTags: false,
      proneToPrematureStop: false,
      proneToDescribeNotAct: true,
    }
  },
  yi: {
    patterns: [/yi-/i, /零一/i, /01\.ai/i],
    name: 'Yi/零一万物',
    strengths: ['双语', '推理'],
    quirks: {
      toolCallFormat: 'openai',
      prefersExplicitToolNames: true,
      needsToolCallReminder: true,
      maxToolCallsPerTurn: 3,
      supportsParallelToolCalls: false,
      argumentFormatStrict: false,
      proneToDSMLTags: false,
      proneToPrematureStop: false,
      proneToDescribeNotAct: false,
    }
  },
  baichuan: {
    patterns: [/baichuan/i, /百川/i],
    name: 'Baichuan/百川',
    strengths: ['中文', '对话'],
    quirks: {
      toolCallFormat: 'openai',
      prefersExplicitToolNames: true,
      needsToolCallReminder: true,
      maxToolCallsPerTurn: 2,
      supportsParallelToolCalls: false,
      argumentFormatStrict: true,
      needsStepByStepGuidance: true,
      proneToDSMLTags: true,
      proneToPrematureStop: true,
      proneToDescribeNotAct: true,
    }
  },
  minimax: {
    patterns: [/minimax/i, /abab/i],
    name: 'MiniMax',
    strengths: ['语音', '多模态'],
    quirks: {
      toolCallFormat: 'openai',
      prefersExplicitToolNames: true,
      needsToolCallReminder: true,
      maxToolCallsPerTurn: 3,
      supportsParallelToolCalls: false,
      argumentFormatStrict: false,
      proneToDSMLTags: false,
      proneToPrematureStop: false,
      proneToDescribeNotAct: false,
    }
  },
  spark: {
    patterns: [/spark/i, /讯飞/i, /xfyun/i],
    name: 'Spark/讯飞星火',
    strengths: ['中文', '语音', '教育'],
    quirks: {
      toolCallFormat: 'openai',
      prefersExplicitToolNames: true,
      needsToolCallReminder: true,
      maxToolCallsPerTurn: 2,
      supportsParallelToolCalls: false,
      argumentFormatStrict: true,
      needsStepByStepGuidance: true,
      proneToDSMLTags: true,
      proneToPrematureStop: true,
      proneToDescribeNotAct: true,
    }
  },
  doubao: {
    patterns: [/doubao/i, /豆包/i, /bytedance/i],
    name: 'Doubao/豆包',
    strengths: ['中文', '对话', '创作'],
    quirks: {
      toolCallFormat: 'openai',
      prefersExplicitToolNames: true,
      needsToolCallReminder: true,
      maxToolCallsPerTurn: 3,
      supportsParallelToolCalls: false,
      argumentFormatStrict: false,
      proneToDSMLTags: false,
      proneToPrematureStop: false,
      proneToDescribeNotAct: true,
    }
  },
};

function detectModelFamily(modelName, providerName) {
  if (!modelName && !providerName) return null;

  const searchStr = `${modelName || ''} ${providerName || ''}`.toLowerCase();

  for (const [key, family] of Object.entries(MODEL_FAMILIES)) {
    for (const pattern of family.patterns) {
      if (pattern.test(searchStr)) {
        return { key, ...family };
      }
    }
  }

  return null;
}

function buildToolGuidancePrompt(modelName, providerName, toolNames = []) {
  const family = detectModelFamily(modelName, providerName);
  if (!family) return '';

  const quirks = family.quirks;
  const lines = [];

  lines.push(`## ${family.name} 模型工具调用指引`);
  lines.push('');

  // ── DSML 标签禁令（针对容易生成 DSML 标签的模型）──────────
  if (quirks.proneToDSMLTags) {
    lines.push('### ⛔ 严禁在文本中输出工具调用标签');
    lines.push('你**必须**通过 function calling 机制调用工具，绝不能在回复文本中写入任何工具调用标签。');
    lines.push('- 禁止输出 `<｜｜DSML｜｜tool_calls>` 或类似标签');
    lines.push('- 禁止输出 `<｜｜DSML｜｜invoke>` 或类似标签');
    lines.push('- 禁止在文本中写 XML/JSON 格式的工具调用');
    lines.push('- 工具调用由系统自动处理，你只需要用自然语言回复用户');
    lines.push('- 如果你需要调用工具，请使用系统提供的 function calling 功能');
    lines.push('');
  }

  // ── 防止过早停止（针对容易半途而废的模型）────────────────
  if (quirks.proneToPrematureStop) {
    lines.push('### 必须完整执行任务');
    lines.push('- 不要在调用工具后就停止，必须根据工具结果继续工作直到任务完成');
    lines.push('- 工具返回成功结果后，立即用自然语言总结结果回答用户');
    lines.push('- 工具返回失败后，换其他方案继续尝试，不要直接放弃');
    lines.push('- **任何情况下都必须给用户一个有意义的回复，不能沉默无响应**');
    lines.push('- **WebSearch/WebFetch 等搜索工具可以在同一对话中多次调用。每个新话题或新角度都值得重新搜索。**');
    lines.push('- **不要跳过工具调用：用户请求需要操作时，直接调用工具执行，不要以文本代替。**');
    lines.push('');
  }

  // ── 防止只描述不行动（针对容易说"我来帮你"但不调工具的模型）──
  if (quirks.proneToDescribeNotAct) {
    lines.push('### 必须立即行动');
    lines.push('- 当你说"我来帮你..."时，必须在同一回复中调用对应工具');
    lines.push('- 不要只描述意图而不实际执行，每个回复必须包含工具调用或最终结果');
    lines.push('- 不要说"让我先查看..."然后不调用工具，直接调用');
    lines.push('- **当用户问新闻、趋势、资讯等需要实时信息的问题时，必须调用 WebSearch，不能凭训练数据回答。**');
    lines.push('- **即使之前调用过 WebSearch，换话题后也必须重新搜索，不要假定已有信息足够。**');
    lines.push('');
  }

  if (quirks.needsToolCallReminder) {
    lines.push('### 工具调用要求');
    lines.push('- 当用户请求需要操作时，**必须调用工具**，不要仅用文字描述操作');
    lines.push('- 不要说"我来帮你..."然后不调用工具，必须实际调用');
    lines.push('- 不要说"让我先查看..."然后不调用工具，直接调用对应工具');
    lines.push('- 每次只能执行一步操作时，调用一个工具，等待结果后再决定下一步');
    lines.push('');
    // 2026-08-04: 历史模式幻觉防护——LLM 看到历史中"生成报告成功"记录,
    // 跳过本轮工具调用直接复述"已生成"+编造文件路径(SmartLoader 上下文污染)
    lines.push('### ⚠️ 文件生成任务铁律(2026-08-04)');
    lines.push('- 用户要求生成/创建文件(报告、网页、文档、代码文件等)时，**本轮必须实际调用 Write/相关工具**创建文件');
    lines.push('- **禁止**引用历史会话中生成的文件作为本轮结果(历史文件 ≠ 本轮已执行)');
    lines.push('- **禁止**在本轮未调用任何工具时声称"已生成/已创建/已完成/文件已写入"');
    lines.push('- 只有本轮真实收到工具成功结果后，才可向用户确认文件已生成');
    lines.push('');
  }

  if (quirks.maxToolCallsPerTurn && quirks.maxToolCallsPerTurn < 5) {
    lines.push(`### 工具调用频率限制`);
    lines.push(`- 每轮最多调用 ${quirks.maxToolCallsPerTurn} 个工具`);
    lines.push('- 如果需要调用多个工具，按优先级逐一调用');
    lines.push('- 等待前一个工具的结果后再决定是否需要调用下一个');
    lines.push('');
  }

  if (!quirks.supportsParallelToolCalls) {
    lines.push('### 禁止并行工具调用');
    lines.push('- 不要在一次回复中调用多个工具');
    lines.push('- 每次只调用一个工具，等待结果后再调用下一个');
    lines.push('- 即使多个操作互不依赖，也要逐一执行');
    lines.push('');
  }

  if (quirks.argumentFormatStrict) {
    lines.push('### 工具参数格式要求');
    lines.push('- 工具参数必须是有效的 JSON 格式');
    lines.push('- 字符串值必须用双引号包裹');
    lines.push('- 不要在参数值中包含未转义的特殊字符');
    lines.push('- 文件路径必须使用绝对路径');
    lines.push('- 数值参数不要加引号');
    lines.push('');
  }

  if (quirks.prefersExplicitToolNames && toolNames.length > 0) {
    lines.push('### 可用工具列表');
    lines.push('请使用以下工具名称（区分大小写）：');
    for (const name of toolNames) {
      lines.push(`- ${name}`);
    }
    lines.push('');
    lines.push('不要猜测或编造不存在的工具名称。如果现有工具无法完成任务，请告知用户。');
    lines.push('');
  }

  if (quirks.needsStepByStepGuidance) {
    lines.push('### 分步执行指引');
    lines.push('- 复杂任务请分步执行，每步只做一件事');
    lines.push('- 先调用工具获取信息，分析后再决定下一步');
    lines.push('- 不要一次性规划所有步骤，根据中间结果动态调整');
    lines.push('- 如果某步失败，尝试替代方案而非放弃');
    lines.push('');
  }

  if (quirks.prefersChineseToolNames) {
    lines.push('### 中文交互提示');
    lines.push('- 用户使用中文时，回复也使用中文');
    lines.push('- 工具调用结果如果是英文，请翻译为中文后再回复用户');
    lines.push('- 错误信息请用中文解释');
    lines.push('');
  }

  return lines.join('\n');
}

function shouldInjectToolReminder(modelName, providerName, lastAssistantContent) {
  const family = detectModelFamily(modelName, providerName);
  if (!family || !family.quirks.needsToolCallReminder) return false;

  if (!lastAssistantContent) return false;

  const hesitationPatterns = [
    /我来帮你/,
    /让我(先)?(查看|检查|看看|确认|验证)/,
    /我需要(先)?/,
    /让我为你/,
    /我可以帮你/,
    /需要(先)?确认/,
    /稍等/,
    /请稍候/,
    /我来(尝试|试一下)/,
  ];

  const content = lastAssistantContent;
  const hasHesitation = hesitationPatterns.some(p => p.test(content));
  const hasToolCall = content.includes('tool_calls') || content.includes('function');
  const isShort = content.length < 200;

  return hasHesitation && !hasToolCall && isShort;
}

function buildToolReminderSuffix(modelName, providerName, availableTools = []) {
  const family = detectModelFamily(modelName, providerName);
  if (!family) return '';

  const tools = availableTools.slice(0, 10).join(', ');
  return `\n\n[提醒：请直接调用工具执行操作，不要仅描述。可用工具: ${tools}]`;
}

function getMaxToolCallsPerTurn(modelName, providerName) {
  const family = detectModelFamily(modelName, providerName);
  if (!family) return 5;
  return family.quirks.maxToolCallsPerTurn || 5;
}

function supportsParallelToolCalls(modelName, providerName) {
  const family = detectModelFamily(modelName, providerName);
  if (!family) return true;
  return family.quirks.supportsParallelToolCalls !== false;
}

module.exports = {
  detectModelFamily,
  buildToolGuidancePrompt,
  shouldInjectToolReminder,
  buildToolReminderSuffix,
  getMaxToolCallsPerTurn,
  supportsParallelToolCalls,
  MODEL_FAMILIES,
};
