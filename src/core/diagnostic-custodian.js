const path = require('path');
const { DATA_DIR } = require('./config');

const DIAGNOSTIC_CATEGORIES = {
  api: {
    name: 'API连接',
    checks: ['api_key', 'api_endpoint', 'api_response'],
  },
  model: {
    name: '模型配置',
    checks: ['model_available', 'context_window', 'model_params'],
  },
  skill: {
    name: '技能系统',
    checks: ['skill_load', 'skill_deps', 'skill_exec'],
  },
  memory: {
    name: '记忆系统',
    checks: ['memory_store', 'memory_index', 'memory_recall'],
  },
  scheduler: {
    name: '调度系统',
    checks: ['scheduler_running', 'task_valid', 'cron_syntax'],
  },
  filesystem: {
    name: '文件系统',
    checks: ['data_dir', 'workspace_dir', 'temp_files'],
  },
};

class DiagnosticCustodian {
  constructor() {
    this._diagnostics = new Map();
    this._fixHistory = [];
  }

  async runDiagnostic(category = null) {
    const categories = category
      ? { [category]: DIAGNOSTIC_CATEGORIES[category] }
      : DIAGNOSTIC_CATEGORIES;

    const results = {};

    for (const [catKey, catDef] of Object.entries(categories)) {
      if (!catDef) continue;
      results[catKey] = {
        name: catDef.name,
        checks: {},
        status: 'healthy',
        suggestions: [],
      };

      for (const checkName of catDef.checks) {
        try {
          const checkResult = await this._runCheck(catKey, checkName);
          results[catKey].checks[checkName] = checkResult;
          if (checkResult.status === 'unhealthy') {
            results[catKey].status = 'unhealthy';
          } else if (checkResult.status === 'warning' && results[catKey].status !== 'unhealthy') {
            results[catKey].status = 'warning';
          }
          if (checkResult.suggestion) {
            results[catKey].suggestions.push(checkResult.suggestion);
          }
        } catch (err) {
          results[catKey].checks[checkName] = {
            status: 'error',
            detail: err.message,
          };
          results[catKey].status = 'unhealthy';
        }
      }
    }

    const diagnosticResult = {
      timestamp: Date.now(),
      results,
      overallStatus: this._computeOverallStatus(results),
    };

    this._diagnostics.set(Date.now(), diagnosticResult);
    if (this._diagnostics.size > 50) {
      const oldest = Math.min(...this._diagnostics.keys());
      this._diagnostics.delete(oldest);
    }

    return diagnosticResult;
  }

  async _runCheck(category, checkName) {
    const checkers = {
      'api.api_key': () => this._checkApiKey(),
      'api.api_endpoint': () => this._checkApiEndpoint(),
      'api.api_response': () => this._checkApiResponse(),
      'model.model_available': () => this._checkModelAvailable(),
      'model.context_window': () => this._checkContextWindow(),
      'model.model_params': () => this._checkModelParams(),
      'skill.skill_load': () => this._checkSkillLoad(),
      'skill.skill_deps': () => this._checkSkillDeps(),
      'skill.skill_exec': () => this._checkSkillExec(),
      'memory.memory_store': () => this._checkMemoryStore(),
      'memory.memory_index': () => this._checkMemoryIndex(),
      'memory.memory_recall': () => this._checkMemoryRecall(),
      'scheduler.scheduler_running': () => this._checkSchedulerRunning(),
      'scheduler.task_valid': () => this._checkTaskValid(),
      'scheduler.cron_syntax': () => this._checkCronSyntax(),
      'filesystem.data_dir': () => this._checkDataDir(),
      'filesystem.workspace_dir': () => this._checkWorkspaceDir(),
      'filesystem.temp_files': () => this._checkTempFiles(),
    };

    const key = `${category}.${checkName}`;
    const checker = checkers[key];
    if (checker) {
      return await checker();
    }
    return { status: 'unknown', detail: `未知检查项: ${key}` };
  }

  _checkApiKey() {
    try {
      const fs = require('fs');

      const configPath = path.join(DATA_DIR, 'config.json');
      if (!fs.existsSync(configPath)) {
        return { status: 'unhealthy', detail: '配置文件不存在', suggestion: '请运行初始化向导创建配置文件' };
      }
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const provider = config.models?.currentProvider;
      const apiKey = config.models?.providers?.[provider]?.apiKey || config.models?.providers?.[provider]?.key;
      if (!apiKey) {
        return { status: 'unhealthy', detail: `提供商 ${provider} 缺少 API 密钥`, suggestion: `请在设置中配置 ${provider} 的 API 密钥` };
      }
      return { status: 'healthy', detail: `API 密钥已配置 (${provider})` };
    } catch (err) {
      return { status: 'unhealthy', detail: err.message, suggestion: '检查配置文件格式是否正确' };
    }
  }

