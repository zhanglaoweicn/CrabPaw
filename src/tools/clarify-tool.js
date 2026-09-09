const { registry } = require('../tools/registry');

registry.register({
  name: 'Clarify',
  toolset: 'interaction',
  category: 'interaction',
  schema: {
    description: '当任务不明确、需要用户决策或需要更多信息时，向用户提出澄清问题。不要猜测用户意图，而是主动询问。',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: '要向用户提出的问题'
        },
        options: {
          type: 'array',
          description: '可选的选项列表（最多4个），用户可以从中选择',
          items: { type: 'string' },
          maxItems: 4
        },
        context: {
          type: 'string',
          description: '为什么需要澄清，当前的困惑点是什么'
        }
      },
      required: ['question']
    }
  },
  handler: async (params) => {
    const { question, options, context } = params;

    if (!question || !question.trim()) {
      return { error: '问题不能为空' };
    }

    let result = '';

    if (context) {
      result += `💭 ${context}\n\n`;
    }

    result += `❓ ${question}`;

    if (options && Array.isArray(options) && options.length > 0) {
      const validOptions = options.slice(0, 4);
      result += '\n\n';
      validOptions.forEach((opt, i) => {
        result += `${i + 1}. ${opt}\n`;
      });
      result += '\n请选择编号或输入你的回答。';
    }

    return result;
  },
  isReadOnly: true
});

console.log('✅ 澄清工具已注册: Clarify');
