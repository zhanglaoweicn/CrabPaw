/**
 * 完整诊断脚本 - 检查所有可能的问题
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('🔍 开始完整诊断...\n');

// 1. 检查配置文件
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('步骤 1: 检查配置文件');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const DATA_DIR = path.join(__dirname, '..', 'data', '.crabpaw');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const TOKEN_PATH = path.join(DATA_DIR, '.api_token');
const PORT_PATH = path.join(DATA_DIR, '.api_port');

console.log(`数据目录: ${DATA_DIR}`);
console.log(`存在: ${fs.existsSync(DATA_DIR) ? '✅' : '❌'}`);

console.log(`\n配置文件: ${CONFIG_PATH}`);
console.log(`存在: ${fs.existsSync(CONFIG_PATH) ? '✅' : '❌'}`);
if (fs.existsSync(CONFIG_PATH)) {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    console.log(`企业微信配置: ${config.wecom ? '✅ 已配置' : '❌ 未配置'}`);
    console.log(`用户ID: ${config.user?.wecomUserId ? '✅ 已配置' : '❌ 未配置'}`);
  } catch (error) {
    console.log(`❌ 配置文件格式错误: ${error.message}`);
  }
}

console.log(`\nToken文件: ${TOKEN_PATH}`);
console.log(`存在: ${fs.existsSync(TOKEN_PATH) ? '✅' : '❌'}`);
if (fs.existsSync(TOKEN_PATH)) {
  const token = fs.readFileSync(TOKEN_PATH, 'utf-8').trim();
  console.log(`Token: ${token.substring(0, 10)}...`);
}

console.log(`\n端口文件: ${PORT_PATH}`);
console.log(`存在: ${fs.existsSync(PORT_PATH) ? '✅' : '❌'}`);
if (fs.existsSync(PORT_PATH)) {
  const port = fs.readFileSync(PORT_PATH, 'utf-8').trim();
  console.log(`端口: ${port}`);
}

// 2. 检查端口占用
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('步骤 2: 检查端口占用');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const PORT = fs.existsSync(PORT_PATH) 
  ? parseInt(fs.readFileSync(PORT_PATH, 'utf-8').trim(), 10)
  : 38767;

try {
  const result = execSync(`netstat -ano | findstr :${PORT}`, { encoding: 'utf-8' });
  if (result.includes(`:${PORT}`)) {
    console.log(`✅ 端口 ${PORT} 正在被使用`);
    console.log(result);
  } else {
    console.log(`❌ 端口 ${PORT} 未被使用 - 后端服务器可能未启动`);
  }
} catch (error) {
  console.log(`❌ 端口 ${PORT} 未被使用 - 后端服务器可能未启动`);
}

// 3. 测试 API 连接
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('步骤 3: 测试 API 连接');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

function testAPI(method, path, data = null) {
  return new Promise((resolve) => {
    const token = fs.existsSync(TOKEN_PATH) 
      ? fs.readFileSync(TOKEN_PATH, 'utf-8').trim()
      : '';
    
    const options = {
      hostname: 'localhost',
      port: PORT,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 5000
    };
    
    if (token) {
      options.headers['X-Api-Key'] = token;
    }
    
    const req = http.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        console.log(`\n${method} ${path}`);
        console.log(`状态码: ${res.statusCode}`);
        try {
          const parsed = JSON.parse(responseData);
          console.log('响应:', JSON.stringify(parsed, null, 2));
          resolve({ success: true, data: parsed });
        } catch (error) {
          console.log('响应 (原始):', responseData);
          resolve({ success: false, error: '解析失败' });
        }
      });
    });
    
    req.on('error', (error) => {
      console.log(`\n${method} ${path}`);
      console.log(`❌ 连接失败: ${error.message}`);
      resolve({ success: false, error: error.message });
    });
    
    req.on('timeout', () => {
      console.log(`\n${method} ${path}`);
      console.log(`⏱️ 连接超时`);
      req.destroy();
      resolve({ success: false, error: '超时' });
    });
    
    if (data) {
      req.write(JSON.stringify(data));
    }
    
    req.end();
  });
}

async function runTests() {
  // 测试健康检查
  const health = await testAPI('GET', '/health');
  
  // 测试任务列表
  const schedules = await testAPI('GET', '/schedules');
  
  // 测试触发任务
  if (schedules.success && schedules.data?.data?.cron?.length > 0) {
    const taskId = schedules.data.data.cron[0].id;
    await testAPI('POST', `/schedules/trigger?id=${taskId}`, {});
  }
  
  // 4. 总结和建议
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('诊断总结');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  if (!health.success) {
    console.log('\n❌ 后端服务器未响应');
    console.log('\n可能的原因:');
    console.log('  1. 后端服务器未启动');
    console.log('  2. 端口被其他程序占用');
    console.log('  3. 防火墙阻止连接');
    console.log('\n建议操作:');
    console.log('  1. 重启 Electron 应用');
    console.log('  2. 检查端口是否被占用: netstat -ano | findstr :38767');
    console.log('  3. 手动启动后端: node src/cli/index.js start');
  } else {
    console.log('\n✅ 后端服务器正常运行');
    console.log('\n如果前端仍然无法连接，请检查:');
    console.log('  1. Electron 主进程日志');
    console.log('  2. 浏览器控制台的网络请求');
    console.log('  3. API Token 是否匹配');
  }
}

runTests();
