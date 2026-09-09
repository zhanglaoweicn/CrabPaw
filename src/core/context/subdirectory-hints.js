const fs = require('fs');
const path = require('path');

const HINT_FILENAMES = [
  '.context.md', 'CONTEXT.md', '.context.txt', 'context.txt',
  '.clinerules', '.cursorrules', '.windsurfrules', '.aiderules',
  '.github/copilot-instructions.md',
  'AGENTS.md', 'CONVENTIONS.md', 'STYLE_GUIDE.md',
  '.env.example', '.env.local.example',
  'README.md', 'readme.md',
  'package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod',
  'tsconfig.json', 'jsconfig.json',
];

const MAX_HINT_SIZE = 10000;
const MAX_HINTS_PER_DIR = 3;
const MAX_TOTAL_HINT_TOKENS = 4000;
const CHARS_PER_TOKEN = 4;

class SubdirectoryHintTracker {
  constructor(workingDir) {
    this.workingDir = path.resolve(workingDir || process.cwd());
    this._loadedDirs = new Set();
    this._loadedDirs.add(this.workingDir);
  }

  checkToolCall(toolName, toolArgs) {
    const dirs = this._extractDirectories(toolName, toolArgs);
    if (dirs.length === 0) return null;

    const allHints = [];
    for (const d of dirs) {
      const hints = this._loadHintsForDirectory(d);
      if (hints) allHints.push(hints);
    }

    if (allHints.length === 0) return null;

    return '\n\n' + allHints.join('\n\n');
  }

  _extractDirectories(toolName, toolArgs) {
    const dirs = [];
    if (!toolArgs || typeof toolArgs !== 'object') return dirs;

    const pathKeys = this._getPathKeys(toolName);
    for (const key of pathKeys) {
      const val = toolArgs[key];
      if (typeof val !== 'string') continue;

      const resolved = path.resolve(this.workingDir, val);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        dirs.push(resolved);
      } else {
        const parent = path.dirname(resolved);
        if (fs.existsSync(parent) && fs.statSync(parent).isDirectory()) {
          dirs.push(parent);
        }
      }
    }

    return dirs;
  }

  _getPathKeys(toolName) {
    const keyMap = {
      Read: ['file_path', 'path'],
      Write: ['file_path', 'path'],
      Edit: ['file_path', 'path'],
      Glob: ['path'],
      Grep: ['path'],
      LS: ['path'],
      Bash: ['cwd'],
      CreateDirectory: ['path'],
      DeleteFile: ['file_path', 'path'],
    };
    return keyMap[toolName] || ['path', 'file_path', 'cwd', 'directory', 'dir'];
  }

  _loadHintsForDirectory(dirPath) {
    const resolved = path.resolve(dirPath);
    if (this._loadedDirs.has(resolved)) return null;

    this._loadedDirs.add(resolved);

    const hints = [];
    let totalChars = 0;

    for (const filename of HINT_FILENAMES) {
      if (hints.length >= MAX_HINTS_PER_DIR) break;
      if (totalChars >= MAX_TOTAL_HINT_TOKENS * CHARS_PER_TOKEN) break;

      const filePath = path.join(resolved, filename);
      if (!fs.existsSync(filePath)) continue;

      try {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) continue;
        if (stat.size > MAX_HINT_SIZE) continue;

        let content = fs.readFileSync(filePath, 'utf-8');
        if (content.length > MAX_HINT_SIZE) {
          content = content.slice(0, MAX_HINT_SIZE) + '\n...[truncated]';
        }

        const relPath = path.relative(this.workingDir, filePath);
        hints.push(`📄 ${relPath}:\n${content}`);
        totalChars += content.length;
      } catch { console.warn('[subdirectory-hints] 读取提示文件失败'); }
    }

    if (hints.length === 0) return null;

    const relDir = path.relative(this.workingDir, resolved) || '.';
    const header = `💡 首次访问目录 ${relDir}/，加载上下文提示:`;
    return `${header}\n${hints.join('\n\n')}`;
  }

  reset() {
    this._loadedDirs.clear();
    this._loadedDirs.add(this.workingDir);
  }

  getLoadedDirs() {
    return [...this._loadedDirs];
  }
}

module.exports = { SubdirectoryHintTracker };