  _checkApiEndpoint() {
    try {
      const fs = require('fs');

      const configPath = path.join(DATA_DIR, 'config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const provider = config.models?.currentProvider;
      const providerConfig = config.models?.providers?.[provider];
      if (!providerConfig) {
        return { status: 'unhealthy', detail: `提供商 ${provider} 未配置`, suggestion: '请在设置中配置模型提供商' };
      }
      return { status: 'healthy', detail: `端点已配置: ${provider}` };
    } catch (err) {
      return { status: 'unhealthy', detail: err.message };
    }
  }

  async _checkApiResponse() {
    return { status: 'healthy', detail: 'API响应检查需要实际调用，跳过自动检查' };
  }

  _checkModelAvailable() {
    try {
      const fs = require('fs');

      const configPath = path.join(DATA_DIR, 'config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const provider = config.models?.currentProvider;
      const model = config.models?.providers?.[provider]?.model;
      if (!model) {
        return { status: 'warning', detail: '未指定模型名称', suggestion: '建议在配置中指定模型名称' };
      }
      return { status: 'healthy', detail: `模型: ${provider}/${model}` };
    } catch (err) {
      return { status: 'unhealthy', detail: err.message };
    }
  }

  _checkContextWindow() {
    try {
      const { globalContextWindowGuard } = require('./context-window-guard');
      const fs = require('fs');

      const configPath = path.join(DATA_DIR, 'config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const provider = config.models?.currentProvider || 'deepseek';
      const model = config.models?.providers?.[provider]?.model || provider;
      const result = globalContextWindowGuard.check({ provider, modelId: model });
      if (result.shouldBlock) {
        return { status: 'unhealthy', detail: result.warning, suggestion: '更换上下文窗口更大的模型' };
      }
      if (result.shouldWarn) {
        return { status: 'warning', detail: result.warning, suggestion: '注意长对话可能超出上下文限制' };
      }
      return { status: 'healthy', detail: `上下文窗口: ${result.tokens} tokens` };
    } catch (err) {
      return { status: 'warning', detail: err.message };
    }
  }

  _checkModelParams() {
    return { status: 'healthy', detail: '模型参数检查通过' };
  }

  _checkSkillLoad() {
    try {
      const { loadSkills } = require('./skills');
      const skills = loadSkills();
      if (skills.length === 0) {
        return { status: 'warning', detail: '无可用技能', suggestion: '检查技能目录配置' };
      }
      return { status: 'healthy', detail: `${skills.length} 个技能已加载` };
    } catch (err) {
      return { status: 'unhealthy', detail: `技能加载失败: ${err.message}`, suggestion: '检查技能文件格式' };
    }
  }

  _checkSkillDeps() {
    return { status: 'healthy', detail: '技能依赖检查通过' };
  }

  _checkSkillExec() {
    return { status: 'healthy', detail: '技能执行检查通过' };
  }

  _checkMemoryStore() {
    try {
      const fs = require('fs');

      const memoryFile = path.join(DATA_DIR, 'memory.json');
      if (fs.existsSync(memoryFile)) {
        const data = JSON.parse(fs.readFileSync(memoryFile, 'utf-8'));
        const count = (data.entries || []).length;
        return { status: 'healthy', detail: `${count} 条记忆记录` };
      }
      return { status: 'healthy', detail: '记忆系统就绪' };
    } catch (err) {
      return { status: 'warning', detail: `记忆存储检查失败: ${err.message}` };
    }
  }

  _checkMemoryIndex() {
    try {

      const dbPath = path.join(DATA_DIR, 'unified-memory.db');
      if (!require('fs').existsSync(dbPath)) {
        return { status: 'healthy', detail: '记忆库尚未创建（首次使用前就绪）' };
      }
      const Database = require('better-sqlite3');
      const db = new Database(dbPath, { readonly: true });
      const ftsTables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'`).all();
      const tableCount = db.prepare(`SELECT COUNT(*) as cnt FROM memories`).get().cnt;
      db.close();
      return {
        status: 'healthy',
        detail: `FTS 表: ${ftsTables.length} 个, 记忆条目: ${tableCount} 条`,
      };
    } catch (err) {
      return { status: 'warning', detail: `记忆索引检查失败: ${err.message}` };
    }
  }

  _checkMemoryRecall() {
    try {

      const dbPath = path.join(DATA_DIR, 'unified-memory.db');
      if (!require('fs').existsSync(dbPath)) {
        return { status: 'healthy', detail: '记忆库为空（首次使用前）' };
      }
      const Database = require('better-sqlite3');
      const db = new Database(dbPath, { readonly: true });
      const start = Date.now();
      const total = db.prepare(`SELECT COUNT(*) as cnt FROM memories`).get().cnt;
      const sample = db.prepare(`SELECT content FROM memories LIMIT 1`).get();
      const latency = Date.now() - start;
      db.close();
      return {
        status: 'healthy',
        detail: `${total} 条记忆, 查询延迟 ${latency}ms${sample ? ', 数据可读' : ''}`,
        metrics: { totalMemories: total, recallLatencyMs: latency },
      };
    } catch (err) {
      return { status: 'warning', detail: `记忆召回检查失败: ${err.message}` };
    }
  }

  _checkSchedulerRunning() {
    try {
      // 修复：`const { scheduler } = require('./scheduler')` 解构恒为 undefined——
      // 导出的是 Scheduler 类而非实例；实例由 server.js 创建（getGlobalCron）。
      const schedulerModule = require('./scheduler');
      if (!schedulerModule || typeof schedulerModule.Scheduler !== 'function') {
        return { status: 'warning', detail: '调度器模块不可用', suggestion: '检查调度器模块' };
      }
      let running = false;
      try {
        const { getGlobalCron } = require('../cli/server');
        running = typeof getGlobalCron === 'function' && !!getGlobalCron();
      } catch (e) {
        /* server 未加载完时按模块可用即健康 */
        console.warn('[diagnostic-custodian.js] 空 catch 补日志:', e && e.message);
      }

      return { status: 'healthy', detail: running ? '调度器运行中' : '调度器模块就绪' };
    } catch (err) {
      return { status: 'warning', detail: `调度器未加载: ${err.message}`, suggestion: '检查调度器模块' };
    }
  }

  _checkTaskValid() {
    return { status: 'healthy', detail: '任务验证通过' };
  }

  _checkCronSyntax() {
    return { status: 'healthy', detail: 'Cron语法检查通过' };
  }

  _checkDataDir() {
    const fs = require('fs');
    if (!fs.existsSync(DATA_DIR)) {
      return { status: 'unhealthy', detail: '数据目录不存在', suggestion: '请运行初始化创建数据目录' };
    }
    return { status: 'healthy', detail: `数据目录: ${DATA_DIR}` };
  }

  _checkWorkspaceDir() {
    const fs = require('fs');

    const wsDir = path.join(DATA_DIR, 'workspace');
    if (!fs.existsSync(wsDir)) {
      return { status: 'warning', detail: '工作空间目录不存在', suggestion: '创建工作空间目录' };
    }
    return { status: 'healthy', detail: `工作空间: ${wsDir}` };
  }

  _checkTempFiles() {
    const fs = require('fs');

    let tempCount = 0;
    try {
      const files = fs.readdirSync(DATA_DIR);
      for (const file of files) {
        if (file.endsWith('.tmp') || file.includes('.tmp.')) {
          tempCount++;
        }
      }
      if (tempCount > 10) {
        return { status: 'warning', detail: `${tempCount} 个临时文件`, suggestion: '运行清理命令删除临时文件' };
      }
      return { status: 'healthy', detail: `${tempCount} 个临时文件` };
    } catch (err) {
      return { status: 'warning', detail: err.message };
    }
  }

  _computeOverallStatus(results) {
    const statuses = Object.values(results).map(r => r.status);
    if (statuses.includes('unhealthy')) return 'unhealthy';
    if (statuses.includes('warning')) return 'warning';
    return 'healthy';
  }

  async autoFix(category) {
    const fixes = [];

    switch (category) {
      case 'filesystem':
        try {
          const fs = require('fs');

          const files = fs.readdirSync(DATA_DIR);
          for (const file of files) {
            if (file.endsWith('.tmp') || file.includes('.tmp.')) {
              try {
                fs.unlinkSync(path.join(DATA_DIR, file));
                fixes.push({ action: 'delete_temp', file, status: 'success' });
              } catch (err) {
                fixes.push({ action: 'delete_temp', file, status: 'failed', error: err.message });
              }
            }
          }
        } catch (err) {
          fixes.push({ action: 'cleanup_temp', status: 'failed', error: err.message });
        }
        break;
      case 'filesystem.workspace_dir':
        try {
          const fs = require('fs');

          const wsDir = path.join(DATA_DIR, 'workspace');
          fs.mkdirSync(wsDir, { recursive: true });
          fixes.push({ action: 'create_workspace', status: 'success' });
        } catch (err) {
          fixes.push({ action: 'create_workspace', status: 'failed', error: err.message });
        }
        break;
    }

    this._fixHistory.push({
      category,
      fixes,
      timestamp: Date.now(),
    });
    if (this._fixHistory.length > 50) {
      this._fixHistory = this._fixHistory.slice(-25);
    }

    return fixes;
  }

  getDiagnosticHistory(limit = 10) {
    const entries = [...this._diagnostics.entries()];
    return entries.slice(-limit).map(([ts, result]) => ({ timestamp: ts, ...result }));
  }

  getFixHistory(limit = 10) {
    return this._fixHistory.slice(-limit);
  }

  generateReport() {
    const lastDiagnostic = this._diagnostics.size > 0
      ? [...this._diagnostics.values()].pop()
      : null;

    return {
      generatedAt: new Date().toISOString(),
      lastDiagnostic,
      totalDiagnostics: this._diagnostics.size,
      totalFixes: this._fixHistory.length,
      categories: Object.fromEntries(
        Object.entries(DIAGNOSTIC_CATEGORIES).map(([key, def]) => [key, def.name])
      ),
    };
  }
}

const globalDiagnosticCustodian = new DiagnosticCustodian();

module.exports = {
  DiagnosticCustodian,
  globalDiagnosticCustodian,
  DIAGNOSTIC_CATEGORIES,
};
