
 function escapeRegExp(str) {
   if (typeof str !== 'string') return '';
   return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
 }
 
 const WORKFLOW_TEMPLATES = {
  'daily_report': {
    id: 'daily_report',
    name: '每日报告',
    description: '自动收集数据并生成日报',
    category: 'report',
    keywords: ['日报', '每日报告', '每天报告', 'daily report', '日汇报', '今天报告'],
    steps: [
      { type: 'skill', skill: 'data-analysis', input: 'action=daily_summary' },
      { type: 'skill', skill: 'chart-visualization', input: 'type=daily_chart' },
      { type: 'skill', skill: 'wecom-daily-news', input: 'mode=report' }
    ],
    params: {
      data_source: { type: 'string', default: 'system', description: '数据来源' },
      report_format: { type: 'string', default: 'daily', description: '报告格式' },
      send_channel: { type: 'string', default: 'wecom', description: '发送渠道' }
    }
  },

  'weekly_summary': {
    id: 'weekly_summary',
    name: '周报汇总',
    description: '汇总一周工作并生成周报',
    category: 'report',
    keywords: ['周报', '每周总结', 'weekly summary', '周总结', '本周总结'],
    steps: [
      { type: 'skill', skill: 'data-analysis', input: 'action=weekly_summary' },
      { type: 'skill', skill: 'chart-visualization', input: 'type=weekly_trend' },
      { type: 'skill', skill: 'pdf-generator', input: 'format=weekly_report' }
    ],
    params: {
      data_source: { type: 'string', default: 'system', description: '数据来源' },
      include_charts: { type: 'boolean', default: true, description: '是否包含图表' }
    }
  },

  'message_notify': {
    id: 'message_notify',
    name: '消息通知',
    description: '发送消息通知给指定对象',
    category: 'communication',
    keywords: ['通知', '发送消息', '提醒', 'notify', 'send message', '提醒我', '发消息', '告诉'],
    steps: [
      { type: 'skill', skill: 'wecom-daily-news', input: 'mode=custom_message' }
    ],
    params: {
      recipient: { type: 'string', required: true, description: '接收人' },
      message: { type: 'string', required: true, description: '消息内容' },
      channel: { type: 'string', default: 'wecom', description: '发送渠道' }
    }
  },

  'data_analysis': {
    id: 'data_analysis',
    name: '数据分析',
    description: '收集数据并进行分析',
    category: 'analysis',
    keywords: ['分析', '数据分析', '统计', 'analysis', 'data analysis', '统计一下', '数据趋势'],
    steps: [
      { type: 'skill', skill: 'data-analysis', input: 'action=general' },
      { type: 'skill', skill: 'chart-visualization', input: 'type=auto' }
    ],
    params: {
      data_source: { type: 'string', required: true, description: '数据来源' },
      analysis_type: { type: 'string', default: 'general', description: '分析类型' }
    }
  },

  'financial_analysis': {
    id: 'financial_analysis',
    name: '财务分析',
    description: '财务数据深度分析',
    category: 'analysis',
    keywords: ['财务分析', '财务报表', '审计', 'financial analysis', '会计分析', '财务指标'],
    steps: [
      { type: 'skill', skill: 'financial-analyst', input: 'action=full_analysis' },
      { type: 'skill', skill: 'chart-visualization', input: 'type=financial_chart' },
      { type: 'skill', skill: 'excel-xlsx', input: 'action=generate_report' }
    ],
    params: {
      period: { type: 'string', default: 'quarterly', description: '分析周期' },
      metrics: { type: 'string', default: 'all', description: '分析指标' }
    }
  },

  'stock_analysis': {
    id: 'stock_analysis',
    name: '股票分析',
    description: '股票行情分析与投资建议',
    category: 'analysis',
    keywords: ['股票', '股票分析', '行情', '投资', 'stock analysis', '股价', 'A股', '港股'],
    steps: [
      { type: 'skill', skill: 'stock-analyst-enhanced', input: 'action=market_analysis' },
      { type: 'skill', skill: 'chart-visualization', input: 'type=stock_chart' },
      { type: 'skill', skill: 'flashclaw-stock', input: 'action=realtime' }
    ],
    params: {
      stock_code: { type: 'string', required: true, description: '股票代码' },
      analysis_type: { type: 'string', default: 'comprehensive', description: '分析类型' }
    }
  },

  'deep_research': {
    id: 'deep_research',
    name: '深度研究',
    description: '对某个主题进行深度研究',
    category: 'research',
    keywords: ['研究', '调研', '深度研究', 'research', 'deep research', '调查', '了解'],
    steps: [
      { type: 'skill', skill: 'deep-research', input: 'depth=standard' },
      { type: 'skill', skill: 'multi-search-engine', input: 'mode=comprehensive' },
      { type: 'skill', skill: 'summarize-pro', input: 'format=research_report' }
    ],
    params: {
      topic: { type: 'string', required: true, description: '研究主题' },
      depth: { type: 'string', default: 'standard', description: '研究深度' }
    }
  },

  'deep_research_pro': {
    id: 'deep_research_pro',
    name: '专业研究',
    description: '专业级深度研究，多角度全面分析',
    category: 'research',
    keywords: ['专业研究', '深度调研', '深度分析', 'deep research pro', '全面调研', '行业研究'],
    steps: [
      { type: 'skill', skill: 'deep-research-pro', input: 'depth=professional' },
      { type: 'skill', skill: 'consulting-analysis', input: 'mode=full' },
      { type: 'skill', skill: 'chart-visualization', input: 'type=research_chart' },
      { type: 'skill', skill: 'pdf-generator', input: 'format=research_report' }
    ],
    params: {
      topic: { type: 'string', required: true, description: '研究主题' },
      industry: { type: 'string', default: 'general', description: '行业领域' }
    }
  },

  'ppt_creation': {
    id: 'ppt_creation',
    name: 'PPT制作',
    description: '创建专业演示文稿',
    category: 'document',
    keywords: ['PPT', '演示文稿', '幻灯片', 'pptx', 'presentation', '做PPT', '制作PPT'],
    steps: [
      { type: 'skill', skill: 'deep-research', input: 'depth=standard' },
      { type: 'skill', skill: 'pptx-generator', input: 'style=auto' }
    ],
    params: {
      topic: { type: 'string', required: true, description: 'PPT主题' },
      style: { type: 'string', default: 'business', description: 'PPT风格' },
      pages: { type: 'number', default: 10, description: '页数' }
    }
  },

  'pdf_generation': {
    id: 'pdf_generation',
    name: 'PDF生成',
    description: '生成PDF文档',
    category: 'document',
    keywords: ['PDF', '生成PDF', 'PDF文档', 'pdf', 'pdf generator', '转PDF'],
    steps: [
      { type: 'skill', skill: 'pdf-generator', input: 'format=standard' }
    ],
    params: {
      content: { type: 'string', required: true, description: '文档内容' },
      format: { type: 'string', default: 'standard', description: '文档格式' }
    }
  },

  'pdf_smart_tool': {
    id: 'pdf_smart_tool',
    name: 'PDF智能处理',
    description: 'PDF文档智能处理（提取、转换、合并等）',
    category: 'document',
    keywords: ['PDF处理', 'PDF提取', 'PDF转换', 'PDF合并', 'pdf smart', 'PDF工具'],
    steps: [
      { type: 'skill', skill: 'pdf-smart-tool-cn', input: 'action=auto' }
    ],
    params: {
      action: { type: 'string', default: 'extract', description: '操作类型' },
      file_path: { type: 'string', required: true, description: '文件路径' }
    }
  },

  'excel_processing': {
    id: 'excel_processing',
    name: 'Excel处理',
    description: 'Excel文件处理和数据分析',
    category: 'document',
    keywords: ['Excel', '表格', 'xlsx', 'excel', '电子表格', '处理Excel'],
    steps: [
      { type: 'skill', skill: 'excel-xlsx', input: 'action=auto' },
      { type: 'skill', skill: 'chart-visualization', input: 'type=excel_chart' }
    ],
    params: {
      file_path: { type: 'string', required: true, description: '文件路径' },
      action: { type: 'string', default: 'analyze', description: '操作类型' }
    }
  },

  'markdown_convert': {
    id: 'markdown_convert',
    name: '文档转换',
    description: 'Markdown与其他格式互转',
    category: 'document',
    keywords: ['文档转换', 'Markdown转换', '格式转换', 'convert', 'markdown', '转换格式'],
    steps: [
      { type: 'skill', skill: 'markdown-converter', input: 'action=auto' }
    ],
    params: {
      source_format: { type: 'string', default: 'markdown', description: '源格式' },
      target_format: { type: 'string', default: 'html', description: '目标格式' }
    }
  },

  'content_writing': {
    id: 'content_writing',
    name: '内容创作',
    description: '生成各类内容文档',
    category: 'content',
    keywords: ['写文章', '生成文档', '创作', 'content', 'write', '写一个', '帮我写', '写一篇'],
    steps: [
      { type: 'skill', skill: 'deep-research', input: 'depth=standard' },
      { type: 'skill', skill: 'prompt-engineering-expert', input: 'task=writing' },
      { type: 'skill', skill: 'summarize-pro', input: 'action=polish' }
    ],
    params: {
      topic: { type: 'string', required: true, description: '主题' },
      format: { type: 'string', default: 'document', description: '输出格式' },
      length: { type: 'string', default: 'standard', description: '内容长度' }
    }
  },

  'prompt_engineering': {
    id: 'prompt_engineering',
    name: 'Prompt优化',
    description: '优化AI提示词工程',
    category: 'content',
    keywords: ['Prompt', '提示词', 'prompt engineering', '优化提示词', '提示词工程'],
    steps: [
      { type: 'skill', skill: 'prompt-engineering-expert', input: 'action=optimize' }
    ],
    params: {
      prompt: { type: 'string', required: true, description: '原始提示词' },
      goal: { type: 'string', default: 'improve', description: '优化目标' }
    }
  },

  'summarize': {
    id: 'summarize',
    name: '内容摘要',
    description: '对长文本进行摘要总结',
    category: 'content',
    keywords: ['摘要', '总结', '概括', 'summarize', '总结一下', '简要', '提炼'],
    steps: [
      { type: 'skill', skill: 'summarize-pro', input: 'action=summarize' }
    ],
    params: {
      content: { type: 'string', required: true, description: '待摘要内容' },
      length: { type: 'string', default: 'medium', description: '摘要长度' }
    }
  },

  'web_search': {
    id: 'web_search',
    name: '网络搜索',
    description: '多引擎搜索信息',
    category: 'research',
    keywords: ['搜索', '查找', '查询', 'search', 'find', '查一下', '搜一下', '网上查'],
    steps: [
      { type: 'skill', skill: 'multi-search-engine', input: 'mode=standard' }
    ],
    params: {
      query: { type: 'string', required: true, description: '搜索关键词' },
      engine: { type: 'string', default: 'multi', description: '搜索引擎' }
    }
  },

  'system_health': {
    id: 'system_health',
    name: '系统健康检查',
    description: '检查系统运行状态',
    category: 'system',
    keywords: ['系统检查', '健康检查', '系统状态', 'healthcheck', 'system info', '检查系统'],
    steps: [
      { type: 'skill', skill: 'healthcheck', input: 'mode=full' },
      { type: 'skill', skill: 'system-info', input: 'mode=detailed' }
    ],
    params: {
      check_type: { type: 'string', default: 'full', description: '检查类型' }
    }
  },

  'desktop_automation': {
    id: 'desktop_automation',
    name: '桌面自动化',
    description: '桌面操作自动化控制',
    category: 'automation',
    keywords: ['桌面控制', '自动化操作', '鼠标键盘', 'desktop', 'automation', '自动操作'],
    steps: [
      { type: 'skill', skill: 'desktop-control', input: 'mode=auto' }
    ],
    params: {
      task: { type: 'string', required: true, description: '自动化任务描述' }
    }
  },

  'web_browse': {
    id: 'web_browse',
    name: '网页浏览',
    description: '浏览和提取网页信息',
    category: 'research',
    keywords: ['浏览网页', '打开网页', '网页内容', 'browse', 'web', '网站', '访问网页'],
    steps: [
      { type: 'skill', skill: 'agent-browser', input: 'mode=browse' }
    ],
    params: {
      url: { type: 'string', required: true, description: '网页地址' },
      action: { type: 'string', default: 'extract', description: '操作类型' }
    }
  },

  'frontend_design': {
    id: 'frontend_design',
    name: '前端设计',
    description: '前端页面设计与生成',
    category: 'development',
    keywords: ['前端设计', '页面设计', 'UI设计', 'frontend', 'web design', '网页设计'],
    steps: [
      { type: 'skill', skill: 'deep-research', input: 'depth=design_research' },
      { type: 'skill', skill: 'frontend-design-ultimate', input: 'style=auto' }
    ],
    params: {
      design_type: { type: 'string', required: true, description: '设计类型' },
      style: { type: 'string', default: 'modern', description: '设计风格' }
    }
  },

  'workflow_design': {
    id: 'workflow_design',
    name: '工作流设计',
    description: '设计和创建自动化工作流',
    category: 'development',
    keywords: ['工作流设计', '流程设计', 'workflow', 'workflow design', '设计工作流'],
    steps: [
      { type: 'skill', skill: 'workflow-designer', input: 'mode=design' }
    ],
    params: {
      workflow_type: { type: 'string', required: true, description: '工作流类型' },
      complexity: { type: 'string', default: 'standard', description: '复杂度' }
    }
  },

  'team_orchestration': {
    id: 'team_orchestration',
    name: '团队协作',
    description: '多Agent团队协作编排',
    category: 'development',
    keywords: ['团队协作', '多Agent', '协作编排', 'team', 'orchestration', 'AI团队'],
    steps: [
      { type: 'skill', skill: 'agent-team-orchestration', input: 'mode=collaborate' }
    ],
    params: {
      team_size: { type: 'number', default: 3, description: '团队规模' },
      task_type: { type: 'string', default: 'general', description: '任务类型' }
    }
  },

  'weather_query': {
    id: 'weather_query',
    name: '天气查询',
    description: '查询天气信息',
    category: 'information',
    keywords: ['天气', '气温', 'weather', '天气预报', '下雨'],
    steps: [
      { type: 'skill', skill: 'weather', input: 'mode=forecast' }
    ],
    params: {
      location: { type: 'string', required: true, description: '位置' },
      days: { type: 'number', default: 3, description: '预报天数' }
    }
  },

  'meeting_schedule': {
    id: 'meeting_schedule',
    name: '会议安排',
    description: '安排会议并发送邀请',
    category: 'calendar',
    keywords: ['安排会议', '开会', '约会议', 'meeting', 'schedule meeting', '约个会'],
    steps: [
      { type: 'skill', skill: 'system-info', input: 'action=check_calendar' },
      { type: 'skill', skill: 'wecom-daily-news', input: 'mode=meeting_invite' }
    ],
    params: {
      participants: { type: 'string', required: true, description: '参会人' },
      duration: { type: 'number', default: 60, description: '会议时长(分钟)' },
      topic: { type: 'string', required: true, description: '会议主题' }
    }
  },

  'monitor_alert': {
    id: 'monitor_alert',
    name: '监控告警',
    description: '监控系统状态并发送告警',
    category: 'system',
    keywords: ['监控', '告警', '报警', 'monitor', 'alert', 'watch'],
    steps: [
      { type: 'skill', skill: 'healthcheck', input: 'mode=monitor' },
      { type: 'condition', condition: 'status.abnormal' },
      { type: 'skill', skill: 'wecom-daily-news', input: 'mode=alert' }
    ],
    params: {
      target: { type: 'string', required: true, description: '监控目标' },
      threshold: { type: 'string', default: 'default', description: '告警阈值' },
      alert_channel: { type: 'string', default: 'wecom', description: '告警渠道' }
    }
  },

  'competitive_analysis': {
    id: 'competitive_analysis',
    name: '竞品分析',
    description: '对竞争对手进行系统化分析',
    category: 'research',
    keywords: ['竞品分析', '竞品', '竞争对手', 'competitive', '竞品对比', '竞品调研'],
    steps: [
      { type: 'skill', skill: 'deep-research-pro', input: 'depth=competitive' },
      { type: 'skill', skill: 'consulting-analysis', input: 'mode=competitive' },
      { type: 'skill', skill: 'chart-visualization', input: 'type=comparison' },
      { type: 'skill', skill: 'pdf-generator', input: 'format=competitive_report' }
    ],
    params: {
      competitors: { type: 'string', required: true, description: '竞品名称' },
      dimensions: { type: 'string', default: 'all', description: '分析维度' }
    }
  },

  'market_research': {
    id: 'market_research',
    name: '市场调研',
    description: '市场环境与趋势调研',
    category: 'research',
    keywords: ['市场调研', '市场分析', '行业调研', 'market research', '市场趋势', '行业趋势'],
    steps: [
      { type: 'skill', skill: 'deep-research-pro', input: 'depth=market' },
      { type: 'skill', skill: 'consulting-analysis', input: 'mode=market' },
      { type: 'skill', skill: 'chart-visualization', input: 'type=trend' },
      { type: 'skill', skill: 'pptx-generator', input: 'style=market_report' }
    ],
    params: {
      industry: { type: 'string', required: true, description: '行业领域' },
      region: { type: 'string', default: 'china', description: '市场区域' }
    }
  },

  'project_proposal': {
    id: 'project_proposal',
    name: '项目方案',
    description: '生成项目方案文档',
    category: 'document',
    keywords: ['项目方案', '方案书', '立项', 'proposal', '项目计划', '方案设计'],
    steps: [
      { type: 'skill', skill: 'deep-research', input: 'depth=project_context' },
      { type: 'skill', skill: 'consulting-analysis', input: 'mode=feasibility' },
      { type: 'skill', skill: 'pptx-generator', input: 'style=proposal' }
    ],
    params: {
      project_name: { type: 'string', required: true, description: '项目名称' },
      project_type: { type: 'string', default: 'general', description: '项目类型' }
    }
  },

  'data_pipeline': {
    id: 'data_pipeline',
    name: '数据处理流水线',
    description: '多步骤数据采集、清洗、分析和输出',
    category: 'analysis',
    keywords: ['数据处理', '数据流水线', '数据清洗', 'data pipeline', 'ETL', '数据整理'],
    steps: [
      { type: 'skill', skill: 'excel-xlsx', input: 'action=extract' },
      { type: 'skill', skill: 'data-analysis', input: 'action=clean_and_transform' },
      { type: 'skill', skill: 'chart-visualization', input: 'type=auto' },
      { type: 'skill', skill: 'pdf-generator', input: 'format=data_report' }
    ],
    params: {
      source: { type: 'string', required: true, description: '数据来源' },
      output_format: { type: 'string', default: 'pdf', description: '输出格式' }
    }
  },

  'daily_briefing': {
    id: 'daily_briefing',
    name: '每日简报',
    description: '自动汇总每日信息并推送简报',
    category: 'communication',
    keywords: ['每日简报', '早报', '简报', 'daily briefing', '每日推送', '信息汇总'],
    steps: [
      { type: 'skill', skill: 'multi-search-engine', input: 'mode=news' },
      { type: 'skill', skill: 'summarize-pro', input: 'action=briefing' },
      { type: 'skill', skill: 'wecom-daily-news', input: 'mode=briefing' }
    ],
    params: {
      topics: { type: 'string', default: 'tech,business', description: '关注主题' },
      channel: { type: 'string', default: 'wecom', description: '推送渠道' }
    }
  },

  'code_review': {
    id: 'code_review',
    name: '代码审查',
    description: '代码质量审查与优化建议',
    category: 'development',
    keywords: ['代码审查', '代码review', 'code review', '代码质量', '代码优化'],
    steps: [
      { type: 'skill', skill: 'prompt-engineering-expert', input: 'task=code_review' },
      { type: 'skill', skill: 'deep-research', input: 'depth=best_practices' }
    ],
    params: {
      language: { type: 'string', default: 'auto', description: '编程语言' },
      focus: { type: 'string', default: 'quality', description: '审查重点' }
    }
  },

  'investment_brief': {
    id: 'investment_brief',
    name: '投资简报',
    description: '投资组合分析与市场动态',
    category: 'analysis',
    keywords: ['投资简报', '投资组合', '投资分析', 'investment brief', '持仓分析', '资产配置'],
    steps: [
      { type: 'skill', skill: 'stock-analyst-enhanced', input: 'action=portfolio' },
      { type: 'skill', skill: 'financial-analyst', input: 'action=risk_assessment' },
      { type: 'skill', skill: 'chart-visualization', input: 'type=portfolio' },
      { type: 'skill', skill: 'wecom-daily-news', input: 'mode=investment_brief' }
    ],
    params: {
      portfolio: { type: 'string', required: true, description: '投资组合' },
      period: { type: 'string', default: 'daily', description: '分析周期' }
    }
  },
  'batch_process': {
    id: 'batch_process',
    name: '批量处理',
    description: '循环处理多条数据并汇总结果',
    category: 'automation',
    keywords: ['批量处理', '批量', '循环处理', 'batch process', '批量操作', '遍历', '逐个处理'],
    steps: [
      {
        type: 'loop',
        maxIterations: 50,
        breakCondition: { type: 'simple', field: '_loopIteration', operator: 'gte', value: 50 },
        actions: [
          { type: 'skill', skill: 'data-analysis', input: 'action=process_item' },
          { type: 'skill', skill: 'summarize-pro', input: 'action=merge' }
        ]
      }
    ],
    params: {
      items: { type: 'string', required: true, description: '待处理数据项' },
      batch_size: { type: 'number', default: 10, description: '每批处理数量' }
    }
  },

  'conditional_approval': {
    id: 'conditional_approval',
    name: '条件审批流程',
    description: '根据条件动态选择审批路径',
    category: 'automation',
    keywords: ['条件审批', '审批流', '条件判断', 'conditional approval', '审批分支', '多级审批'],
    steps: [
      {
        type: 'condition',
        condition: { type: 'simple', field: 'input.amount', operator: 'gt', value: 10000 },
        thenActions: [
          { type: 'skill', skill: 'wecom-daily-news', input: 'mode=approval_manager' },
          { type: 'skill', skill: 'summarize-pro', input: 'action=audit_log' }
        ],
        elseActions: [
          { type: 'skill', skill: 'wecom-daily-news', input: 'mode=approval_auto' }
        ]
      }
    ],
    params: {
      amount: { type: 'number', required: true, description: '审批金额' },
      applicant: { type: 'string', required: true, description: '申请人' }
    }
  },

  // ══════ 浏览器数据源工作流模板 ══════

  'product_sourcing': {
    id: 'product_sourcing',
    name: '商品找品比价',
    description: '在电商平台搜索商品并生成比价分析',
    category: 'research',
    keywords: ['找品', '找货', '货源', '比价', 'sourcing', '供应商', '采购', '帮我找', '搜商品', '哪里买', '多少钱'],
    steps: [
      { type: 'skill', skill: 'browser-extract', input: 'data_source=auto,query={keyword},action=search_and_extract' },
      { type: 'skill', skill: 'data-analysis', input: 'action=price_sort_and_filter' },
      { type: 'skill', skill: 'summarize-pro', input: 'action=product_recommendation' },
    ],
    params: {
      keyword: { type: 'string', required: true, description: '搜索关键词' },
      max_price: { type: 'number', default: 0, description: '最高价格限制(0=不限)' },
      platforms: { type: 'string', default: '1688', description: '搜索平台(逗号分隔)' },
      max_results: { type: 'number', default: 20, description: '最大结果数' },
    }
  },

  'academic_review': {
    id: 'academic_review',
    name: '学术文献综述',
    description: '多源搜索学术论文并生成文献综述',
    category: 'research',
    keywords: ['文献综述', '论文搜索', 'literature review', '学术调研', '论文综述', '研究现状', '文献调研', '论文汇总'],
    steps: [
      {
        type: 'parallel',
        branches: [
          { type: 'skill', skill: 'browser-extract', input: 'data_source=arxiv,query={topic},maxPages=3' },
          { type: 'skill', skill: 'browser-extract', input: 'data_source=semantic_scholar,query={topic}' },
          { type: 'skill', skill: 'browser-extract', input: 'data_source=pubmed,query={topic}' },
        ]
      },
      { type: 'skill', skill: 'deep-research-pro', input: 'depth=academic,action=synthesize' },
      { type: 'skill', skill: 'summarize-pro', input: 'action=literature_review' },
      { type: 'skill', skill: 'pdf-generator', input: 'format=academic_report' },
    ],
    params: {
      topic: { type: 'string', required: true, description: '研究主题' },
      max_papers: { type: 'number', default: 50, description: '最大论文数量' },
      year_range: { type: 'string', default: '2024-2026', description: '年份范围' },
    }
  },

  'trend_monitor': {
    id: 'trend_monitor',
    name: '热点趋势监控',
    description: '监控多平台热点并生成趋势简报',
    category: 'research',
    keywords: ['热点', '热搜', '热榜', 'trending', '时事', '动态', '今天热点', '最新趋势', '热门话题'],
    steps: [
      {
        type: 'parallel',
        branches: [
          { type: 'skill', skill: 'browser-extract', input: 'data_source=douyin,mode=hotspot' },
          { type: 'skill', skill: 'browser-extract', input: 'data_source=weibo_hot,mode=hotspot' },
          { type: 'skill', skill: 'browser-extract', input: 'data_source=zhihu_hot,mode=hotspot' },
          { type: 'skill', skill: 'browser-extract', input: 'data_source=baidu_hot,mode=hotspot' },
        ]
      },
      { type: 'skill', skill: 'summarize-pro', input: 'action=trend_briefing' },
      { type: 'skill', skill: 'chart-visualization', input: 'type=trend_radar' },
      { type: 'approval', input: 'message=今日热点简报已生成，是否推送到飞书/企微？', timeout: 1800000 },
      { type: 'skill', skill: 'wecom-daily-news', input: 'mode=trend_briefing' },
    ],
    params: {
      platforms: { type: 'string', default: 'douyin,weibo,zhihu,baidu', description: '监控平台' },
      category: { type: 'string', default: 'all', description: '热点分类' },
    }
  },

  'competitor_monitor': {
    id: 'competitor_monitor',
    name: '竞品监控分析',
    description: '监控竞品网站变化并生成分析报告',
    category: 'research',
    keywords: ['竞品', '竞品分析', '竞品监控', 'competitor', '对手', '对标', '行业对比', '市场格局'],
    steps: [
      {
        type: 'parallel',
        branches: [
          { type: 'skill', skill: 'browser-extract', input: 'data_source=auto,urls={target_urls},mode=snapshot' },
          { type: 'skill', skill: 'web-diff-analyzer', input: 'mode=change_detection' },
        ]
      },
      { type: 'skill', skill: 'consulting-analysis', input: 'mode=competitive' },
      { type: 'skill', skill: 'chart-visualization', input: 'type=competitive_matrix' },
      { type: 'skill', skill: 'pdf-generator', input: 'format=competitor_report' },
    ],
    params: {
      target_urls: { type: 'string', required: true, description: '竞品网站URL列表' },
      competitors: { type: 'string', required: true, description: '竞品名称列表' },
      monitor_type: { type: 'string', default: 'pricing,features,content', description: '监控维度' },
    }
  },

  'price_comparison': {
    id: 'price_comparison',
    name: '多平台价格对比',
    description: '在多个电商平台搜索同一商品进行价格对比',
    category: 'research',
    keywords: ['价格对比', '比价', '哪个平台便宜', '最低价', '全网比价', 'price comparison', '哪里便宜'],
    steps: [
      {
        type: 'parallel',
        branches: [
          { type: 'skill', skill: 'browser-extract', input: 'data_source=1688,query={product},action=search_and_extract' },
          { type: 'skill', skill: 'browser-extract', input: 'data_source=taobao,query={product},action=search_and_extract' },
          { type: 'skill', skill: 'browser-extract', input: 'data_source=jd,query={product},action=search_and_extract' },
          { type: 'skill', skill: 'browser-extract', input: 'data_source=pinduoduo,query={product},action=search_and_extract' },
        ]
      },
      { type: 'skill', skill: 'data-analysis', input: 'action=price_comparison' },
      { type: 'skill', skill: 'chart-visualization', input: 'type=price_bar_chart' },
      { type: 'skill', skill: 'summarize-pro', input: 'action=best_deal_recommendation' },
    ],
    params: {
      product: { type: 'string', required: true, description: '商品名称' },
      platforms: { type: 'string', default: '1688,taobao,jd,pinduoduo', description: '对比平台' },
    }
  },

  'daily_briefing_enhanced': {
    id: 'daily_briefing_enhanced',
    name: '每日综合简报(增强版)',
    description: '综合新闻+热榜+行业动态生成每日简报',
    category: 'communication',
    keywords: ['每日简报', '早报', '今日简报', '每日汇总', '综合简报', '今日动态', 'daily briefing'],
    steps: [
      {
        type: 'parallel',
        branches: [
          { type: 'skill', skill: 'browser-extract', input: 'data_source=36kr,mode=latest,limit=10' },
          { type: 'skill', skill: 'browser-extract', input: 'data_source=huxiu,mode=latest,limit=10' },
          { type: 'skill', skill: 'browser-extract', input: 'data_source=weibo_hot,mode=hotspot' },
          { type: 'skill', skill: 'browser-extract', input: 'data_source=zhihu_hot,mode=hotspot' },
        ]
      },
      { type: 'skill', skill: 'summarize-pro', input: 'action=daily_briefing' },
      { type: 'skill', skill: 'chart-visualization', input: 'type=news_timeline' },
      { type: 'approval', input: 'message=今日综合简报已生成，是否推送？', timeout: 1800000 },
      { type: 'skill', skill: 'wecom-daily-news', input: 'mode=daily_briefing_enhanced' },
    ],
    params: {
      topics: { type: 'string', default: 'tech,business,finance', description: '关注主题' },
      channel: { type: 'string', default: 'wecom', description: '推送渠道' },
    }
  },

  // ── OpenHuman 启发的流水线模板（含质量门禁） ──
  // 用户说"开发个新功能/修Bug"时，自动匹配这些模板

  'pipeline_feature': {
    id: 'pipeline_feature',
    name: '功能开发流水线',
    description: '完整的软件功能开发流程：需求分析→架构规划→实现→测试→验证，含质量门禁',
    category: 'development',
    keywords: ['开发流水线', '功能开发', '新功能', 'feature', 'pipeline', 'feature pipeline', '开发新功能'],
    steps: [
      { type: 'sub_agent', agent: 'planner', input: '分析需求并制定实现方案' },
      { type: 'gate', condition: 'plan_approved', description: '架构方案审查通过' },
      { type: 'sub_agent', agent: 'code_executor', input: '按实现方案编写代码' },
      { type: 'sub_agent', agent: 'critic', input: '审查代码质量、安全性和性能' },
      { type: 'gate', condition: 'code_quality_pass', description: '代码质量门禁——审查通过' },
      { type: 'skill', skill: 'exec', input: 'npm test' },
      { type: 'gate', condition: 'tests_pass', description: '测试门禁——全部通过' },
    ],
    params: {
      feature_description: { type: 'string', required: true, description: '功能描述' },
      priority: { type: 'string', default: 'medium', enum: ['high', 'medium', 'low'], description: '优先级' },
      requires_ui: { type: 'boolean', default: false, description: '是否需要 UI 设计' },
    },
    qualityGates: [
      { name: '架构评审', step: 1, check: 'plan_approved', description: '实现方案需经过架构师确认' },
      { name: '代码审查', step: 3, check: 'code_quality_pass', description: '代码需通过 critic 审查' },
      { name: '测试通过', step: 5, check: 'tests_pass', description: '全部测试必须通过' },
    ]
  },

  'pipeline_bugfix': {
    id: 'pipeline_bugfix',
    name: 'Bug 修复流水线',
    description: '标准 Bug 修复流程：问题分析→根因定位→修复实现→回归测试→验证',
    category: 'development',
    keywords: ['修复Bug', '修bug', '修Bug', 'bug修复', 'bug fix', 'bugfix', '问题修复', 'fix bug'],
    steps: [
      { type: 'sub_agent', agent: 'planner', input: '分析 Bug 症状，定位根因' },
      { type: 'gate', condition: 'root_cause_found', description: '根因定位确认' },
      { type: 'sub_agent', agent: 'code_executor', input: '实现修复代码' },
      { type: 'sub_agent', agent: 'critic', input: '审查修复方案是否有副作用' },
      { type: 'skill', skill: 'exec', input: 'npm test' },
      { type: 'gate', condition: 'fix_confirmed', description: '修复 + 回归测试验证通过' },
    ],
    params: {
      bug_description: { type: 'string', required: true, description: 'Bug 描述（含复现步骤）' },
      severity: { type: 'string', default: 'medium', enum: ['critical', 'high', 'medium', 'low'], description: '严重程度' },
    },
    qualityGates: [
      { name: '根因确认', step: 1, check: 'root_cause_found', description: '确认已找到根因而非只解决了表面症状' },
      { name: '副作用审查', step: 3, check: 'code_quality_pass', description: '修复不引入新的问题' },
      { name: '回归测试', step: 5, check: 'fix_confirmed', description: 'Bug 已修复且不破坏现有功能' },
    ]
  },

  'pipeline_design': {
    id: 'pipeline_design',
    name: '设计系统流水线',
    description: 'UI/UX 设计系统流程：设计研究→组件规范→实现→设计QA→文档',
    category: 'development',
    keywords: ['设计系统', 'design system', 'UI设计', '组件设计', '设计规范', 'design'],
    steps: [
      { type: 'sub_agent', agent: 'planner', input: '分析设计需求，制定组件规范' },
      { type: 'gate', condition: 'spec_approved', description: '设计规范评审通过' },
      { type: 'sub_agent', agent: 'code_executor', input: '实现设计稿和组件' },
      { type: 'gate', condition: 'ui_review_pass', description: 'UI 还原度审查通过' },
    ],
    params: {
      design_description: { type: 'string', required: true, description: '设计需求描述' },
      platform: { type: 'string', default: 'web', enum: ['web', 'mobile', 'desktop'], description: '目标平台' },
    },
    qualityGates: [
      { name: '规范评审', step: 1, check: 'spec_approved', description: '设计规范和技术方案需通过评审' },
      { name: 'UI 审查', step: 3, check: 'ui_review_pass', description: '实现效果与设计稿一致' },
    ]
  },

  'pipeline_refactoring': {
    id: 'pipeline_refactoring',
    name: '重构流水线',
    description: '代码重构流程：分析→计划→实现→验证→性能验证',
    category: 'development',
    keywords: ['重构', 'refactor', 'refactoring', '代码重构', '优化代码', 'code cleanup'],
    steps: [
      { type: 'sub_agent', agent: 'planner', input: '分析代码质量问题和重构范围' },
      { type: 'gate', condition: 'refactor_plan_approved', description: '重构方案评审通过' },
      { type: 'sub_agent', agent: 'code_executor', input: '执行代码重构' },
      { type: 'skill', skill: 'exec', input: 'npm test' },
      { type: 'gate', condition: 'tests_still_pass', description: '重构后测试全部通过' },
      { type: 'sub_agent', agent: 'critic', input: '验证重构效果——代码质量/性能/可维护性' },
    ],
    params: {
      scope: { type: 'string', required: true, description: '重构范围描述' },
      motivation: { type: 'string', default: 'improve_maintainability', description: '重构动机' },
    },
    qualityGates: [
      { name: '方案评审', step: 1, check: 'refactor_plan_approved', description: '重构范围和方案合理' },
      { name: '不破坏功能', step: 3, check: 'tests_still_pass', description: '重构后所有存量测试通过' },
      { name: '效果验证', step: 5, check: 'improvement_confirmed', description: '重构确实提升了代码质量' },
    ]
  },
};

