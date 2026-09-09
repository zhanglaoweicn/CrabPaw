/**
 * 股票工具 - 技术指标计算
 *
 * 提取自 stock-tools.js，包含技术分析相关函数
 */

const { fmtNum } = require('./stock-utils');

function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  
  const avgGain = gains / period;
  const avgLoss = losses / period;
  
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateMA(prices, period) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calculateMACD(closes) {
  if (closes.length < 26) return null;
  
  const ema12 = [];
  const ema26 = [];
  const multiplier12 = 2 / (12 + 1);
  const multiplier26 = 2 / (26 + 1);
  
  ema12[0] = closes[0];
  ema26[0] = closes[0];
  
  for (let i = 1; i < closes.length; i++) {
    ema12[i] = (closes[i] - ema12[i - 1]) * multiplier12 + ema12[i - 1];
    ema26[i] = (closes[i] - ema26[i - 1]) * multiplier26 + ema26[i - 1];
  }
  
  const dif = ema12[ema12.length - 1] - ema26[ema26.length - 1];
  
  return { dif, signal: 'MACD计算完成' };
}

function analyzeMomentum(klineData) {
  if (!klineData || klineData.length < 20) return null;
  
  const closes = klineData.map(d => d.close);
  const volumes = klineData.map(d => d.volume);
  const highs = klineData.map(d => d.high);
  const lows = klineData.map(d => d.low);
  
  const currentPrice = closes[closes.length - 1];
  const high52w = Math.max(...highs);
  const low52w = Math.min(...lows);
  
  const rsi = calculateRSI(closes);
  const ma5 = calculateMA(closes, 5);
  const ma10 = calculateMA(closes, 10);
  const ma20 = calculateMA(closes, 20);
  
  const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volumeRatio = volumes[volumes.length - 1] / avgVolume;
  
  const priceVsHigh = ((currentPrice - low52w) / (high52w - low52w) * 100);
  
  let rsiStatus = '中性';
  if (rsi > 70) rsiStatus = '超买';
  else if (rsi > 60) rsiStatus = '偏强';
  else if (rsi < 30) rsiStatus = '超卖';
  else if (rsi < 40) rsiStatus = '偏弱';
  
  let trendStatus = '震荡';
  if (ma5 > ma10 && ma10 > ma20) trendStatus = '多头排列';
  else if (ma5 < ma10 && ma10 < ma20) trendStatus = '空头排列';
  
  let momentumScore = 0;
  if (rsi !== null) {
    if (rsi < 30) momentumScore += 0.3;
    else if (rsi < 40) momentumScore += 0.1;
    else if (rsi > 70) momentumScore -= 0.3;
    else if (rsi > 60) momentumScore -= 0.1;
  }
  
  if (trendStatus === '多头排列') momentumScore += 0.3;
  else if (trendStatus === '空头排列') momentumScore -= 0.3;
  
  if (volumeRatio > 2) momentumScore += 0.2;
  else if (volumeRatio > 1.5) momentumScore += 0.1;
  else if (volumeRatio < 0.5) momentumScore -= 0.1;
  
  return {
    rsi: rsi ? rsi.toFixed(2) : 'N/A',
    rsiStatus,
    ma5: ma5 ? ma5.toFixed(2) : 'N/A',
    ma10: ma10 ? ma10.toFixed(2) : 'N/A',
    ma20: ma20 ? ma20.toFixed(2) : 'N/A',
    trendStatus,
    volumeRatio: volumeRatio.toFixed(2),
    priceVsHigh: priceVsHigh.toFixed(1),
    high52w: high52w.toFixed(2),
    low52w: low52w.toFixed(2),
    nearHigh: priceVsHigh > 80,
    nearLow: priceVsHigh < 20,
    momentumScore: momentumScore.toFixed(2)
  };
}

