const { VoiceSessionManager } = require('../../src/core/voice-session');
const os = require('os');
const path = require('path');

// 2026-08-24: 落系统临时目录——原相对路径写仓库根,每轮 eval 残留并多次混入 git
function fresh() {
  return new VoiceSessionManager({
    storageFile: path.join(os.tmpdir(), `voice_session_eval_${Date.now()}.json`),
  });
}

module.exports = {
  name: 'Voice Session',
  cases: [
    {
      id: 'vs_001',
      name: '会话生命周期：start→thinking→speaking→end',
      category: 'voice_session',
      run: () => {
        const m = fresh();
        const id = m.startSession({ userId: 'u1' });
        m.updateState(id, 'thinking');
        m.updateState(id, 'speaking');
        const s = m.getState(id);
        m.endSession(id);
        return s.status === 'speaking' && m.getState(id) === null;
      },
    },
    {
      id: 'vs_002',
      name: '状态回退被拒绝（单向状态机）',
      category: 'voice_session',
      run: () => {
        const m = fresh();
        const id = m.startSession({ userId: 'u1' });
        m.updateState(id, 'speaking');
        const r = m.updateState(id, 'listening'); // 回退
        const s = m.getState(id);
        m.endSession(id);
        return r === false && s.status === 'speaking';
      },
    },
    {
      id: 'vs_003',
      name: '陈旧会话回收（前端崩溃场景）',
      category: 'voice_session',
      run: () => {
        const m = fresh();
        const id = m.startSession({ userId: 'u1' });
        m.updateState(id, 'listening');
        const stale = m.recoverStaleSessions({ maxAgeMs: -1 }); // 全部视为陈旧
        return stale.length === 1 && m.getState(id) === null;
      },
    },
    {
      id: 'vs_004',
      name: '持久化读写闭环（重启恢复）',
      category: 'voice_session',
      run: () => {
        // 2026-08-24: 原相对路径写仓库根——220 个 voice_session_eval2_*.json 曾因此入库
        const file = path.join(os.tmpdir(), `voice_session_eval2_${Date.now()}.json`);
        const m1 = new VoiceSessionManager({ storageFile: file });
        const id = m1.startSession({ userId: 'u1' });
        m1.updateState(id, 'thinking');
        const m2 = new VoiceSessionManager({ storageFile: file });
        const s = m2.getState(id);
        m2.endSession(id);
        return s && s.status === 'thinking';
      },
    },
    {
      id: 'vs_005',
      name: '未知会话操作不崩溃',
      category: 'voice_session',
      run: () => {
        const m = fresh();
        return m.updateState('nope', 'speaking') === false && m.endSession('nope') === false;
      },
    },
  ],
};
