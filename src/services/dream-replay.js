/**
 * Dream Replay Service
 * 
 * 梦境结果持久化与回放
 * 支持快照保存、回滚和恢复
 */

const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const EventEmitter = require('events');

class DreamReplay extends EventEmitter {
  constructor(config = {}) {
    super();

    this.config = {
      maxSnapshots: config.maxSnapshots || 50,
      snapshotDir: config.snapshotDir || null,
      enablePersistence: config.enablePersistence || false,
      ...config,
    };

    this.snapshots = [];
    this.currentIndex = -1;
    this.sessionSnapshots = new Map();
  }

  async initialize() {
    if (this.config.enablePersistence && this.config.snapshotDir) {
      await fs.mkdir(this.config.snapshotDir, { recursive: true });
      await this._loadPersistedSnapshots();
    }
  }

  async saveSnapshot(phase, state, metadata = {}) {
    const serialized = this._serialize(state);
    const checksum = this._computeChecksum(serialized);

    const snapshot = {
      id: `dream_${Date.now()}_${phase}_${crypto.randomBytes(4).toString('hex')}`,
      phase,
      timestamp: Date.now(),
      state: serialized,
      checksum,
      metadata: {
        ...metadata,
        stateSize: serialized.length,
      },
    };

    this.snapshots.push(snapshot);
    this.currentIndex = this.snapshots.length - 1;

    if (this.snapshots.length > this.config.maxSnapshots) {
      const removed = this.snapshots.shift();
      this.currentIndex--;
      
      if (this.config.enablePersistence && removed.id) {
        await this._deletePersistedSnapshot(removed.id);
      }
    }

    if (this.config.enablePersistence) {
      await this._persistSnapshot(snapshot);
    }

    this.emit('snapshot:saved', {
      id: snapshot.id,
      phase,
      size: serialized.length,
    });

    return snapshot.id;
  }

  async restoreSnapshot(snapshotId) {
    const index = this.snapshots.findIndex(s => s.id === snapshotId);
    
    if (index === -1) {
      return null;
    }

    const snapshot = this.snapshots[index];

    const currentChecksum = this._computeChecksum(snapshot.state);
    if (currentChecksum !== snapshot.checksum) {
      this.emit('snapshot:corrupted', { id: snapshotId });
      throw new Error('Snapshot corrupted: checksum mismatch');
    }

    const restored = this._deserialize(snapshot.state);
    this.currentIndex = index;

    this.emit('snapshot:restored', {
      id: snapshotId,
      phase: snapshot.phase,
    });

    return restored;
  }

  canRollback() {
    return this.currentIndex > 0;
  }

  async rollback() {
    if (!this.canRollback()) {
      return null;
    }

    this.currentIndex--;
    const snapshot = this.snapshots[this.currentIndex];
    
    return this.restoreSnapshot(snapshot.id);
  }

  canForward() {
    return this.currentIndex < this.snapshots.length - 1;
  }

  async forward() {
    if (!this.canForward()) {
      return null;
    }

    this.currentIndex++;
    const snapshot = this.snapshots[this.currentIndex];
    
    return this.restoreSnapshot(snapshot.id);
  }

  getSnapshot(index) {
    if (index < 0 || index >= this.snapshots.length) {
      return null;
    }
    return this.snapshots[index];
  }

  getCurrentSnapshot() {
    if (this.currentIndex < 0 || this.currentIndex >= this.snapshots.length) {
      return null;
    }
    return this.snapshots[this.currentIndex];
  }

  getSnapshotsByPhase(phase) {
    return this.snapshots.filter(s => s.phase === phase);
  }

  getSnapshotTimeline() {
    return this.snapshots.map((s, i) => ({
      index: i,
      id: s.id,
      phase: s.phase,
      timestamp: s.timestamp,
      isCurrent: i === this.currentIndex,
      metadata: s.metadata,
    }));
  }

  createSessionSnapshot(sessionId, state) {
    const snapshot = {
      id: `session_${sessionId}_${Date.now()}`,
      sessionId,
      timestamp: Date.now(),
      state: this._serialize(state),
    };

    if (!this.sessionSnapshots.has(sessionId)) {
      this.sessionSnapshots.set(sessionId, []);
    }

    const sessionSnaps = this.sessionSnapshots.get(sessionId);
    sessionSnaps.push(snapshot);

    if (sessionSnaps.length > 10) {
      sessionSnaps.shift();
    }

    this.emit('session:snapshot', { sessionId, id: snapshot.id });

    return snapshot.id;
  }