function detectRisks(quoteData, momentum, marginData) {
  const risks = [];
  const warnings = [];
  
  if (momentum) {
    if (momentum.rsiStatus === '超买') {
      risks.push({
        level: 'HIGH',
        type: '超买风险',
        message: `RSI=${momentum.rsi}，处于超买区域，短期回调风险较大`
      });
    } else if (momentum.rsiStatus === '偏强' && parseFloat(momentum.rsi) > 65) {
      warnings.push({
        level: 'MEDIUM',
        type: '接近超买',
        message: `RSI=${momentum.rsi}，接近超买区域，注意回调风险`
      });
    }
    
    if (momentum.nearHigh) {
      warnings.push({
        level: 'MEDIUM',
        type: '接近高点',
        message: `股价接近52周高点，当前位置: ${momentum.priceVsHigh}%`
      });
    }
    
    if (momentum.trendStatus === '空头排列') {
      risks.push({
        level: 'MEDIUM',
        type: '趋势风险',
        message: '均线空头排列，短期趋势偏弱'
      });
    }
  }
  
  if (quoteData) {
    const changePct = parseFloat(quoteData.changePct);
    if (changePct > 9) {
      warnings.push({
        level: 'HIGH',
        type: '大幅上涨',
        message: `今日涨幅${changePct}%，追高风险较大`
      });
    } else if (changePct < -9) {
      warnings.push({
        level: 'MEDIUM',
        type: '大幅下跌',
        message: `今日跌幅${Math.abs(changePct)}%，可能存在利空因素`
      });
    }
  }
  
  if (marginData) {
    const rzche = marginData.rzche || 0;
    const rqchl = marginData.rqchl || 0;
    if (rzche > 0 && rqchl > 0) {
      warnings.push({
        level: 'LOW',
        type: '融资融券变化',
        message: `融资余额变化: ${fmtNum(rzche)}，融券余额变化: ${fmtNum(rqchl)}`
      });
    }
  }
  
  return { risks, warnings };
}

function detectSupportResistance(klineData) {
  if (!klineData || klineData.length < 30) return null;

  const closes = klineData.map(d => d.close);
  const highs = klineData.map(d => d.high);
  const lows = klineData.map(d => d.low);
  const currentPrice = closes[closes.length - 1];

  const recentHighs = [];
  const recentLows = [];

  for (let i = 2; i < highs.length - 2; i++) {
    if (highs[i] > highs[i - 1] && highs[i] > highs[i - 2] &&
        highs[i] > highs[i + 1] && highs[i] > highs[i + 2]) {
      recentHighs.push(highs[i]);
    }
    if (lows[i] < lows[i - 1] && lows[i] < lows[i - 2] &&
        lows[i] < lows[i + 1] && lows[i] < lows[i + 2]) {
      recentLows.push(lows[i]);
    }
  }

  const priceBuckets = {};
  const bucketSize = (Math.max(...closes.slice(-60)) - Math.min(...closes.slice(-60))) / 20;

  if (bucketSize > 0) {
    for (let i = Math.max(0, closes.length - 60); i < closes.length; i++) {
      const bucket = Math.round(closes[i] / bucketSize) * bucketSize;
      priceBuckets[bucket] = (priceBuckets[bucket] || 0) + 1;
    }
  }

  const supportLevels = [];
  const resistanceLevels = [];

  const sortedBuckets = Object.entries(priceBuckets)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([price]) => parseFloat(price));

  for (const level of sortedBuckets) {
    if (level < currentPrice) {
      supportLevels.push(level.toFixed(2));
    } else if (level > currentPrice) {
      resistanceLevels.push(level.toFixed(2));
    }
  }

  if (recentLows.length > 0) {
    const recentSupport = Math.min(...recentLows.slice(-3));
    if (!supportLevels.includes(recentSupport.toFixed(2))) {
      supportLevels.unshift(recentSupport.toFixed(2));
    }
  }
  if (recentHighs.length > 0) {
    const recentResistance = Math.max(...recentHighs.slice(-3));
    if (!resistanceLevels.includes(recentResistance.toFixed(2))) {
      resistanceLevels.unshift(recentResistance.toFixed(2));
    }
  }

  return {
    support: supportLevels.slice(0, 3),
    resistance: resistanceLevels.slice(0, 3),
    currentPrice: currentPrice.toFixed(2),
  };
}

function analyzeVolatility(klineData) {
  if (!klineData || klineData.length < 20) return null;

  const closes = klineData.map(d => d.close);
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
  const dailyVol = Math.sqrt(variance);
  const annualVol = dailyVol * Math.sqrt(252);

  const recentReturns = returns.slice(-5);
  const recentVol = Math.sqrt(recentReturns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / recentReturns.length) * Math.sqrt(252);

  let volLevel = '正常';
  if (annualVol > 0.5) volLevel = '极高';
  else if (annualVol > 0.35) volLevel = '偏高';
  else if (annualVol < 0.15) volLevel = '偏低';

  return {
    dailyVolatility: (dailyVol * 100).toFixed(2) + '%',
    annualVolatility: (annualVol * 100).toFixed(2) + '%',
    recentVolatility: (recentVol * 100).toFixed(2) + '%',
    level: volLevel,
    avgDailyRange: ((klineData.slice(-20).reduce((sum, d) => sum + (d.high - d.low), 0) / 20) / closes[closes.length - 1] * 100).toFixed(2) + '%',
  };
}

