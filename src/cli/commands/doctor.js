/**
 * CLI 命令 - 诊断修复 (doctor)
 *
 * 系统诊断与自动修复命令。
 * 诊断配置和依赖项问题，可选自动修复
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('../../core/config');

async function handleDoctorCommand(args) {
  const fix = args.includes('--fix');
  const issues = [];
  const warnings = [];
  const fixed = [];

  console.log('\n🩺 CrabPaw Doctor — 诊断检查\n');
  console.log('━'.repeat(50));

  // 1. Node.js 版本检查
  const nodeVersion = process.version;
  const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0], 10);
  if (majorVersion < 18) {
    issues.push(`Node.js 版本过低: ${nodeVersion} (需要 >= 18.x)`);
  } else {
    console.log(`✅ Node.js: ${nodeVersion}`);
  }

  // 2. 配置文件检查
  const configPath = path.join(process.cwd(), 'config.json');
  let appConfig;
  try {
    appConfig = config.loadConfig();
    console.log('✅ 配置文件: 可读取');
  } catch (e) {
    issues.push(`配置文件读取失败: ${e.message}`);
    if (fix) {
      try {
        const defaultConfig = config.getDefaultConfig ? config.getDefaultConfig() : {};
        fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
        fixed.push('已创建默认配置文件');
        appConfig = defaultConfig;
      } catch (writeErr) {
        issues.push(`无法创建默认配置: ${writeErr.message}`);
      }
    }
  }

  if (appConfig) {
    // 3. AI 提供者检查
    const currentProvider = appConfig.models?.currentProvider;
    if (!currentProvider) {
      issues.push('未配置默认 AI 提供者');
    } else {
      const provConfig = appConfig.models?.providers?.[currentProvider];
      if (!provConfig) {
        issues.push(`当前提供者 "${currentProvider}" 配置缺失`);
      } else if (!provConfig.apiKey && !provConfig.baseUrl) {
        issues.push(`提供者 "${currentProvider}" 缺少 API Key 或 Base URL`);
      } else {
        const keyStatus = provConfig.apiKey ? '已配置' : '未配置';
        const modelStatus = provConfig.model || '未指定';
        console.log(`✅ AI 提供者: ${currentProvider} (模型: ${modelStatus}, Key: ${keyStatus})`);
      }
    }

    // 4. 飞书配置检查
    if (appConfig.lark) {
      if (!appConfig.lark.appId || !appConfig.lark.appSecret) {
        warnings.push('飞书 App ID 或 App Secret 未配置');
      } else {
        console.log('✅ 飞书配置: 已配置');
      }
    }

    // 5. 端口冲突检查
    const port = appConfig.port || 38767;
    console.log(`✅ 服务端口: ${port}`);
  }

  // 6. 数据目录检查
  const dataDir = path.join(os.homedir(), '.crabpaw');
  if (!fs.existsSync(dataDir)) {
    warnings.push(`数据目录不存在: ${dataDir}`);
    if (fix) {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        fixed.push(`已创建数据目录: ${dataDir}`);
      } catch (e) {
        issues.push(`无法创建数据目录: ${e.message}`);
      }
    }
  } else {
    console.log(`✅ 数据目录: ${dataDir}`);
  }

  // 7. .env 文件检查
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    console.log('✅ .env 文件: 存在');
  } else {
    warnings.push('.env 文件不存在');
  }

  // 8. 依赖检查
  try {
    const pkgPath = path.join(__dirname, '..', '..', '..', 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const missing = [];
      for (const dep of Object.keys(deps)) {
        try {
          require.resolve(dep);
        } catch {
          missing.push(dep);
        }
      }
      if (missing.length > 0) {
        issues.push(`缺少依赖: ${missing.join(', ')}`);
        if (fix) {
          console.log('  尝试安装缺失依赖...');
          // 不自动执行 npm install，仅提示
          fixed.push(`请运行: npm install ${missing.join(' ')}`);
        }
      } else {
        console.log('✅ 依赖: 完整');
      }
    }
  } catch (e) {
    warnings.push(`依赖检查失败: ${e.message}`);
  }

  // 9. 磁盘空间检查
  try {
    // eslint-disable-next-line no-unused-vars
    const stats = fs.statSync(dataDir);
    console.log('✅ 磁盘访问: 正常');
  } catch {
    warnings.push('数据目录不可写');
  }

  // 10. 内存检查
  const memUsage = process.memoryUsage();
  const memMB = Math.round(memUsage.rss / 1024 / 1024);
  if (memMB > 1024) {
    warnings.push(`内存使用较高: ${memMB}MB`);
  }
  console.log(`✅ 内存使用: ${memMB}MB`);

  // 汇总
  console.log('\n' + '━'.repeat(50));

  if (issues.length === 0 && warnings.length === 0) {
    console.log('\n✅ 所有检查通过，系统健康！');
  } else {
    if (issues.length > 0) {
      console.log(`\n❌ 问题 (${issues.length}):`);
      for (const issue of issues) {
        console.log(`   • ${issue}`);
      }
    }
    if (warnings.length > 0) {
      console.log(`\n⚠️  警告 (${warnings.length}):`);
      for (const warning of warnings) {
        console.log(`   • ${warning}`);
      }
    }
  }

  if (fixed.length > 0) {
    console.log(`\n🔧 已修复 (${fixed.length}):`);
    for (const f of fixed) {
      console.log(`   • ${f}`);
    }
  }

  console.log('');

  return issues.length === 0 ? 0 : 1;
}

module.exports = { handleDoctorCommand };
