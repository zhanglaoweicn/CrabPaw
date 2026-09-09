const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DATA_DIR = process.env.CRABPAW_DATA_DIR || path.join(__dirname, '..', 'data', '.crabpaw');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function configureWeCom() {
  console.log('\n🔧 企业微信配置向导\n');
  console.log('请按照提示输入企业微信配置信息：\n');
  
  let config = {};
  
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
      config = JSON.parse(content);
    } catch (error) {
      console.error('读取现有配置失败，将创建新配置');
    }
  }
  
  console.log('📋 配置说明：');
  console.log('   - 企业ID (corpId): 在企业微信管理后台的"我的企业"页面获取');
  console.log('   - 应用ID (agentId): 在企业微信管理后台的"应用管理"页面获取');
  console.log('   - 应用密钥 (secret): 在企业微信管理后台的"应用管理"页面获取');
  console.log('   - 用户ID (wecomUserId): 接收消息的用户ID，可在企业微信通讯录中查看\n');
  
  const corpId = await question('请输入企业ID (corpId): ');
  const agentId = await question('请输入应用ID (agentId): ');
  const secret = await question('请输入应用密钥 (secret): ');
  const wecomUserId = await question('请输入接收消息的用户ID (wecomUserId): ');
  
  config.wecom = {
    corpId: corpId.trim(),
    agentId: agentId.trim(),
    secret: secret.trim()
  };
  
  config.user = config.user || {};
  config.user.wecomUserId = wecomUserId.trim();
  
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  
  console.log('\n✅ 配置已保存到:', CONFIG_PATH);
  console.log('\n📝 配置摘要：');
  console.log(`   - 企业ID: ${corpId ? '已配置' : '未配置'}`);
  console.log(`   - 应用ID: ${agentId ? '已配置' : '未配置'}`);
  console.log(`   - 应用密钥: ${secret ? '已配置' : '未配置'}`);
  console.log(`   - 用户ID: ${wecomUserId ? '已配置' : '未配置'}`);
  
  rl.close();
  
  console.log('\n🎉 配置完成！现在可以运行消息发送任务了。');
  console.log('\n运行命令: node scripts/wecom-message-task.js\n');
}

configureWeCom().catch(error => {
  console.error('配置过程出错:', error);
  rl.close();
  process.exit(1);
});