const CATEGORY_LABELS = {
  report: '报告生成',
  communication: '消息通信',
  analysis: '数据分析',
  research: '研究调研',
  document: '文档处理',
  content: '内容创作',
  system: '系统运维',
  automation: '自动化',
  development: '开发设计',
  information: '信息查询',
  calendar: '日程管理'
};

const EXPERT_ROLES = {
  'data_analyst': {
    id: 'data_analyst',
    name: '数据分析师',
    description: '擅长数据挖掘、统计分析和可视化',
    emoji: '📊',
    category: 'analysis',
    keywords: ['数据分析', '统计', '数据挖掘', 'data analyst', '数据分析师', '数据报告'],
    systemPrompt: '你是一位专业的数据分析师，擅长从数据中发现洞察、进行统计分析并生成可视化报告。',
    preferredSkills: ['data-analysis', 'chart-visualization', 'financial-analyst', 'excel-xlsx'],
    templateIds: ['data_analysis', 'financial_analysis', 'stock_analysis']
  },

  'researcher': {
    id: 'researcher',
    name: '研究专家',
    description: '擅长深度研究和信息整合',
    emoji: '🔬',
    category: 'research',
    keywords: ['研究', '调研', '深度分析', 'researcher', '研究专家', '行业分析'],
    systemPrompt: '你是一位资深研究专家，擅长系统化的深度研究、多角度分析和信息整合。',
    preferredSkills: ['deep-research', 'deep-research-pro', 'multi-search-engine', 'consulting-analysis'],
    templateIds: ['deep_research', 'deep_research_pro', 'web_search']
  },

  'content_writer': {
    id: 'content_writer',
    name: '内容创作者',
    description: '擅长各类文案写作和内容创作',
    emoji: '✍️',
    category: 'content',
    keywords: ['写作', '文案', '内容创作', 'writer', '内容创作者', '写文章'],
    systemPrompt: '你是一位专业的内容创作者，擅长撰写各类文案、文章和创意内容。',
    preferredSkills: ['prompt-engineering-expert', 'summarize-pro', 'deep-research'],
    templateIds: ['content_writing', 'prompt_engineering', 'summarize']
  },

  'document_expert': {
    id: 'document_expert',
    name: '文档专家',
    description: '擅长文档生成、转换和处理',
    emoji: '📄',
    category: 'document',
    keywords: ['文档', 'PDF', 'PPT', 'Excel', 'document expert', '文档专家'],
    systemPrompt: '你是一位文档处理专家，擅长生成、转换和优化各类文档格式。',
    preferredSkills: ['pdf-generator', 'pdf-smart-tool-cn', 'pptx-generator', 'excel-xlsx', 'markdown-converter'],
    templateIds: ['ppt_creation', 'pdf_generation', 'pdf_smart_tool', 'excel_processing', 'markdown_convert']
  },

  'financial_analyst': {
    id: 'financial_analyst',
    name: '财务分析师',
    description: '擅长财务数据分析和投资建议',
    emoji: '💰',
    category: 'analysis',
    keywords: ['财务', '投资', '股票', 'financial analyst', '财务分析师', '金融'],
    systemPrompt: '你是一位专业的财务分析师，擅长财务报表分析、投资评估和市场趋势预测。',
    preferredSkills: ['financial-analyst', 'stock-analyst-enhanced', 'flashclaw-stock', 'chart-visualization'],
    templateIds: ['financial_analysis', 'stock_analysis']
  },

  'automation_expert': {
    id: 'automation_expert',
    name: '自动化专家',
    description: '擅长流程自动化和系统集成',
    emoji: '🤖',
    category: 'automation',
    keywords: ['自动化', '流程', '集成', 'automation', '自动化专家', '工作流'],
    systemPrompt: '你是一位自动化专家，擅长设计自动化流程、系统集成和效率优化。',
    preferredSkills: ['desktop-control', 'workflow-designer', 'agent-team-orchestration'],
    templateIds: ['desktop_automation', 'workflow_design', 'team_orchestration']
  },

  'system_admin': {
    id: 'system_admin',
    name: '系统管理员',
    description: '擅长系统运维和监控',
    emoji: '🖥️',
    category: 'system',
    keywords: ['系统', '运维', '监控', 'admin', '系统管理员', '运维工程师'],
    systemPrompt: '你是一位系统管理员，擅长系统运维、健康检查和故障排除。',
    preferredSkills: ['healthcheck', 'system-info', 'desktop-control'],
    templateIds: ['system_health', 'monitor_alert']
  },

  'frontend_designer': {
    id: 'frontend_designer',
    name: '前端设计师',
    description: '擅长UI/UX设计和前端开发',
    emoji: '🎨',
    category: 'development',
    keywords: ['前端', 'UI', '设计', 'frontend', '前端设计师', '网页设计'],
    systemPrompt: '你是一位前端设计师，擅长UI/UX设计、交互设计和前端页面开发。',
    preferredSkills: ['frontend-design-ultimate', 'deep-research'],
    templateIds: ['frontend_design']
  },

  'product_manager': {
    id: 'product_manager',
    name: '产品经理',
    description: '擅长产品规划、需求分析和竞品研究',
    emoji: '📋',
    category: 'research',
    keywords: ['产品', '需求', '产品经理', 'product manager', '竞品', 'PRD', '产品规划'],
    systemPrompt: '你是一位资深产品经理，擅长产品规划、需求分析、竞品研究和用户洞察。',
    preferredSkills: ['deep-research-pro', 'consulting-analysis', 'chart-visualization', 'pptx-generator'],
    templateIds: ['competitive_analysis', 'market_research', 'project_proposal', 'product_sourcing', 'price_comparison', 'competitor_monitor']
  },

  'consultant': {
    id: 'consultant',
    name: '咨询顾问',
    description: '擅长战略咨询和商业分析',
    emoji: '💼',
    category: 'research',
    keywords: ['咨询', '顾问', '战略', 'consultant', '咨询顾问', '商业分析', '战略规划'],
    systemPrompt: '你是一位资深咨询顾问，擅长战略分析、商业建模和决策支持。',
    preferredSkills: ['consulting-analysis', 'deep-research-pro', 'financial-analyst', 'pdf-generator'],
    templateIds: ['market_research', 'competitive_analysis', 'financial_analysis', 'academic_review', 'trend_monitor']
  },

  'project_manager': {
    id: 'project_manager',
    name: '项目经理',
    description: '擅长项目管理和进度跟踪',
    emoji: '📅',
    category: 'system',
    keywords: ['项目管理', '进度', '里程碑', 'project manager', '项目经理', '项目规划'],
    systemPrompt: '你是一位经验丰富的项目经理，擅长项目规划、进度管理和风险控制。',
    preferredSkills: ['healthcheck', 'wecom-daily-news', 'system-info'],
    templateIds: ['project_proposal', 'daily_briefing', 'monitor_alert', 'daily_briefing_enhanced']
  },

  'data_engineer': {
    id: 'data_engineer',
    name: '数据工程师',
    description: '擅长数据管道和ETL流程设计',
    emoji: '🔧',
    category: 'analysis',
    keywords: ['数据工程', 'ETL', '数据管道', 'data engineer', '数据工程师', '数据清洗'],
    systemPrompt: '你是一位数据工程师，擅长数据管道设计、ETL流程和数据质量管理。',
    preferredSkills: ['excel-xlsx', 'data-analysis', 'chart-visualization', 'pdf-generator'],
    templateIds: ['data_pipeline', 'data_analysis', 'financial_analysis']
  },

};

