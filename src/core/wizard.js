/**
 * Wizard Pattern - 配置向导模式
 */

const { _maskToken } = require('./secret-redactor');

class WizardPrompter {
  constructor(backend = 'console') {
    this.backend = backend;
    this.colors = {
      reset: '\x1b[0m',
      bold: '\x1b[1m',
      dim: '\x1b[2m',
      green: '\x1b[32m',
      yellow: '\x1b[33m',
      blue: '\x1b[34m',
      cyan: '\x1b[36m',
    };
  }

  colorize(text, color) {
    if (this.backend !== 'console') return text;
    const code = this.colors[color];
    return code ? `${code}${text}${this.colors.reset}` : text;
  }

  async intro(message) {
    console.log();
    console.log(this.colorize('╭─────────────────────────────────────╮', 'cyan'));
    console.log(this.colorize(`│  ${message.padEnd(35)}│`, 'cyan'));
    console.log(this.colorize('╰─────────────────────────────────────╯', 'cyan'));
    console.log();
  }

  async outro(message) {
    console.log();
    console.log(this.colorize(`✓ ${message}`, 'green'));
    console.log();
  }

  async note(message, title = '') {
    if (title) {
      console.log();
      console.log(this.colorize(`┌─ ${title} ─`, 'bold'));
    }
    
    const lines = message.split('\n');
    for (const line of lines) {
      console.log(this.colorize(`│ ${line}`, 'dim'));
    }
    
    if (title) {
      console.log(this.colorize('└─', 'bold'));
    }
    console.log();
  }

  async text(params) {
    const { message, initialValue = '', placeholder = '' } = params;
    
    console.log();
    console.log(this.colorize(`? ${message}`, 'cyan'));
    if (placeholder) {
      console.log(this.colorize(`  ${placeholder}`, 'dim'));
    }
    
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    
    return new Promise((resolve) => {
      const prompt = initialValue ? `  [${initialValue}]: ` : '  : ';
      rl.question(this.colorize(prompt, 'yellow'), (answer) => {
        rl.close();
        resolve(answer.trim() || initialValue);
      });
    });
  }

  async confirm(params) {
    const { message, initialValue = false } = params;
    
    console.log();
    console.log(this.colorize(`? ${message}`, 'cyan'));
    
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    
    return new Promise((resolve) => {
      const defaultHint = initialValue ? 'Y/n' : 'y/N';
      rl.question(this.colorize(`  [${defaultHint}]: `, 'yellow'), (answer) => {
        rl.close();
        const normalized = answer.trim().toLowerCase();
        if (normalized === 'y' || normalized === 'yes') resolve(true);
        else if (normalized === 'n' || normalized === 'no') resolve(false);
        else resolve(initialValue);
      });
    });
  }

  async select(params) {
    const { message, options, initialValue } = params;
    
    console.log();
    console.log(this.colorize(`? ${message}`, 'cyan'));
    
    for (let i = 0; i < options.length; i++) {
      const option = options[i];
      const num = this.colorize(`  ${i + 1}.`, 'dim');
      const label = this.colorize(option.label, 'bold');
      const hint = option.hint ? this.colorize(` - ${option.hint}`, 'dim') : '';
      console.log(`${num} ${label}${hint}`);
    }
    
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    
    return new Promise((resolve) => {
      const defaultIndex = initialValue
        ? options.findIndex(o => o.value === initialValue) + 1
        : '';
      rl.question(this.colorize(`  Select [1-${options.length}]${defaultIndex ? ` [${defaultIndex}]` : ''}: `, 'yellow'), (answer) => {
        rl.close();
        
        const num = parseInt(answer.trim());
        if (num >= 1 && num <= options.length) {
          resolve(options[num - 1].value);
        } else if (defaultIndex) {
          resolve(options[defaultIndex - 1].value);
        } else {
          resolve(options[0].value);
        }
      });
    });
  }

