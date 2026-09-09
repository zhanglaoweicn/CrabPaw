/**
 * 配置迁移脚本：旧格式 → 新格式
 *
 * 旧格式：
 *   models: { currentProvider, providers: { deepseek: { apiKey, baseUrl, model }, ... } }
 *   imageGeneration: { provider, providers: { ... } }
 *   videoGeneration: { provider, providers: { ... } }
 *   visionGeneration: { provider, providers: { ... } }
 *
 * 新格式：
 *   providers: { deepseek: { apiKey, baseUrl, model }, volcengine_standard: { ... }, ... }
 *   modelAssignments: { chat: { provider, model }, image: { ... }, ... }
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

function migrate(oldConfig) {
  const newConfig = { ...oldConfig };
  const providers = { ...(oldConfig.providers || {}) };
  const modelAssignments = {
    chat: { provider: 'deepseek', model: 'deepseek-chat' },
    codingPlan: { provider: '', model: '' },
    image: { provider: '', model: '' },
    video: { provider: '', model: '' },
    vision: { provider: '', model: '' },
    audio: { provider: '', model: '' },
    ...(oldConfig.modelAssignments || {}),
  };

  // 从旧 models.providers 迁移
  const oldModels = oldConfig.models;
  if (oldModels && oldModels.providers) {
    for (const [key, p] of Object.entries(oldModels.providers)) {
      if (p && p.apiKey && !providers[key]) {
        providers[key] = { ...p };
      }
    }
    if (oldModels.currentProvider) {
      const p = oldModels.providers[oldModels.currentProvider];
      if (p) {
        modelAssignments.chat = {
          provider: oldModels.currentProvider,
          model: p.model || 'unknown',
        };
      }
    }
  }

  // 从旧 imageGeneration 迁移
  const oldImage = oldConfig.imageGeneration;
  if (oldImage && oldImage.providers) {
    for (const [key, p] of Object.entries(oldImage.providers)) {
      if (p && p.apiKey && !providers[key]) {
        providers[key] = { ...p };
      }
    }
    if (oldImage.provider) {
      modelAssignments.image = {
        provider: oldImage.provider,
        model: oldImage.model || oldImage.providers?.[oldImage.provider]?.model || '',
      };
    }
  }

  // 从旧 videoGeneration 迁移
  const oldVideo = oldConfig.videoGeneration;
  if (oldVideo && oldVideo.providers) {
    for (const [key, p] of Object.entries(oldVideo.providers)) {
      if (p && p.apiKey && !providers[key]) {
        providers[key] = { ...p };
      }
    }
    if (oldVideo.provider) {
      modelAssignments.video = {
        provider: oldVideo.provider,
        model: oldVideo.model || '',
      };
    }
  }

  // 从旧 visionGeneration 迁移
  const oldVision = oldConfig.visionGeneration;
  if (oldVision && oldVision.providers) {
    for (const [key, p] of Object.entries(oldVision.providers)) {
      if (p && p.apiKey && !providers[key]) {
        providers[key] = { ...p };
      }
    }
    if (oldVision.provider) {
      modelAssignments.vision = {
        provider: oldVision.provider,
        model: oldVision.model || '',
      };
    }
  }

  // 清理旧字段
  delete newConfig.models;
  delete newConfig.imageGeneration;
  delete newConfig.videoGeneration;
  delete newConfig.visionGeneration;

  newConfig.providers = providers;
  newConfig.modelAssignments = modelAssignments;

  return newConfig;
}

// CLI 入口
function main() {
  const configPath = process.argv[2] || path.join(__dirname, '..', 'config.yaml');
  if (!fs.existsSync(configPath)) {
    console.error('配置文件不存在:', configPath);
    process.exit(1);
  }

  const content = fs.readFileSync(configPath, 'utf-8');
  let config;
  try {
    config = yaml.load(content) || {};
  } catch (e) {
    console.error('YAML 解析失败:', e.message);
    process.exit(1);
  }

  const newConfig = migrate(config);

  // 备份原文件
  const backupPath = configPath + '.bak-' + Date.now();
  fs.copyFileSync(configPath, backupPath);
  console.log('已备份到:', backupPath);

  // 写入新配置
  const newYaml = yaml.dump(newConfig, { lineWidth: 120, noRefs: true });
  fs.writeFileSync(configPath, newYaml, 'utf-8');
  console.log('迁移完成:', configPath);
  console.log(JSON.stringify({ providers: Object.keys(newConfig.providers), modelAssignments: newConfig.modelAssignments }, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = { migrate };
