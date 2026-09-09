const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BUILTIN_TEMPLATES = [
  {
    id: 'daily_news',
    name: '每日新闻推送',
    description: '每天定时推送最新新闻资讯',
    category: 'information',
    icon: '📰',
    template: {
      name: '每日新闻推送',
      cron: '0 9 * * *',
      action: 'search',
      params: { keyword: '今日新闻' },
      enabled: true
    },
    customizable: ['name', 'cron', 'params.keyword'],
    tags: ['新闻', '资讯', '每日']
  },
  {
    id: 'weekly_report',
    name: '每周工作总结',
    description: '每周五生成并发送工作总结报告',
    category: 'report',
    icon: '📊',
    template: {
      name: '每周工作总结',
      cron: '0 18 * * 5',
      action: 'skill',
      skill: 'report-generator',
      params: { instruction: '生成本周工作总结报告' },
      enabled: true
    },
    customizable: ['name', 'cron', 'params.instruction'],
    tags: ['报告', '周报', '总结']
  },
  {
    id: 'stock_monitor',
    name: '股票价格监控',
    description: '定时监控指定股票价格并推送',
    category: 'finance',
    icon: '📈',
    template: {
      name: '股票价格监控',
      cron: '0 10,14,16 * * 1-5',
      action: 'skill',
      params: { instruction: '查询股票价格并推送' },
      enabled: true
    },
    customizable: ['name', 'cron', 'params.instruction'],
    tags: ['股票', '金融', '监控']
  },
  {
    id: 'weather_forecast',
    name: '天气预报提醒',
    description: '每天早上推送天气预报',
    category: 'lifestyle',
    icon: '🌤️',
    template: {
      name: '天气预报提醒',
      cron: '0 7 * * *',
      action: 'skill',
      params: { instruction: '查询今天天气并推送' },
      enabled: true
    },
    customizable: ['name', 'cron', 'params.instruction'],
    tags: ['天气', '生活', '提醒']
  },
  {
    id: 'meeting_reminder',
    name: '会议提醒',
    description: '会议前30分钟发送提醒',
    category: 'productivity',
    icon: '📅',
    template: {
      name: '会议提醒',
      cron: '*/30 9-18 * * 1-5',
      action: 'skill',
      params: { instruction: '检查即将开始的会议并发送提醒' },
      enabled: true
    },
    customizable: ['name', 'cron', 'params.instruction'],
    tags: ['会议', '提醒', '工作']
  },
  {
    id: 'data_backup',
    name: '数据备份',
    description: '定期备份重要数据',
    category: 'system',
    icon: '💾',
    template: {
      name: '数据备份',
      cron: '0 2 * * 0',
      action: 'skill',
      skill: 'backup',
      params: { instruction: '执行数据备份' },
      enabled: true
    },
    customizable: ['name', 'cron', 'params.instruction'],
    tags: ['备份', '系统', '数据']
  },
  {
    id: 'social_media_check',
    name: '社交媒体监控',
    description: '定时检查社交媒体动态',
    category: 'social',
    icon: '📱',
    template: {
      name: '社交媒体监控',
      cron: '0 9,12,18 * * *',
      action: 'skill',
      params: { instruction: '检查社交媒体最新动态' },
      enabled: true
    },
    customizable: ['name', 'cron', 'params.instruction'],
    tags: ['社交', '媒体', '监控']
  },
  {
    id: 'health_reminder',
    name: '健康提醒',
    description: '定时提醒喝水、休息、运动',
    category: 'health',
    icon: '💪',
    template: {
      name: '健康提醒',
      cron: '0 10,15,20 * * *',
      action: 'skill',
      params: { instruction: '发送健康提醒' },
      enabled: true
    },
    customizable: ['name', 'cron', 'params.instruction'],
    tags: ['健康', '提醒', '生活']
  },
  {
    id: 'email_digest',
    name: '邮件摘要',
    description: '每天汇总未读邮件',
    category: 'productivity',
    icon: '📧',
    template: {
      name: '邮件摘要',
      cron: '0 9 * * 1-5',
      action: 'skill',
      params: { instruction: '汇总并发送未读邮件摘要' },
      enabled: true
    },
    customizable: ['name', 'cron', 'params.instruction'],
    tags: ['邮件', '摘要', '工作']
  },
  {
    id: 'learning_reminder',
    name: '学习提醒',
    description: '定时提醒学习任务',
    category: 'education',
    icon: '📚',
    template: {
      name: '学习提醒',
      cron: '0 20 * * *',
      action: 'skill',
      params: { instruction: '发送学习提醒和今日学习任务' },
      enabled: true
    },
    customizable: ['name', 'cron', 'params.instruction'],
    tags: ['学习', '教育', '提醒']
  }
];