  async multiselect(params) {
    const { message, options, initialValues = [] } = params;
    
    console.log();
    console.log(this.colorize(`? ${message} (space to select, enter to confirm)`, 'cyan'));
    
    for (let i = 0; i < options.length; i++) {
      const option = options[i];
      const selected = initialValues.includes(option.value);
      const checkbox = selected ? this.colorize('◉', 'green') : '○';
      const num = this.colorize(`  ${i + 1}.`, 'dim');
      const label = this.colorize(option.label, 'bold');
      const hint = option.hint ? this.colorize(` - ${option.hint}`, 'dim') : '';
      console.log(`${checkbox} ${num} ${label}${hint}`);
    }
    
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    
    return new Promise((resolve) => {
      rl.question(this.colorize('  Selected: ', 'yellow'), (answer) => {
        rl.close();
        
        const nums = answer.trim().split(/\s+/).map(n => parseInt(n));
        const selected = nums
          .filter(n => n >= 1 && n <= options.length)
          .map(n => options[n - 1].value);
        
        resolve(selected.length > 0 ? selected : initialValues);
      });
    });
  }

  async password(params) {
    const { message, placeholder = '' } = params;
    
    console.log();
    console.log(this.colorize(`? ${message}`, 'cyan'));
    if (placeholder) {
      console.log(this.colorize(`  ${placeholder}`, 'dim'));
    }
    
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    
    return new Promise((resolve) => {
      process.stdout.write(this.colorize('  : ', 'yellow'));
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      
      let password = '';
      process.stdin.on('data', (char) => {
        if (char === '\n' || char === '\r' || char === '\u0004') {
          process.stdin.setRawMode(false);
          rl.close();
          console.log();
          resolve(password);
        } else if (char === '\u0003') {
          process.exit();
        } else if (char === '\u007F') {
          password = password.slice(0, -1);
        } else {
          password += char;
        }
      });
    });
  }

  async spinner(message, task) {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;
    let interval = null;
    
    const start = () => {
      interval = setInterval(() => {
        const frame = this.colorize(frames[i], 'cyan');
        process.stdout.write(`\r${frame} ${message}`);
        i = (i + 1) % frames.length;
      }, 80);
    };
    
    const stop = () => {
      if (interval) {
        clearInterval(interval);
        process.stdout.write('\r' + ' '.repeat(message.length + 2) + '\r');
      }
    };
    
    start();
    try {
      const result = await task();
      stop();
      console.log(this.colorize(`✓ ${message}`, 'green'));
      return result;
    } catch (error) {
      stop();
      console.log(this.colorize(`✗ ${message}`, 'yellow'));
      throw error;
    }
  }
}

class Wizard {
  constructor(prompter = new WizardPrompter()) {
    this.prompter = prompter;
    this.steps = [];
    this.currentStep = 0;
    this.context = {};
    this.cancelled = false;
  }

  addStep(step) {
    this.steps.push(step);
    return this;
  }

  async run() {
    for (const step of this.steps) {
      try {
        const result = await step.execute(this.prompter, this.context);
        
        if (result.cancelled) {
          this.cancelled = true;
          await this.prompter.outro('Setup cancelled');
          return { cancelled: true, context: this.context };
        }
        
        this.context = { ...this.context, ...result.data };
        this.currentStep++;
      } catch (error) {
        console.error(`Step failed: ${step.name}`, error);
        throw error;
      }
    }
    
    return { cancelled: false, context: this.context };
  }

  getProgress() {
    return {
      current: this.currentStep,
      total: this.steps.length,
      percentage: Math.round((this.currentStep / this.steps.length) * 100),
    };
  }
}

class WizardStep {
  constructor(name, execute) {
    this.name = name;
    this.execute = execute;
  }
}

class SetupWizard extends Wizard {
  constructor(prompter) {
    super(prompter);
    this.setupDefaultSteps();
  }

