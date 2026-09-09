/**
 * 唤醒词命中率测量脚本（手动运行）
 *
 * 用法: 在 gui/ 下启动 dev:desktop 后, 打开任意页面的 DevTools 控制台执行:
 *   1) 连续说 10 遍唤醒词, 记录命中次数 (目标 ≥ 9/10)
 *   2) 播放 3 段干扰音(音乐/键盘/说话声), 记录误触发次数 (目标 ≤ 1)
 *
 * 本脚本为测量指引, 实际计数由应用内 wake:hit 事件驱动:
 *   在 DevTools 控制台粘贴以下代码即可开始计时:
 *
 *   let hits = 0
 *   window.electronAPI.wake.onHit(() => { hits += 1; console.log('HIT', hits) })
 *   setTimeout(() => console.log('命中次数:', hits), 10000)
 */
console.log('测量指引见文件注释。验收标准: 10 次实读命中 ≥ 9, 3 段干扰误触发 ≤ 1。')
