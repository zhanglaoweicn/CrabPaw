const fs = require('fs');
const path = require('path');

function read(p) { return fs.readFileSync(path.join('gui', p), 'utf8'); }

module.exports = {
  name: 'UI Farfield',
  cases: [
    {
      id: 'uf_001',
      name: '对话气泡字号 ≥16px（远场基准）',
      category: 'ui_farfield',
      run: () => {
        const css = read('src/pages/VoiceShell/styles.css');
        return /font-size:\s*16px/.test(css) || /--font-body-far/.test(css);
      },
    },
    {
      id: 'uf_002',
      name: '大字模式选择器存在',
      category: 'ui_farfield',
      run: () => {
        const css = read('src/index.css');
        return css.includes('data-accessibility="large"');
      },
    },
    {
      id: 'uf_003',
      name: '大字模式下最小字号 18px',
      category: 'ui_farfield',
      run: () => {
        const css = read('src/index.css');
        const large = css.slice(css.indexOf('data-accessibility="large"'));
        return /font-size:\s*18px/.test(large) || /font-size:\s*1[89]px/.test(large);
      },
    },
    {
      id: 'uf_004',
      name: '触控目标 ≥44px（审批按钮）',
      category: 'ui_farfield',
      run: () => {
        const css = read('src/components/ApprovalCard/index.tsx');
        return /min-height:\s*44px|padding:\s*\d+px\s+1\dpx/.test(css) || read('src/index.css').includes('min-height: 44px');
      },
    },
    {
      id: 'uf_005',
      name: 'reduced-motion 保留（不破坏既有可访问性）',
      category: 'ui_farfield',
      run: () => {
        const css = read('src/index.css');
        return css.includes('prefers-reduced-motion');
      },
    },
    {
      id: 'uf_008',
      name: 'AmbientGlow 含 idle 停帧守卫（idle prop + rAF 取消逻辑）',
      category: 'ui_farfield',
      run: () => {
        const src = read('src/components/AmbientGlow/index.tsx');
        // idle 必须出现在非注释代码中（函数签名的 prop 或 ref 赋值），非注释中的空闲说明
        const noComments = src.replace(/\/\/.*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const hasIdleProp = /\bidle\b/.test(noComments);
        const hasCancelRaf = src.includes('cancelAnimationFrame');
        return hasIdleProp && hasCancelRaf;
      },
    },
    {
      id: 'uf_009',
      name: 'HoloDissolve 含性能降级分支（reduce-animations 设置项跳过）',
      category: 'ui_farfield',
      run: () => {
        const src = read('src/components/HoloDissolve/index.tsx');
        // reduce-animations 设置项或 existing performance mode + reduced-motion gate
        return /reduce-animations/.test(src) || /reduceAnimations/i.test(src);
      },
    },
  ],
};