  setupDefaultSteps() {
    this.addStep(new WizardStep('welcome', async (prompter, _context) => {
      await prompter.note(
        'Welcome to CrabPaw Setup!\n\nThis wizard will help you configure:\n• AI Model & API Key\n• Enterprise Profile\n• Channels (Telegram, Discord, etc.)\n• Tool permissions',
        'Welcome'
      );
      return { data: {} };
    }));

    this.addStep(new WizardStep('risk-acknowledgement', async (prompter, _context) => {
      await prompter.note(
        [
          'Security warning — please read.',
          '',
          'CrabPaw is a personal agent: one trusted operator boundary.',
          'This bot can read files and run actions if tools are enabled.',
          'A bad prompt can trick it into doing unsafe things.',
          '',
          'Recommended baseline:',
          '- Use allowlists + mention gating.',
          '- Sandbox + least-privilege tools.',
          '- Keep secrets out of the agent\'s reachable filesystem.',
          '- Use the strongest available model for any bot with tools.',
        ].join('\n'),
        'Security'
      );

      const ok = await prompter.confirm({
        message: 'I understand the security implications. Continue?',
        initialValue: false,
      });

      if (!ok) {
        return { cancelled: true };
      }

      return { data: { riskAcknowledged: true } };
    }));

    this.addStep(new WizardStep('enterprise-profile', async (prompter, _context) => {
      // eslint-disable-next-line no-unused-vars
      const { EnterpriseWizard, BUSINESS_TYPES, INDUSTRIES, SCALES } = require('./agent/enterprise-wizard');

      await prompter.note(
        'CrabPaw can auto-configure agents based on your enterprise type.\nThis enables domain-specific intelligence and role composition.',
        'Enterprise Profile'
      );

      const quickSetup = await prompter.confirm({
        message: 'Quick setup? (Describe your company in one sentence)',
        initialValue: true,
      });

      if (quickSetup) {
        const description = await prompter.text({
          message: 'Describe your company (e.g., "We are a SaaS startup in fintech")',
          placeholder: 'Type your company description...',
        });

        if (description.trim()) {
          const { EnterpriseTypeInferencer } = require('./agent/enterprise-type-inferencer');
          const inferencer = new EnterpriseTypeInferencer();
          const inference = inferencer.inferFromDescription(description);

          if (inference.overallConfidence > 0.5) {
            await prompter.note(
              [
                `Detected: ${inference.type || 'unknown'} / ${inference.industry || 'unknown'} / ${inference.scale || 'unknown'}`,
                `Confidence: ${(inference.overallConfidence * 100).toFixed(0)}%`,
              ].join('\n'),
              'Auto-detected Profile'
            );

            const accept = await prompter.confirm({
              message: 'Accept this profile?',
              initialValue: true,
            });

            if (accept) {
              return { data: { enterpriseProfile: inference } };
            }
          }
        }
      }

      const businessType = await prompter.select({
        message: 'Select Business Type',
        options: BUSINESS_TYPES.map(b => ({ value: b.id, label: b.name, hint: b.description })),
      });

      const industry = await prompter.select({
        message: 'Select Industry',
        options: INDUSTRIES.map(i => ({ value: i.id, label: i.name })),
      });

      const scale = await prompter.select({
        message: 'Select Company Scale',
        options: SCALES.map(s => ({ value: s.id, label: s.name, hint: s.description })),
      });

      return { data: { enterpriseProfile: { businessType, industry, scale, confidence: 1.0 } } };
    }));

    this.addStep(new WizardStep('model-selection', async (prompter, _context) => {
      const model = await prompter.select({
        message: 'Select AI Model',
        options: [
          { value: 'minimax', label: 'MiniMax', hint: '推荐，国内' },
          { value: 'kimi', label: 'Kimi (月之暗面)', hint: '国内，快' },
          { value: 'deepseek', label: 'DeepSeek', hint: '国内，便宜' },
          { value: 'zhipu', label: '智谱 GLM', hint: '国内，有免费' },
          { value: 'qwen', label: '通义千问', hint: '国内，有免费' },
          // 国内 Coding Plan 套餐（订阅制，一个 Key 通多模型）
          { value: 'tencent_coding', label: '腾讯云 Coding Plan', hint: '订阅套餐，自动匹配最优模型' },
          { value: 'aliyun_coding', label: '阿里云百炼 Coding Plan', hint: '订阅套餐，Qwen3 Coder 主力' },
          { value: 'volc_coding', label: '火山引擎 Coding Plan', hint: '订阅套餐，Doubao Seed Code' },
          { value: 'openai', label: 'OpenAI GPT-4o', hint: '强，需翻墙' },
          { value: 'claude', label: 'Claude Sonnet 4', hint: '强，需翻墙' },
          { value: 'custom', label: 'Custom OpenAI-Compatible', hint: '自定义配置' },
        ],
        initialValue: 'minimax',
      });

      // Coding Plan 套餐说明
      const codingPlanProviders = ['tencent_coding', 'aliyun_coding', 'volc_coding'];
      if (codingPlanProviders.includes(model)) {
        await prompter.note(
          [
            'Coding Plan 套餐说明：',
            '',
            '• 国内云厂商推出的编码订阅套餐，一个 API Key 可调用多家模型',
            '• 腾讯云：tc-code-latest / GLM-5 / Kimi-K2.5 / MiniMax-M2.5 等',
            '• 阿里云：Qwen3 Coder Plus / Qwen3.7 Plus / Kimi-K2.5 / GLM-5 等',
            '• 火山引擎：Doubao Seed Code Preview / Ark Code (DeepSeek V3.2)',
            '',
            '请到对应厂商控制台开通套餐后获取专属 API Key（通常以 sk-sp- 开头）',
          ].join('\n'),
          '💡 Coding Plan'
        );
      }

      return { data: { model } };
    }));

    this.addStep(new WizardStep('api-key', async (prompter, context) => {
      const apiKey = await prompter.password({
        message: `Enter API Key for ${context.model}`,
        placeholder: 'Your key is stored locally and never uploaded',
      });

      return { data: { apiKey } };
    }));

    this.addStep(new WizardStep('tool-profile', async (prompter, _context) => {
      const profile = await prompter.select({
        message: 'Select Tool Permission Profile',
        options: [
          { value: 'minimal', label: 'Minimal', hint: '仅读取和状态查看' },
          { value: 'coding', label: 'Coding', hint: '编程助手，包含文件操作和执行权限' },
          { value: 'messaging', label: 'Messaging', hint: '消息助手，专注于会话管理' },
          { value: 'full', label: 'Full', hint: '完整权限，无限制' },
        ],
        initialValue: 'coding',
      });

      return { data: { toolProfile: profile } };
    }));

    this.addStep(new WizardStep('channels', async (prompter, _context) => {
      const channels = await prompter.multiselect({
        message: 'Select Channels to Enable',
        options: [
          { value: 'telegram', label: 'Telegram', hint: 'Bot API' },
          { value: 'discord', label: 'Discord', hint: 'Bot API' },
          { value: 'slack', label: 'Slack', hint: 'Bot API' },
          { value: 'lark', label: 'Feishu (Lark)', hint: 'Bot API' },
          { value: 'web', label: 'Web Chat', hint: 'HTTP interface' },
          { value: 'cli', label: 'CLI', hint: 'Terminal interface' },
        ],
        initialValues: ['cli'],
      });

      return { data: { channels } };
    }));

    this.addStep(new WizardStep('completion', async (prompter, context) => {
      const profileLines = [];
      if (context.enterpriseProfile) {
        const ep = context.enterpriseProfile;
        profileLines.push(`Enterprise: ${ep.businessType || 'N/A'} / ${ep.industry || 'N/A'} / ${ep.scale || 'N/A'}`);
      }

      await prompter.note(
        [
          'Configuration Summary:',
          '',
          `Model: ${context.model}`,
          `API Key: ${context.apiKey ? _maskToken(context.apiKey) : 'not set'}`,
          ...profileLines,
          `Tool Profile: ${context.toolProfile}`,
          `Channels: ${context.channels.join(', ')}`,
        ].join('\n'),
        'Ready to Start'
      );

      const confirm = await prompter.confirm({
        message: 'Save configuration and start?',
        initialValue: true,
      });

      if (!confirm) {
        return { cancelled: true };
      }

      return { data: { confirmed: true } };
    }));
  }
}

module.exports = {
  WizardPrompter,
  Wizard,
  WizardStep,
  SetupWizard,
};
