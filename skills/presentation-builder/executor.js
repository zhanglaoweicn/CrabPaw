/**
 * presentation-builder executor — 四阶段 PPT 生成引擎
 * 主题分析 → 风格推断 → 大纲生成 → 渲染指令
 */
var BT = String.fromCharCode(96);
var STYLE_RULES = [
  { p: /(?:商务|汇报|述职|方案|计划|战略|转型|年度|半年|季度|月报|周报|报告)/i, s: 'corporate-clean', c: 'solid', d: '商务汇报' },
  { p: /(?:科技|AI|人工智能|智能|数字化|互联网|技术|研发|创新|前沿|未来|机器人|算法|数据)/i, s: 'pitch-deck-vc', c: 'gradient', d: '科技主题' },
  { p: /(?:学术|论文|研究|发表|科研|实验|方法论|理论|综述|期刊|会议)/i, s: 'academic-paper', c: 'solid', d: '学术研究' },
  { p: /(?:金融|投资|融资|估值|IPO|上市|股价|财报|基金|理财|银行)/i, s: 'corporate-clean', c: 'gradient', d: '金融投资' },
  { p: /(?:教育|培训|课程|教学|学习|知识|科普|留学)/i, s: 'arctic-cool', c: 'solid', d: '教育培训' },
  { p: /(?:产品|发布|上线|版本|更新|迭代|功能|特性|路线图)/i, s: 'pitch-deck-vc', c: 'image', d: '产品发布' },
  { p: /(?:运营|营销|推广|品牌|市场|活动|增长|用户|流量|内容|社群|新媒体)/i, s: 'sunset-warm', c: 'gradient', d: '运营营销' },
  { p: /(?:政府|党建|政策|法规|制度|治理|政务|国企)/i, s: 'news-broadcast', c: 'solid', d: '政府汇报' },
  { p: /(?:设计|创意|艺术|美学|品牌|vi|ui|视觉|交互|体验)/i, s: 'editorial-serif', c: 'split', d: '设计创意' },
  { p: /(?:计划|规划|路线|愿景|目标|使命|战略)/i, s: 'corporate-clean', c: 'gradient', d: '战略规划' },
  { p: /(?:竞赛|比赛|路演|pitch|demo|展示|展会|发布)/i, s: 'aurora', c: 'image', d: '路演展示' },
  { p: /(?:健康|医疗|医药|养生|保健|健身|运动|营养|护理)/i, s: 'soft-pastel', c: 'gradient', d: '医疗健康' },
  { p: /(?:环保|绿色|可持续|能源|碳|生态|自然|气候)/i, s: 'terminal-green', c: 'image', d: '环保能源' },
  { p: /(?:发展|现状|趋势|行业|市场|调研|分析|报告|白皮书|蓝皮书)/i, s: 'corporate-clean', c: 'solid', d: '行业分析' },
  { p: /(?:小红书|种草|图文|xhs|博主|穿搭|美妆|探店)/i, s: 'xiaohongshu-white', c: 'split', d: '小红书图文' },
  { p: /(?:黑客|安全|渗透|漏洞|攻防|ctf|极客|terminal)/i, s: 'terminal-green', c: 'gradient', d: '安全极客' },
  { p: /(?:游戏|电竞|二次元|动漫|acg)/i, s: 'cyberpunk-neon', c: 'gradient', d: '游戏电竞' },
  { p: /(?:艺术|展览|画廊|美学|视觉|创意|摄影|电影|戏剧)/i, s: 'vaporwave', c: 'image', d: '艺术展览' },
];
var PAGE_COUNTS = { 'corporate-clean':10, 'pitch-deck-vc':9, 'academic-paper':12, 'arctic-cool':8, 'sunset-warm':8, 'soft-pastel':8, 'editorial-serif':8, 'aurora':7, 'xiaohongshu-white':8, 'terminal-green':8, 'tokyo-night':9, 'cyberpunk-neon':7 };
var TEMPLATES = {
  corporate: [{t:'title',l:'封面'},{t:'content',l:'目录'},{t:'content',l:'背景'},{t:'data',l:'核心数据',h:true},{t:'content',l:'方案'},{t:'data',l:'趋势',h:true},{t:'two_column',l:'对比'},{t:'diagram',l:'架构',g:true},{t:'content',l:'实施'},{t:'summary',l:'总结'}],
  modern: [{t:'title',l:'封面'},{t:'content',l:'背景'},{t:'data',l:'市场数据',h:true},{t:'content',l:'方案'},{t:'diagram',l:'架构',g:true},{t:'data',l:'效果',h:true},{t:'content',l:'优势'},{t:'two_column',l:'案例'},{t:'summary',l:'总结'}],
  classic: [{t:'title',l:'封面'},{t:'content',l:'目录'},{t:'content',l:'背景'},{t:'content',l:'文献'},{t:'data',l:'方法',h:true},{t:'data',l:'结果',h:true},{t:'table',l:'数据表'},{t:'diagram',l:'框架',g:true},{t:'content',l:'讨论'},{t:'content',l:'结论'},{t:'summary',l:'展望'}],
};

