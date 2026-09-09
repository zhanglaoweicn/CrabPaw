/**
 * perf-token-baseline.js — 每轮 token 基线统计（性能专修轨 P3 测量）
 *
 * 用法：node scripts/perf-token-baseline.js [日志目录= data/.crabpaw]
 * 数据源（零插桩，地面真值）：ai.js:1760/:3573 "📊 Token 使用: 输入 X, 输出 Y, 总计 Z"。
 * 输出：输入/输出 token 分布 + 模型窗口 65536 越限率 + 上下文溢出/强制压缩计数。
 */
const fs = require('fs');
const path = require('path');

const LOG_DIR = process.argv[2] || path.resolve(__dirname, '..', 'data', '.crabpaw');
const MODEL_WINDOW = 65536;

function collectLines() {
  const files = ['crabpaw.log', 'crabpaw.log.1', 'crabpaw.log.2', 'crabpaw.log.3', 'crabpaw.log.4']
    .map((f) => path.join(LOG_DIR, f))
    .filter((f) => fs.existsSync(f));
  const lines = [];
  for (const f of files) {
    let content = '';
    try { content = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
    // 分批入数组，避免超大文件全量常驻（10MB 级可接受，此处直接 push）
    for (const line of content.split('\n')) lines.push(line);
  }
  return lines;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[idx];
}

function main() {
  const lines = collectLines();
  const inputs = [];
  const outputs = [];
  let overflow = 0;
  let forced = 0;
  let compressionEvents = 0;

  for (const line of lines) {
    let m = line.match(/📊 Token 使用: 输入 (\d+), 输出 (\d+)/);
    if (m) {
      inputs.push(Number(m[1]));
      outputs.push(Number(m[2]));
    }
    if (/上下文即将溢出/.test(line)) overflow++;
    if (/强制压缩至/.test(line) || /强制压缩/.test(line)) forced++;
    if (/开始压缩上下文/.test(line)) compressionEvents++;
  }

  inputs.sort((a, b) => a - b);
  outputs.sort((a, b) => a - b);
  const mean = (arr) => (arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : 0);

  console.log('=== CrabPaw 每轮 Token 基线 ===');
  console.log(`日志文件行数: ${lines.length}`);
  console.log(`样本轮次: ${inputs.length}（输入 token 实测记录）`);
  if (inputs.length === 0) {
    console.log('⚠️ 未找到 Token 使用日志（可能日志已轮转或格式变化），请检查');
    return;
  }
  console.log('');
  console.log('【输入 token（messages+tools 真实值）】');
  console.log(`  p50: ${percentile(inputs, 0.5)} | p95: ${percentile(inputs, 0.95)} | max: ${inputs[inputs.length - 1]} | mean: ${mean(inputs)}`);
  const overWindow = inputs.filter((v) => v > MODEL_WINDOW).length;
  console.log(`  超 65536 窗口: ${overWindow}/${inputs.length} (${((overWindow / inputs.length) * 100).toFixed(1)}%)`);
  const overDouble = inputs.filter((v) => v > MODEL_WINDOW * 1.2).length;
  console.log(`  超 78.6k: ${overDouble}/${inputs.length} (${((overDouble / inputs.length) * 100).toFixed(1)}%)`);
  console.log('');
  console.log('【输出 token】');
  console.log(`  p50: ${percentile(outputs, 0.5)} | p95: ${percentile(outputs, 0.95)} | max: ${outputs[outputs.length - 1]}`);
  console.log('');
  console.log('【上下文压榨事件】');
  console.log(`  "上下文即将溢出"告警: ${overflow} 次 | 强制压缩: ${forced} 次 | 开始压缩: ${compressionEvents} 次`);
  console.log(`  强制压缩/轮次≈ ${forced && inputs.length ? (forced / inputs.length).toFixed(2) : 0}`);
}

main();
