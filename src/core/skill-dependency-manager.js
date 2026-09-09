const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const { GLOBAL_SKILLS_DIR, DATA_DIR } = require('./config');

const DEPS_CACHE_FILE = path.join(DATA_DIR, 'skill-deps-cache.json');
const PYTHON_VERSIONS = ['python3', 'python', 'py'];
const NODE_VERSIONS = ['node', 'nodejs'];

class SkillDependencyManager {
  constructor(config = {}) {
    this.config = config;
    this.cache = new Map();
    this.installing = new Set();
    this.installQueue = [];
    this.maxConcurrent = config.maxConcurrent || 3;
    this.timeout = config.timeout || 120000;
    this.pythonPath = null;
    this.nodePath = null;
    
    this.detectRuntimes();
    this.loadCache();
  }

  async detectRuntimes() {
    this.pythonPath = await this.findExecutable(PYTHON_VERSIONS);
    this.nodePath = await this.findExecutable(NODE_VERSIONS);
    
    console.log(`🐍 Python: ${this.pythonPath || '未找到'}`);
    console.log(`📦 Node: ${this.nodePath || '未找到'}`);
  }

  findExecutable(names) {
    return new Promise((resolve) => {
      const commands = process.platform === 'win32'
        ? names.map(n => ({ cmd: 'where', args: [n] }))
        : names.map(n => ({ cmd: 'which', args: [n] }));
      
      let resolved = false;
      let pending = commands.length;
      
      for (const { cmd, args } of commands) {
        // exec 首参是命令串(经 shell)——cmd+args 拼接; windowsHide 防止打包版弹可见控制台
        exec([cmd].concat(args || []).join(' '), { windowsHide: true }, (error, stdout) => {
          pending--;
          
          if (!resolved && !error && stdout.trim()) {
            resolved = true;
            resolve(stdout.trim().split('\n')[0]);
          } else if (pending === 0 && !resolved) {
            resolve(null);
          }
        });
      }
    });
  }

  loadCache() {
    try {
      if (fs.existsSync(DEPS_CACHE_FILE)) {
        const data = JSON.parse(fs.readFileSync(DEPS_CACHE_FILE, 'utf-8'));
        for (const [skill, deps] of Object.entries(data)) {
          this.cache.set(skill, deps);
        }
      }
    } catch (e) {
      console.warn('加载依赖缓存失败:', e.message);
    }
  }

  saveCache() {
    try {
      const dir = path.dirname(DEPS_CACHE_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      const data = {};
      for (const [skill, deps] of this.cache) {
        data[skill] = deps;
      }
      
      fs.writeFileSync(DEPS_CACHE_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
      console.warn('保存依赖缓存失败:', e.message);
    }
  }

  parseSkillDeps(skillPath) {
    const deps = {
      pip: [],
      npm: [],
      bin: [],
      system: []
    };

    const skillMdPath = path.join(skillPath, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) {
      return deps;
    }

    const content = fs.readFileSync(skillMdPath, 'utf-8');
    
    const requiresMatch = content.match(/requires:\s*([\s\S]*?)(?=\n\w|\n---|$)/);
    if (requiresMatch) {
      const requiresBlock = requiresMatch[1];
      
      const pipMatch = requiresBlock.match(/pip:\s*\[([^\]]+)\]/);
      if (pipMatch) {
        deps.pip = pipMatch[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);
      }
      
      const npmMatch = requiresBlock.match(/npm:\s*\[([^\]]+)\]/);
      if (npmMatch) {
        deps.npm = npmMatch[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);
      }
      
      const binMatch = requiresBlock.match(/bin:\s*\[([^\]]+)\]/);
      if (binMatch) {
        deps.bin = binMatch[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);
      }
    }

