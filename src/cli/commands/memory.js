/**
 * CrabPaw CLI - 记忆系统命令
 * 
 * 命令:
 * - memory add: 添加记忆
 * - memory search: 搜索记忆
 * - memory list: 列出记忆
 * - memory stats: 记忆统计
 * - memory entity: 实体管理
 * - memory feedback: 记录反馈
 * - memory export: 导出记忆
 * - memory import: 导入记忆
 * - memory benchmark: 性能基准测试
 */

const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora');
const Table = require('cli-table3');
const path = require('path');
const fs = require('fs').promises;

const core = require('../../core');
const { DATA_DIR: CONFIG_DATA_DIR } = require('../../core/config');

const DATA_DIR = path.join(CONFIG_DATA_DIR, 'memory');

function getMemorySystem() {
  return new core.memory.EnhancedMemorySystem({
    dataDir: DATA_DIR,
    hrrDim: 512,
    maxFacts: 500,
  });
}

function createMemoryCommand() {
  const cmd = new Command('memory')
    .description('记忆系统管理')
    .addCommand(createAddCommand())
    .addCommand(createSearchCommand())
    .addCommand(createListCommand())
    .addCommand(createStatsCommand())
    .addCommand(createEntityCommand())
    .addCommand(createFeedbackCommand())
    .addCommand(createExportCommand())
    .addCommand(createImportCommand())
    .addCommand(createBenchmarkCommand())
    .addCommand(createCleanCommand());
  
  return cmd;
}

function createAddCommand() {
  return new Command('add')
    .description('添加新记忆')
    .argument('<content>', '记忆内容')
    .option('-c, --category <category>', '分类', 'general')
    .option('-t, --tags <tags>', '标签 (逗号分隔)')
    .option('--confidence <confidence>', '置信度', '0.8')
    .option('--agent <agent>', '关联代理')
    .option('--json', 'JSON 格式输出')
    .action(async (content, options) => {
      const spinner = ora('添加记忆...').start();
      
      try {
        const memorySystem = getMemorySystem();
        await memorySystem.initialize();
        
        const fact = await memorySystem.addFact(content, {
          category: options.category,
          tags: options.tags ? options.tags.split(',').map(t => t.trim()) : [],
          confidence: parseFloat(options.confidence),
          agentName: options.agent,
        });
        
        spinner.succeed('记忆添加成功');
        
        if (options.json) {
          console.log(JSON.stringify(fact, null, 2));
        } else {
          console.log(chalk.bold('\n记忆详情'));
          console.log('─'.repeat(50));
          console.log(`ID: ${chalk.cyan(fact.id)}`);
          console.log(`内容: ${fact.content}`);
          console.log(`分类: ${chalk.yellow(fact.category)}`);
          console.log(`信任评分: ${formatTrustScore(fact.trustScore)}`);
          console.log(`实体: ${fact.entities?.map(e => e.name).join(', ') || '无'}`);
          console.log(`标签: ${fact.tags?.join(', ') || '无'}`);
        }
      } catch (error) {
        spinner.fail('添加记忆失败');
        console.error(chalk.red(error.message));
        process.exit(1);
      }
    });
}

function createSearchCommand() {
  return new Command('search')
    .description('搜索记忆')
    .argument('<query>', '搜索查询')
    .option('-l, --limit <limit>', '结果数量限制', '10')
    .option('-c, --category <category>', '分类过滤')
    .option('-t, --min-trust <trust>', '最低信任评分', '0')
    .option('--json', 'JSON 格式输出')
    .action(async (query, options) => {
      const spinner = ora('搜索记忆...').start();
      
      try {
        const memorySystem = getMemorySystem();
        await memorySystem.initialize();
        
        const results = await memorySystem.search(query, {
          limit: parseInt(options.limit, 10),
          category: options.category,
          minTrust: parseFloat(options.minTrust),
        });
        
        spinner.succeed(`找到 ${results.length} 条记忆`);
        
        if (options.json) {
          console.log(JSON.stringify(results, null, 2));
        } else {
          if (results.length === 0) {
            console.log(chalk.gray('没有找到匹配的记忆'));
            return;
          }
          
          const table = new Table({
            head: ['ID', '内容', '分类', '评分', '信任'],
            style: { head: ['cyan'] },
            colWidths: [12, 40, 12, 8, 8],
          });
          
          for (const r of results) {
            table.push([
              r.id.slice(0, 10),
              r.content.slice(0, 37) + (r.content.length > 37 ? '...' : ''),
              r.category || '-',
              r.score?.toFixed(2) || '-',
              formatTrustScore(r.trustScore),
            ]);
          }
          
          console.log(table.toString());
        }
      } catch (error) {
        spinner.fail('搜索失败');
        console.error(chalk.red(error.message));
        process.exit(1);
      }
    });
}