function analyzeMultiTimeframe(klineData) {
  if (!klineData || klineData.length < 60) return null;

  const closes = klineData.map(d => d.close);
  const current = closes[closes.length - 1];

  const shortMA = calculateMA(closes, 5);
  const midMA = calculateMA(closes, 20);
  const longMA = calculateMA(closes, 60);

  let shortTrend = '震荡';
  if (shortMA && current > shortMA) shortTrend = '偏多';
  else if (shortMA && current < shortMA) shortTrend = '偏空';

  let midTrend = '震荡';
  if (midMA && shortMA) {
    if (shortMA > midMA) midTrend = '偏多';
    else if (shortMA < midMA) midTrend = '偏空';
  }

  let longTrend = '震荡';
  if (longMA && midMA) {
    if (midMA > longMA) longTrend = '偏多';
    else if (midMA < longMA) longTrend = '偏空';
  }

  let alignment = '分歧';
  if (shortTrend === '偏多' && midTrend === '偏多' && longTrend === '偏多') alignment = '多头共振';
  else if (shortTrend === '偏空' && midTrend === '偏空' && longTrend === '偏空') alignment = '空头共振';

  return {
    shortTerm: { trend: shortTrend, ma: shortMA ? shortMA.toFixed(2) : 'N/A' },
    midTerm: { trend: midTrend, ma: midMA ? midMA.toFixed(2) : 'N/A' },
    longTerm: { trend: longTrend, ma: longMA ? longMA.toFixed(2) : 'N/A' },
    alignment,
  };
}

function identifyTechnicalPattern(klineData) {
  if (!klineData || klineData.length < 20) return null;

  const recent = klineData.slice(-20);
  const closes = recent.map(d => d.close);
  const highs = recent.map(d => d.high);
  const lows = recent.map(d => d.low);
  const volumes = recent.map(d => d.volume);

  const patterns = [];

  // 头肩顶/底
  if (recent.length >= 15) {
    const last15 = recent.slice(-15);
    const h = last15.map(d => d.high);
    const midIdx = 7;
    if (h[midIdx] > h[midIdx - 3] && h[midIdx] > h[midIdx + 3] &&
        h[midIdx - 3] > h[midIdx - 5] && h[midIdx + 3] > h[midIdx + 5]) {
      patterns.push({ name: '头肩顶雏形', reliability: '中', implication: '看跌' });
    }
  }

  // 双底/双顶
  const recentLows = lows.slice(-10);
  const recentHighs = highs.slice(-10);
  const minLow = Math.min(...recentLows);
  const maxHigh = Math.max(...recentHighs);
  const lowCount = recentLows.filter(l => l < minLow * 1.02).length;
  const highCount = recentHighs.filter(h => h > maxHigh * 0.98).length;

  if (lowCount >= 2) patterns.push({ name: '双底雏形', reliability: '中', implication: '看涨' });
  if (highCount >= 2) patterns.push({ name: '双顶雏形', reliability: '中', implication: '看跌' });

  // 放量突破/缩量回调
  const avgVol = volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1);
  const lastVol = volumes[volumes.length - 1];
  const lastChange = closes[closes.length - 1] - closes[closes.length - 2];

  if (lastChange > 0 && lastVol > avgVol * 1.5) {
    patterns.push({ name: '放量上涨', reliability: '高', implication: '看涨' });
  } else if (lastChange < 0 && lastVol < avgVol * 0.5) {
    patterns.push({ name: '缩量回调', reliability: '中', implication: '偏多' });
  }

  return {
    patterns: patterns.length > 0 ? patterns : [{ name: '无明显形态', reliability: '-', implication: '中性' }],
    currentPrice: closes[closes.length - 1].toFixed(2),
  };
}

module.exports = {
  calculateRSI,
  calculateMA,
  calculateMACD,
  analyzeMomentum,
  detectRisks,
  detectSupportResistance,
  analyzeVolatility,
  analyzeMultiTimeframe,
  identifyTechnicalPattern,
};
