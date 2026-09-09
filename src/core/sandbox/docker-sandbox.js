/**
 * Docker Sandbox — secure code execution in an isolated container
 *
 * Inspired by OpenHarness sandbox/: adapter + docker_backend + Dockerfile.
 * Provides: pull/build/run/stop/teardown lifecycle with configurable
 * resource limits (CPU, memory, disk) and network isolation.
 *
 * Usage:
 *   const sandbox = new DockerSandbox({ image: 'crabpaw-sandbox:latest' });
 *   await sandbox.ensureReady();
 *   const result = await sandbox.run('python -c "print(1+1)"', { timeout: 5000 });
 *   await sandbox.stop();
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const DOCKER_CMD = process.platform === 'win32' ? 'docker.exe' : 'docker';

const DEFAULT_OPTIONS = {
  image: 'crabpaw-sandbox:latest',
  containerName: null,
  memoryLimit: '512m',
  cpuLimit: '1.0',
  diskLimit: '2g',
  networkDisabled: true,
  defaultTimeout: 30000,
  maxTimeout: 120000,
  workspaceMount: null,
};

class DockerSandbox {
  constructor(opts = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
    this._containerId = null;
    this._ready = false;
    this._lastPull = 0;
    this._execCount = 0;
    this._totalRuntimeMs = 0;
  }

  async _docker(args, opts = {}) {
    return new Promise((resolve, reject) => {
      const proc = spawn(DOCKER_CMD, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: opts.timeout || 120000,
        windowsHide: true,
        ...opts,
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => (stdout += d.toString()));
      proc.stderr.on('data', (d) => (stderr += d.toString()));
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`docker ${args[0]} exited ${code}: ${stderr.trim()}`));
      });
    });
  }

  async _buildImage() {
    const inlinePath = path.join(os.tmpdir(), 'crabpaw-sandbox-Dockerfile');
    fs.writeFileSync(inlinePath, this._generateDockerfile());
    try {
      await this._docker(['build', '-t', this.opts.image, '-f', inlinePath, '.']);
    } finally {
      try { fs.unlinkSync(inlinePath); } catch (_) {
        console.warn('[DockerSandbox] failed to cleanup temp Dockerfile:', inlinePath);
      }
    }
  }

  _generateDockerfile() {
    return `FROM node:20-alpine\nRUN apk add --no-cache python3 py3-pip bash curl git jq\nRUN pip3 install --no-cache-dir requests numpy pandas\nRUN adduser -D -h /workspace sandbox\nWORKDIR /workspace\nUSER sandbox\n`;
  }

  async ensureReady() {
    if (this._ready && this._containerId) return;
    try {
      await this._docker(['image', 'inspect', this.opts.image]);
    } catch {
      console.log('[sandbox] Building docker image...');
      await this._buildImage();
    }
    const cname = this.opts.containerName || `crabpaw-sbx-${Date.now()}`;
    const { stdout } = await this._docker([
      'run', '-d',
      '--memory', this.opts.memoryLimit,
      '--cpus', this.opts.cpuLimit,
      '--storage-opt', `size=${this.opts.diskLimit}`,
      '--network', this.opts.networkDisabled ? 'none' : 'bridge',
      '--read-only',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=128m',
      '--rm',
      '--name', cname,
      this.opts.image,
      'tail', '-f', '/dev/null',
    ]);
    this._containerId = stdout.trim();
    this._ready = true;
    console.log(`[sandbox] Container ready: ${this._containerId.slice(0, 12)}`);
  }

  async run(command, opts = {}) {
    if (!this._ready) await this.ensureReady();
    const timeout = Math.min(opts.timeout || this.opts.defaultTimeout, this.opts.maxTimeout);
    const startTime = Date.now();
    this._execCount++;
    try {
      const result = await this._docker([
        'exec', '-w', opts.workdir || '/workspace',
        this._containerId,
        'timeout', '--signal=KILL',
        String(Math.floor(timeout / 1000)),
        'sh', '-c', command,
      ], { timeout: timeout + 5000 });
      this._totalRuntimeMs += Date.now() - startTime;
      return { success: true, stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (e) {
      this._totalRuntimeMs += Date.now() - startTime;
      return { success: false, stdout: '', stderr: e.message, exitCode: 1, error: e.message };
    }
  }

  async stop() {
    if (!this._containerId) return;
    try { await this._docker(['stop', '-t', '5', this._containerId], { timeout: 15000 }); } catch (_) {
      console.warn('[DockerSandbox] failed to stop container:', this._containerId);
    }
    this._containerId = null;
    this._ready = false;
  }

  getStats() {
    return { execCount: this._execCount, totalRuntimeMs: this._totalRuntimeMs, ready: this._ready, containerId: this._containerId };
  }

  async healthCheck() {
    try {
      const r = await this.run('echo OK', { timeout: 5000 });
      return r.success && r.stdout.trim() === 'OK';
    } catch { return false; }
  }
}

const sandboxPool = {
  _pool: [],
  _maxPoolSize: 3,
  async acquire(opts) {
    if (this._pool.length > 0) return this._pool.pop();
    const sb = new DockerSandbox(opts);
    await sb.ensureReady();
    return sb;
  },
  release(sb) {
    if (this._pool.length < this._maxPoolSize) this._pool.push(sb);
    else sb.stop();
  },
  async drain() {
    for (const sb of this._pool) await sb.stop();
    this._pool = [];
  },
};

module.exports = { DockerSandbox, sandboxPool };
