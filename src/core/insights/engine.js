/**
 * Usage Insights Engine - 使用洞察引擎
 * 
 * 分析历史会话数据:
 * - Token 消耗统计
 * - 成本估算
 * - 工具使用模式
 * - 活动趋势分析
 * - 模型/平台分布
 * - 会话指标
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { getCrabPawSubDir } = require('../path-utils');

class InsightsEngine {
  constructor(dbPath) {
    this.dbPath = dbPath || path.join(getCrabPawSubDir('data'), 'insights.db');
    this.db = null;
  }

  async initialize() {
    return new Promise((resolve, reject) => {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      this.db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) {
          reject(err);
          return;
        }
        
        this.db.serialize(() => {
          this.db.run(`
            CREATE TABLE IF NOT EXISTS sessions (
              id TEXT PRIMARY KEY,
              source TEXT,
              model TEXT,
              started_at REAL,
              ended_at REAL,
              message_count INTEGER DEFAULT 0,
              tool_call_count INTEGER DEFAULT 0,
              input_tokens INTEGER DEFAULT 0,
              output_tokens INTEGER DEFAULT 0,
              cache_read_tokens INTEGER DEFAULT 0,
              cache_write_tokens INTEGER DEFAULT 0,
              estimated_cost_usd REAL DEFAULT 0,
              actual_cost_usd REAL DEFAULT 0,
              title TEXT,
              metadata TEXT
            )
          `);
          
          this.db.run(`
            CREATE TABLE IF NOT EXISTS messages (
              id TEXT PRIMARY KEY,
              session_id TEXT,
              role TEXT,
              content TEXT,
              tool_name TEXT,
              tool_calls TEXT,
              created_at REAL,
              tokens INTEGER DEFAULT 0,
              FOREIGN KEY (session_id) REFERENCES sessions(id)
            )
          `);
          
          this.db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at)`);
          this.db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source)`);
          this.db.run(`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)`);
        });
        
        resolve();
      });
    });
  }

  async recordSession(sessionData) {
    const {
      id,
      source = 'cli',
      model = 'unknown',
      startedAt = Date.now(),
      title = ''
    } = sessionData;
    
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT OR REPLACE INTO sessions 
         (id, source, model, started_at, title) 
         VALUES (?, ?, ?, ?, ?)`,
        [id, source, model, startedAt / 1000, title],
        (err) => err ? reject(err) : resolve(id)
      );
    });
  }

  async updateSession(sessionId, updates) {
    const fields = [];
    const values = [];
    
    const mapping = {
      endedAt: 'ended_at',
      messageCount: 'message_count',
      toolCallCount: 'tool_call_count',
      inputTokens: 'input_tokens',
      outputTokens: 'output_tokens',
      cacheReadTokens: 'cache_read_tokens',
      cacheWriteTokens: 'cache_write_tokens',
      estimatedCost: 'estimated_cost_usd',
      actualCost: 'actual_cost_usd',
      title: 'title'
    };
    
    for (const [key, value] of Object.entries(updates)) {
      const dbField = mapping[key];
      if (dbField) {
        fields.push(`${dbField} = ?`);
        values.push(value);
      }
    }
    
    if (fields.length === 0) return;
    
    values.push(sessionId);
    
    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`,
        values,
        (err) => err ? reject(err) : resolve()
      );
    });
  }

  async recordMessage(messageData) {
    const {
      id,
      sessionId,
      role,
      content = '',
      toolName = null,
      toolCalls = null,
      tokens = 0
    } = messageData;
    
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO messages 
         (id, session_id, role, content, tool_name, tool_calls, created_at, tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, sessionId, role, content, toolName, 
         toolCalls ? JSON.stringify(toolCalls) : null, 
         Date.now() / 1000, tokens],
        (err) => err ? reject(err) : resolve(id)
      );
    });
  }

  async generateReport(days = 30, source = null) {
    const cutoff = Date.now() / 1000 - (days * 86400);
    
    const sessions = await this._getSessions(cutoff, source);
    const toolUsage = await this._getToolUsage(cutoff, source);
    const messageStats = await this._getMessageStats(cutoff, source);
    
    if (sessions.length === 0) {
      return {
        days,
        sourceFilter: source,
        empty: true,
        overview: {},
        models: [],
        platforms: [],
        tools: [],
        activity: {},
        topSessions: [],
        skillInsights: [],
        optimizationTips: [],
      };
    }

    const report = {
      days,
      sourceFilter: source,
      empty: false,
      generatedAt: Date.now(),
      overview: this._computeOverview(sessions, messageStats),
      models: this._computeModelBreakdown(sessions),
      platforms: this._computePlatformBreakdown(sessions),
      tools: this._computeToolBreakdown(toolUsage),
      activity: this._computeActivityPatterns(sessions),
      topSessions: this._computeTopSessions(sessions),
      skillInsights: [],
      optimizationTips: [],
    };

    try {
      report.skillInsights = await this.getSkillInsights(days);
    } catch (e) { console.warn('[insights-engine] failed to get skill insights:', e.message); }

    report.optimizationTips = this.generateOptimizationTips(report);
    
    return report;
  }

  async _getSessions(cutoff, source) {
    return new Promise((resolve, reject) => {
      let query = `SELECT * FROM sessions WHERE started_at >= ?`;
      const params = [cutoff];
      
      if (source) {
        query += ` AND source = ?`;
        params.push(source);
      }
      
      query += ` ORDER BY started_at DESC`;
      
      this.db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  async _getToolUsage(cutoff, source) {
    return new Promise((resolve, reject) => {
      let query = `
        SELECT m.tool_name, COUNT(*) as count
        FROM messages m
        JOIN sessions s ON s.id = m.session_id
        WHERE s.started_at >= ? AND m.role = 'tool' AND m.tool_name IS NOT NULL
      `;
      const params = [cutoff];
      
      if (source) {
        query += ` AND s.source = ?`;
        params.push(source);
      }
      
      query += ` GROUP BY m.tool_name ORDER BY count DESC`;
      
      this.db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  async _getMessageStats(cutoff, source) {
    return new Promise((resolve, reject) => {
      let query = `
        SELECT 
          COUNT(*) as total_messages,
          SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END) as user_messages,
          SUM(CASE WHEN m.role = 'assistant' THEN 1 ELSE 0 END) as assistant_messages,
          SUM(CASE WHEN m.role = 'tool' THEN 1 ELSE 0 END) as tool_messages
        FROM messages m
        JOIN sessions s ON s.id = m.session_id
        WHERE s.started_at >= ?
      `;
      const params = [cutoff];
      
      if (source) {
        query += ` AND s.source = ?`;
        params.push(source);
      }
      
      this.db.get(query, params, (err, row) => {
        if (err) reject(err);
        else resolve(row || { total_messages: 0, user_messages: 0, assistant_messages: 0, tool_messages: 0 });
      });
    });
  }

  _computeOverview(sessions, messageStats) {
    const totalInput = sessions.reduce((sum, s) => sum + (s.input_tokens || 0), 0);
    const totalOutput = sessions.reduce((sum, s) => sum + (s.output_tokens || 0), 0);
    const totalCacheRead = sessions.reduce((sum, s) => sum + (s.cache_read_tokens || 0), 0);
    const totalCacheWrite = sessions.reduce((sum, s) => sum + (s.cache_write_tokens || 0), 0);
    const totalTokens = totalInput + totalOutput + totalCacheRead + totalCacheWrite;
    const totalToolCalls = sessions.reduce((sum, s) => sum + (s.tool_call_count || 0), 0);
    const totalMessages = sessions.reduce((sum, s) => sum + (s.message_count || 0), 0);
    const totalCost = sessions.reduce((sum, s) => sum + (s.estimated_cost_usd || 0), 0);
    
    const durations = sessions
      .filter(s => s.started_at && s.ended_at && s.ended_at > s.started_at)
      .map(s => s.ended_at - s.started_at);
    
    const totalHours = durations.reduce((sum, d) => sum + d, 0) / 3600;
    const avgDuration = durations.length > 0 ? durations.reduce((sum, d) => sum + d, 0) / durations.length : 0;
    
    const timestamps = sessions.filter(s => s.started_at).map(s => s.started_at);
    
    return {
      totalSessions: sessions.length,
      totalMessages,
      totalToolCalls,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalCacheReadTokens: totalCacheRead,
      totalCacheWriteTokens: totalCacheWrite,
      totalTokens,
      estimatedCost: totalCost,
      totalHours,
      avgSessionDuration: avgDuration,
      avgMessagesPerSession: sessions.length > 0 ? totalMessages / sessions.length : 0,
      avgTokensPerSession: sessions.length > 0 ? totalTokens / sessions.length : 0,
      userMessages: messageStats.user_messages || 0,
      assistantMessages: messageStats.assistant_messages || 0,
      toolMessages: messageStats.tool_messages || 0,
      dateRangeStart: timestamps.length > 0 ? Math.min(...timestamps) : null,
      dateRangeEnd: timestamps.length > 0 ? Math.max(...timestamps) : null
    };
  }

  _computeModelBreakdown(sessions) {
    const modelData = {};
    
    for (const s of sessions) {
      const model = s.model || 'unknown';
      const displayModel = model.includes('/') ? model.split('/').pop() : model;
      
      if (!modelData[displayModel]) {
        modelData[displayModel] = {
          model: displayModel,
          sessions: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          toolCalls: 0,
          cost: 0
        };
      }
      
      const d = modelData[displayModel];
      d.sessions++;
      d.inputTokens += s.input_tokens || 0;
      d.outputTokens += s.output_tokens || 0;
      d.cacheReadTokens += s.cache_read_tokens || 0;
      d.cacheWriteTokens += s.cache_write_tokens || 0;
      d.totalTokens += (s.input_tokens || 0) + (s.output_tokens || 0) + 
                       (s.cache_read_tokens || 0) + (s.cache_write_tokens || 0);
      d.toolCalls += s.tool_call_count || 0;
      d.cost += s.estimated_cost_usd || 0;
    }
    
    return Object.values(modelData).sort((a, b) => b.totalTokens - a.totalTokens);
  }

  _computePlatformBreakdown(sessions) {
    const platformData = {};
    
    for (const s of sessions) {
      const platform = s.source || 'unknown';
      
      if (!platformData[platform]) {
        platformData[platform] = {
          platform,
          sessions: 0,
          messages: 0,
          tokens: 0,
          toolCalls: 0
        };
      }
      
      const d = platformData[platform];
      d.sessions++;
      d.messages += s.message_count || 0;
      d.tokens += (s.input_tokens || 0) + (s.output_tokens || 0);
      d.toolCalls += s.tool_call_count || 0;
    }
    
    return Object.values(platformData).sort((a, b) => b.sessions - a.sessions);
  }

  _computeToolBreakdown(toolUsage) {
    const totalCalls = toolUsage.reduce((sum, t) => sum + t.count, 0);
    
    return toolUsage.map(t => ({
      tool: t.tool_name,
      count: t.count,
      percentage: totalCalls > 0 ? ((t.count / totalCalls) * 100).toFixed(1) : 0
    }));
  }

  _computeActivityPatterns(sessions) {
    const dayCounts = {};
    const hourCounts = {};
    const dailyCounts = {};
    
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    
    for (const s of sessions) {
      if (!s.started_at) continue;
      
      const dt = new Date(s.started_at * 1000);
      const day = dt.getDay();
      const hour = dt.getHours();
      const dateStr = dt.toISOString().split('T')[0];
      
      dayCounts[day] = (dayCounts[day] || 0) + 1;
      hourCounts[hour] = (hourCounts[hour] || 0) + 1;
      dailyCounts[dateStr] = (dailyCounts[dateStr] || 0) + 1;
    }
    
    return {
      byDayOfWeek: dayNames.map((name, i) => ({ day: name, count: dayCounts[i] || 0 })),
      byHour: Array.from({ length: 24 }, (_, i) => ({ hour: i, count: hourCounts[i] || 0 })),
      daily: Object.entries(dailyCounts)
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-30)
    };
  }

  _computeTopSessions(sessions) {
    return sessions
      .filter(s => s.input_tokens || s.output_tokens)
      .sort((a, b) => {
        const aTokens = (a.input_tokens || 0) + (a.output_tokens || 0);
        const bTokens = (b.input_tokens || 0) + (b.output_tokens || 0);
        return bTokens - aTokens;
      })
      .slice(0, 10)
      .map(s => ({
        id: s.id,
        title: s.title || 'Untitled',
        model: s.model,
        tokens: (s.input_tokens || 0) + (s.output_tokens || 0),
        cost: s.estimated_cost_usd || 0,
        startedAt: s.started_at
      }));
  }

  formatTerminalReport(report) {
    if (report.empty) {
      return '📊 暂无使用数据';
    }
    
    const lines = [];
    const o = report.overview;
    
    lines.push('📊 使用洞察报告');
    lines.push('='.repeat(50));
    lines.push('');
    
    lines.push('📈 概览');
    lines.push(`  会话总数: ${o.totalSessions}`);
    lines.push(`  消息总数: ${o.totalMessages}`);
    lines.push(`  工具调用: ${o.totalToolCalls}`);
    lines.push(`  总 Tokens: ${o.totalTokens.toLocaleString()}`);
    lines.push(`    - 输入: ${o.totalInputTokens.toLocaleString()}`);
    lines.push(`    - 输出: ${o.totalOutputTokens.toLocaleString()}`);
    lines.push(`    - 缓存读取: ${o.totalCacheReadTokens.toLocaleString()}`);
    lines.push(`    - 缓存写入: ${o.totalCacheWriteTokens.toLocaleString()}`);
    lines.push(`  预估成本: $${o.estimatedCost.toFixed(4)}`);
    lines.push(`  总时长: ${o.totalHours.toFixed(1)} 小时`);
    lines.push('');
    
    if (report.models.length > 0) {
      lines.push('🤖 模型分布');
      for (const m of report.models.slice(0, 5)) {
        lines.push(`  ${m.model}: ${m.sessions} 会话, ${m.totalTokens.toLocaleString()} tokens, $${m.cost.toFixed(4)}`);
      }
      lines.push('');
    }
    
    if (report.platforms.length > 0) {
      lines.push('📡 平台分布');
      for (const p of report.platforms) {
        lines.push(`  ${p.platform}: ${p.sessions} 会话, ${p.messages} 消息`);
      }
      lines.push('');
    }
    
    if (report.tools.length > 0) {
      lines.push('🔧 工具使用');
      for (const t of report.tools.slice(0, 10)) {
        lines.push(`  ${t.tool}: ${t.count} 次 (${t.percentage}%)`);
      }
      lines.push('');
    }

    if (report.skillInsights && report.skillInsights.length > 0) {
      lines.push('🎯 技能洞察');
      for (const si of report.skillInsights.slice(0, 10)) {
        const successRate = si.total > 0 ? ((si.successes / si.total) * 100).toFixed(0) : 0;
        lines.push(`  ${si.skill}: ${si.total} 次 (成功率 ${successRate}%)`);
      }
      lines.push('');
    }

    if (report.optimizationTips && report.optimizationTips.length > 0) {
      lines.push('💡 优化建议');
      for (const tip of report.optimizationTips) {
        lines.push(`  - ${tip}`);
      }
      lines.push('');
    }
    
    return lines.join('\n');
  }

  async getSkillInsights(days = 30) {
    const cutoff = Date.now() / 1000 - (days * 86400);
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT m.content, COUNT(*) as count
         FROM messages m
         JOIN sessions s ON s.id = m.session_id
         WHERE s.started_at >= ? AND m.role = 'tool' AND m.tool_name = 'SkillView'
         GROUP BY m.content
         ORDER BY count DESC`,
        [cutoff],
        (err, rows) => {
          if (err) reject(err);
          else resolve((rows || []).map(r => ({
            skill: r.content?.slice(0, 80) || 'unknown',
            total: r.count,
            successes: r.count,
          })));
        }
      );
    });
  }

  generateOptimizationTips(report) {
    const tips = [];
    const o = report.overview;

    if (o.totalCacheReadTokens > 0 && o.totalInputTokens > 0) {
      const cacheRatio = o.totalCacheReadTokens / (o.totalCacheReadTokens + o.totalInputTokens);
      if (cacheRatio < 0.3) {
        tips.push(`缓存命中率仅 ${(cacheRatio * 100).toFixed(0)}%，考虑使用三层 System Prompt 架构提升缓存命中`);
      }
    }

    if (o.totalSessions > 5) {
      const avgToolCalls = o.totalToolCalls / o.totalSessions;
      if (avgToolCalls > 8) {
        tips.push(`平均每会话 ${avgToolCalls.toFixed(1)} 次工具调用，考虑创建技能 Bundle 减少重复调用`);
      }
    }

    if (report.tools && report.tools.length > 0) {
      const topTool = report.tools[0];
      if (topTool && parseFloat(topTool.percentage) > 40) {
        tips.push(`工具 ${topTool.tool} 占 ${topTool.percentage}% 使用量，考虑创建专用技能优化流程`);
      }
    }

    if (o.estimatedCost > 1.0) {
      tips.push(`月度成本 $${o.estimatedCost.toFixed(2)}，考虑对简单任务使用更经济的模型`);
    }

    return tips;
  }

  close() {
    if (this.db) {
      this.db.close();
    }
  }
}

module.exports = InsightsEngine;
