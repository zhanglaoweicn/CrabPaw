/**
 * 项目管理处理器
 *
 * 处理项目的 CRUD、重命名、移动、导出、删除、钉住等 API 请求
 * 项目 = 文件夹，所有对话和生成的文件都归属于项目
 *
 * 便携存储适配：
 * - 所有路径基于 BASE_DIR（项目根目录），与现有架构一致
 * - 不使用 process.cwd()（便携环境下盘符可能变化）
 * - 不存储绝对路径（避免盘符变化导致路径断裂）
 * - 项目目录位于 data/projects/{userId}/ 下，与 data/.crabpaw/ 并列
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const execAsync = require('util').promisify(require('child_process').exec);

// 与现有架构一致：基于项目根目录的相对路径
const BASE_DIR = path.join(__dirname, '..', '..', '..');

/**
 * 获取项目根目录（所有项目存放的父目录）
 * 路径策略：与 DATA_DIR (data/.crabpaw/) 并列，位于 data/projects/
 */
function getProjectsRoot(userId = 'default') {
  const base = process.env.CRABPAW_PROJECTS_DIR || path.join(BASE_DIR, 'data', 'projects');
  const userRoot = path.join(base, userId);
  if (!fs.existsSync(userRoot)) {
    fs.mkdirSync(userRoot, { recursive: true });
  }
  return userRoot;
}

/**
 * 获取项目元数据文件路径
 */
function getProjectMetaPath(projectsRoot, projectId) {
  return path.join(projectsRoot, projectId, '.crabpaw', 'project.json');
}

/**
 * 异步读取项目元数据
 */