class WorkflowTemplateEngine {
  constructor() {
    this.templates = new Map();
    this.expertRoles = new Map();
    this._registerDefaultTemplates();
    this._registerDefaultExperts();
  }

  _registerDefaultTemplates() {
    for (const [id, template] of Object.entries(WORKFLOW_TEMPLATES)) {
      this.templates.set(id, template);
    }
  }

  _registerDefaultExperts() {
    for (const [id, expert] of Object.entries(EXPERT_ROLES)) {
      this.expertRoles.set(id, expert);
    }
  }

  registerTemplate(template) {
    if (!template || !template.id) {
      throw new Error('模板必须包含 id');
    }
    this.templates.set(template.id, template);
    return template;
  }

  registerExpertRole(expert) {
    if (!expert || !expert.id) {
      throw new Error('专家角色必须包含 id');
    }
    this.expertRoles.set(expert.id, expert);
    return expert;
  }

  getTemplate(templateId) {
    return this.templates.get(templateId);
  }

  getExpertRole(expertId) {
    return this.expertRoles.get(expertId);
  }

  listTemplates(category) {
    const templates = Array.from(this.templates.values());
    if (category) {
      return templates.filter(t => t.category === category);
    }
    return templates;
  }

  listExpertRoles(category) {
    const experts = Array.from(this.expertRoles.values());
    if (category) {
      return experts.filter(e => e.category === category);
    }
    return experts;
  }

