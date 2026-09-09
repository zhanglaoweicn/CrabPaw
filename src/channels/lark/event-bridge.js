require('../../core/safe-stdio').installSafeStdio();
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { DEFAULT_PORT } = require('../../core/config');

console.log('🚀 飞书事件桥接器启动');
console.log('🔍 CRABPAW_DATA_DIR env:', process.env.CRABPAW_DATA_DIR);

const BASE_DIR = path.join(__dirname, '..', '..', '..');
const DATA_DIR = process.env.CRABPAW_DATA_DIR || path.join(BASE_DIR, 'data', '.crabpaw');
const LARK_STATUS_PATH = path.join(DATA_DIR, 'lark-status.json');

console.log('📁 BASE_DIR:', BASE_DIR);
console.log('📁 DATA_DIR:', DATA_DIR);

// 从环境变量同步 lark-cli 配置，确保与主服务使用相同凭据
function _ensureLarkCliConfig() {
  const appId = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;
  if (!appId || !appSecret) {
    console.log('📝 LARK_APP_ID/SECRET 未设置，lark-cli 将使用 ~/.lark/config.json 中的现有配置');
    return false;
  }

  const os = require('os');
  const larkConfigDir = path.join(os.homedir(), '.lark');
  const larkConfigPath = path.join(larkConfigDir, 'config.json');

  try {
    if (!fs.existsSync(larkConfigDir)) {
      fs.mkdirSync(larkConfigDir, { recursive: true });
    }

    let existing = {};
    try {
      if (fs.existsSync(larkConfigPath)) {
        existing = JSON.parse(fs.readFileSync(larkConfigPath, 'utf-8'));
      }
    } catch (e) {
      /* 忽略已损坏的配置文件 */
      console.warn('[event-bridge.js] 空 catch 补日志:', e && e.message);
    }


    // 只更新凭据相关字段，保留其他配置
    existing.appId = appId;
    existing.appSecret = appSecret;

    fs.writeFileSync(larkConfigPath, JSON.stringify(existing, null, 2), 'utf-8');
    console.log('✅ 已同步 lark-cli 配置 (App ID: ' + appId.substring(0, 8) + '***) → ' + larkConfigPath);
    return true;
  } catch (e) {
    console.error('❌ 写入 lark-cli 配置失败:', e.message);
    return false;
  }
}

const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BASE_DELAY = 3000;
let reconnectAttempts = 0;
let larkEvent = null;
let isShuttingDown = false;
let heartbeatTimer = null;

function updateLarkStatus(connected) {
  try {
    fs.writeFileSync(LARK_STATUS_PATH, JSON.stringify({
      connected,
      timestamp: Date.now()
    }));
    console.log('📝 Lark status updated:', connected, LARK_STATUS_PATH);
  } catch (e) {
    console.error('❌ Failed to write lark status:', e.message, LARK_STATUS_PATH);
  }
}