  getSessionSnapshots(sessionId) {
    return this.sessionSnapshots.get(sessionId) || [];
  }

  async restoreSessionSnapshot(sessionId, snapshotId) {
    const sessionSnaps = this.sessionSnapshots.get(sessionId);
    if (!sessionSnaps) return null;

    const snapshot = sessionSnaps.find(s => s.id === snapshotId);
    if (!snapshot) return null;

    return this._deserialize(snapshot.state);
  }

  _serialize(state) {
    return JSON.stringify(state, (key, value) => {
      if (value instanceof Map) {
        return { __type: 'Map', data: Array.from(value.entries()) };
      }
      if (value instanceof Set) {
        return { __type: 'Set', data: Array.from(value.values()) };
      }
      if (value instanceof Date) {
        return { __type: 'Date', data: value.toISOString() };
      }
      if (typeof value === 'bigint') {
        return { __type: 'BigInt', data: value.toString() };
      }
      if (value instanceof Error) {
        return {
          __type: 'Error',
          data: {
            name: value.name,
            message: value.message,
            stack: value.stack,
          },
        };
      }
      return value;
    });
  }

  _deserialize(str) {
    return JSON.parse(str, (key, value) => {
      if (value?.__type === 'Map') {
        return new Map(value.data);
      }
      if (value?.__type === 'Set') {
        return new Set(value.data);
      }
      if (value?.__type === 'Date') {
        return new Date(value.data);
      }
      if (value?.__type === 'BigInt') {
        return BigInt(value.data);
      }
      if (value?.__type === 'Error') {
        const err = new Error(value.data.message);
        err.name = value.data.name;
        err.stack = value.data.stack;
        return err;
      }
      return value;
    });
  }

  _computeChecksum(data) {
    return crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
  }

  async _persistSnapshot(snapshot) {
    if (!this.config.snapshotDir) return;

    const filePath = path.join(this.config.snapshotDir, `${snapshot.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(snapshot, null, 2));
  }

  async _deletePersistedSnapshot(snapshotId) {
    if (!this.config.snapshotDir) return;

    const filePath = path.join(this.config.snapshotDir, `${snapshotId}.json`);
    try {
      await fs.unlink(filePath);
    } catch (e) {

      // Ignore if file doesn't exist

      console.warn('[dream-replay.js] 空 catch 补日志:', e && e.message);
    }

  }

  async _loadPersistedSnapshots() {
      if (!this.config.snapshotDir) return;
      try {
      const files = await fs.readdir(this.config.snapshotDir);
      for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
      const filePath = path.join(this.config.snapshotDir, file);
      const content = await fs.readFile(filePath, 'utf8');
      const snapshot = JSON.parse(content);
      this.snapshots.push(snapshot);
      } catch (e) {
        // Skip corrupted files
        console.warn('[dream-replay.js] 空 catch 补日志:', e && e.message);
      }
      }
      this.snapshots.sort((a, b) => a.timestamp - b.timestamp);
      this.currentIndex = this.snapshots.length - 1;
    } catch (e) {

      // Directory doesn't exist or can't be read

      console.warn('[dream-replay.js] 空 catch 补日志:', e && e.message);
    }

  }

  getStats() {
    const byPhase = {};
    
    for (const snapshot of this.snapshots) {
      byPhase[snapshot.phase] = (byPhase[snapshot.phase] || 0) + 1;
    }

    return {
      totalSnapshots: this.snapshots.length,
      currentIndex: this.currentIndex,
      canRollback: this.canRollback(),
      canForward: this.canForward(),
      byPhase,
      sessionSnapshots: this.sessionSnapshots.size,
      totalSize: this.snapshots.reduce((sum, s) => sum + (s.metadata?.stateSize || 0), 0),
    };
  }

  clear() {
    this.snapshots = [];
    this.currentIndex = -1;
    this.sessionSnapshots.clear();
    this.emit('cleared');
  }

  export() {
    return {
      snapshots: this.snapshots,
      currentIndex: this.currentIndex,
      sessionSnapshots: Array.from(this.sessionSnapshots.entries()),
    };
  }

  import(data) {
    if (data?.snapshots) {
      this.snapshots = data.snapshots;
    }
    if (typeof data?.currentIndex === 'number') {
      this.currentIndex = data.currentIndex;
    }
    if (data?.sessionSnapshots) {
      this.sessionSnapshots = new Map(data.sessionSnapshots);
    }
  }
}

const dreamReplay = new DreamReplay();

module.exports = {
  DreamReplay,
  dreamReplay,
};
