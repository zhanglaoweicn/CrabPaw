const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { classifyMemory } = require('./sector-classifier');

// 2026-08-31 Task1(数据目录统一): 统一走 config.DATA_DIR
const { DATA_DIR } = require('../config');
const MEMORY_DIR = path.join(DATA_DIR, 'memory');
const MEMORY_FILE = path.join(MEMORY_DIR, 'MEMORY.md');
const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference', 'note'];
const MAX_ENTRYPOINT_LINES = 200;
const MAX_ENTRYPOINT_BYTES = 25000;
const MAX_MEMORY_FILES = 200;

class AutoMemory extends EventEmitter {
  constructor() {
    super();
    this.memories = new Map();
    this.index = [];
    this.initialized = false;
  }

  async initialize() {
    await this._ensureDir();
    await this.load();
    this.initialized = true;
    this.emit('initialized');
  }

  async _ensureDir() {
    if (!fs.existsSync(MEMORY_DIR)) {
      fs.mkdirSync(MEMORY_DIR, { recursive: true });
    }
  }

  async load() {
    try {
      if (fs.existsSync(MEMORY_FILE)) {
        const content = fs.readFileSync(MEMORY_FILE, 'utf-8');
        const { index, memories } = this._parseMemoryFile(content);
        this.index = index;

        for (const memory of memories) {
          this.memories.set(memory.id, memory);
        }

        // BUG FIX: MEMORY.md 可能被 MAX_ENTRYPOINT_BYTES 截断导致尾部记忆块丢失
        // （索引行保留但块缺失）。独立文件 mem_<id>.md 是权威备份，从文件补全。
        let restored = 0;
        for (const entry of this.index) {
          const id = (entry.file || '').replace(/\.md$/, '');
          if (!id || this.memories.has(id)) continue;
          const filePath = path.join(MEMORY_DIR, `${id}.md`);
          if (!fs.existsSync(filePath)) continue;
          try {
            const fileText = fs.readFileSync(filePath, 'utf-8');
            const fmMatch = fileText.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
            const fm = this._parseFrontmatter(fmMatch ? fmMatch[1].split('\n') : []);
            const bodyText = fileText.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
            if (!fm.id) continue;
            this.memories.set(fm.id, {
              id: fm.id,
              type: fm.type || 'general',
              title: fm.title || 'Untitled',
              description: fm.description || '',
              scope: fm.scope || 'private',
              created: Number(fm.created) || Date.now(),
              updated: Number(fm.updated) || Date.now(),
              tags: Array.isArray(fm.tags) ? fm.tags : (fm.tags ? [fm.tags] : []),
              content: (fm.description || bodyText || '').trim(),
              sector: fm.sector || 'general',
              sectorSecondary: fm.sectorSecondary || null,
            });
            restored++;
          } catch (e) {
            console.warn(`[AutoMemory] 恢复记忆文件失败 ${id}:`, e.message);
          }
        }
        console.log(`Notebook loaded: ${this.memories.size} memories (${restored} restored from files)`);
      }
    } catch (e) {
      this.memories = new Map();
      this.index = [];
    }
  }

  _parseMemoryFile(content) {
    const index = [];
    const memories = [];
    const lines = content.split('\n');
    let currentMemory = null;
    let inFrontmatter = false;
    let frontmatterLines = [];
    let contentLines = [];
    // BUG FIX（v2，两行前瞻状态机）:
    // 文件结构为 header →(---)→ 索引区 →(---)→ memory 块*。
    // 旧实现把 inIndex 在第一个 --- 处置 false，索引行永远解析不到
    // （index 恒空，save() 用空索引逐步清空索引区）。
    // 块边界判定：--- 后紧跟 "id:" 行 = 块开始；否则按 frontmatter/块结束处理。
    // 该状态机同时兼容"块间单 ---"（content 后直接接下一块）与
    // "块间双 ---"（结束线 + 开始线分离）两种格式。
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const next = lines[i + 1];

      if (line.startsWith('---')) {
        const isBlockStart = !!(next && next.startsWith('id:'));
        if (isBlockStart) {
          if (currentMemory) {
            currentMemory.content = contentLines.join('\n').trim();
            memories.push(currentMemory);
            currentMemory = null;
          }
          inFrontmatter = true;
          frontmatterLines = [];
        } else if (inFrontmatter) {
          inFrontmatter = false;
          currentMemory = this._parseFrontmatter(frontmatterLines);
          contentLines = [];
        } else if (currentMemory) {
          currentMemory.content = contentLines.join('\n').trim();
          memories.push(currentMemory);
          currentMemory = null;
        }
        continue;
      }

      if (inFrontmatter) {
        frontmatterLines.push(line);
      } else if (currentMemory) {
        contentLines.push(line);
      } else if (line.startsWith('- [') && line.includes('](')) {
        const match = line.match(/- \[(.+?)\]\((.+?)\)/);
        if (match) {
          index.push({
            title: match[1],
            file: match[2],
            line: line
          });
        }
      }
    }

