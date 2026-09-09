/**
 * voice-evolution bundled plugin
 * 原 src/core/voice-evolution.js 的插件封装
 */
let _timer = null;

module.exports = {
  async onLoad({ manifest }) {
    console.log(`[VoicePlugin] 已加载 v${manifest.version}`);
  },
  async onStart() {
    // 修复：此前 `const { voiceEvolution } = require(...)` 解构导出对象为 undefined，
    // 定时器每 30 分钟抛 "Cannot read properties of undefined (reading 'runAutoEvolution')"
    const voiceEvolution = require('../../src/core/voice-evolution');
    // 去重：init.js 已注册同间隔调度器（带 registerCleanup），此处不再重复调度
    if (global.__voiceEvolutionTimerRegistered) {
      console.log('[VoicePlugin] 调度已由 init.js 注册，跳过重复调度');
      return;
    }
    _timer = setInterval(() => {
      try { voiceEvolution.runAutoEvolution(); } catch (e) {
        console.warn('[VoicePlugin] 进化失败:', e.message);
      }
    }, 30 * 60 * 1000);
    console.log('[VoicePlugin] 已启动 (间隔: 30分钟)');
  },
  async onStop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
    console.log('[VoicePlugin] 已停止');
  },
};