function createListCommand() {
  return new Command('list')
    .description('列出记忆')
    .option('-c, --category <category>', '分类过滤')
    .option('-l, --limit <limit>', '数量限制', '20')
    .option('--sort <field>', '排序字段', 'updatedAt')
    .option('--desc', '降序排列')
    .option('--json', 'JSON 格式输出')
    .action(async (options) => {
      const spinner = ora('加载记忆...').start();
      
      try {
        const memorySystem = getMemorySystem();
        await memorySystem.initialize();
        
        const stats = await memorySystem.getStats();
        const facts = stats.facts || [];
        
        spinner.succeed(`共 ${facts.length} 条记忆`);
        
        if (options.json) {
          console.log(JSON.stringify(facts, null, 2));
        } else {
          if (facts.length === 0) {
            console.log(chalk.gray('暂无记忆'));
            return;
          }
          
          const table = new Table({
            head: ['ID', '内容', '分类', '信任', '更新时间'],
            style: { head: ['cyan'] },
            colWidths: [12, 35, 12, 8, 16],
          });
          
          const sorted = [...facts].sort((a, b) => {
            const field = options.sort;
            const aVal = a[field] || 0;
            const bVal = b[field] || 0;
            return options.desc ? bVal - aVal : aVal - bVal;
          });
          
          const limited = sorted.slice(0, parseInt(options.limit, 10));
          
          for (const f of limited) {
            const date = f.updatedAt ? new Date(f.updatedAt).toLocaleDateString() : '-';
            table.push([
              f.id.slice(0, 10),
              f.content.slice(0, 32) + (f.content.length > 32 ? '...' : ''),
              f.category || '-',
              formatTrustScore(f.trustScore),
              date,
            ]);
          }
          
          console.log(table.toString());
        }
      } catch (error) {
        spinner.fail('加载失败');
        console.error(chalk.red(error.message));
        process.exit(1);
      }
    });
}

function createStatsCommand() {
  return new Command('stats')
    .description('显示记忆系统统计')
    .option('--json', 'JSON 格式输出')
    .action(async (options) => {
      const spinner = ora('收集统计信息...').start();
      
      try {
        const memorySystem = getMemorySystem();
        await memorySystem.initialize();
        
        const stats = await memorySystem.getStats();
        
        spinner.stop();
        
        if (options.json) {
          console.log(JSON.stringify(stats, null, 2));
        } else {
          console.log(chalk.bold('\n记忆系统统计'));
          console.log('═'.repeat(50));
          
          console.log(chalk.cyan('\n总览'));
          console.log('─'.repeat(30));
          console.log(`总记忆数: ${stats.totalFacts}`);
          console.log(`实体数: ${stats.entities?.total || 0}`);
          console.log(`缓存大小: ${stats.cache?.size || 0}`);
          
          if (stats.entities?.byType) {
            console.log(chalk.cyan('\n实体类型分布'));
            console.log('─'.repeat(30));
            
            const table = new Table({
              head: ['类型', '数量'],
              style: { head: ['cyan'] },
            });
            
            for (const [type, count] of Object.entries(stats.entities.byType)) {
              table.push([type, count]);
            }
            
            console.log(table.toString());
          }
          
          if (stats.trustDistribution) {
            console.log(chalk.cyan('\n信任评分分布'));
            console.log('─'.repeat(30));
            console.log(`高 (>0.7): ${stats.trustDistribution.high || 0}`);
            console.log(`中 (0.3-0.7): ${stats.trustDistribution.medium || 0}`);
            console.log(`低 (<0.3): ${stats.trustDistribution.low || 0}`);
          }
        }
      } catch (error) {
        spinner.fail('获取统计失败');
        console.error(chalk.red(error.message));
        process.exit(1);
      }
    });
}

