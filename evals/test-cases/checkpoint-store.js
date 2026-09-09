const fs = require('fs');
const path = require('path');
const os = require('os');
const { CheckpointStore } = require('../../src/core/checkpoint-store');

module.exports = {
  name: 'Checkpoint Store',
  cases: [
    {
      id: 'cp_001',
      name: '保存/读取/删除闭环',
      category: 'checkpoint_store',
      run: () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp_'));
        const store = new CheckpointStore({ dir });
        store.saveCheckpoint('flow_1', { steps: [1, 2], ctx: { a: 1 } });
        const loaded = store.loadCheckpoint('flow_1');
        const del = store.deleteCheckpoint('flow_1');
        const gone = store.loadCheckpoint('flow_1');
        return loaded.steps.length === 2 && loaded.ctx.a === 1 && del === true && gone === null;
      },
    },
    {
      id: 'cp_002',
      name: '损坏快照降级 null 不崩溃',
      category: 'checkpoint_store',
      run: () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp_'));
        const store = new CheckpointStore({ dir });
        fs.writeFileSync(path.join(dir, 'flow_bad.json'), '{broken json');
        return store.loadCheckpoint('flow_bad') === null;
      },
    },
    {
      id: 'cp_003',
      name: '原子写（tmp+rename）',
      category: 'checkpoint_store',
      run: () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp_'));
        const store = new CheckpointStore({ dir });
        store.saveCheckpoint('flow_atomic', { x: 1 });
        const files = fs.readdirSync(dir);
        return files.length === 1 && files[0] === 'flow_atomic.json'; // 无 .tmp 残留
      },
    },
    {
      id: 'cp_004',
      name: 'listCheckpoints 前缀过滤',
      category: 'checkpoint_store',
      run: () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp_'));
        const store = new CheckpointStore({ dir });
        store.saveCheckpoint('flow_1', {});
        store.saveCheckpoint('flow_2', {});
        store.saveCheckpoint('other_1', {});
        return store.listCheckpoints('flow_').length === 2;
      },
    },
    {
      id: 'cp_005',
      name: 'JSON 序列化深层对象完整',
      category: 'checkpoint_store',
      run: () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp_'));
        const store = new CheckpointStore({ dir });
        const data = { flowId: 'f', completedSteps: ['a', 'b'], contextSnapshot: { nested: { deep: [1, 2, 3] } } };
        store.saveCheckpoint('flow_deep', data);
        const loaded = store.loadCheckpoint('flow_deep');
        return JSON.stringify(loaded.contextSnapshot.nested.deep) === '[1,2,3]';
      },
    },
  ],
};
