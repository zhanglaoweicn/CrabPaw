/**
 * CrabPaw CLI - 核心命令
 * 
 * 命令:
 * - insights: 使用洞察报告
 * - pricing: 定价查询
 * - credentials: 凭证管理
 * - pairing: 配对授权
 * - hooks: 钩子管理
 * - skin: 皮肤管理
 */

const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora');
const Table = require('cli-table3');

const core = require('../../core');
function createInsightsCommand() {
  const cmd = new Command('insights')
    .description('生成使用洞察报告')
    .option('-d, --days <days>', '分析天数', '30')
    .option('-s, --source <source>', '数据源过滤')
    .option('--json', 'JSON 格式输出')
    .action(async (options) => {
      const spinner = ora('生成洞察报告...').start();
      
      try {
        const engine = new core.insights.InsightsEngine();
        await engine.initialize();
        
        const report = await engine.generateReport(
          parseInt(options.days, 10),
          options.source
        );
        
        spinner.stop();
        
        if (options.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          console.log(engine.formatTerminalReport(report));
        }
        
        engine.close();
      } catch (error) {
        spinner.fail('生成报告失败');
        console.error(chalk.red(error.message));
      }
    });
  
  return cmd;
}

function createPricingCommand() {
  const cmd = new Command('pricing')
    .description('查询模型定价')
    .option('-m, --model <model>', '模型名称')
    .option('-l, --list', '列出所有支持的模型')
    .option('-c, --compare <models>', '比较多个模型 (逗号分隔)')
    .option('--tokens <tokens>', '估算 Token 数量', '1000000')
    .action((options) => {
      if (options.list) {
        const models = core.pricing.listSupportedModels();
        
        const table = new Table({
          head: ['供应商', '模型', '输入 ($/M)', '输出 ($/M)', '缓存读取 ($/M)'],
          style: { head: ['cyan'] }
        });
        
        for (const m of models) {
          table.push([
            m.provider,
            m.model,
            m.inputPerMillion?.toFixed(2) || '-',
            m.outputPerMillion?.toFixed(2) || '-',
            m.cacheReadPerMillion?.toFixed(2) || '-'
          ]);
        }
        
        console.log(table.toString());
        return;
      }
      
      if (options.model) {
        const pricing = core.pricing.findModelPricing(options.model);
        const tokens = parseInt(options.tokens, 10);
        
        const cost = core.pricing.estimateCost({
          inputTokens: tokens,
          outputTokens: tokens / 2
        }, options.model);
        
        console.log(chalk.bold('\n模型定价信息'));
        console.log('─'.repeat(40));
        console.log(`模型: ${chalk.cyan(options.model)}`);
        console.log(`供应商: ${chalk.yellow(pricing.provider)}`);
        console.log(`输入: $${pricing.input}/M tokens`);
        console.log(`输出: $${pricing.output}/M tokens`);
        if (pricing.cacheRead) {
          console.log(`缓存读取: $${pricing.cacheRead}/M tokens`);
        }
        if (pricing.cacheWrite) {
          console.log(`缓存写入: $${pricing.cacheWrite}/M tokens`);
        }
        console.log(`\n估算成本 (${tokens.toLocaleString()} tokens):`);
        console.log(`  总计: ${chalk.green(core.pricing.formatCost(cost.totalCost))}`);
        return;
      }
      
      if (options.compare) {
        const models = options.compare.split(',').map(m => m.trim());
        const comparison = core.pricing.compareModels(models);
        
        const table = new Table({
          head: ['模型', '供应商', '输入 ($/M)', '输出 ($/M)'],
          style: { head: ['cyan'] }
        });
        
        for (const c of comparison) {
          table.push([
            c.model,
            c.provider,
            c.inputPerMillion?.toFixed(2) || '-',
            c.outputPerMillion?.toFixed(2) || '-'
          ]);
        }
        
        console.log(table.toString());
        return;
      }
      
      console.log(chalk.yellow('请使用 --model, --list 或 --compare 选项'));
    });
  
  return cmd;
}