function createEntityCommand() {
  const cmd = new Command('entity')
    .description('实体管理')
    .addCommand(new Command('list')
      .description('列出所有实体')
      .option('-t, --type <type>', '类型过滤')
      .option('-l, --limit <limit>', '数量限制', '20')
      .option('--json', 'JSON 格式输出')
      .action(async (options) => {
        const spinner = ora('加载实体...').start();
        
        try {
          const memorySystem = getMemorySystem();
          await memorySystem.initialize();
          
          const stats = await memorySystem.getStats();
          const entities = stats.entities?.all || [];
          
          spinner.succeed(`共 ${entities.length} 个实体`);
          
          if (options.json) {
            console.log(JSON.stringify(entities, null, 2));
          } else {
            if (entities.length === 0) {
              console.log(chalk.gray('暂无实体'));
              return;
            }
            
            const table = new Table({
              head: ['名称', '类型', '关联记忆数', '别名'],
              style: { head: ['cyan'] },
              colWidths: [20, 12, 12, 20],
            });
            
            const filtered = options.type
              ? entities.filter(e => e.type === options.type)
              : entities;
            
            const limited = filtered.slice(0, parseInt(options.limit, 10));
            
            for (const e of limited) {
              table.push([
                e.name,
                e.type,
                e.factCount || 0,
                (e.aliases || []).slice(0, 2).join(', ') || '-',
              ]);
            }
            
            console.log(table.toString());
          }
        } catch (error) {
          spinner.fail('加载失败');
          console.error(chalk.red(error.message));
          process.exit(1);
        }
      }))
    .addCommand(new Command('probe')
      .description('探查实体关联')
      .argument('<entity>', '实体名称')
      .option('--json', 'JSON 格式输出')
      .action(async (entityName, options) => {
        const spinner = ora(`探查实体 "${entityName}"...`).start();
        
        try {
          const memorySystem = getMemorySystem();
          await memorySystem.initialize();
          
          const result = await memorySystem.probeEntity(entityName);
          
          spinner.succeed(`找到 ${result.facts.length} 条关联记忆`);
          
          if (options.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            if (result.entity) {
              console.log(chalk.bold('\n实体信息'));
              console.log('─'.repeat(40));
              console.log(`名称: ${chalk.cyan(result.entity.name)}`);
              console.log(`类型: ${result.entity.type}`);
              console.log(`关联记忆数: ${result.entity.factCount || 0}`);
            } else {
              console.log(chalk.yellow('实体未找到'));
            }
            
            if (result.facts.length > 0) {
              console.log(chalk.bold('\n关联记忆'));
              console.log('─'.repeat(40));
              
              for (const fact of result.facts.slice(0, 5)) {
                console.log(`• ${fact.content}`);
              }
              
              if (result.facts.length > 5) {
                console.log(chalk.gray(`... 还有 ${result.facts.length - 5} 条`));
              }
            }
          }
        } catch (error) {
          spinner.fail('探查失败');
          console.error(chalk.red(error.message));
          process.exit(1);
        }
      }));
  
  return cmd;
}

function createFeedbackCommand() {
  return new Command('feedback')
    .description('记录记忆反馈')
    .argument('<factId>', '记忆 ID')
    .argument('<type>', '反馈类型')
    .option('--json', 'JSON 格式输出')
    .action(async (factId, type, options) => {
      const spinner = ora('记录反馈...').start();
      
      try {
        const memorySystem = getMemorySystem();
        await memorySystem.initialize();
        
        const updated = await memorySystem.recordFeedback(factId, type);
        
        spinner.succeed('反馈已记录');
        
        if (options.json) {
          console.log(JSON.stringify(updated, null, 2));
        } else {
          console.log(chalk.bold('\n更新后的记忆'));
          console.log('─'.repeat(40));
          console.log(`ID: ${chalk.cyan(updated.id)}`);
          console.log(`信任评分: ${formatTrustScore(updated.trustScore)}`);
          console.log(`帮助次数: ${updated.helpfulCount}`);
          console.log(`无帮助次数: ${updated.unhelpfulCount}`);
        }
      } catch (error) {
        spinner.fail('记录反馈失败');
        console.error(chalk.red(error.message));
        process.exit(1);
      }
    });
}

function createExportCommand() {
  return new Command('export')
    .description('导出记忆')
    .option('-o, --output <file>', '输出文件', 'memory-export.json')
    .option('--format <format>', '导出格式', 'json')
    .action(async (options) => {
      const spinner = ora('导出记忆...').start();
      
      try {
        const memorySystem = getMemorySystem();
        await memorySystem.initialize();
        
        const exported = await memorySystem.export();
        
        await fs.writeFile(options.output, JSON.stringify(exported, null, 2));
        
        spinner.succeed(`已导出到 ${options.output}`);
        console.log(chalk.gray(`共 ${exported.memory?.facts?.length || 0} 条记忆`));
      } catch (error) {
        spinner.fail('导出失败');
        console.error(chalk.red(error.message));
        process.exit(1);
      }
    });
}

function createImportCommand() {
  return new Command('import')
    .description('导入记忆')
    .argument('<file>', '导入文件')
    .option('--merge', '合并模式 (不覆盖现有)')
    .action(async (file, options) => {
      const spinner = ora('导入记忆...').start();
      
      try {
        const content = await fs.readFile(file, 'utf-8');
        const data = JSON.parse(content);
        
        const memorySystem = getMemorySystem();
        await memorySystem.initialize();
        
        await memorySystem.import(data, { merge: options.merge });
        
        spinner.succeed('导入成功');
      } catch (error) {
        spinner.fail('导入失败');
        console.error(chalk.red(error.message));
        process.exit(1);
      }
    });
}

