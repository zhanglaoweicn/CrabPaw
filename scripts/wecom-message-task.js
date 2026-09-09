const http = require('http');
const fs = require('fs');
const path = require('path');

// SP3: 修正层级错位（两级 '..' 会解析到 D:\data\.crabpaw，缺端口文件与 token）
const DATA_DIR = process.env.CRABPAW_DATA_DIR || path.join(__dirname, '..', 'data', '.crabpaw');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const WECOM_SEND_PORT_PATH = path.join(DATA_DIR, '.wecom_send_port');
const API_TOKEN_PATH = path.join(DATA_DIR, '.api_token');
// 统一端口解析（SP3）：env WECOM_SEND_PORT > .wecom_send_port 文件 > 默认 38769
const { resolveWecomSendPort } = require('../src/channels/wecom/index');

class WeComMessageSender {
  constructor() {
    this.config = this.loadConfig();
    this.logs = [];
  }
  
  loadConfig() {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
        return JSON.parse(content);
      }
    } catch (error) {
      this.log('error', `加载配置文件失败: ${error.message}`);
    }
    
    return {
      wecom: {
        corpId: process.env.WECOM_CORP_ID || '',
        agentId: process.env.WECOM_AGENT_ID || '',
        secret: process.env.WECOM_SECRET || ''
      },
      user: {
        wecomUserId: process.env.WECOM_USER_ID || ''
      }
    };
  }
  
  log(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level,
      message,
      data
    };
    
    this.logs.push(logEntry);
    
    const levelColors = {
      info: '\x1b[36m',
      success: '\x1b[32m',
      warning: '\x1b[33m',
      error: '\x1b[31m'
    };
    
    const color = levelColors[level] || '\x1b[0m';
    const reset = '\x1b[0m';
    
    console.log(`${color}[${timestamp}] [${level.toUpperCase()}]${reset} ${message}`);
    
    if (data) {
      console.log(JSON.stringify(data, null, 2));
    }
  }
  
  isConfigured() {
    const { wecom, user } = this.config;
    
    const hasCorpId = wecom?.corpId && wecom.corpId.trim() !== '';
    const hasSecret = wecom?.secret && wecom.secret.trim() !== '';
    const hasUserId = user?.wecomUserId && user.wecomUserId.trim() !== '';
    
    return hasCorpId && hasSecret && hasUserId;
  }
  
  getSendPort() {
    let portFileValue = null;
    try {
      if (fs.existsSync(WECOM_SEND_PORT_PATH)) {
        portFileValue = fs.readFileSync(WECOM_SEND_PORT_PATH, 'utf-8').trim();
      }
    } catch (error) {
      this.log('warning', `读取发送端口失败: ${error.message}`);
    }

    return resolveWecomSendPort(process.env, portFileValue);
  }

  getApiToken() {
    try {
      if (fs.existsSync(API_TOKEN_PATH)) {
        return fs.readFileSync(API_TOKEN_PATH, 'utf-8').trim();
      }
    } catch (error) {
      this.log('warning', `读取 API token 失败: ${error.message}`);
    }
    return '';
  }
  
  async sendMessage(chatId, content, options = {}) {
    const { msgType = 'markdown', chatType = 'single' } = options;
    
    this.log('info', `准备发送企业微信消息`, {
      chatId,
      msgType,
      chatType,
      contentLength: content.length
    });
    
    if (!this.isConfigured()) {
      const error = '企业微信未配置完整，请检查 corpId、secret 和 wecomUserId';
      this.log('error', error);
      return {
        success: false,
        error,
        logs: this.logs
      };
    }
    
    const sendPort = this.getSendPort();
    
    const postData = JSON.stringify({
      chat_id: chatId,
      msg_type: msgType,
      content: content,
      chat_type: chatType
    });
    
    this.log('info', `发送请求到端口 ${sendPort}`);
    
    return new Promise((resolve) => {
      const apiToken = this.getApiToken();
      const req = http.request({
        hostname: 'localhost',
        port: sendPort,
        path: '/wecom/send',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          // SP3: 本地发送服务强制鉴权——必须携带 API token
          ...(apiToken ? { 'X-Api-Key': apiToken } : {})
        },
        timeout: 10000
      }, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            
            if (result.success === false) {
              this.log('error', `企业微信发送失败`, result);
              resolve({
                success: false,
                error: result.error || result.errcode || '未知错误',
                details: result,
                logs: this.logs
              });
            } else {
              this.log('success', '企业微信消息发送成功', result);
              resolve({
                success: true,
                result,
                logs: this.logs
              });
            }
          } catch (error) {
            this.log('warning', `响应解析失败，但消息可能已发送`, { data, error: error.message });
            resolve({
              success: true,
              message: '消息可能已发送（响应解析失败）',
              logs: this.logs
            });
          }
        });
      });
      
      req.on('error', (error) => {
        this.log('error', `发送请求失败: ${error.message}`);
        resolve({
          success: false,
          error: error.message,
          logs: this.logs
        });
      });
      
      req.on('timeout', () => {
        req.destroy();
        this.log('error', '请求超时');
        resolve({
          success: false,
          error: '请求超时',
          logs: this.logs
        });
      });
      
      req.write(postData);
      req.end();
    });
  }
  
  async sendTestMessage() {
    this.log('info', '=== 开始执行企业微信消息发送测试 ===');
    
    const { user } = this.config;
    const chatId = user?.wecomUserId;
    
    if (!chatId) {
      const error = '未配置企业微信用户ID (wecomUserId)';
      this.log('error', error);
      return {
        success: false,
        error,
        logs: this.logs
      };
    }
    
    const timestamp = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    
    const message = `## 🦀 CrabPaw 自动化任务测试

**测试时间**: ${timestamp}

**任务类型**: 企业微信消息发送

**状态**: ✅ 测试成功

---

> 此消息由 CrabPaw 自动化任务系统发送
> 如有疑问，请联系管理员`;

    this.log('info', `准备发送测试消息到用户: ${chatId}`);
    
    const result = await this.sendMessage(chatId, message, {
      msgType: 'markdown',
      chatType: 'single'
    });
    
    this.log('info', '=== 企业微信消息发送测试完成 ===');
    
    return result;
  }
  
  getLogs() {
    return this.logs;
  }
  
  generateReport(result) {
    const report = {
      taskName: '企业微信消息发送自动化任务',
      executedAt: new Date().toISOString(),
      status: result.success ? 'SUCCESS' : 'FAILED',
      configuration: {
        corpId: this.config.wecom?.corpId ? '已配置' : '未配置',
        agentId: this.config.wecom?.agentId ? '已配置' : '未配置',
        secret: this.config.wecom?.secret ? '已配置' : '未配置',
        wecomUserId: this.config.user?.wecomUserId ? '已配置' : '未配置',
        sendPort: this.getSendPort()
      },
      result: {
        success: result.success,
        error: result.error || null,
        details: result.result || null
      },
      logs: this.logs,
      summary: result.success 
        ? '✅ 任务执行成功，消息已发送到企业微信'
        : `❌ 任务执行失败: ${result.error}`
    };
    
    return report;
  }
}