const TEMPLATE_CATEGORIES = {
  information: { name: '信息资讯', icon: '📰', description: '新闻、资讯类任务' },
  report: { name: '报告生成', icon: '📊', description: '自动生成各类报告' },
  finance: { name: '金融理财', icon: '📈', description: '股票、基金等金融监控' },
  lifestyle: { name: '生活服务', icon: '🌤️', description: '天气、生活提醒' },
  productivity: { name: '效率工具', icon: '⚡', description: '提升工作效率的任务' },
  system: { name: '系统管理', icon: '💾', description: '系统维护、备份等' },
  social: { name: '社交网络', icon: '📱', description: '社交媒体监控' },
  health: { name: '健康生活', icon: '💪', description: '健康提醒、运动打卡' },
  education: { name: '学习教育', icon: '📚', description: '学习提醒、知识推送' }
};

class TaskTemplateManager {
  constructor() {
    this.templates = new Map();
    this.customTemplates = new Map();
    this.templateUsageStats = new Map();
    
    this.loadBuiltinTemplates();
    this.loadCustomTemplates();
  }
  
  loadBuiltinTemplates() {
    for (const template of BUILTIN_TEMPLATES) {
      this.templates.set(template.id, {
        ...template,
        type: 'builtin',
        createdAt: Date.now()
      });
    }
    
    console.log(`📋 已加载 ${this.templates.size} 个内置任务模板`);
  }
  