function createCredentialsCommand() {
  const cmd = new Command('credentials')
    .description('管理凭证池')
    .option('-l, --list', '列出所有凭证')
    .option('-a, --add', '添加凭证')
    .option('-r, --remove <id>', '删除凭证')
    .option('-s, --stats', '显示统计信息')
    .option('--strategy <strategy>', '设置选择策略')
    .action((options) => {
      const pool = new core.credentials.CredentialPool();
      
      if (options.list) {
        const creds = pool.listCredentials();
        
        if (creds.length === 0) {
          console.log(chalk.yellow('暂无凭证'));
          return;
        }
        
        const table = new Table({
          head: ['ID', '供应商', '类型', '状态', '使用次数'],
          style: { head: ['cyan'] }
        });
        
        for (const c of creds) {
          table.push([
            c.id.slice(0, 8),
            c.provider,
            c.type,
            c.isHealthy ? chalk.green('健康') : chalk.red('异常'),
            c.usageCount
          ]);
        }
        
        console.log(table.toString());
        return;
      }
      
      if (options.stats) {
        const stats = pool.getStats();
        console.log(chalk.bold('\n凭证池统计'));
        console.log('─'.repeat(40));
        console.log(`总数: ${stats.total}`);
        console.log(`健康: ${chalk.green(stats.healthy)}`);
        console.log(`异常: ${chalk.red(stats.unhealthy)}`);
        console.log(`策略: ${stats.strategy}`);
        
        if (Object.keys(stats.byProvider).length > 0) {
          console.log('\n按供应商:');
          for (const [provider, data] of Object.entries(stats.byProvider)) {
            console.log(`  ${provider}: ${data.healthy}/${data.total} 健康, ${data.totalUsage} 次使用`);
          }
        }
        return;
      }
      
      if (options.strategy) {
        if (pool.setStrategy(options.strategy)) {
          console.log(chalk.green(`策略已设置为: ${options.strategy}`));
        } else {
          console.log(chalk.red('无效的策略，可选: fill_first, round_robin, random, least_used'));
        }
        return;
      }
      
      if (options.remove) {
        if (pool.removeCredential(options.remove)) {
          console.log(chalk.green('凭证已删除'));
        } else {
          console.log(chalk.red('凭证不存在'));
        }
        return;
      }
      
      console.log(chalk.yellow('请使用 --list, --stats, --add 或 --remove 选项'));
    });
  
  return cmd;
}

function createPairingCommand() {
  const cmd = new Command('pairing')
    .description('管理配对授权')
    .option('-g, --generate <platform>', '生成配对码')
    .option('-v, --verify <code>', '验证配对码')
    .option('-l, --list', '列出授权用户')
    .option('-r, --revoke <userId>', '撤销授权')
    .option('--platform <platform>', '指定平台')
    .action((options) => {
      const pairing = new core.auth.PairingSystem();
      
      if (options.generate && options.platform) {
        const result = pairing.generateCode(options.platform, 'cli-user', 'CLI User');
        
        if (result.success) {
          console.log(chalk.bold('\n配对码已生成'));
          console.log('─'.repeat(40));
          console.log(`配对码: ${chalk.cyan.bold(result.code)}`);
          console.log(`过期时间: ${new Date(result.expiresAt).toLocaleString()}`);
          console.log(`有效期: ${result.expiresIn} 秒`);
        } else {
          console.log(chalk.red(`生成失败: ${result.message}`));
        }
        return;
      }
      
      if (options.verify && options.platform) {
        const result = pairing.verifyCode(options.verify, options.platform);
        
        if (result.success) {
          console.log(chalk.green('验证成功!'));
          console.log(`用户: ${result.userName || result.userId}`);
        } else {
          console.log(chalk.red(`验证失败: ${result.message}`));
        }
        return;
      }
      
      if (options.list) {
        const auths = pairing.listAuthorizations(options.platform);
        
        if (auths.length === 0) {
          console.log(chalk.yellow('暂无授权用户'));
          return;
        }
        
        const table = new Table({
          head: ['平台', '用户ID', '用户名', '授权时间'],
          style: { head: ['cyan'] }
        });
        
        for (const a of auths) {
          table.push([
            a.platform,
            a.userId,
            a.userName || '-',
            new Date(a.authorizedAt).toLocaleString()
          ]);
        }
        
        console.log(table.toString());
        return;
      }
      
      if (options.revoke && options.platform) {
        if (pairing.revokeAuthorization(options.platform, options.revoke)) {
          console.log(chalk.green('授权已撤销'));
        } else {
          console.log(chalk.red('撤销失败'));
        }
        return;
      }
      
      console.log(chalk.yellow('请使用 --generate, --verify, --list 或 --revoke 选项'));
    });
  
  return cmd;
}