    if (currentMemory) {
      currentMemory.content = contentLines.join('\n').trim();
      memories.push(currentMemory);
    }

    return { index, memories };
  }

  _parseFrontmatter(lines) {
    const memory = {
      id: `mem_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 6)}`,
      type: 'general',
      title: '',
      description: '',
      scope: 'private',
      created: Date.now(),
      updated: Date.now(),
      tags: [],
      content: ''
    };

    for (const line of lines) {
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;
      
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();
      
      switch (key) {
        case 'id':
          memory.id = value;
          break;
        case 'type':
          memory.type = MEMORY_TYPES.includes(value) ? value : 'general';
          break;
        case 'title':
          memory.title = value;
          break;
        case 'description':
          memory.description = value;
          break;
        case 'scope':
          memory.scope = value;
          break;
        case 'tags': {
          // P2: 兼容旧版 JSON 序列化残留（["a","b"]）与逗号分隔两种格式
          let parsed = null;
          try {
            const maybe = JSON.parse(value);
            if (Array.isArray(maybe)) parsed = maybe.map(t => String(t));
          } catch { /* 非 JSON，走逗号分隔 */ }
          memory.tags = parsed
            ? parsed.filter(Boolean)
            : value.split(',').map(t => t.trim()).filter(Boolean);
          break;
        }
        case 'created':
          memory.created = parseInt(value) || Date.now();
          break;
        case 'updated':
          memory.updated = parseInt(value) || Date.now();
          break;
      }
    }

    return memory;
  }

  async save() {
    const lines = [
      '# CrabPaw Auto Memory',
      '',
      '> Auto-generated cross-session memory notebook.',
      '',
      '---',
      ''
    ];

    for (const entry of this.index) {
      lines.push(entry.line);
    }

    lines.push('');
    lines.push('---');
    lines.push('');

    for (const memory of this.memories.values()) {
      lines.push('---');
      lines.push(`id: ${memory.id}`);
      lines.push(`type: ${memory.type}`);
      lines.push(`title: ${memory.title}`);
      if (memory.description) {
        lines.push(`description: ${memory.description}`);
      }
      lines.push(`scope: ${memory.scope}`);
      if (memory.tags.length > 0) {
        lines.push(`tags: ${memory.tags.join(', ')}`);
      }
      lines.push(`created: ${memory.created}`);
      lines.push(`updated: ${memory.updated}`);
      lines.push('---');
      lines.push('');
      lines.push(memory.content || '');
      lines.push('');
    }

    let content = lines.join('\n');

    if (content.length > MAX_ENTRYPOINT_BYTES) {
      // BUG FIX: 此前直接按字符截断，会切断记忆块（frontmatter 不完整），
      // 导致 load() 后索引存在但块缺失（134 索引 vs 98 块的不一致）。
      // 改为按完整块边界截断：只保留整块，避免半块数据。
      const warning = `\n\n> WARNING: MEMORY.md exceeds ${MAX_ENTRYPOINT_BYTES} bytes. Older entries truncated to complete blocks.`;
      const budget = MAX_ENTRYPOINT_BYTES - warning.length;
      const headerEnd = content.indexOf('\n---\n');
      let cutIndex = budget; // 默认退化为字符截断位置
      if (headerEnd > 0 && headerEnd < budget) {
        // 从后向前找最后一个完整块起点（块起点 = "\n---\nid: "）
        const tail = content.slice(headerEnd + 1);
        const blockMarker = '\n---\nid: ';
        let searchFrom = budget - headerEnd - 1;
        while (searchFrom > 0) {
          const pos = tail.lastIndexOf(blockMarker, searchFrom);
          if (pos === -1) break;
          // 验证块完整：块内应有结束 ---（早于下一个块起点）
          const after = tail.slice(pos + blockMarker.length);
          const firstClose = after.indexOf('\n---\n');
          const nextBlock = after.indexOf(blockMarker);
          if (firstClose !== -1 && (nextBlock === -1 || firstClose < nextBlock)) {
            cutIndex = headerEnd + 1 + pos;
            break;
          }
          searchFrom = pos - 1;
        }
      }
      content = content.slice(0, cutIndex) + warning;
    }

    await this._ensureDir();
    const { atomicWriteFile } = require('../atomic-write');
    await atomicWriteFile(MEMORY_FILE, content, 'utf-8');
    this.emit('saved', { memoryCount: this.memories.size });
  }

  /**
   * SP1: 归一化记忆文本用于查重——与 MemoryManager._normalizeMemoryText 同款语义
   * （去口语前缀/标点/小写）。memory-manager 反向依赖本模块，无法复用导入，故同款内联。
   */
  _normalizeMemoryText(text) {
    return String(text || '')
      .replace(/^用户(?:说|表示|认为|希望|需要|要求|想要|决定|选择|偏好|习惯|喜欢)/, '')
      .replace(/^(我|我们|用户)\s*/, '')
      .replace(/[，。！？、,.!?；;：:"“”'‘’\s]+/g, '')
      .toLowerCase();
  }

  /** SP1: 近重复键——content 优先（content 空则 title），normalize 后前 40 字符 sha1; 归一化长度 < 4 不参与查重 */
  _memoryDedupKey(title, content) {
    const norm = this._normalizeMemoryText(String(content || title || ''));
    if (norm.length < 4) return null;
    return crypto.createHash('sha1').update(norm.slice(0, 40)).digest('hex');
  }

  /**
   * SP1 记忆写入门控——纯函数（无 I/O、不读 this.memories），可直测。
   * @param {string} type 记忆类型
   * @param {string} title 标题
   * @param {string} content 内容
   * @param {Array<{id,title,content}>} existing 近重复比对集合（调用方传最近 N 条）
   * @returns {{ok:boolean, reason?:string, dedup?:boolean, matchedId?:string}}
   */
  _gateAdmit(type, title, content, existing = []) {
    const t = String(title || '').trim();
    const c = String(content || '').trim();

    // 1. 标题与内容均空（覆盖 hotspot 空写入产生 Untitled 的场景）
    if (!t && !c) return { ok: false, reason: 'empty' };

    // 2. 标题或内容有效长度 ≥ 4（去空白后）
    const effLen = (s) => String(s || '').replace(/\s+/g, '').length;
    if (effLen(t) < 4 && effLen(c) < 4) return { ok: false, reason: 'too_short' };

    // 3. 系统提示内容
    if (c.includes('[系统提示：')) return { ok: false, reason: 'system_prompt' };

    // 4. 配置/错误信息类（标题或内容命中）
    if (/未配置|API\s*密钥|系统错误|env\s*[:：]/i.test(`${t}\n${c}`)) {
      return { ok: false, reason: 'config_noise' };
    }

    // 5. session 型会话原始转录一律拒（语义裁定：梦境 JSON/SQLite 通道保留，直写笔记本拒）
    if (type === 'session') return { ok: false, reason: 'session_transcript' };

    // 6. 近重复：normalize 前 40 字符 sha1 与既有集合比对，命中 → dedup 标记
    const candKey = this._memoryDedupKey(t, c);
    if (candKey) {
      for (const m of existing) {
        const key = this._memoryDedupKey(m && m.title, m && m.content);
        if (key === candKey) return { ok: true, dedup: true, matchedId: (m && m.id) || null };
      }
    }

    return { ok: true };
  }

  async addMemory(memory) {
    // SP1 门控：写前准入（拒: 空/过短/系统提示/配置类/session 直写; 近重复 → skip 不新增）。
    // 与 MemoryManager 层 S4 全等去重互补：此处为前缀 hash 近重复，粒度更粗。
    const recent = Array.from(this.memories.values())
      .sort((a, b) => (b.updated || 0) - (a.updated || 0))
      .slice(0, 100);
    const gate = this._gateAdmit(memory.type, memory.title, memory.content, recent);
    if (!gate.ok) {
      console.debug('[memory-gate] 拒写:', gate.reason, String(memory.title || '').slice(0, 30));
      return { rejected: true, reason: gate.reason };
    }
    if (gate.dedup) {
      console.debug('[memory-gate] 近重复跳过:', gate.matchedId);
      return { skip: true, dedup: true, matchedId: gate.matchedId };
    }

    const sectorResult = classifyMemory((memory.title || '') + ' ' + (memory.description || '') + ' ' + (memory.content || ''));
    const newMemory = {
      id: `mem_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 6)}`,
      type: MEMORY_TYPES.includes(memory.type) ? memory.type : 'general',
      title: memory.title || 'Untitled',
      description: memory.description || '',
      scope: memory.scope || 'private',
      created: Date.now(),
      updated: Date.now(),
      tags: memory.tags || [],
      content: memory.content || '',
      sector: sectorResult.primary,
      sectorSecondary: sectorResult.secondary,
    };

    this.memories.set(newMemory.id, newMemory);

    const indexLine = "- [" + newMemory.title + "](" + newMemory.id + ".md)  " + newMemory.type;
    this.index.push({
      title: newMemory.title,
      file: `${newMemory.id}.md`,
      line: indexLine
    });

    await this._ensureDir();
    const memFilePath = path.join(MEMORY_DIR, `${newMemory.id}.md`);
    const memContent = [
      '---',
      `id: ${newMemory.id}`,
      `type: ${newMemory.type}`,
      `title: ${newMemory.title}`,
      `created: ${newMemory.created}`,
      `updated: ${newMemory.updated}`,
      `tags: ${newMemory.tags.join(', ')}`,
      `scope: ${newMemory.scope}`,
      `sector: ${newMemory.sector}`,
      ...(newMemory.sectorSecondary ? [`sectorSecondary: ${newMemory.sectorSecondary}`] : []),
      '---',
      '',
      newMemory.description || newMemory.content || '',
    ].join('\n');
    try {
      fs.writeFileSync(memFilePath, memContent, 'utf-8');
    } catch (e) {
      console.error(`[AutoMemory] Failed to write memory file ${memFilePath}: ${e.message}`);
    }

    if (this.index.length > MAX_ENTRYPOINT_LINES) {
      this.index = this.index.slice(-MAX_ENTRYPOINT_LINES);
    }

    await this.save();
    this.emit('memory:added', newMemory);
    
    return newMemory;
  }

  async updateMemory(id, updates) {
    const memory = this.memories.get(id);
    if (!memory) return null;

    Object.assign(memory, updates, { updated: Date.now() });
    
    const indexEntry = this.index.find(e => e.file.includes(id));
    if (indexEntry) {
      indexEntry.title = memory.title;
      indexEntry.line = "- [" + memory.title + "](" + memory.id + ".md)  " + memory.type;
    }
    
    await this.save();
    this.emit('memory:updated', memory);
    
    return memory;
  }

  async removeMemory(id) {
    const memory = this.memories.get(id);
    if (!memory) return false;

    this.memories.delete(id);
    this.index = this.index.filter(e => !e.file.includes(id));
    
    await this.save();
    this.emit('memory:removed', { id });
    
    return true;
  }

  search(query, limit = 10, options = {}) {
    const queryLower = query.toLowerCase();
    const sectorFilter = options.sector;
    
    const scored = Array.from(this.memories.values())
      .filter(m => !sectorFilter || m.sector === sectorFilter || m.sectorSecondary === sectorFilter)
      .map(memory => {
      let score = 0;
      
      const title = (memory.title || '').toLowerCase();
      const description = (memory.description || '').toLowerCase();
      const content = (memory.content || '').toLowerCase();
      
      if (title.includes(queryLower)) score += 3;
      if (description.includes(queryLower)) score += 2;
      if (content.includes(queryLower)) score += 2;
      
      for (const tag of (memory.tags || [])) {
        if (tag.toLowerCase().includes(queryLower)) score += 1;
      }
      
      if (MEMORY_TYPES.includes(queryLower) && memory.type === queryLower) {
        score += 2;
      }
      
      return { ...memory, score };
    });

    return scored
      .filter(m => m.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  getRecent(limit = 5) {
    return Array.from(this.memories.values())
      .sort((a, b) => b.updated - a.updated)
      .slice(0, limit);
  }

  getByType(type) {
    return Array.from(this.memories.values()).filter(m => m.type === type);
  }

  scanMemoryFiles() {
    const memories = Array.from(this.memories.values())
      .sort((a, b) => b.updated - a.updated)
      .slice(0, MAX_MEMORY_FILES);
    
    return memories.map(m => ({
      filename: `${m.id}.md`,
      filePath: path.join(MEMORY_DIR, `${m.id}.md`),
      mtimeMs: m.updated,
      description: m.description || m.title,
      type: m.type
    }));
  }

  formatMemoryManifest(memories) {
    return memories.map(m => {
      const tag = m.type ? `[${m.type}] ` : '';
      const ts = new Date(m.mtimeMs).toISOString();
      return m.description
        ? `- ${tag}${m.filename} (${ts}): ${m.description}`
        : `- ${tag}${m.filename} (${ts})`;
    }).join('\n');
  }

  getStats() {
    const byType = {};
    for (const type of MEMORY_TYPES) {
      byType[type] = this.getByType(type).length;
    }

    const memories = Array.from(this.memories.values());
    
    return {
      totalMemories: this.memories.size,
      indexSize: this.index.length,
      byType,
      oldestMemory: memories.length > 0 ? Math.min(...memories.map(m => m.created)) : 0,
      newestMemory: memories.length > 0 ? Math.max(...memories.map(m => m.created)) : 0
    };
  }
}

module.exports = { AutoMemory, MEMORY_TYPES };
