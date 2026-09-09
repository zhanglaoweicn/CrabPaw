/**
 * 企业微信每日资讯推送技能 - 测试脚本
 * 
 * 用法：
 * node scripts/test-wecom-daily-news.js
 */

const path = require('path');
const fs = require('fs');

const CONFIG_PATH = path.join(__dirname, '..', 'data', '.crabpaw', 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
      return JSON.parse(content);
    }
  } catch (error) {
    console.error('加载配置失败:', error.message);
  }
  return {};
}

async function testWeComDailyNews() {
  console.log('🧪 开始测试企业微信每日资讯推送技能...\n');

  const config = loadConfig();
  
  console.log('📋 配置检查:');
  console.log('  - 企业微信配置:', config.wecom ? '✅ 已配置' : '❌ 未配置');
  console.log('  - 用户ID:', config.user?.wecomUserId ? '✅ 已配置' : '❌ 未配置');
  
  if (!config.wecom?.corpId || !config.wecom?.agentId || !config.wecom?.secret) {
    console.log('\n❌ 企业微信配置不完整，请先运行配置向导:');
    console.log('   node scripts/configure-wecom.js\n');
    return;
  }

  if (!config.user?.wecomUserId) {
    console.log('\n❌ 未配置企业微信用户ID，请先运行配置向导:');
    console.log('   node scripts/configure-wecom.js\n');
    return;
  }

  try {
    const { execute } = require('../skills/wecom-daily-news/executor.js');

    const context = {
      appConfig: config
    };

    console.log('\n🚀 执行技能...');
    const result = await execute({}, context);
    
    console.log('\n📊 执行结果:');
    console.log(JSON.stringify(result, null, 2));
    
    if (result.success) {
      console.log('\n✅ 测试成功！请检查企业微信是否收到消息。');
    } else {
      console.log('\n❌ 测试失败:', result.error);
    }
  } catch (error) {
    console.error('\n❌ 执行出错:', error.message);
    console.error(error.stack);
  }
}

testWeComDailyNews();