  loadCustomTemplates() {
    const customTemplatePath = this.getCustomTemplatePath();
    
    if (fs.existsSync(customTemplatePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(customTemplatePath, 'utf-8'));
        
        for (const template of data.templates || []) {
          this.customTemplates.set(template.id, {
            ...template,
            type: 'custom',
            createdAt: template.createdAt || Date.now()
          });
        }
        
        console.log(`📋 已加载 ${this.customTemplates.size} 个自定义任务模板`);
      } catch (e) {
        console.error('加载自定义模板失败:', e.message);
      }
    }
  }
  
  getCustomTemplatePath() {
    const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
    return path.join(dataDir, 'task-templates.json');
  }
  
  saveCustomTemplates() {
    const customTemplatePath = this.getCustomTemplatePath();
    const dir = path.dirname(customTemplatePath);
    
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    const templates = Array.from(this.customTemplates.values());
    
    fs.writeFileSync(
      customTemplatePath,
      JSON.stringify({ templates }, null, 2),
      'utf-8'
    );
  }
  
  getTemplate(templateId) {
    return this.templates.get(templateId) || this.customTemplates.get(templateId);
  }
  
  listTemplates(options = {}) {
    const { category, tags, search } = options;
    
    let templates = [
      ...Array.from(this.templates.values()),
      ...Array.from(this.customTemplates.values())
    ];
    
    if (category) {
      templates = templates.filter(t => t.category === category);
    }
    
    if (tags && tags.length > 0) {
      templates = templates.filter(t => 
        tags.some(tag => t.tags && t.tags.includes(tag))
      );
    }
    
    if (search) {
      const searchLower = search.toLowerCase();
      templates = templates.filter(t => 
        t.name.toLowerCase().includes(searchLower) ||
        t.description.toLowerCase().includes(searchLower) ||
        (t.tags && t.tags.some(tag => tag.toLowerCase().includes(searchLower)))
      );
    }
    
    return templates.sort((a, b) => {
      const usageA = this.templateUsageStats.get(a.id) || 0;
      const usageB = this.templateUsageStats.get(b.id) || 0;
      return usageB - usageA;
    });
  }
  
  listCategories() {
    return Object.entries(TEMPLATE_CATEGORIES).map(([key, value]) => ({
      id: key,
      ...value,
      templateCount: this.getTemplateCountByCategory(key)
    }));
  }
  
  getTemplateCountByCategory(categoryId) {
    let count = 0;
    
    for (const template of this.templates.values()) {
      if (template.category === categoryId) count++;
    }
    
    for (const template of this.customTemplates.values()) {
      if (template.category === categoryId) count++;
    }
    
    return count;
  }
  
  createTaskFromTemplate(templateId, customizations = {}) {
    const template = this.getTemplate(templateId);
    
    if (!template) {
      return {
        success: false,
        error: `模板不存在: ${templateId}`
      };
    }
    
    const task = {
      ...template.template,
      id: `${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 8)}`,
      createdAt: Date.now(),
      fromTemplate: templateId
    };
    
    for (const [key, value] of Object.entries(customizations)) {
      if (template.customizable && template.customizable.includes(key)) {
        this.setNestedValue(task, key, value);
      }
    }
    
    this.recordTemplateUsage(templateId);
    
    return {
      success: true,
      task,
      template: {
        id: template.id,
        name: template.name,
        icon: template.icon
      }
    };
  }
  
  setNestedValue(obj, path, value) {
    const keys = path.split('.');
    let current = obj;
    
    for (let i = 0; i < keys.length - 1; i++) {
      if (!current[keys[i]]) {
        current[keys[i]] = {};
      }
      current = current[keys[i]];
    }
    
    current[keys[keys.length - 1]] = value;
  }
  
  recordTemplateUsage(templateId) {
    const current = this.templateUsageStats.get(templateId) || 0;
    this.templateUsageStats.set(templateId, current + 1);
  }
  
  createCustomTemplate(templateData) {
    const { name, description, category, template, customizable, tags, icon } = templateData;
    
    if (!name || !template) {
      return {
        success: false,
        error: '模板名称和任务模板不能为空'
      };
    }
    
    const id = `custom_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 8)}`;
    
    const customTemplate = {
      id,
      name,
      description: description || '',
      category: category || 'productivity',
      icon: icon || '⭐',
      template,
      customizable: customizable || Object.keys(template),
      tags: tags || [],
      type: 'custom',
      createdAt: Date.now()
    };
    
    this.customTemplates.set(id, customTemplate);
    this.saveCustomTemplates();
    
    console.log(`✅ 创建自定义模板: ${name}`);
    
    return {
      success: true,
      template: customTemplate
    };
  }
  
  updateCustomTemplate(templateId, updates) {
    const template = this.customTemplates.get(templateId);
    
    if (!template) {
      return {
        success: false,
        error: `自定义模板不存在: ${templateId}`
      };
    }
    
    const updated = {
      ...template,
      ...updates,
      updatedAt: Date.now()
    };
    
    this.customTemplates.set(templateId, updated);
    this.saveCustomTemplates();
    
    return {
      success: true,
      template: updated
    };
  }
  
  deleteCustomTemplate(templateId) {
    if (!this.customTemplates.has(templateId)) {
      return {
        success: false,
        error: `自定义模板不存在: ${templateId}`
      };
    }
    
    this.customTemplates.delete(templateId);
    this.saveCustomTemplates();
    
    console.log(`🗑️ 删除自定义模板: ${templateId}`);
    
    return {
      success: true,
      message: '模板已删除'
    };
  }
  
  getTemplateUsageStats(templateId) {
    return {
      templateId,
      usageCount: this.templateUsageStats.get(templateId) || 0
    };
  }
  
  getPopularTemplates(limit = 10) {
    const templates = this.listTemplates();
    
    return templates
      .map(t => ({
        ...t,
        usageCount: this.templateUsageStats.get(t.id) || 0
      }))
      .sort((a, b) => b.usageCount - a.usageCount)
      .slice(0, limit);
  }
  
  exportTemplates(templateIds) {
    const templates = [];
    
    for (const id of templateIds) {
      const template = this.getTemplate(id);
      if (template) {
        templates.push(template);
      }
    }
    
    return {
      success: true,
      templates,
      exportedAt: Date.now()
    };
  }
  
  importTemplates(templatesData) {
    const imported = [];
    const failed = [];
    
    for (const templateData of templatesData) {
      try {
        const result = this.createCustomTemplate(templateData);
        
        if (result.success) {
          imported.push(result.template);
        } else {
          failed.push({
            name: templateData.name,
            error: result.error
          });
        }
      } catch (e) {
        failed.push({
          name: templateData.name,
          error: e.message
        });
      }
    }
    
    return {
      success: true,
      imported: imported.length,
      failed: failed.length,
      details: { imported, failed }
    };
  }
}

let instance = null;

function getTaskTemplateManager() {
  if (!instance) {
    instance = new TaskTemplateManager();
  }
  return instance;
}

module.exports = {
  TaskTemplateManager,
  getTaskTemplateManager,
  BUILTIN_TEMPLATES,
  TEMPLATE_CATEGORIES
};
