const path = require('path');
const fs = require('fs');

class SummarizeEngine {
  constructor() {
    this.storageDir = path.join(process.env.HOME || process.env.USERPROFILE, '.crabpaw', 'summarize-pro');

    this.formats = {
      'tldr': this.formatTLDR.bind(this),
      'bullets': this.formatBullets.bind(this),
      'eli5': this.formatELI5.bind(this),
      'executive': this.formatExecutive.bind(this),
      'comparison': this.formatComparison.bind(this),
      'meeting': this.formatMeeting.bind(this),
      'email': this.formatEmail.bind(this),
      'action-items': this.formatActionItems.bind(this),
      'progressive': this.formatProgressive.bind(this),
      'chapter': this.formatChapter.bind(this)
    };
  }

  async initialize() {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }

    this.settingsFile = path.join(this.storageDir, 'settings.json');
    this.historyFile = path.join(this.storageDir, 'history.json');
    this.savedFile = path.join(this.storageDir, 'saved.json');

    await this.loadSettings();
    await this.loadHistory();
    await this.loadSaved();
  }

  async loadSettings() {
    const defaultSettings = {
      default_format: 'bullets',
      default_length: 'medium',
      default_language: 'chinese',
      summaries_count: 0,
      words_processed: 0,
      streak_days: 0,
      last_used: null,
      favorite_format: null
    };

    try {
      if (fs.existsSync(this.settingsFile)) {
        this.settings = JSON.parse(fs.readFileSync(this.settingsFile, 'utf-8'));
      } else {
        this.settings = defaultSettings;
        await this.saveSettings();
      }
    } catch (e) {
      this.settings = defaultSettings;
    }
  }

  async saveSettings() {
    fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2));
  }

  async loadHistory() {
    try {
      if (fs.existsSync(this.historyFile)) {
        this.history = JSON.parse(fs.readFileSync(this.historyFile, 'utf-8'));
      } else {
        this.history = [];
      }
    } catch (e) {
      this.history = [];
    }
  }

  async saveHistory() {
    const maxHistory = this.settings?.max_history || 100;
    const trimmed = this.history.slice(-maxHistory);
    fs.writeFileSync(this.historyFile, JSON.stringify(trimmed, null, 2));
  }

  async loadSaved() {
    try {
      if (fs.existsSync(this.savedFile)) {
        this.saved = JSON.parse(fs.readFileSync(this.savedFile, 'utf-8'));
      } else {
        this.saved = [];
      }
    } catch (e) {
      this.saved = [];
    }
  }

  async saveSaved() {
    fs.writeFileSync(this.savedFile, JSON.stringify(this.saved, null, 2));
  }

  detectFormat(userInput) {
    const input = userInput.toLowerCase();

    if (input.includes('tldr') || input.includes('tl;dr') || input.includes('一句话')) {
      return 'tldr';
    }
    if (input.includes('eli5')) {
      return 'eli5';
    }
    if (input.includes('对比')) {
      return 'comparison';
    }
    if (input.includes('会议')) {
      return 'meeting';
    }
    if (input.includes('邮件')) {
      return 'email';
    }
    if (input.includes('行动项目') || input.includes('待办') || input.includes('action')) {
      return 'action-items';
    }
    if (input.includes('执行摘要') || input.includes('exec')) {
      return 'executive';
    }
    if (input.includes('章节') || input.includes('chapter')) {
      return 'chapter';
    }
    if (input.includes('渐进') || input.includes('progressive')) {
      return 'progressive';
    }
    if (input.includes('子弹') || input.includes('bullets') || input.includes('要点')) {
      return 'bullets';
    }

    return this.settings?.default_format || 'bullets';
  }

  detectContentType(text) {
    if (text.length < 100) return 'short';
    if (/[\u4e00-\u9fa5]/.test(text)) {
      if (text.includes('邮件') || text.includes('@') || text.includes('发件人')) {
        return 'email';
      }
      if (text.includes('会议') || text.includes('参会') || text.includes('讨论')) {
        return 'meeting';
      }
      if (text.includes('对比') || text.includes('比较')) {
        return 'comparison';
      }
    }
    return 'general';
  }

  async summarize(text, options = {}) {
    const {
      format = 'bullets',
      customLength = null,
      language = 'chinese',
      showStats = true
    } = options;

    const originalWords = this.countWords(text);

    let summary;
    const formatter = this.formats[format];

    if (formatter) {
      summary = formatter(text);
    } else {
      summary = this.formatBullets(text);
    }

    const summaryWords = this.countWords(summary);
    const reduction = ((originalWords - summaryWords) / originalWords * 100).toFixed(0);

    this.settings.summaries_count++;
    this.settings.words_processed += originalWords;
    this.settings.last_used = new Date().toISOString();

    const historyEntry = {
      id: `hist_${Date.now()}`,
      timestamp: new Date().toISOString(),
      format,
      topic: this.extractTopic(text),
      original_words: originalWords,
      summary_words: summaryWords
    };

    this.history.push(historyEntry);

    await this.saveSettings();
    await this.saveHistory();

    let result = summary;

    if (showStats) {
      result += `\n\n📊 ${originalWords} 字 → ${summaryWords} 字 (压缩 ${reduction}%)`;
    }

    return result;
  }

  countWords(text) {
    const chinese = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const english = (text.match(/[a-zA-Z]+/g) || []).length;
    return chinese + english;
  }

  extractTopic(text) {
    const firstLine = text.split('\n')[0] || text.slice(0, 50);
    return firstLine.replace(/[#*📝🔥📋🧒📊⚖️🤝📧✅📖]/g, '').trim();
  }

  formatTLDR(text) {
    const sentences = text.split(/[。！？.!?]+/).filter(s => s.trim());
    const keySentences = sentences.slice(0, 2);
    return `🔥 TL;DR\n━━━━━━━━━━━━━━━━━━\n${keySentences.join('。').slice(0, 150)}${keySentences.join('。').length > 150 ? '...' : ''}`;
  }

  formatBullets(text) {
    const sentences = text.split(/[。！？.!?]+/).filter(s => s.trim());
    const bullets = sentences.slice(0, 5).map(s => `• ${s.trim()}`);

    return `📋 要点总结\n━━━━━━━━━━━━━━━━━━\n${bullets.join('\n')}`;
  }

  formatELI5(text) {
    const keyPoints = text.split(/[。！？.!?]+/).filter(s => s.trim()).slice(0, 3);

    return `🧒 ELI5（简单解释）\n━━━━━━━━━━━━━━━━━━\n${keyPoints.map(p => `想象一下：${p.trim()}`).join('\n\n')}\n\n💡 一句话总结：${keyPoints[0]?.trim().slice(0, 30) || '这是一个需要简化的话题'}...`;
  }

  formatExecutive(text) {
    const paragraphs = text.split(/\n+/).filter(p => p.trim());
    const overview = paragraphs[0] || text.slice(0, 100);
    const keyPoints = paragraphs.slice(1, 4).map(p => `• ${p.trim().slice(0, 50)}`);

    return `📊 执行摘要\n━━━━━━━━━━━━━━━━━━\n\n**概述：**\n${overview.slice(0, 100)}\n\n**关键发现：**\n${keyPoints.join('\n')}\n\n**建议：**\n• 深入分析关键发现\n• 制定行动计划`;
  }

  formatComparison(text) {
    const parts = text.split(/对比|比较|A与B|vs/i).filter(p => p.trim());

    if (parts.length >= 2) {
      const comparison = parts.map((p, i) => {
        const points = p.split(/[。！？.!?]+/).filter(s => s.trim()).slice(0, 3);
        return `**${i === 0 ? 'A' : 'B'}：**\n${points.map(pt => `• ${pt.trim()}`).join('\n')}`;
      });

      return `⚖️ 对比摘要\n━━━━━━━━━━━━━━━━━━\n\n${comparison.join('\n\n')}\n\n**结论：** 两者的核心差异在于...`;
    }

    return this.formatBullets(text);
  }

  formatMeeting(text) {
    const participants = this.extractNames(text);
    const decisions = text.match(/决定|通过|批准|确认|同意|达成/g) || [];
    const actions = text.match(/需要|应该|待办|执行|完成|处理/g) || [];

    return `🤝 会议摘要\n━━━━━━━━━━━━━━━━━━\n\n**参会人员：**${participants.length > 0 ? participants.join('、') : '未识别'}\n\n**讨论要点：**\n• ${text.split(/[。！？.!?]+/).filter(s => s.trim())[0]?.trim() || '见下文'}\n\n**已决事项：**\n${decisions.length > 0 ? decisions.map(d => `• ${d}`).join('\n') : '• 暂无明确决策'}\n\n**待办事项：**\n${actions.length > 0 ? actions.slice(0, 3).map(a => `□ ${a}...`).join('\n') : '□ 暂无待办'}`;
  }

  extractNames(text) {
    const namePattern = /[\u4e00-\u9fa5]{2,4}(?:总|总|经理|总|总监|工程师|顾问|负责人|主管)/g;
    return text.match(namePattern) || [];
  }

  formatEmail(text) {
    const urgencyHigh = /紧急|重要|马上|立即|尽快/i;
    const urgencyMedium = /请|希望|期待|需要/i;

    let urgency = '🟡 中';
    if (urgencyHigh.test(text)) urgency = '🔴 高';
    else if (!urgencyMedium.test(text)) urgency = '🟢 低';

    const purpose = text.split(/[。！？.!?]/)[0] || '识别中...';

    return `📧 邮件摘要\n━━━━━━━━━━━━━━━━━━\n\n**目的：**\n${purpose.slice(0, 80)}\n\n**关键内容：**\n• ${text.split(/[。！？.!?]+/).filter(s => s.trim())[1]?.trim().slice(0, 50) || '见正文'}\n\n**紧急程度：** ${urgency}\n\n**建议行动：**\n□ 查看详情\n□ 必要时回复`;
  }

  formatActionItems(text) {
    const tasks = text.split(/[。！？.!?；;]+/)
      .filter(s => /需要|应该|待办|必须|记得|别忘|执行|完成/i.test(s))
      .slice(0, 5);

    const taskList = tasks.length > 0
      ? tasks.map(t => `□ ${t.trim()}`).join('\n')
      : '□ 无明确任务';

    const deadlines = text.match(/\d+[月周天日年]|\d{4}[-/]\d{2}[-/]\d{2}/g) || [];

    return `✅ 行动项目\n━━━━━━━━━━━━━━━━━━\n\n${taskList}\n\n${deadlines.length > 0 ? `⏰ 识别的截止日期：${deadlines.join(', ')}` : ''}`;
  }

  formatProgressive(text) {
    const sentences = text.split(/[。！？.!?]+/).filter(s => s.trim());

    return `📝 渐进摘要\n━━━━━━━━━━━━━━━━━━\n\n**🔥 一句话（TL;DR）：**\n${sentences[0]?.trim().slice(0, 50) || '...'}${sentences[0]?.length > 50 ? '...' : ''}\n\n**📋 短版（3要点）：**\n${sentences.slice(0, 3).map(s => `• ${s.trim().slice(0, 30)}...`).join('\n')}\n\n**📄 完整版：**\n${text.slice(0, 300)}${text.length > 300 ? '...' : ''}`;
  }

  formatChapter(text) {
    const paragraphs = text.split(/\n+/).filter(p => p.trim());

    return `📖 章节摘要\n━━━━━━━━━━━━━━━━━━\n\n**概要：**\n${paragraphs[0]?.slice(0, 100) || '暂无'}\n\n**关键内容：**\n${paragraphs.slice(1, 4).map((p, i) => `${i + 1}. ${p.trim().slice(0, 50)}...`).join('\n')}\n\n**重要细节：**\n• ${paragraphs[4]?.trim().slice(0, 50) || '见正文'}...`;
  }

  async getHistory() {
    if (!this.history || this.history.length === 0) {
      return '📜 暂无摘要历史';
    }

    const recent = this.history.slice(-10).reverse();
    const items = recent.map((h, i) =>
      `${i + 1}. 📝 "${h.topic}" — ${new Date(h.timestamp).toLocaleString('zh-CN')} — ${h.format} — ${h.original_words}→${h.summary_words}字`
    );

    return `📜 摘要历史\n━━━━━━━━━━━━━━━━━━\n\n${items.join('\n')}\n\n📊 共 ${this.history.length} 条摘要 | 处理 ${this.settings?.words_processed || 0} 字`;
  }

  async getSaved() {
    if (!this.saved || this.saved.length === 0) {
      return '💾 暂无收藏的摘要';
    }

    const items = this.saved.slice(-10).reverse().map((s, i) =>
      `${i + 1}. "${s.topic}" — ${new Date(s.timestamp).toLocaleString('zh-CN')}`
    );

    return `💾 收藏的摘要\n━━━━━━━━━━━━━━━━━━\n\n${items.join('\n')}\n\n共 ${this.saved.length} 条收藏`;
  }

  async saveToSaved(summary, topic) {
    const entry = {
      id: `save_${Date.now()}`,
      timestamp: new Date().toISOString(),
      topic: topic || '未命名',
      summary
    };

    this.saved.push(entry);
    await this.saveSaved();

    return `💾 已收藏！ID: ${entry.id}`;
  }

  async getStats() {
    const settings = this.settings;

    return `📊 摘要统计\n━━━━━━━━━━━━━━━━━━\n\n🔢 总摘要数：${settings.summaries_count}\n📄 处理字数：${settings.words_processed} 字\n🔥 当前连续：${settings.streak_days} 天\n⭐ 常用格式：${settings.favorite_format || '子弹要点'}

🏆 成就\n• 📝 首次摘要 — 完成 ✅\n• 🔟 10次摘要 — ${settings.summaries_count >= 10 ? '✅' : '🔒 ' + (10 - settings.summaries_count) + '次'}\n• 💯 100次摘要 — ${settings.summaries_count >= 100 ? '✅' : '🔒 ' + (100 - settings.summaries_count) + '次'}`;
  }
}

module.exports = SummarizeEngine;
