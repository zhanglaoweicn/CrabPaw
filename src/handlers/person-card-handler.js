/**
 * Person Card Handler — 人物卡片数据
 *
 * GET /api/person-card?name=某某
 * 内置常见人物库 + 可扩展的外部查询
 */

const PERSON_DB = [
  {
    name: 'Claude',
    alias: ['Claude AI', 'Anthropic Claude'],
    identity: 'Anthropic 公司开发的 AI 助手',
    summary: 'Claude 是 Anthropic 公司开发的基于大语言模型的 AI 助手系列。最新版本为 Claude Fable 5 / Mythos 5，具备强大的推理、代码、多模态和工具调用能力。Anthropic 由前 OpenAI 员工 Dario Amodei 和 Daniela Amodei 创立。',
    tags: ['AI助手', '大语言模型', 'Anthropic'],
    works: ['Claude Fable 5', 'Claude Opus 4.8', 'Claude Sonnet 4.6'],
  },
  {
    name: 'Volodymyr Zelenskyy',
    alias: ['泽连斯基', 'Zelensky'],
    identity: '乌克兰总统',
    summary: '弗拉基米尔·泽连斯基，乌克兰政治家、喜剧演员出身，2019年起担任乌克兰总统。在其任期内领导乌克兰抵御俄罗斯全面入侵，成为战时领导人。',
    tags: ['政治家', '乌克兰', '战时领导人'],
    nationality: '乌克兰',
  },
  {
    name: 'Elon Musk',
    alias: ['马斯克', '埃隆·马斯克'],
    identity: '企业家、工程师',
    summary: '埃隆·马斯克（Elon Musk），特斯拉CEO、SpaceX创始人、xAI创始人。领导开发了特斯拉电动汽车、SpaceX可回收火箭、Neuralink脑机接口等前沿技术。旗下AI公司xAI开发了Grok系列大模型。',
    tags: ['企业家', '特斯拉', 'SpaceX', 'xAI'],
    works: ['特斯拉', 'SpaceX猎鹰火箭', 'Starlink卫星网络', 'Grok AI'],
    nationality: '美国/南非',
  },
  {
    name: '梁文锋',
    alias: ['Wenfeng Liang', 'DeepSeek'],
    identity: '深度求索（DeepSeek）创始人',
    summary: '梁文锋，深度求索（DeepSeek）创始人兼CEO。领导开发了DeepSeek系列大语言模型，以高性价比和开源策略在AI行业产生重要影响。DeepSeek-V3和DeepSeek-R1在多项基准测试中达到国际领先水平。',
    tags: ['AI研究者', '企业家', 'DeepSeek'],
    works: ['DeepSeek-V3', 'DeepSeek-R1', 'DeepSeek-Coder'],
    nationality: '中国',
  },
  {
    name: 'Sam Altman',
    alias: ['山姆·奥特曼', 'Altman'],
    identity: 'OpenAI CEO',
    summary: '萨姆·奥特曼（Sam Altman），美国企业家、投资人。曾任Y Combinator总裁，2019年起担任OpenAI CEO。领导开发了GPT系列模型、ChatGPT、DALL-E等项目，推动了AI产业的快速发展。',
    tags: ['企业家', 'OpenAI', 'AI'],
    works: ['ChatGPT', 'GPT-4', 'Y Combinator'],
    nationality: '美国',
  },
]

function handlePersonCard(req, res, _pathname) {
  if (req.method !== 'GET') {
    res.writeHead(405); res.end(JSON.stringify({ success: false })); return true
  }
  const url = new URL(req.url, 'http://localhost')
  const name = decodeURIComponent((url.searchParams.get('name') || '').trim().toLowerCase())
  if (!name) {
    res.writeHead(400); res.end(JSON.stringify({ success: false, error: '缺少 name 参数' })); return true
  }

  // Search: exact match > alias match > partial match
  let match = PERSON_DB.find(p => p.name.toLowerCase() === name)
  if (!match) match = PERSON_DB.find(p => p.alias?.some(a => a.toLowerCase() === name))
  if (!match) match = PERSON_DB.find(p => p.name.toLowerCase().includes(name) || p.tags?.some(t => t.toLowerCase().includes(name)))

  if (match) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: true, data: match }))
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: true, data: null, knownNames: PERSON_DB.map(p => p.name) }))
  }
  return true
}

module.exports = { handlePersonCard }
