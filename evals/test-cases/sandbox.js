/**
 * Sandbox Eval — Docker sandbox module load and configuration tests.
 * Full execution tests are skipped (require Docker runtime).
 */

const path = require('path');

module.exports = {
  name: 'Sandbox',
  cases: [
    {
      id: 'sb_001',
      name: 'docker-sandbox module loads',
      category: 'sandbox',
      run: () => {
        try {
          require('../../src/core/sandbox/docker-sandbox');
          return true;
        } catch (e) { return false; }
      },
    },
    {
      id: 'sb_002',
      name: 'sandbox-tool module loads',
      category: 'sandbox',
      run: () => {
        try {
          require('../../src/core/sandbox/sandbox-tool');
          return true;
        } catch (e) { return false; }
      },
    },
    {
      id: 'sb_003',
      name: 'DockerSandbox constructs with defaults',
      category: 'sandbox',
      run: () => {
        const { DockerSandbox } = require('../../src/core/sandbox/docker-sandbox');
        const sb = new DockerSandbox();
        return sb.opts.image === 'crabpaw-sandbox:latest'
          && sb.opts.memoryLimit === '512m'
          && sb.getStats().execCount === 0;
      },
    },
    {
      id: 'sb_004',
      name: 'DockerSandbox generates valid Dockerfile',
      category: 'sandbox',
      run: () => {
        const { DockerSandbox } = require('../../src/core/sandbox/docker-sandbox');
        const sb = new DockerSandbox();
        const df = sb._generateDockerfile();
        return df.includes('FROM node:20-alpine') && df.includes('WORKDIR /workspace');
      },
    },
  ],
};