    const packageJsonPath = path.join(skillPath, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        deps.npm = [...deps.npm, ...Object.keys(pkg.dependencies || {})];
      } catch (e) {
        console.debug('[skill-dep] 解析 package.json 失败:', e.message);
      }
    }

    const requirementsPath = path.join(skillPath, 'requirements.txt');
    if (fs.existsSync(requirementsPath)) {
      const reqContent = fs.readFileSync(requirementsPath, 'utf-8');
      const pipDeps = reqContent.split('\n')
        .map(line => line.split('==')[0].split('>=')[0].split('<=')[0].split('~=')[0].trim())
        .filter(line => line && !line.startsWith('#'));
      deps.pip = [...deps.pip, ...pipDeps];
    }

    deps.pip = [...new Set(deps.pip)];
    deps.npm = [...new Set(deps.npm)];
    deps.bin = [...new Set(deps.bin)];

    return deps;
  }

  checkPipInstalled(packages) {
    return new Promise((resolve) => {
      if (!this.pythonPath || packages.length === 0) {
        resolve({ installed: [], missing: packages });
        return;
      }

      const cmd = this.pythonPath;
      const args = ['-c', 'import sys; print("\\n".join(sys.path))'];
      exec([cmd].concat(args || []).join(' '), { windowsHide: true }, (error, stdout) => {
        if (error) {
          resolve({ installed: [], missing: packages });
          return;
        }

        // eslint-disable-next-line no-unused-vars -- pythonPath 局部计算值未使用
        const pythonPath = stdout.trim().split('\n')[0];
        const checkPromises = packages.map(pkg => this.checkPythonPackage(pkg));
        
        Promise.all(checkPromises).then(results => {
          const installed = packages.filter((_, i) => results[i]);
          const missing = packages.filter((_, i) => !results[i]);
          resolve({ installed, missing });
        });
      });
    });
  }

  checkPythonPackage(packageName) {
    return new Promise((resolve) => {
      const importName = packageName.replace(/-/g, '_').split('[')[0];
      // 校验 importName 防止命令注入：只允许 Python 标识符
      if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(importName)) {
        console.warn(`[SkillDependencyManager] 非法 Python 包名: ${importName}`);
        resolve(false);
        return;
      }
      // 使用 -c 传入代码时，用 JSON 编码避免 shell 注入
      const safeCode = `import ${importName}`;
      // safeCode 已校验为 Python 标识符(import X)，无 shell 特殊字符，可安全拼接
      exec([this.pythonPath, '-c', safeCode].join(' '), { windowsHide: true }, (error) => {
        resolve(!error);
      });
    });
  }

  checkNpmInstalled(packages) {
    return new Promise((resolve) => {
      if (!this.nodePath || packages.length === 0) {
        resolve({ installed: [], missing: packages });
        return;
      }

      const checkPromises = packages.map(pkg => this.checkNodePackage(pkg));
      
      Promise.all(checkPromises).then(results => {
        const installed = packages.filter((_, i) => results[i]);
        const missing = packages.filter((_, i) => !results[i]);
        resolve({ installed, missing });
      });
    });
  }

  checkNodePackage(packageName) {
    return new Promise((resolve) => {
      // 安全检查：包名只能包含字母、数字、连字符、下划线、斜杠和@
      if (!/^[@a-zA-Z0-9/_-]+$/.test(packageName)) {
        console.warn(`⚠️ 无效的包名: ${packageName}`);
        resolve(false);
        return;
      }
      // 使用 spawn 传递参数，通过 process.argv 传入包名，避免字符串拼接注入
      const child = spawn(this.nodePath, [
        '-e',
        'try { require(process.argv[1]); process.exit(0) } catch { process.exit(1) }',
        packageName,
      ], {
        shell: false,
        timeout: 10000,
        windowsHide: true,
      });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    });
  }

  checkBinInstalled(bins) {
    return new Promise((resolve) => {
      if (bins.length === 0) {
        resolve({ installed: [], missing: [] });
        return;
      }

      const checkPromises = bins.map(bin => this.findExecutable([bin]));
      
      Promise.all(checkPromises).then(results => {
        const installed = bins.filter((_, i) => results[i]);
        const missing = bins.filter((_, i) => !results[i]);
        resolve({ installed, missing });
      });
    });
  }

  async getSkillDependencyStatus(skillName) {
    const cached = this.cache.get(skillName);
    if (cached && Date.now() - cached.timestamp < 3600000) {
      return cached.status;
    }

    const skillPath = path.join(GLOBAL_SKILLS_DIR, skillName);
    if (!fs.existsSync(skillPath)) {
      return { error: 'Skill not found' };
    }

    const deps = this.parseSkillDeps(skillPath);
    
    const [pipStatus, npmStatus, binStatus] = await Promise.all([
      this.checkPipInstalled(deps.pip),
      this.checkNpmInstalled(deps.npm),
      this.checkBinInstalled(deps.bin)
    ]);

    const status = {
      pip: {
        required: deps.pip,
        installed: pipStatus.installed,
        missing: pipStatus.missing
      },
      npm: {
        required: deps.npm,
        installed: npmStatus.installed,
        missing: npmStatus.missing
      },
      bin: {
        required: deps.bin,
        installed: binStatus.installed,
        missing: binStatus.missing
      },
      ready: pipStatus.missing.length === 0 && npmStatus.missing.length === 0,
      hasDependencies: deps.pip.length > 0 || deps.npm.length > 0 || deps.bin.length > 0
    };

    this.cache.set(skillName, {
      status,
      timestamp: Date.now()
    });
    this.saveCache();

    return status;
  }

  async installPipPackages(packages, options = {}) {
    if (!this.pythonPath || packages.length === 0) {
      return { success: false, error: 'No Python or packages specified' };
    }

    const targetDir = options.targetDir || path.join(DATA_DIR, 'skill-libs', 'python');
    
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    return new Promise((resolve) => {
      const args = ['install', '--target', targetDir, ...packages];
      const proc = spawn(this.pythonPath, ['-m', 'pip', ...args], {
        stdio: 'pipe',
        windowsHide: true
      });

      // eslint-disable-next-line no-unused-vars -- stdout 仅累积写入从未读取
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const timeout = setTimeout(() => {
        proc.kill();
        resolve({ success: false, error: 'Installation timeout' });
      }, this.timeout);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        
        if (code === 0) {
          resolve({ 
            success: true, 
            message: `Successfully installed: ${packages.join(', ')}`,
            targetDir
          });
        } else {
          resolve({ 
            success: false, 
            error: stderr || `pip exited with code ${code}` 
          });
        }
      });

      proc.on('error', (e) => {
        clearTimeout(timeout);
        resolve({ success: false, error: e.message });
      });
    });
  }

  async installNpmPackages(packages, options = {}) {
    if (!this.nodePath || packages.length === 0) {
      return { success: false, error: 'No Node or packages specified' };
    }

    const targetDir = options.targetDir || path.join(DATA_DIR, 'skill-libs', 'node');
    
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    return new Promise((resolve) => {
      const proc = spawn(this.nodePath, ['npm', 'install', ...packages], {
        cwd: targetDir,
        stdio: 'pipe',
        windowsHide: true
      });

      // eslint-disable-next-line no-unused-vars -- stdout 仅累积写入从未读取
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const timeout = setTimeout(() => {
        proc.kill();
        resolve({ success: false, error: 'Installation timeout' });
      }, this.timeout);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        
        if (code === 0) {
          resolve({ 
            success: true, 
            message: `Successfully installed: ${packages.join(', ')}`,
            targetDir
          });
        } else {
          resolve({ 
            success: false, 
            error: stderr || `npm exited with code ${code}` 
          });
        }
      });

      proc.on('error', (e) => {
        clearTimeout(timeout);
        resolve({ success: false, error: e.message });
      });
    });
  }

  async installSkillDependencies(skillName) {
    if (this.installing.has(skillName)) {
      return { success: false, error: 'Installation already in progress' };
    }

    this.installing.add(skillName);

    try {
      const status = await this.getSkillDependencyStatus(skillName);
      
      const results = {
        pip: null,
        npm: null
      };

      if (status.pip?.missing?.length > 0) {
        results.pip = await this.installPipPackages(status.pip.missing);
      }

      if (status.npm?.missing?.length > 0) {
        results.npm = await this.installNpmPackages(status.npm.missing);
      }

      this.cache.delete(skillName);
      
      return {
        success: results.pip?.success !== false && results.npm?.success !== false,
        results
      };
    } finally {
      this.installing.delete(skillName);
    }
  }

  async batchInstallDependencies(skillNames) {
    const results = {};
    
    for (const skillName of skillNames) {
      results[skillName] = await this.installSkillDependencies(skillName);
    }
    
    return results;
  }

  getAllMissingDependencies() {
    const allMissing = {
      pip: new Set(),
      npm: new Set(),
      bin: new Set()
    };

    // eslint-disable-next-line no-unused-vars -- skill 未使用，仅遍历 cached
    for (const [skill, cached] of this.cache) {
      if (cached.status?.pip?.missing) {
        cached.status.pip.missing.forEach(p => allMissing.pip.add(p));
      }
      if (cached.status?.npm?.missing) {
        cached.status.npm.missing.forEach(p => allMissing.npm.add(p));
      }
      if (cached.status?.bin?.missing) {
        cached.status.bin.missing.forEach(p => allMissing.bin.add(p));
      }
    }

    return {
      pip: Array.from(allMissing.pip),
      npm: Array.from(allMissing.npm),
      bin: Array.from(allMissing.bin)
    };
  }

  clearCache() {
    this.cache.clear();
    if (fs.existsSync(DEPS_CACHE_FILE)) {
      fs.unlinkSync(DEPS_CACHE_FILE);
    }
  }
}

const globalDependencyManager = new SkillDependencyManager();

module.exports = {
  SkillDependencyManager,
  globalDependencyManager
};