async function main() {
  console.log('🚀 启动企业微信消息发送自动化任务\n');
  
  const sender = new WeComMessageSender();
  
  console.log('📋 配置检查:');
  console.log(`   - 企业ID (corpId): ${sender.config.wecom?.corpId ? '✅ 已配置' : '❌ 未配置'}`);
  console.log(`   - 应用ID (agentId): ${sender.config.wecom?.agentId ? '✅ 已配置' : '❌ 未配置'}`);
  console.log(`   - 应用密钥 (secret): ${sender.config.wecom?.secret ? '✅ 已配置' : '❌ 未配置'}`);
  console.log(`   - 用户ID (wecomUserId): ${sender.config.user?.wecomUserId ? '✅ 已配置' : '❌ 未配置'}`);
  console.log('');
  
  const result = await sender.sendTestMessage();
  
  console.log('\n📊 任务执行结果:');
  console.log(`   状态: ${result.success ? '✅ 成功' : '❌ 失败'}`);
  if (result.error) {
    console.log(`   错误: ${result.error}`);
  }
  
  const report = sender.generateReport(result);
  
  const reportPath = path.join(DATA_DIR, `wecom-task-report-${Date.now()}.json`);
  try {
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
    console.log(`\n📄 详细报告已保存到: ${reportPath}`);
  } catch (error) {
    console.error(`\n❌ 保存报告失败: ${error.message}`);
  }
  
  console.log('\n' + '='.repeat(60));
  console.log(report.summary);
  console.log('='.repeat(60));
  
  return result;
}

if (require.main === module) {
  main().then(result => {
    process.exit(result.success ? 0 : 1);
  }).catch(error => {
    console.error('❌ 任务执行异常:', error);
    process.exit(1);
  });
}

module.exports = { WeComMessageSender };