function analyzeTopic(q) {
  q = (q || '').toLowerCase();
  var m = null;
  for (var i = 0; i < STYLE_RULES.length; i++) { if (STYLE_RULES[i].p.test(q)) { m = STYLE_RULES[i]; break; } }
  var style = m ? m.s : 'pitch-deck-vc';
  var cover = m ? m.c : 'solid';
  var num = q.match(/(\d+)\s*(?:页|张|slide)/i);
  var count = Math.min(Math.max(num ? parseInt(num[1],10) : (PAGE_COUNTS[style]||9), 5), 20);
  var html = /(?:现场演讲|演讲|HTML|网页|keynote|slides|speaker|演示|浏览器|线上|web)/i.test(q);
  var pptx = /(?:PPTX|PowerPoint|发给|邮件|打印|客户|老板|下载|文件|office|WPS)/i.test(q);
  return { f: html ? 'html' : (pptx ? 'pptx' : 'auto'), s: style, c: cover, n: count, d: m ? m.d : '通用' };
}
function genOutline(a) {
  var t = TEMPLATES[a.s] || TEMPLATES.modern;
  var slides = t.map(function(s,i) { return { index:i+1, type:s.t, label:s.l, has_chart:!!s.h, has_diagram:!!s.g }; });
  for (var e = slides.length; e < a.n; e++) {
    slides.splice(Math.min(3, slides.length-1), 0, { index:0, type:'content', label:'主题阐述 '+(e+1), has_chart:false, has_diagram:false });
  }
  for (var j = 0; j < slides.length; j++) slides[j].index = j+1;
  return slides;
}
function buildInstr(topic, style, cover, outline, analysis, tool) {
  var L = [];
  L.push('## 四阶段 PPT 生成指令'); L.push('');
  L.push('主题: ' + topic); L.push('风格: ' + style); L.push('封面: ' + cover);
  L.push('页数: ' + outline.length); L.push('输出: ' + tool); L.push('');
  for (var i = 0; i < outline.length; i++) L.push('  '+(i+1)+'. ['+outline[i].type+'] '+outline[i].label);
  L.push(''); L.push('为每页生成内容，data页准备metrics，diagram页准备图片路径');
  L.push(''); L.push('完成后调用 ' + tool + '：');
  L.push(BT+BT+BT); L.push(tool+'({'); L.push('  style: "'+style+'",');
  if (tool === 'html-presentation') L.push('  topic: "'+topic.substring(0,40)+'",'), L.push('  slides: [...]');
  else L.push('  slides: [...],'), L.push('  coverTemplate: "'+cover+'"');
  L.push('})'); L.push(BT+BT+BT);
  return L.join('\n');
}

async function execute(input, options, params) {
  var topic = typeof input === 'string' ? input : (input && (input.topic||input.query||input.message)) || '';
  if (!topic) return { success:false, error:'请提供 PPT 主题' };
  var a = analyzeTopic(topic);
  var style = (options&&options.style)||(params&&params.style)||a.s;
  var cover = (options&&options.coverTemplate)||(params&&params.coverTemplate)||a.c;
  var slideCount = (options&&options.slideCount)||(params&&params.slideCount)||a.n;
  var outline = genOutline({s:style,n:slideCount});
  var tool = a.f === 'html' ? 'html-presentation' : 'pptx_generate';
  var instr = buildInstr(topic, style, cover, outline, a, tool);
  return {
    success:true, topic:topic, format:a.f,
    analysis:{ style:style, coverTemplate:cover, slideCount:outline.length, styleReason:a.d },
    outline:outline, instructions:instr,
    message:'已分析【'+topic+'】, '+style+', '+outline.length+' 页',
  };
}

module.exports = { execute, schema:{name:'presentation-builder',description:'智能PPT生成：主题分析+风格推断+大纲生成',capabilities:['document_generation','presentation']}, analyzeTopic, genOutline, STYLE_RULES };
