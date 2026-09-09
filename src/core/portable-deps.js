const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const execAsync = require('util').promisify(require('child_process').exec);
// eslint-disable-next-line no-unused-vars -- DATA_DIR 未使用，仅用 BASE_DIR
const { BASE_DIR, DATA_DIR } = require('./config');

const PORTABLE_DIR = path.join(BASE_DIR, 'portable');
const PORTABLE_LIBS_DIR = path.join(PORTABLE_DIR, 'libs');
const PORTABLE_PYTHON_DIR = path.join(PORTABLE_DIR, 'python');
const PORTABLE_FFMPEG_BIN = path.join(PORTABLE_DIR, 'ffmpeg', 'bin');

/**
 * 便携 ffmpeg 解析(2026-09-08 全内置发行): download-portable-deps.js 落
 * portable/ffmpeg/bin/{ffmpeg,ffprobe}.exe, extraResources 打包到 resources/portable/ffmpeg。
 * BASE_DIR 在打包版=resources → 命中; dev 下仓库内已下载同样命中; 否则回退系统 PATH。
 */
function getPortableFfmpegPath(bin = 'ffmpeg.exe') {
  const p = path.join(PORTABLE_FFMPEG_BIN, bin);
  return fs.existsSync(p) ? p : null;
}

function getPortableLibsDir() {
  return PORTABLE_LIBS_DIR;
}

function getSkillLibDir(skillId) {
  return path.join(PORTABLE_LIBS_DIR, skillId);
}

function getPortablePythonPath() {
  if (fs.existsSync(path.join(PORTABLE_PYTHON_DIR, 'python.exe'))) {
    return path.join(PORTABLE_PYTHON_DIR, 'python.exe');
  }
  if (fs.existsSync(path.join(PORTABLE_PYTHON_DIR, 'bin', 'python'))) {
    return path.join(PORTABLE_PYTHON_DIR, 'bin', 'python');
  }
  return 'python';
}