function startLarkEvent() {
  if (isShuttingDown) return;
  
  console.log(`🔌 启动 lark-cli event 连接... (尝试 ${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS})`);
  
  // 优先使用本地安装的 @larksuite/cli，回退到 npx
  const localLarkCli = path.join(BASE_DIR, 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js');
  let cmd, args;
  
  if (fs.existsSync(localLarkCli)) {
    console.log('📦 使用本地安装的 @larksuite/cli');
    cmd = process.execPath;
    args = [localLarkCli, 'event', '+subscribe', '--compact', '--as', 'bot', '--force'];
  } else {
    console.log('📦 本地未找到 @larksuite/cli，回退到 npx');
    cmd = 'npx';
    args = ['-y', '@larksuite/cli@latest', 'event', '+subscribe', '--compact', '--as', 'bot', '--force'];
  }
  
  larkEvent = spawn(cmd, args, {
    cwd: __dirname,
    shell: true,
    windowsHide: true,
  });

  // 2026-09-06: NDJSON 行缓冲——stdout 按 chunk 到达，一行 JSON 可能被截成
  // 两半；此前直接 split('\n') 会让半行 JSON.parse 失败被静默丢弃。
  let lineBuffer = '';
  larkEvent.stdout.on('data', async (data) => {
    const raw = data.toString();
    if (!raw.trim()) return;

    console.log('📥 收到 lark-cli 输出:', raw.substring(0, 500));

    if (raw.includes('Connected') || raw.includes('connected')) {
      reconnectAttempts = 0;
      updateLarkStatus(true);
    }

    lineBuffer += raw;
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() || ''; // 最后一段可能是半行，留到下一个 chunk

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        console.log('📨 解析到事件:', JSON.stringify(event).substring(0, 300));
        updateLarkStatus(true);
        await sendToWebhook(event);
      } catch (e) {
        if (line.startsWith('{') || line.startsWith('[')) {
          console.log('⚠️ 解析 JSON 失败:', line.substring(0, 100), e.message);
        }
      }
    }
  });

  larkEvent.stderr.on('data', (data) => {
    const output = data.toString();
    if (output.includes('Connected')) {
      reconnectAttempts = 0;
      console.log('✅ WebSocket 已连接');
      updateLarkStatus(true);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => updateLarkStatus(true), 60000);
    } else if (output.includes('Connecting')) {
      console.log('🔌 正在连接...');
      updateLarkStatus(false);
    } else if (!output.includes('SDK Info') && !output.includes('Tip:')) {
      console.log('💬 状态:', output.trim());
    }
  });

  larkEvent.on('close', (code) => {
    console.log(`⚠️ lark-cli event 进程退出，代码: ${code}`);
    updateLarkStatus(false);
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    lineBuffer = ''; // 丢弃残行（半行事件不可恢复）

    if (!isShuttingDown && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      const delay = RECONNECT_BASE_DELAY * Math.pow(1.5, reconnectAttempts);
      console.log(`🔄 ${delay/1000}秒后尝试重连...`);

      setTimeout(() => {
        reconnectAttempts++;
        startLarkEvent();
      }, delay);
    } else if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      // 2026-09-06 自愈: 耗尽后此前只打日志不退出——server 侧看门狗只对
      // "子进程退出非 0" 重启, 僵尸进程谁也不会再拉。改为退出交看门狗重启。
      console.error(`❌ 达到最大重连次数 (${MAX_RECONNECT_ATTEMPTS})，退出进程交由看门狗重启`);
      process.exit(1);
    }
  });

  larkEvent.on('error', (err) => {
    console.error('❌ lark-cli event 进程错误:', err.message);
  });
}

const API_TOKEN_PATH = path.join(DATA_DIR, '.api_token');

function getApiToken() {
  try {
    if (fs.existsSync(API_TOKEN_PATH)) {
      return fs.readFileSync(API_TOKEN_PATH, 'utf-8').trim();
    }
  } catch (e) { console.warn('读取 API Token 失败:', e.message) }
  return '';
}

async function sendToWebhook(event) {
  const port = process.env.API_PORT || process.env.PORT || DEFAULT_PORT;

  const postData = JSON.stringify(event);

  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData)
  };
  const token = getApiToken();
  if (token) {
    headers['X-Api-Key'] = token;
  }

  const options = {
    hostname: 'localhost',
    port: port,
    path: '/webhook',
    method: 'POST',
    headers
  };

  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          console.error(`❌ webhook 返回错误: ${res.statusCode} ${data}`);
          reject(new Error(`webhook ${res.statusCode}: ${data}`));
        } else {
          console.log('✅ 事件已发送到 webhook');
          resolve(data);
        }
      });
    });

    req.on('error', (e) => {
      console.error('❌ 发送到 webhook 失败:', e.message);
      reject(e);
    });

    req.write(postData);
    req.end();
  });
}

process.on('SIGINT', () => {
  console.log('\n👋 正在关闭...');
  isShuttingDown = true;
  if (larkEvent) {
    larkEvent.kill();
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 收到终止信号...');
  isShuttingDown = true;
  if (larkEvent) {
    larkEvent.kill();
  }
  process.exit(0);
});

_ensureLarkCliConfig();
startLarkEvent();