  matchTemplate(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') {
      return null;
    }

    const message = userMessage.toLowerCase();
    const scoredMatches = [];

    for (const template of this.templates.values()) {
      const score = this._calculateMatchScore(message, template);
      if (score >= 0.15) {
        scoredMatches.push({ template, score });
      }
    }

    scoredMatches.sort((a, b) => b.score - a.score);

    if (scoredMatches.length > 0 && scoredMatches[0].score >= 0.2) {
      const best = scoredMatches[0];
      return {
        template: best.template,
        score: best.score,
        params: this._extractParams(message, best.template),
        alternatives: scoredMatches.slice(1, 3).map(m => ({
          template: m.template,
          score: m.score
        }))
      };
    }

    return null;
  }

  matchExpertRole(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') {
      return null;
    }

    const message = userMessage.toLowerCase();
    const scoredExperts = [];

    for (const expert of this.expertRoles.values()) {
      const score = this._calculateExpertScore(message, expert);
      if (score >= 0.2) {
        scoredExperts.push({ expert, score });
      }
    }

    // 降级：尝试 Expert Panel 的内置专家人格
    if (scoredExperts.length === 0) {
      try {
        const expertModule = require('../core/experts');
        const panelExperts = expertModule.getAllExperts().filter(e => e.builtin && e.routingKeywords && e.routingKeywords.length > 0);
        for (const pe of panelExperts) {
          const mapped = { ...pe, keywords: pe.routingKeywords, emoji: pe.icon };
          const score = this._calculateExpertScore(message, mapped);
          if (score >= 0.2) {
            scoredExperts.push({ expert: mapped, score });
          }
        }
      } catch (e) {
        /* Expert Panel 不可用时降级 */
        console.warn('[workflow-template-engine.js] 空 catch 补日志:', e && e.message);
      }

    }

    scoredExperts.sort((a, b) => b.score - a.score);

    if (scoredExperts.length > 0) {
      return {
        expert: scoredExperts[0].expert,
        score: scoredExperts[0].score,
        alternatives: scoredExperts.slice(1, 3).map(e => ({
          expert: e.expert,
          score: e.score
        }))
      };
    }

    return null;
  }

  _calculateMatchScore(message, template) {
    let score = 0;
    let matched = 0;
    let totalWeight = 0;
    let matchedKeywords = 0;

    for (const keyword of template.keywords) {
      const isCore = keyword.length >= 2 && !/^(the|a|an|of|in|on|at|to|for|and|or|is|are)$/i.test(keyword);
      const weight = isCore ? (keyword.length >= 4 ? 2.0 : 1.5) : 0.5;
      totalWeight += weight;
      if (message.includes(keyword.toLowerCase())) {
        matched += weight;
        matchedKeywords++;
      }
    }

    if (matched > 0 && totalWeight > 0) {
      score = matched / totalWeight;
    }

    if (matchedKeywords >= 2) {
      score *= 1.0 + (matchedKeywords - 1) * 0.3;
    }

    if (template.name && message.includes(template.name.toLowerCase())) {
      score += 0.3;
    }

    for (const keyword of template.keywords) {
      if (keyword.length >= 2 && message.includes(keyword.toLowerCase())) {
        score += 0.08;
        break;
      }
    }

    return Math.min(score, 1.0);
  }

  _calculateExpertScore(message, expert) {
    let score = 0;
    let matched = 0;
    let matchedKeywords = 0;

    for (const keyword of expert.keywords) {
      if (message.includes(keyword.toLowerCase())) {
        matched++;
        matchedKeywords++;
      }
    }

    if (matched > 0) {
      score = matched / expert.keywords.length;
    }

    if (matchedKeywords >= 2) {
      score *= 1.0 + (matchedKeywords - 1) * 0.25;
    }

    if (expert.name && message.includes(expert.name.toLowerCase())) {
      score += 0.35;
    }

    return Math.min(score, 1.0);
  }

  _extractParams(message, template) {
    const params = {};

    if (!template.params) {
      return params;
    }

    for (const [key, config] of Object.entries(template.params)) {
      const patterns = [
        new RegExp(`${escapeRegExp(key)}[是为：:]=?\\s*([^,，\\s]+)`, 'i'),
        new RegExp(`${escapeRegExp(key)}[是为：:]\\s*(.+?)(?:[,，]|$)`, 'i')
      ];

      for (const pattern of patterns) {
        const match = message.match(pattern);
        if (match) {
          params[key] = match[1].trim();
          break;
        }
      }

      if (!params[key] && config.default) {
        params[key] = config.default;
      }
    }

    return params;
  }

  buildTaskFlowGoal(template, params = {}) {
    if (!template || !template.steps) {
      return '';
    }

    const steps = template.steps.map((step) => {
      let input = step.input || '';

      for (const [key, value] of Object.entries(params)) {
        input = input.replace(new RegExp(`\\$\\{${escapeRegExp(key)}\\}`, 'g'), value);
      }

      switch (step.type) {
        case 'skill':
          return `skill:${step.skill}(${input})`;
        case 'task':
          return `task:${step.taskId}(${input})`;
        case 'condition':
          return `condition:${step.condition}`;
        case 'delay':
          return `delay:${step.duration || 1000}`;
        case 'approval':
          return `approval:${step.approver || 'user'}`;
        case 'sub_agent':
        case 'agent':
          return `sub_agent:${step.agent}(${input})`;
        default:
          return `${step.type}:${step.skill || step.taskId || 'unknown'}`;
      }
    });

    return steps.join('\n');
  }

  createFlowFromTemplate(templateId, params = {}) {
    const template = this.templates.get(templateId);
    if (!template) {
      throw new Error(`模板不存在: ${templateId}`);
    }

    const goal = this.buildTaskFlowGoal(template, params);

    return {
      goal,
      syncMode: 'managed',
      ownerKey: 'template-auto',
      notifyPolicy: 'on_failure',
      stateJson: { steps: template.steps },
      metadata: {
        templateId: template.id,
        templateName: template.name,
        templateCategory: template.category,
        generatedAt: Date.now(),
        params
      }
    };
  }

  createFlowFromExpert(expertId, userMessage) {
    const expert = this.expertRoles.get(expertId);
    if (!expert) {
      throw new Error(`专家角色不存在: ${expertId}`);
    }

    const templateMatch = this.matchTemplate(userMessage);
    let goal = '';
    let structuredSteps = null;

    if (templateMatch && expert.templateIds.includes(templateMatch.template.id)) {
      goal = this.buildTaskFlowGoal(templateMatch.template, templateMatch.params);
      structuredSteps = templateMatch.template.steps;
    } else if (expert.templateIds.length > 0) {
      const fallbackTemplateId = expert.templateIds[0];
      const fallbackTemplate = this.templates.get(fallbackTemplateId);
      if (fallbackTemplate) {
        goal = this.buildTaskFlowGoal(fallbackTemplate, {});
        structuredSteps = fallbackTemplate.steps;
      }
    } else {
      goal = expert.preferredSkills.map(s => `skill:${s}(input=auto)`).join('\n');
      structuredSteps = expert.preferredSkills.map(s => ({
        type: 'skill',
        skill: s,
        input: 'input=auto'
      }));
    }

    return {
      goal,
      syncMode: 'managed',
      ownerKey: 'expert-auto',
      notifyPolicy: 'on_failure',
      stateJson: structuredSteps ? { steps: structuredSteps } : null,
      metadata: {
        templateId: 'expert_' + expertId,
        templateName: expert.name,
        templateCategory: expert.category,
        expertId: expert.id,
        expertName: expert.name,
        systemPrompt: expert.systemPrompt,
        generatedAt: Date.now(),
        originalMessage: userMessage
      }
    };
  }

  generateFromDescription(description) {
    if (!description || typeof description !== 'string') {
      return null;
    }

    const templateMatch = this.matchTemplate(description);
    if (templateMatch && templateMatch.score >= 0.4) {
      return this.createFlowFromTemplate(templateMatch.template.id, templateMatch.params);
    }

    const expertMatch = this.matchExpertRole(description);
    if (expertMatch && expertMatch.score >= 0.4) {
      return this.createFlowFromExpert(expertMatch.expert.id, description);
    }

    return this._generateDynamicFlow(description);
  }

  _generateDynamicFlow(description) {
    const steps = [];
    // eslint-disable-next-line no-unused-vars -- toLowerCase() 结果未使用
    const desc = description.toLowerCase();

    const skillMapping = [
      { test: /获取|收集|抓取|读取|查询|fetch|get|read|query/i, skill: 'data-analysis', input: 'action=fetch' },
      { test: /分析|统计|计算|对比|analysis|analyze|calculate|compare/i, skill: 'data-analysis', input: 'action=analyze' },
      { test: /图表|可视化|chart|visualization|画图/i, skill: 'chart-visualization', input: 'type=auto' },
      { test: /搜索|查找|查询|search|find|查一下/i, skill: 'multi-search-engine', input: 'mode=standard' },
      { test: /研究|调研|深度|research|investigate/i, skill: 'deep-research', input: 'depth=standard' },
      { test: /报告|报表|文档|总结|report|document|summary/i, skill: 'pdf-generator', input: 'format=report' },
      { test: /PPT|演示|幻灯片|presentation|pptx/i, skill: 'pptx-generator', input: 'style=auto' },
      { test: /PDF|pdf/i, skill: 'pdf-smart-tool-cn', input: 'action=auto' },
      { test: /Excel|表格|xlsx/i, skill: 'excel-xlsx', input: 'action=auto' },
      { test: /发送|通知|提醒|推送|send|notify|alert|push/i, skill: 'wecom-daily-news', input: 'mode=notify' },
      { test: /天气|weather/i, skill: 'weather', input: 'mode=forecast' },
      { test: /股票|stock|投资/i, skill: 'stock-analyst-enhanced', input: 'action=analysis' },
      { test: /财务|financial/i, skill: 'financial-analyst', input: 'action=analysis' },
      { test: /写|创作|文章|write|content/i, skill: 'prompt-engineering-expert', input: 'task=writing' },
      { test: /摘要|总结|概括|summarize/i, skill: 'summarize-pro', input: 'action=summarize' },
      { test: /系统|检查|健康|system|health/i, skill: 'healthcheck', input: 'mode=full' },
      { test: /桌面|自动|desktop|automation/i, skill: 'desktop-control', input: 'mode=auto' },
      { test: /网页|浏览|browse|web/i, skill: 'agent-browser', input: 'mode=browse' }
    ];

    for (const mapping of skillMapping) {
      if (mapping.test.test(description)) {
        steps.push(`skill:${mapping.skill}(${mapping.input})`);
      }
    }

    if (steps.length === 0) {
      steps.push('skill:general_assistant(input=auto)');
    }

    return {
      goal: steps.join('\n'),
      syncMode: 'managed',
      ownerKey: 'dynamic-auto',
      notifyPolicy: 'on_failure',
      metadata: {
        templateId: 'dynamic',
        templateName: '动态生成',
        templateCategory: 'dynamic',
        generatedAt: Date.now(),
        originalDescription: description
      }
    };
  }

  validateTemplates(registeredSkills = []) {
    const skillSet = new Set(registeredSkills);
    const issues = [];

    for (const template of this.templates.values()) {
      if (!template.steps || !Array.isArray(template.steps)) continue;

      for (let i = 0; i < template.steps.length; i++) {
        const step = template.steps[i];
        if (step.type === 'skill' && step.skill) {
          if (skillSet.size > 0 && !skillSet.has(step.skill)) {
            issues.push({
              templateId: template.id,
              templateName: template.name,
              stepIndex: i,
              skill: step.skill,
              issue: 'skill_not_registered'
            });
          }
        }
      }
    }

    for (const expert of this.expertRoles.values()) {
      if (expert.preferredSkills) {
        for (const skill of expert.preferredSkills) {
          if (skillSet.size > 0 && !skillSet.has(skill)) {
            issues.push({
              expertId: expert.id,
              expertName: expert.name,
              skill,
              issue: 'expert_skill_not_registered'
            });
          }
        }
      }

      if (expert.templateIds) {
        for (const tid of expert.templateIds) {
          if (!this.templates.has(tid)) {
            issues.push({
              expertId: expert.id,
              expertName: expert.name,
              templateId: tid,
              issue: 'expert_template_not_found'
            });
          }
        }
      }
    }

    return {
      valid: issues.length === 0,
      issues,
      totalTemplates: this.templates.size,
      totalExperts: this.expertRoles.size
    };
  }
}

let templateEngine = null;

function getWorkflowTemplateEngine() {
  if (!templateEngine) {
    templateEngine = new WorkflowTemplateEngine();
  }
  return templateEngine;
}

module.exports = {
  WorkflowTemplateEngine,
  getWorkflowTemplateEngine,
  WORKFLOW_TEMPLATES,
  EXPERT_ROLES,
  CATEGORY_LABELS
};