function getSystemPythonPath() {
  try {
    const result = execSync('where python 2>nul || which python 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    }).trim().split('\n')[0].trim();
    return result || 'python';
  } catch (e) {
    console.warn('[portable-deps] system python not found:', e.message);
    return 'python';
  }
}

function getPythonPath() {
  const portablePython = getPortablePythonPath();
  if (portablePython !== 'python') return portablePython;
  return getSystemPythonPath();
}

function ensureSkillLibDir(skillId) {
  const libDir = getSkillLibDir(skillId);
  if (!fs.existsSync(libDir)) {
    fs.mkdirSync(libDir, { recursive: true });
  }
  return libDir;
}

async function installPipDeps(skillId, pipDeps) {
  if (!pipDeps || pipDeps.length === 0) return { success: true, skipped: true };

  const libDir = ensureSkillLibDir(skillId);
  const pythonPath = getPythonPath();

  const depsStr = pipDeps.join(' ');

  try {
    const cmd = `"${pythonPath}" -m pip install --target="${libDir}" ${depsStr} --quiet --no-warn-script-location 2>&1`;
    const { stdout } = await execAsync(cmd, {
      encoding: 'utf-8',
      timeout: 120000,
      windowsHide: true,
    });

    const markerFile = path.join(libDir, '.crabpaw-deps.json');
    fs.writeFileSync(markerFile, JSON.stringify({
      skillId,
      pipDeps,
      installedAt: Date.now(),
      pythonPath,
      portable: pythonPath !== 'python',
    }, null, 2), 'utf-8');

    return {
      success: true,
      libDir,
      output: stdout.trim(),
      portable: pythonPath !== 'python',
    };
  } catch (e) {
    return {
      success: false,
      libDir,
      error: e.message,
      hint: `手动安装: "${pythonPath}" -m pip install --target="${libDir}" ${pipDeps.join(' ')}`,
    };
  }
}

async function installNpmDeps(skillId, npmDeps) {
  if (!npmDeps || npmDeps.length === 0) return { success: true, skipped: true };

  const libDir = ensureSkillLibDir(skillId);
  const nodeModulesDir = path.join(libDir, 'node_modules');

  try {
    if (!fs.existsSync(nodeModulesDir)) {
      fs.mkdirSync(nodeModulesDir, { recursive: true });
    }

    const depsStr = npmDeps.join(' ');
    const cmd = `npm install --prefix "${libDir}" ${depsStr} 2>&1`;
    const { stdout } = await execAsync(cmd, {
      encoding: 'utf-8',
      timeout: 120000,
      windowsHide: true,
    });

    return {
      success: true,
      libDir,
      output: stdout.trim(),
    };
  } catch (e) {
    return {
      success: false,
      libDir,
      error: e.message,
      hint: `手动安装: npm install --prefix "${libDir}" ${npmDeps.join(' ')}`,
    };
  }
}

function checkPipDepsInstalled(skillId, pipDeps) {
  if (!pipDeps || pipDeps.length === 0) return { installed: true, missing: [] };

  const libDir = getSkillLibDir(skillId);
  const markerFile = path.join(libDir, '.crabpaw-deps.json');

  if (!fs.existsSync(markerFile)) {
    return { installed: false, missing: pipDeps, libDir };
  }

  try {
    const marker = JSON.parse(fs.readFileSync(markerFile, 'utf-8'));
    const installedDeps = new Set(marker.pipDeps || []);
    const missing = pipDeps.filter(dep => {
      const baseName = dep.split(/[<>=!]/)[0].trim();
      return !installedDeps.has(dep) && !installedDeps.has(baseName);
    });

    return {
      installed: missing.length === 0,
      missing,
      libDir,
      lastInstalled: marker.installedAt,
    };
  } catch (e) {
    return { installed: false, missing: pipDeps, libDir };
  }
}

function getPythonPathEnv(skillId) {
  const libDir = getSkillLibDir(skillId);
  const paths = [libDir];

  if (fs.existsSync(PORTABLE_PYTHON_DIR)) {
    const sitePackages = path.join(PORTABLE_PYTHON_DIR, 'Lib', 'site-packages');
    if (fs.existsSync(sitePackages)) {
      paths.push(sitePackages);
    }
  }

  return paths.join(path.delimiter);
}

function generatePythonEnvSetup(skillId) {
  // eslint-disable-next-line no-unused-vars -- libDir 未使用，保留 getSkillLibDir 调用
  const libDir = getSkillLibDir(skillId);
  const portablePython = getPortablePythonPath();
  const isPortable = portablePython !== 'python';

  const lines = [
    'import sys',
    'import os',
    '',
    `portable_libs = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'portable', 'libs', '${skillId}')`,
    'if os.path.exists(portable_libs):',
    '    sys.path.insert(0, portable_libs)',
  ];

  if (isPortable) {
    lines.push(
      '',
      `portable_python_libs = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'portable', 'python', 'Lib', 'site-packages')`,
      'if os.path.exists(portable_python_libs):',
      '    sys.path.insert(0, portable_python_libs)',
    );
  }

  return lines.join('\n');
}

function generateExecutorEnvSetup(skillId) {
  // eslint-disable-next-line no-unused-vars -- libDir 未使用，保留 getSkillLibDir 调用
  const libDir = getSkillLibDir(skillId);

  return `const { execSync } = require('child_process');
const path = require('path');
const PORTABLE_LIBS = path.join(__dirname, '..', '..', '..', 'portable', 'libs', '${skillId}');
const PYTHON_PATH_ENV = PORTABLE_LIBS + (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : '');`;
}

function generatePipInstallCommand(skillId, pipDeps) {
  if (!pipDeps || pipDeps.length === 0) return '';

  const libDir = getSkillLibDir(skillId);
  const pythonPath = getPythonPath();
  const depsStr = pipDeps.join(' ');

  return `"${pythonPath}" -m pip install --target="${libDir}" ${depsStr}`;
}

function getSkillDependenciesInfo(skillId) {
  const libDir = getSkillLibDir(skillId);
  const markerFile = path.join(libDir, '.crabpaw-deps.json');

  if (!fs.existsSync(markerFile)) {
    return { installed: false, libDir };
  }

  try {
    return {
      installed: true,
      ...JSON.parse(fs.readFileSync(markerFile, 'utf-8')),
      libDir,
    };
  } catch (e) {
    return { installed: false, libDir, error: e.message };
  }
}

function buildIsolatedChildEnv(skillId) {
  const env = { ...process.env };
  const pythonPathEnv = getPythonPathEnv(skillId);
  if (pythonPathEnv) {
    env.PYTHONPATH = pythonPathEnv + (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : '');
  }
  return env;
}

module.exports = {
  PORTABLE_LIBS_DIR,
  PORTABLE_PYTHON_DIR,
  PORTABLE_FFMPEG_BIN,
  getPortableLibsDir,
  getSkillLibDir,
  getPythonPath,
  getPortablePythonPath,
  getPortableFfmpegPath,
  ensureSkillLibDir,
  installPipDeps,
  installNpmDeps,
  checkPipDepsInstalled,
  getPythonPathEnv,
  buildIsolatedChildEnv,
  generatePythonEnvSetup,
  generateExecutorEnvSetup,
  generatePipInstallCommand,
  getSkillDependenciesInfo,
};