function createSkinCommand() {
  const cmd = new Command('skin')
    .description('管理 UI 主题')
    .option('-l, --list', '列出所有主题')
    .option('-s, --set <name>', '设置当前主题')
    .option('-c, --current', '显示当前主题')
    .option('-e, --export <name>', '导出主题')
    .action((options) => {
      const skinEngine = new core.skin.SkinEngine();
      
      if (options.list) {
        const skins = skinEngine.listSkins();
        
        const table = new Table({
          head: ['名称', '描述', '类型', '当前'],
          style: { head: ['cyan'] }
        });
        
        for (const s of skins) {
          table.push([
            s.name,
            s.description || '-',
            s.isCustom ? '自定义' : '内置',
            s.isCurrent ? chalk.green('✓') : ''
          ]);
        }
        
        console.log(table.toString());
        return;
      }
      
      if (options.set) {
        if (skinEngine.setSkin(options.set)) {
          console.log(chalk.green(`主题已切换为: ${options.set}`));
        } else {
          console.log(chalk.red('主题不存在'));
        }
        return;
      }
      
      if (options.current) {
        const skin = skinEngine.getCurrentSkin();
        console.log(chalk.bold(`\n当前主题: ${chalk.cyan(skin.name)}`));
        console.log('─'.repeat(40));
        console.log(`描述: ${skin.description || '无'}`);
        console.log(`品牌: ${skin.branding.name}`);
        console.log(`标语: ${skin.branding.tagline || '无'}`);
        console.log(`主色: ${skin.colors.primary}`);
        console.log(`工具前缀: ${skin.toolPrefix}`);
        return;
      }
      
      if (options.export) {
        const exported = skinEngine.exportSkin(options.export);
        if (exported) {
          console.log(exported);
        } else {
          console.log(chalk.red('主题不存在'));
        }
        return;
      }
      
      console.log(chalk.yellow('请使用 --list, --set, --current 或 --export 选项'));
    });
  
  return cmd;
}

function createHooksCommand() {
  const cmd = new Command('hooks')
    .description('管理事件钩子')
    .option('-l, --list', '列出所有钩子')
    .option('-e, --enable <name>', '启用钩子')
    .option('-d, --disable <name>', '禁用钩子')
    .option('-r, --remove <name>', '删除钩子')
    .action((options) => {
      const hookManager = new core.hooks.HookManager();
      
      if (options.list) {
        const hooks = hookManager.listHooks();
        
        if (hooks.length === 0) {
          console.log(chalk.yellow('暂无钩子'));
          return;
        }
        
        const table = new Table({
          head: ['名称', '事件类型', '状态', '描述'],
          style: { head: ['cyan'] }
        });
        
        for (const h of hooks) {
          table.push([
            h.name,
            h.eventType,
            h.enabled ? chalk.green('启用') : chalk.red('禁用'),
            h.description || '-'
          ]);
        }
        
        console.log(table.toString());
        return;
      }
      
      if (options.enable) {
        if (hookManager.enableHook(options.enable)) {
          console.log(chalk.green(`钩子已启用: ${options.enable}`));
        } else {
          console.log(chalk.red('钩子不存在'));
        }
        return;
      }
      
      if (options.disable) {
        if (hookManager.disableHook(options.disable)) {
          console.log(chalk.yellow(`钩子已禁用: ${options.disable}`));
        } else {
          console.log(chalk.red('钩子不存在'));
        }
        return;
      }
      
      if (options.remove) {
        if (hookManager.unregisterHook(options.remove)) {
          console.log(chalk.green(`钩子已删除: ${options.remove}`));
        } else {
          console.log(chalk.red('钩子不存在'));
        }
        return;
      }
      
      console.log(chalk.yellow('请使用 --list, --enable, --disable 或 --remove 选项'));
    });
  
  return cmd;
}

function setupCoreCommands(program) {
  program.addCommand(createInsightsCommand());
  program.addCommand(createPricingCommand());
  program.addCommand(createCredentialsCommand());
  program.addCommand(createPairingCommand());
  program.addCommand(createSkinCommand());
  program.addCommand(createHooksCommand());
}

module.exports = {
  setupCoreCommands,
  createInsightsCommand,
  createPricingCommand,
  createCredentialsCommand,
  createPairingCommand,
  createSkinCommand,
  createHooksCommand
};
