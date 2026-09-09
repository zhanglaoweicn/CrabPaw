const http = require('http');
const https = require('https');
// eslint-disable-next-line no-unused-vars -- 工具已停用，registry 保留以便后续恢复 ShowWeather 替代时直接注册
const { registry } = require('./registry');

// eslint-disable-next-line no-unused-vars -- 天气查询无需会话上下文，保留签名以兼容旧 handler 契约
async function _handleWeather(params, context) {
  // 支持多种参数名：city, location, query, place
  const city = params.city || params.location || params.query || params.place || params.cityName;
  
  if (!city) {
    return {
      success: false,
      error: '请提供城市名称。请使用 "city" 参数，例如: {"city": "乌鲁木齐"}。不要再重试，直接告诉用户无法获取天气。'
    };
  }
  
  try {
    const result = await fetchWeather(city);
    if (result && !result.includes('Unknown') && !result.includes('ERROR')) {
      return {
        success: true,
        content: `📍 ${city} 天气: ${result}\n\n[重要] 天气数据已获取完毕，请直接用自然语言向用户播报天气，不要再调用任何工具。]`
      };
    }
    throw new Error('wttr.in 返回无效结果');
  } catch (primaryError) {
    console.log('🌤️ wttr.in 不可用，尝试备用 API...', primaryError.message);
    try {
      const fallbackResult = await fetchWeatherFallback(city);
      return {
        success: true,
        content: `📍 ${city} 天气: ${fallbackResult}\n\n[重要] 天气数据已获取完毕，请直接用自然语言向用户播报天气，不要再调用任何工具。]`
      };
    } catch (fallbackError) {
      return {
        success: false,
        error: `获取天气失败: 主API(${primaryError.message}), 备用API(${fallbackError.message})。请直接告诉用户无法获取天气信息，不要重试。`
      };
    }
  }
}

function fetchWeather(city) {
  return new Promise((resolve, reject) => {
    const url = `http://wttr.in/${encodeURIComponent(city)}?format=3&lang=zh`;
    const protocol = url.startsWith('https') ? https : http;
    
    const req = protocol.get(url, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        resolve(data.trim());
      });
    });
    
    req.on('error', (error) => {
      reject(error);
    });
    
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
  });
}

function fetchWeatherFallback(city) {
  return new Promise((resolve, reject) => {
    const url = `https://api.seniverse.com/v3/weather/now.json?key=demo&location=${encodeURIComponent(city)}&language=zh-Hans`;
    
    const req = https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.results && json.results[0]) {
            const loc = json.results[0].location;
            const now = json.results[0].now;
            resolve(`${loc.name}: ${now.text} ${now.temperature}°C`);
          } else {
            reject(new Error('API 返回格式异常'));
          }
        } catch {
          reject(new Error('解析天气数据失败'));
        }
      });
    });
    
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('备用API超时')); });
  });
}

// 2026-08-01: 旧版 Weather 工具停用——ShowWeather（panel-tools.js）是功能超集
// （同数据源 wttr.in + 创建 weather-panel 面板 surface）。两个天气工具并存时
// LLM 更易选中短名旧版（仅文本、无面板），导致天气面板不可用。
// handleWeather 函数保留作回退参考。
/*
registry.register({
  name: 'Weather',
  toolset: 'web',
  category: 'information',
  description: '获取指定城市的天气信息。调用时必须使用 "city" 参数传入城市名称，例如: {"city": "北京"}。获取天气后直接向用户播报结果，不要再调用其他工具。',
  schema: {
    description: '获取指定城市的天气信息',
    parameters: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          description: '城市名称，必须使用 "city" 作为参数名，如：北京、上海、乌鲁木齐、Beijing、London'
        }
      },
      required: ['city']
    }
  },
  handler: handleWeather,
  checkFn: (params) => !!(params.city || params.location || params.query || params.place || params.cityName),
  timeout: 15000,
  isReadOnly: true,
  isDangerous: false
});
*/

console.log('✅ 天气工具已停用（统一使用 ShowWeather）');
