/**
 * CLI 命令 - Profile 多配置文件管理
 *
 * crabpaw profile list
 * crabpaw profile use <name>
 * crabpaw profile create <name> [--clone <source>] [--label <label>]
 * crabpaw profile delete <name>
 * crabpaw profile show [name]
 * crabpaw profile export <name> [--output <file>]
 * crabpaw profile import <name> --file <path>
 */

const profileManager = require('../../core/profile-manager');
const fs = require('fs');

async function handleProfileCommand(args) {
  const subCmd = args[0] || 'list';

  switch (subCmd) {
    case 'list':
    case 'ls': {
      const profiles = profileManager.listProfiles();
      console.log('\n📋 配置文件列表\n');
      for (const p of profiles) {
        const active = p.isActive ? ' ← 当前' : '';
        const label = p.label !== p.name ? ` (${p.label})` : '';
        const cloned = p.clonedFrom ? ` [克隆自: ${p.clonedFrom}]` : '';
        console.log(`  ${p.isActive ? '✅' : '⬜'} ${p.name}${label}${cloned}${active}`);
      }
      console.log('');
      break;
    }

    case 'use':
    case 'switch': {
      const name = args[1];
      if (!name) {
        console.log('❌ 用法: crabpaw profile use <name>');
        break;
      }
      try {
        const result = profileManager.useProfile(name);
        console.log(`✅ 已切换到 Profile: ${result.profile}`);
        console.log('⚠️  部分配置需要重启服务生效');
      } catch (e) {
        console.log(`❌ ${e.message}`);
      }
      break;
    }

    case 'create': {
      const name = args[1];
      if (!name) {
        console.log('❌ 用法: crabpaw profile create <name> [--clone <source>] [--label <label>]');
        break;
      }
      const cloneIdx = args.indexOf('--clone');
      const labelIdx = args.indexOf('--label');
      const cloneFrom = cloneIdx > -1 ? args[cloneIdx + 1] : null;
      const label = labelIdx > -1 ? args[labelIdx + 1] : null;

      try {
        // eslint-disable-next-line no-unused-vars
        const result = profileManager.createProfile(name, { clone: cloneFrom, label });
        const cloned = cloneFrom ? ` (克隆自 ${cloneFrom})` : '';
        console.log(`✅ 已创建 Profile: ${name}${cloned}`);
      } catch (e) {
        console.log(`❌ ${e.message}`);
      }
      break;
    }

    case 'delete':
    case 'rm':
    case 'remove': {
      const name = args[1];
      if (!name) {
        console.log('❌ 用法: crabpaw profile delete <name>');
        break;
      }
      try {
        profileManager.deleteProfile(name);
        console.log(`✅ 已删除 Profile: ${name}`);
      } catch (e) {
        console.log(`❌ ${e.message}`);
      }
      break;
    }

    case 'show':
    case 'info': {
      const name = args[1] || profileManager.getActiveProfile();
      try {
        const info = profileManager.showProfile(name);
        console.log(`\n📋 Profile: ${info.name}`);
        console.log(`标签: ${info.label}`);
        console.log(`描述: ${info.description || '(无)'}`);
        console.log(`默认: ${info.isDefault ? '是' : '否'}`);
        console.log(`当前: ${info.isActive ? '是' : '否'}`);
        if (info.clonedFrom) console.log(`克隆自: ${info.clonedFrom}`);
        if (info.createdAt) console.log(`创建时间: ${info.createdAt}`);
        console.log('');
      } catch (e) {
        console.log(`❌ ${e.message}`);
      }
      break;
    }

    case 'export': {
      const name = args[1];
      if (!name) {
        console.log('❌ 用法: crabpaw profile export <name> [--output <file>]');
        break;
      }
      const outputIdx = args.indexOf('--output');
      const outputFile = outputIdx > -1 ? args[outputIdx + 1] : null;

      try {
        const json = profileManager.exportProfile(name);
        if (outputFile) {
          fs.writeFileSync(outputFile, json, 'utf-8');
          console.log(`✅ 已导出 Profile "${name}" 到: ${outputFile}`);
        } else {
          console.log(json);
        }
      } catch (e) {
        console.log(`❌ ${e.message}`);
      }
      break;
    }

    case 'import': {
      const name = args[1];
      const fileIdx = args.indexOf('--file');
      const filePath = fileIdx > -1 ? args[fileIdx + 1] : null;
      const force = args.includes('--force');

      if (!name || !filePath) {
        console.log('❌ 用法: crabpaw profile import <name> --file <path> [--force]');
        break;
      }

      try {
        const json = fs.readFileSync(filePath, 'utf-8');
        profileManager.importProfile(name, json, { force });
        console.log(`✅ 已导入 Profile: ${name} (来自: ${filePath})`);
      } catch (e) {
        console.log(`❌ ${e.message}`);
      }
      break;
    }

    default:
      console.log(`
用法: crabpaw profile <command> [options]

命令:
  list                    列出所有 Profile
  use <name>              切换到指定 Profile
  create <name>           创建新 Profile
    --clone <source>        从现有 Profile 克隆
    --label <label>         设置标签
  delete <name>           删除 Profile
  show [name]             显示 Profile 详情
  export <name>           导出 Profile 配置
    --output <file>         导出到文件
  import <name>           导入 Profile 配置
    --file <path>           从文件导入
    --force                 覆盖已有 Profile
`);
  }
}

module.exports = { handleProfileCommand };
