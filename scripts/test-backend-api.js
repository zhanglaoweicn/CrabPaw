/**
 * 测试后端API连接
 * 
 * 用法：
 * node scripts/test-backend-api.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data', '.crabpaw');
const TOKEN_PATH = path.join(DATA_DIR, '.api_token');
const PORT_PATH = path.join(DATA_DIR, '.api_port');

function getToken() {
  try {
    if (fs.existsSync(TOKEN_PATH)) {
      return fs.readFileSync(TOKEN_PATH, 'utf-8').trim();
    }
  } catch (error) {
    console.error('读取 Token 失败:', error.message);
  }
  return null;
}

function getPort() {
  try {
    if (fs.existsSync(PORT_PATH)) {
      return parseInt(fs.readFileSync(PORT_PATH, 'utf-8').trim(), 10);
    }
  } catch (error) {
    console.error('读取端口失败:', error.message);
  }
  return 38767;
}

function makeRequest(method, path, data = null) {
  return new Promise((resolve, reject) => {
    const token = getToken();
    const port = getPort();
    
    console.log(`\n📡 发送请求:`);
    console.log(`  方法: ${method}`);
    console.log(`  路径: ${path}`);
    console.log(`  端口: ${port}`);
    console.log(`  Token: ${token ? '已设置' : '未设置'}`);
    
    const options = {
      hostname: 'localhost',
      port: port,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      }
    };
    
    if (token) {
      options.headers['X-Api-Key'] = token;
    }
    
    const req = http.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        console.log(`\n✅ 响应状态: ${res.statusCode}`);
        try {
          const parsed = JSON.parse(responseData);
          console.log('📦 响应数据:');
          console.log(JSON.stringify(parsed, null, 2));
          resolve(parsed);
        } catch (error) {
          console.log('📦 响应数据 (原始):');
          console.log(responseData);
          resolve(responseData);
        }
      });
    });
    
    req.on('error', (error) => {
      console.error(`\n❌ 请求失败:`, error.message);
      reject(error);
    });
    
    req.setTimeout(5000, () => {
      console.error(`\n⏱️ 请求超时`);
      req.destroy();
      reject(new Error('请求超时'));
    });
    
    if (data) {
      const postData = JSON.stringify(data);
      req.write(postData);
    }
    
    req.end();
  });
}

async function testBackendAPI() {
  console.log('🧪 开始测试后端API连接...\n');
  
  try {
    // 测试 1: 健康检查
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('测试 1: 健康检查 GET /health');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    await makeRequest('GET', '/health');
    
    // 测试 2: 获取任务列表
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('测试 2: 获取任务列表 GET /schedules');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    const schedules = await makeRequest('GET', '/schedules');
    
    // 测试 3: 触发任务
    if (schedules && schedules.data && schedules.data.cron && schedules.data.cron.length > 0) {
      const taskId = schedules.data.cron[0].id;
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`测试 3: 触发任务 POST /schedules/trigger?id=${taskId}`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      await makeRequest('POST', `/schedules/trigger?id=${taskId}`, {});
    } else {
      console.log('\n⚠️ 没有找到可触发的任务');
    }
    
    console.log('\n✅ 所有测试完成！');
    
  } catch (error) {
    console.error('\n❌ 测试失败:', error.message);
    console.error('\n可能的原因:');
    console.error('  1. 后端服务器未启动');
    console.error('  2. 端口被占用');
    console.error('  3. Token 不匹配');
    console.error('\n建议操作:');
    console.error('  - 重启 Electron 应用');
    console.error('  - 检查端口 38767 是否被占用');
    console.error('  - 查看后端日志: data/.crabpaw/crabpaw.log');
  }
}

testBackendAPI();
