/**
 * Archive Tools — 压缩/解压工具
 *
 * 支持 ZIP、tar.gz、tar、.7z 格式。
 * 使用系统 CLI 工具 (7z/zip/tar)，无需 Node.js 库。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { registry } = require('./registry');

const ARCHIVE_TIMEOUT = 120000;

function _exec(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      timeout: ARCHIVE_TIMEOUT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `Exit code ${code}`));
    });
  });
}

function _listFiles(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(..._listFiles(fullPath));
    } else {
      const stat = fs.statSync(fullPath);
      results.push({ path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  return results;
}

// ── 压缩 ──

async function handleArchiveCompress(params, context) {
  const { source, output, format = 'zip' } = params;
  if (!source || !output) {
    return { success: false, error: '需要 source（源文件/目录路径）和 output（输出路径）参数' };
  }

  const sourcePath = path.resolve(source);
  const outputPath = path.resolve(output);
  const workspaceDir = context?.workspaceDir || process.cwd();

  // 安全检查：必须在工作目录内
  if (!sourcePath.startsWith(workspaceDir) || !outputPath.startsWith(workspaceDir)) {
    return { success: false, error: '路径必须在工作目录内' };
  }

  if (!fs.existsSync(sourcePath)) {
    return { success: false, error: `源路径不存在: ${source}` };
  }

  try {
    const stats = fs.statSync(sourcePath);

    if (format === 'zip') {
      await _exec('7z', ['a', '-tzip', outputPath, sourcePath]);
    } else if (format === 'tar') {
      if (stats.isDirectory()) {
        const parentDir = path.dirname(sourcePath);
        const baseName = path.basename(sourcePath);
        await _exec('tar', ['cf', outputPath, '-C', parentDir, baseName]);
      } else {
        await _exec('tar', ['cf', outputPath, sourcePath]);
      }
    } else if (format === 'tar.gz') {
      if (stats.isDirectory()) {
        const parentDir = path.dirname(sourcePath);
        const baseName = path.basename(sourcePath);
        await _exec('tar', ['czf', outputPath, '-C', parentDir, baseName]);
      } else {
        await _exec('tar', ['czf', outputPath, sourcePath]);
      }
    } else if (format === '7z') {
      await _exec('7z', ['a', '-t7z', outputPath, sourcePath]);
    } else {
      return { success: false, error: `不支持的格式: ${format}。支持: zip, tar, tar.gz, 7z` };
    }

    const outStat = fs.existsSync(outputPath) ? fs.statSync(outputPath) : null;

    return {
      success: true,
      action: 'compress',
      format,
      source,
      output,
      compressedSize: outStat ? outStat.size : 0,
    };
  } catch (e) {
    return { success: false, error: `压缩失败: ${e.message}`, action: 'compress' };
  }
}

// ── 解压 ──

async function handleArchiveExtract(params, context) {
  const { source, outputDir, format } = params;
  if (!source) return { success: false, error: '需要 source（压缩包路径）参数' };

  const sourcePath = path.resolve(source);
  const outputPath = outputDir ? path.resolve(outputDir) : path.dirname(sourcePath) + '_extracted';
  const workspaceDir = context?.workspaceDir || process.cwd();

  if (!sourcePath.startsWith(workspaceDir) || !outputPath.startsWith(workspaceDir)) {
    return { success: false, error: '路径必须在工作目录内' };
  }

  if (!fs.existsSync(sourcePath)) {
    return { success: false, error: `文件不存在: ${source}` };
  }

  // 自动检测格式
  const ext = path.extname(sourcePath).toLowerCase();
  let detectedFormat = format;
  if (!detectedFormat) {
    if (ext === '.zip') detectedFormat = 'zip';
    else if (ext === '.tar') detectedFormat = 'tar';
    else if (ext === '.gz' || source.endsWith('.tar.gz')) detectedFormat = 'tar.gz';
    else if (ext === '.7z') detectedFormat = '7z';
    else return { success: false, error: `无法识别文件格式: ${ext}，请指定 format 参数` };
  }

  try {
    if (!fs.existsSync(outputPath)) {
      fs.mkdirSync(outputPath, { recursive: true });
    }

    if (detectedFormat === 'zip') {
      await _exec('7z', ['x', sourcePath, `-o${outputPath}`, '-y']);
    } else if (detectedFormat === 'tar' || detectedFormat === 'tar.gz') {
      const args = detectedFormat === 'tar.gz' ? ['xzf', sourcePath, '-C', outputPath] : ['xf', sourcePath, '-C', outputPath];
      await _exec('tar', args);
    } else if (detectedFormat === '7z') {
      await _exec('7z', ['x', sourcePath, `-o${outputPath}`, '-y']);
    } else {
      return { success: false, error: `不支持的格式: ${detectedFormat}` };
    }

    const extracted = _listFiles(outputPath);

    return {
      success: true,
      action: 'extract',
      source,
      outputDir: outputPath,
      fileCount: extracted.length,
      totalSize: extracted.reduce((sum, f) => sum + f.size, 0),
      files: extracted.slice(0, 30).map(f => ({
        name: f.path.replace(outputPath + path.sep, ''),
        size: f.size,
      })),
      truncated: extracted.length > 30,
    };
  } catch (e) {
    return { success: false, error: `解压失败: ${e.message}`, action: 'extract' };
  }
}

// ── 列表 ──

async function handleArchiveList(params, _context) {
  const { source } = params;
  if (!source) return { success: false, error: '需要 source（压缩包路径）参数' };

  const sourcePath = path.resolve(source);
  if (!fs.existsSync(sourcePath)) return { success: false, error: `文件不存在: ${source}` };

  try {
    const ext = path.extname(sourcePath).toLowerCase();
    let output;

    if (ext === '.zip' || ext === '.7z') {
      output = await _exec('7z', ['l', sourcePath]);
    } else if (ext === '.tar' || source.endsWith('.tar.gz') || ext === '.gz') {
      output = await _exec('tar', ['tf', sourcePath]);
    } else {
      return { success: false, error: `无法识别文件格式: ${ext}` };
    }

    const lines = output.split('\n').filter(Boolean);
    return {
      success: true,
      action: 'list',
      source,
      entries: lines.slice(0, 100), // 最多 100 条
      entryCount: lines.length,
      truncated: lines.length > 100,
    };
  } catch (e) {
    return { success: false, error: `列出文件失败: ${e.message}`, action: 'list' };
  }
}

// ── 注册工具 ──

registry.register({
  name: 'ArchiveCompress',
  toolset: 'filesystem',
  category: 'file',
  description: '将文件或目录压缩为存档。支持 zip、tar、tar.gz、7z 格式。使用系统 7z/tar 命令。',
  schema: {
    type: 'object',
    properties: {
      source: { type: 'string', description: '要被压缩的文件或目录路径' },
      output: { type: 'string', description: '输出的压缩包路径' },
      format: { type: 'string', enum: ['zip', 'tar', 'tar.gz', '7z'], default: 'zip', description: '压缩格式' },
    },
    required: ['source', 'output'],
  },
  handler: handleArchiveCompress,
  timeout: 120000,
  isDangerous: true,
});

registry.register({
  name: 'ArchiveExtract',
  toolset: 'filesystem',
  category: 'file',
  description: '解压存档文件到指定目录。支持 zip、tar、tar.gz、7z 格式。自动检测格式。',
  schema: {
    type: 'object',
    properties: {
      source: { type: 'string', description: '压缩包路径' },
      outputDir: { type: 'string', description: '解压输出目录（选填，默认在压缩包同级创建 *_extracted 目录）' },
      format: { type: 'string', enum: ['zip', 'tar', 'tar.gz', '7z'], description: '压缩格式（选填，自动检测）' },
    },
    required: ['source'],
  },
  handler: handleArchiveExtract,
  timeout: 120000,
  isDangerous: true,
});

registry.register({
  name: 'ArchiveList',
  toolset: 'filesystem',
  category: 'file',
  description: '列出压缩包内的文件清单（不解压）。支持 zip、tar、tar.gz、7z。',
  schema: {
    type: 'object',
    properties: {
      source: { type: 'string', description: '压缩包路径' },
    },
    required: ['source'],
  },
  handler: handleArchiveList,
  timeout: 30000,
  isReadOnly: true,
});

module.exports = { handleArchiveCompress, handleArchiveExtract, handleArchiveList };