function createBenchmarkCommand() {
  return new Command('benchmark')
    .description('运行性能基准测试')
    .option('-d, --dim <dim>', '向量维度', '512')
    .option('-i, --iterations <iterations>', '迭代次数', '1000')
    .action(async (options) => {
      console.log(chalk.bold('\nHRR 引擎性能基准测试'));
      console.log('═'.repeat(50));
      
      const dim = parseInt(options.dim, 10);
      const iterations = parseInt(options.iterations, 10);
      
      const engine = new core.memory.HRREngine({ dim });
      
      console.log(`\n向量维度: ${dim}`);
      console.log(`迭代次数: ${iterations.toLocaleString()}`);
      
      const testText = 'User prefers TypeScript over JavaScript for frontend development';
      
      console.log(chalk.cyan('\n编码测试'));
      console.log('─'.repeat(30));
      
      const encodeStart = performance.now();
      for (let i = 0; i < iterations; i++) {
        engine.encodeText(testText);
      }
      const encodeTime = performance.now() - encodeStart;
      
      console.log(`总时间: ${encodeTime.toFixed(2)}ms`);
      console.log(`平均: ${(encodeTime / iterations).toFixed(4)}ms`);
      console.log(`吞吐量: ${((iterations / encodeTime) * 1000).toFixed(0)} ops/s`);
      
      const vec1 = engine.encodeText(testText);
      const vec2 = engine.encodeText('User likes React with TypeScript');
      
      console.log(chalk.cyan('\n相似度计算测试'));
      console.log('─'.repeat(30));
      
      const simStart = performance.now();
      for (let i = 0; i < iterations * 10; i++) {
        engine.similarity(vec1, vec2);
      }
      const simTime = performance.now() - simStart;
      
      console.log(`总时间: ${simTime.toFixed(2)}ms`);
      console.log(`平均: ${(simTime / (iterations * 10)).toFixed(4)}ms`);
      console.log(`吞吐量: ${((iterations * 10 / simTime) * 1000).toFixed(0)} ops/s`);
      
      console.log(chalk.green('\n基准测试完成'));
    });
}

function createCleanCommand() {
  return new Command('clean')
    .description('清理低信任记忆')
    .option('-t, --threshold <threshold>', '信任阈值', '0.2')
    .option('--dry-run', '仅预览，不实际删除')
    .option('-f, --force', '强制执行，不确认')
    .action(async (options) => {
      const threshold = parseFloat(options.threshold);
      
      try {
        const memorySystem = getMemorySystem();
        await memorySystem.initialize();
        
        const stats = await memorySystem.getStats();
        const facts = stats.facts || [];
        
        const toClean = facts.filter(f => (f.trustScore || 0) < threshold);
        
        if (toClean.length === 0) {
          console.log(chalk.green('没有需要清理的记忆'));
          return;
        }
        
        console.log(chalk.yellow(`\n找到 ${toClean.length} 条低信任记忆 (信任 < ${threshold})`));
        
        if (options.dryRun) {
          console.log(chalk.gray('\n[预览模式] 将删除以下记忆:'));
          for (const f of toClean.slice(0, 10)) {
            console.log(`  • ${f.content.slice(0, 50)}... (信任: ${f.trustScore?.toFixed(2)})`);
          }
          if (toClean.length > 10) {
            console.log(chalk.gray(`  ... 还有 ${toClean.length - 10} 条`));
          }
          return;
        }
        
        if (!options.force) {
          const readline = require('readline');
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          
          const answer = await new Promise(resolve => {
            rl.question('确认删除? (y/N) ', resolve);
          });
          rl.close();
          
          if (answer.toLowerCase() !== 'y') {
            console.log(chalk.gray('已取消'));
            return;
          }
        }
        
        const spinner = ora('清理记忆...').start();
        
        let deleted = 0;
        for (const f of toClean) {
          try {
            await memorySystem.deleteFact(f.id);
            deleted++;
          } catch (e) {

            // Ignore individual errors

            console.warn('[memory.js] 空 catch 补日志:', e && e.message);
          }

        }
        
        spinner.succeed(`已清理 ${deleted} 条记忆`);
      } catch (error) {
        console.error(chalk.red(error.message));
        process.exit(1);
      }
    });
}

function formatTrustScore(score) {
  if (score === undefined || score === null) return '-';
  
  const s = score.toFixed(2);
  if (score >= 0.7) return chalk.green(s);
  if (score >= 0.3) return chalk.yellow(s);
  return chalk.red(s);
}

module.exports = {
  createMemoryCommand,
  handleMemoryCommand: async (args) => {
    const cmd = createMemoryCommand();
    await cmd.parseAsync(['node', 'crabpaw', 'memory', ...args]);
  },
};
