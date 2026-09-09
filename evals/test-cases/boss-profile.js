const { BossProfileManager, getBossProfile } = require('../../src/core/boss-profile');
const os = require('os');
const path = require('path');

// 2026-08-13: 文件名加随机后缀——eval 以 concurrency 6 并行跑用例,
// 仅用 Date.now() 会在同毫秒撞文件(bp_005 偶发读到其他用例写入的画像而失败)
// 2026-08-24: storageFile 改落系统临时目录——原相对路径写进 cwd(仓库根),
// 每轮 eval 残留 boss_profile_eval_*.json/signals.json 并多次混入 git(220 个已清理)
function fresh() {
  return new BossProfileManager({
    storageFile: path.join(os.tmpdir(), `boss_profile_eval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`),
  });
}

module.exports = {
  name: 'Boss Profile',
  cases: [
    {
      id: 'bp_001',
      name: '画像字段白名单——敏感键被拒绝',
      category: 'boss_profile',
      run: () => {
        const m = fresh();
        m.ingest({ apiKey: 'sk-xxx', password: 'p', name: '张总' });
        const p = m.getProfile();
        return p.name === '张总' && p.apiKey === undefined && p.password === undefined;
      },
    },
    {
      id: 'bp_002',
      name: '从记忆提取身份（fact 型记忆聚合）',
      category: 'boss_profile',
      run: () => {
        const m = fresh();
        m.ingest({ type: 'fact', content: '我在深圳开餐饮公司', ts: Date.now() });
        m.ingest({ type: 'fact', content: '公司有 30 人', ts: Date.now() });
        const p = m.getProfile();
        return !!p.company && !!p.teamSize;
      },
    },
    {
      id: 'bp_003',
      name: '稳定性加权——单次提及不覆盖已稳定画像',
      category: 'boss_profile',
      run: () => {
        const m = fresh();
        m.ingest({ type: 'fact', content: '我在深圳开餐饮公司', ts: Date.now() - 86400000 * 10 });
        m.ingest({ type: 'fact', content: '我在深圳开餐饮公司', ts: Date.now() - 86400000 * 5 });
        const stable = m.getProfile();
        m.ingest({ type: 'fact', content: '我其实是做汽修的', ts: Date.now() });
        const after = m.getProfile();
        return stable.industry === '餐饮' && after.industry === '餐饮'; // 单次新信号不改稳定画像
      },
    },
    {
      id: 'bp_004',
      name: '画像块注入格式（system prompt 固定段）',
      category: 'boss_profile',
      run: () => {
        const m = fresh();
        m.ingest({ type: 'fact', content: '我在深圳开餐饮公司', ts: Date.now() });
        const block = m.getIdentityBlock();
        return block.includes('老板画像') && block.includes('深圳');
      },
    },
    {
      id: 'bp_005',
      name: '空画像优雅降级（不注入空块）',
      category: 'boss_profile',
      run: () => {
        const m = fresh();
        return m.getIdentityBlock() === '';
      },
    },
    {
      id: 'bp_006',
      name: '持久化读写闭环',
      category: 'boss_profile',
      run: () => {
        const m = fresh();
        m.ingest({ type: 'fact', content: '我叫张伟', ts: Date.now() });
        const m2 = new BossProfileManager({ storageFile: m._storageFile });
        return m2.getProfile().name === '张伟';
      },
    },
  ],
};