async function readProjectMetaAsync(projectsRoot, projectId) {
  const metaPath = getProjectMetaPath(projectsRoot, projectId);
  try {
    const content = await fsp.readFile(metaPath, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    console.warn(`[project-handlers] 读取项目元数据失败 ${projectId}:`, e.message);
    return null;
  }
}

/**
 * 异步写入项目元数据
 */
async function writeProjectMetaAsync(projectsRoot, projectId, meta) {
  const metaDir = path.join(projectsRoot, projectId, '.crabpaw');
  await fsp.mkdir(metaDir, { recursive: true });
  await fsp.writeFile(path.join(metaDir, 'project.json'), JSON.stringify(meta, null, 2), 'utf-8');
}

/**
 * 异步递归列出目录下所有文件
 */
// File extensions to show in project file lists (user-facing only)
const USER_FILE_EXTS = new Set([
  'png','jpg','jpeg','gif','webp','svg','bmp',
  'html','htm','pdf','docx','xlsx','pptx',
  'mp4','webm','mp3','wav',
  'zip','tar','gz',
  'txt','md','csv',
])

// Directories to skip when listing project files (internal/auto-generated)
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.crabpaw', 'backups'])

async function listFilesRecursiveAsync(dir, base = '') {
  const results = [];
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.gitkeep') continue
      const relPath = base ? `${base}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        results.push(...await listFilesRecursiveAsync(path.join(dir, entry.name), relPath))
      } else {
        const ext = path.extname(entry.name).toLowerCase().replace('.', '')
        if (USER_FILE_EXTS.has(ext)) {
          results.push(relPath)
        }
      }
    }
  } catch (e) {
    console.warn(`[project-handlers] 列出目录失败 ${dir}:`, e.message)
  }
  return results
}

/**
 * 创建项目管理处理器集合
 * @param {Function} sendJson - JSON 响应发送函数
 * @returns {Object} 项目管理处理器映射
 */
function createProjectHandlers(sendJson) {
  return {
    /**
     * GET /api/projects - 列出所有项目
     */
    async handleProjectsList(req, res, ctx) {
      const userId = ctx.url.searchParams.get('userId') || 'default';
      try {
        const projectsRoot = getProjectsRoot(userId);
        let entries;
        try {
          entries = await fsp.readdir(projectsRoot, { withFileTypes: true });
        } catch {
          return sendJson(res, 200, { success: true, projects: [], total: 0 });
        }

        const projects = [];

        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const projectId = entry.name;
          const meta = await readProjectMetaAsync(projectsRoot, projectId);

          // 统计项目文件数和大小
          const projectDir = path.join(projectsRoot, projectId);
          let fileCount = 0;
          let totalSize = 0;
          try {
            const files = await listFilesRecursiveAsync(projectDir);
            fileCount = files.length;
            for (const f of files) {
              try {
                const stat = await fsp.stat(path.join(projectDir, f));
                totalSize += stat.size;
              } catch (e) {
                /* 单个文件stat失败不影响整体统计 */
                console.warn('[project-handlers.js] 空 catch 补日志:', e && e.message);
              }

            }
          } catch (e) {
            console.warn(`[project-handlers] 统计项目文件失败 ${projectId}:`, e.message);
          }

          projects.push({
            projectId,
            name: meta?.name || projectId,
            description: meta?.description || '',
            path: projectDir,
            pinned: meta?.pinned || false,
            createdAt: meta?.createdAt || 0,
            updatedAt: meta?.updatedAt || 0,
            lastAccessedAt: meta?.lastAccessedAt || 0,
            sessionCount: meta?.sessionCount || 0,
            fileCount,
            totalSize,
            color: meta?.color || null,
            icon: meta?.icon || null,
          });
        }

        // 排序：钉住的在前，然后按最近访问时间
        projects.sort((a, b) => {
          if (a.pinned !== b.pinned) return b.pinned ? 1 : -1;
          return (b.lastAccessedAt || b.updatedAt || 0) - (a.lastAccessedAt || a.updatedAt || 0);
        });

        sendJson(res, 200, { success: true, projects, total: projects.length });
      } catch (e) {
        console.error('[project-handlers] 列出项目失败:', e);
        sendJson(res, 500, { success: false, message: e.message });
      }
    },

    /**
     * POST /api/projects - 创建项目
     * Body: { name, description?, color?, icon? }
     */
    async handleProjectCreate(req, res, _ctx) {
      try {
        const body = await new Promise((resolve, reject) => {
          let data = '';
          req.on('data', chunk => data += chunk);
          req.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { console.warn('[project-handlers] 解析创建请求体失败:', e.message); resolve({}); } });
          req.on('error', reject);
        });

        const userId = body.userId || 'default';
        const name = body.name || '未命名项目';
        const projectId = `proj_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;

        const projectsRoot = getProjectsRoot(userId);
        const projectDir = path.join(projectsRoot, projectId);

        try {
          await fsp.access(projectDir);
          return sendJson(res, 409, { success: false, message: '项目已存在' });
        } catch (e) {
          /* 目录不存在，可以创建 */
          console.warn('[project-handlers.js] 空 catch 补日志:', e && e.message);
        }


        await fsp.mkdir(projectDir, { recursive: true });

        const meta = {
          projectId,
          name,
          description: body.description || '',
          color: body.color || null,
          icon: body.icon || null,
          pinned: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          lastAccessedAt: Date.now(),
          sessionCount: 0,
        };

        await writeProjectMetaAsync(projectsRoot, projectId, meta);

        sendJson(res, 200, { success: true, project: { ...meta, path: projectDir, fileCount: 0, totalSize: 0 } });
      } catch (e) {
        console.error('[project-handlers] 创建项目失败:', e);
        sendJson(res, 500, { success: false, message: e.message });
      }
    },

    /**
     * PUT /api/projects/:id - 更新项目（重命名、描述、颜色、钉住等）
     * Body: { name?, description?, color?, icon?, pinned? }
     */
    async handleProjectUpdate(req, res, ctx) {
      const pathname = ctx.url.pathname;
      const projectId = pathname.replace('/api/projects/', '');

      if (!projectId || projectId.includes('/')) {
        return sendJson(res, 400, { success: false, message: '缺少 projectId' });
      }

      try {
        const body = await new Promise((resolve, reject) => {
          let data = '';
          req.on('data', chunk => data += chunk);
          req.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { console.warn('[project-handlers] 解析更新请求体失败:', e.message); resolve({}); } });
          req.on('error', reject);
        });

        const userId = body.userId || 'default';
        const projectsRoot = getProjectsRoot(userId);
        const meta = await readProjectMetaAsync(projectsRoot, projectId);

        if (!meta) {
          return sendJson(res, 404, { success: false, message: '项目不存在' });
        }

        // 更新允许的字段
        if (body.name !== undefined) meta.name = body.name;
        if (body.description !== undefined) meta.description = body.description;
        if (body.color !== undefined) meta.color = body.color;
        if (body.icon !== undefined) meta.icon = body.icon;
        if (body.pinned !== undefined) meta.pinned = Boolean(body.pinned);
        meta.updatedAt = Date.now();

        await writeProjectMetaAsync(projectsRoot, projectId, meta);

        const projectDir = path.join(projectsRoot, projectId);
        sendJson(res, 200, { success: true, project: { ...meta, path: projectDir } });
      } catch (e) {
        console.error('[project-handlers] 更新项目失败:', e);
        sendJson(res, 500, { success: false, message: e.message });
      }
    },

    /**
     * DELETE /api/projects/:id - 删除项目
     * Query: ?userId=default&confirm=true
     */
    async handleProjectDelete(req, res, ctx) {
      const pathname = ctx.url.pathname;
      const projectId = pathname.replace('/api/projects/', '');
      const userId = ctx.url.searchParams.get('userId') || 'default';
      const confirm = ctx.url.searchParams.get('confirm') === 'true';

      if (!projectId || projectId.includes('/')) {
        return sendJson(res, 400, { success: false, message: '缺少 projectId' });
      }

      if (!confirm) {
        return sendJson(res, 400, { success: false, message: '删除项目需要确认参数 confirm=true' });
      }

      try {
        const projectsRoot = getProjectsRoot(userId);
        const projectDir = path.join(projectsRoot, projectId);

        try {
          await fsp.access(projectDir);
        } catch {
          return sendJson(res, 404, { success: false, message: '项目不存在' });
        }

        // 递归删除项目目录
        await fsp.rm(projectDir, { recursive: true, force: true });

        // 清理关联会话的 projectId 引用，防止幽灵引用
        try {
          const sessionsDir = path.join(BASE_DIR, 'data', '.crabpaw', 'memory', 'sessions');
          const sessionFiles = await fsp.readdir(sessionsDir).catch(() => []);
          const jsonFiles = sessionFiles.filter(f => f.endsWith('.json'));
          for (const file of jsonFiles) {
            const filePath = path.join(sessionsDir, file);
            try {
              const content = await fsp.readFile(filePath, 'utf-8');
              const data = JSON.parse(content);
              if (data.projectId === projectId) {
                data.projectId = null;
                await fsp.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
              }
            } catch (e) {
              console.warn(`[project-handlers] 清理会话引用失败 ${file}:`, e.message);
            }
          }
        } catch (e) {
          console.warn('[project-handlers] 会话清理失败，不影响项目删除:', e.message);
        }

        sendJson(res, 200, { success: true, message: '项目已删除' });
      } catch (e) {
        console.error('[project-handlers] 删除项目失败:', e);
        sendJson(res, 500, { success: false, message: e.message });
      }
    },

    /**
     * POST /api/projects/:id/move - 移动项目
     * 
     * 便携存储适配：
     * - 仅支持在项目存储区域内移动（重命名项目目录名）
     * - 不支持移动到外部绝对路径（便携环境下盘符变化会导致路径断裂）
     * - 如需将项目文件导出到外部位置，请使用导出功能
     * 
     * Body: { newName? } - 重命名项目目录（内部移动）
     */
    async handleProjectMove(req, res, ctx) {
      const pathname = ctx.url.pathname;
      const projectId = pathname.replace('/api/projects/', '').replace('/move', '');
      const userId = ctx.url.searchParams.get('userId') || 'default';

      if (!projectId) {
        return sendJson(res, 400, { success: false, message: '缺少 projectId' });
      }

      try {
        const body = await new Promise((resolve, reject) => {
          let data = '';
          req.on('data', chunk => data += chunk);
          req.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { console.warn('[project-handlers] 解析移动请求体失败:', e.message); resolve({}); } });
          req.on('error', reject);
        });

        const projectsRoot = getProjectsRoot(userId);
        const srcDir = path.join(projectsRoot, projectId);

        try {
          await fsp.access(srcDir);
        } catch {
          return sendJson(res, 404, { success: false, message: '项目不存在' });
        }

        // 便携存储安全策略：仅支持内部重命名，不支持外部移动
        if (body.targetPath) {
          return sendJson(res, 400, {
            success: false,
            message: '便携存储模式下不支持移动到外部路径。请使用"导出"功能将项目文件复制到外部位置。',
          });
        }

        // 内部重命名（修改项目显示名称，不改变物理路径）
        if (body.newName) {
          const meta = await readProjectMetaAsync(projectsRoot, projectId);
          if (!meta) {
            return sendJson(res, 404, { success: false, message: '项目元数据不存在' });
          }
          meta.name = body.newName;
          meta.updatedAt = Date.now();
          await writeProjectMetaAsync(projectsRoot, projectId, meta);
          return sendJson(res, 200, { success: true, message: '项目已重命名', project: { ...meta, path: srcDir } });
        }

        sendJson(res, 400, { success: false, message: '请提供 newName 参数' });
      } catch (e) {
        console.error('[project-handlers] 移动/重命名项目失败:', e);
        sendJson(res, 500, { success: false, message: e.message });
      }
    },

    /**
     * GET /api/projects/:id/export - 导出项目为 ZIP
     */
    async handleProjectExport(req, res, ctx) {
      const pathname = ctx.url.pathname;
      const projectId = pathname.replace('/api/projects/', '').replace('/export', '');
      const userId = ctx.url.searchParams.get('userId') || 'default';

      if (!projectId) {
        return sendJson(res, 400, { success: false, message: '缺少 projectId' });
      }

      try {
        const projectsRoot = getProjectsRoot(userId);
        const projectDir = path.join(projectsRoot, projectId);
        const meta = await readProjectMetaAsync(projectsRoot, projectId);

        try {
          await fsp.access(projectDir);
        } catch {
          return sendJson(res, 404, { success: false, message: '项目不存在' });
        }
        if (!meta) {
          return sendJson(res, 404, { success: false, message: '项目元数据不存在' });
        }

        // 使用 Node.js 内置的 zlib 创建 ZIP（或使用系统 zip 命令）
        const exportDir = path.join(projectsRoot, '.exports');
        await fsp.mkdir(exportDir, { recursive: true });

        const exportName = `${meta.name || projectId}_${new Date().toISOString().slice(0, 10)}.zip`;
        const exportPath = path.join(exportDir, exportName);

        // 尝试使用系统 zip 命令
        try {
          if (process.platform === 'win32') {
            const safeProjectDir = projectDir.replace(/'/g, "''");
            const safeExportPath = exportPath.replace(/'/g, "''");
            await execAsync(
              `powershell -Command "Compress-Archive -Path '${safeProjectDir}\\*' -DestinationPath '${safeExportPath}' -Force"`,
              { timeout: 30000 }
            );
          } else {
            await execAsync(`zip -r "${exportPath}" .`, { cwd: projectDir, timeout: 30000 });
          }
        } catch (e) {
          // 降级：返回文件列表而非 ZIP
          console.warn('[project-handlers] ZIP压缩失败，降级为文件列表:', e.message);
          const files = await listFilesRecursiveAsync(projectDir);
          return sendJson(res, 200, {
            success: true,
            exportType: 'file-list',
            projectName: meta.name,
            files,
            totalFiles: files.length,
          });
        }

        // 流式传输 ZIP 文件
        try {
          const stat = await fsp.stat(exportPath);
          res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${encodeURIComponent(exportName)}"`,
            'Content-Length': stat.size,
          });
          const stream = fs.createReadStream(exportPath);
          stream.pipe(res);
          stream.on('end', () => {
            fsp.unlink(exportPath).catch(e => console.warn('[project-handlers] 清理导出临时文件失败:', e.message));
          });
          return;
        } catch (e) {
          console.warn('[project-handlers] 读取导出ZIP失败:', e.message);
        }

        sendJson(res, 500, { success: false, message: '导出失败' });
      } catch (e) {
        console.error('[project-handlers] 导出项目失败:', e);
        sendJson(res, 500, { success: false, message: e.message });
      }
    },

    /**
     * GET /api/projects/:id/sessions - 获取项目下的对话列表
     */
    async handleProjectSessions(req, res, ctx) {
      const pathname = ctx.url.pathname;
      const projectId = pathname.replace('/api/projects/', '').replace('/sessions', '');
      const userId = ctx.url.searchParams.get('userId') || 'default';

      if (!projectId) {
        return sendJson(res, 400, { success: false, message: '缺少 projectId' });
      }

      try {
        const sessionPersistence = ctx.sessionManager?.persistence;
        if (!sessionPersistence) {
          return sendJson(res, 200, { success: true, sessions: [], total: 0 });
        }

        const allSessions = await sessionPersistence.getUserSessions(userId, { limit: 1000 });
        // 过滤属于当前项目的会话
        const projectSessions = allSessions.filter(s => {
          if (s.projectId === projectId) return true;
          // 兼容：检查会话文件中的 projectId
          try {
            const sessionData = sessionPersistence.loadSession(s.sessionId);
            if (sessionData && sessionData.projectId === projectId) return true;
          } catch (e) {
            console.warn(`[project-handlers] 加载会话数据失败 ${s.sessionId}:`, e.message);
          }
          return false;
        });

        sendJson(res, 200, { success: true, sessions: projectSessions, total: projectSessions.length });
      } catch (e) {
        console.error('[project-handlers] 获取项目会话列表失败:', e);
        sendJson(res, 500, { success: false, message: e.message });
      }
    },

    /**
     * GET /api/projects/:id/files - 获取项目文件列表
     */
    async handleProjectFiles(req, res, ctx) {
      const pathname = ctx.url.pathname;
      const projectId = pathname.replace('/api/projects/', '').replace('/files', '');
      const userId = ctx.url.searchParams.get('userId') || 'default';

      if (!projectId) {
        return sendJson(res, 400, { success: false, message: '缺少 projectId' });
      }

      try {
        const projectsRoot = getProjectsRoot(userId);
        const projectDir = path.join(projectsRoot, projectId);

        try {
          await fsp.access(projectDir);
        } catch {
          return sendJson(res, 404, { success: false, message: '项目不存在' });
        }

        const files = await listFilesRecursiveAsync(projectDir);
        sendJson(res, 200, { success: true, files: files.map(f => ({ name: f })), total: files.length });
      } catch (e) {
        console.error('[project-handlers] 获取项目文件列表失败:', e);
        sendJson(res, 500, { success: false, message: e.message });
      }
    },
  };
}

module.exports = { createProjectHandlers, getProjectsRoot, readProjectMetaAsync, writeProjectMetaAsync, listFilesRecursiveAsync };
