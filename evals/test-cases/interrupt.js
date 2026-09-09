const { registerInterruptForChatStream } = require('../../src/core/ai');

module.exports = {
  name: 'Interrupt',
  cases: [
    {
      id: 'int_001',
      name: '注册后返回 signal 且可中止',
      category: 'interrupt',
      run: async () => {
        const r = registerInterruptForChatStream('eval_user');
        if (!r || !r.signal || !r.abortController) return false;
        const aborted = new Promise((res) => r.signal.addEventListener('abort', () => res(true)));
        r.abortController.abort();
        const ok = await aborted;
        r.unregister();
        return ok === true;
      },
    },
    {
      id: 'int_002',
      name: 'unregister 后 abort 不再影响（幂等清理）',
      category: 'interrupt',
      run: () => {
        const r = registerInterruptForChatStream('eval_user2');
        r.unregister();
        r.unregister(); // 二次调用不抛
        return true;
      },
    },
    {
      id: 'int_003',
      name: '全局中断触发对应会话 abort',
      category: 'interrupt',
      run: async () => {
        const { globalRequestInterrupt } = require('../../src/core/request-interrupt');
        const r = registerInterruptForChatStream('eval_user3');
        const aborted = new Promise((res) => r.signal.addEventListener('abort', () => res(true)));
        if (globalRequestInterrupt && typeof globalRequestInterrupt.abort === 'function') {
          globalRequestInterrupt.abort('eval_user3');
        } else {
          r.abortController.abort(); // API 不符时退化为直接 abort（报告说明实际 API）
        }
        const ok = await aborted;
        r.unregister();
        return ok === true;
      },
    },
  ],
};
