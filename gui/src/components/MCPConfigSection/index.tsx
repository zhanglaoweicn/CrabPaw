import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost } from '../../lib/api'
import { useConfirm } from '../useConfirm'
// 2026-08-27 A6: 状态点迁移 CockpitUI StatusBadge(connected=success/connecting=warn/error=danger/disabled=neutral)
import { StatusBadge } from '../CockpitUI'

interface MCPServer {
  name: string
  type: 'stdio' | 'http'
  // 2026-08-28 CK4: 补 'disconnected'(B6 传输层进程死亡)与 'disabled'(B1 幽灵配置合并入列)——
  // 后端实际下发全集, 此前类型缺项仅靠 statusTone/statusLabel 的 Record 运行时兜底
  status: 'connecting' | 'connected' | 'error' | 'disconnected' | 'disabled'
  error: string | null
  toolCount: number
  resourceCount: number
  promptCount: number
  config: {
    command?: string | null
    url?: string | null
    enabled: boolean
    tools: { include?: string[]; exclude?: string[]; prompts?: boolean; resources?: boolean }
    sampling: { enabled?: boolean; model?: string; maxTokensCap?: number; maxRpm?: number; timeout?: number }
  }
}

interface MCPTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/**
 * 2026-08-08(审计 P1): 错误串脱敏——MCP 连接错误常含端点 URL/stderr,
 * 直接 toast 原始串可能回显鉴权头片段。截断 + 剥离疑似凭据后展示。
 */
function sanitizeMcpError(msg: unknown): string {
  let s = String(msg ?? '未知错误').replace(/\s+/g, ' ').trim()
  s = s.replace(/(bearer\s+|authorization\s*[:=]\s*|api[_-]?key\s*[:=]\s*|token\s*[:=]\s*)[^\s,;]+/gi, '$1***')
  s = s.replace(/(https?:\/\/)[^/@\s]+@/gi, '$1***@')
  if (s.length > 160) s = s.slice(0, 160) + '…'
  return s || '未知错误'
}

interface AddServerForm {
  name: string
  type: 'stdio' | 'http'
  command: string
  args: string
  env: string
  url: string
  headers: string
  timeout: number
  connectTimeout: number
  enabled: boolean
}

interface MCPServicePreset {
  name: string
  provider: string
  description: string
  category: string
  icon: string
  type: 'stdio' | 'http'
  url?: string
  command?: string
  args?: string
  env?: string
  headersTemplate?: string
  notes: string[]
  needKey: boolean
  keyField?: string
}

const PRESET_SERVICES: MCPServicePreset[] = [
  {
    name: '企查查企业数据',
    provider: '企查查',
    description: '180 个原子能力：工商查询、风控大脑、司法诉讼、知产引擎、股权穿透、董高监画像。数据 T+0 更新。',
    category: '工商/风控',
    icon: '🏢',
    type: 'http',
    url: 'https://mcp.qichacha.com/mcp',
    headersTemplate: '{"Authorization": "Bearer YOUR_QICHACHA_API_KEY"}',
    notes: ['需在企查查开放平台注册获取 API Key', '覆盖工商、司法、知产、经营、风险五大数据维度', '适合尽调、准入审核、供应链风控'],
    needKey: true,
    keyField: 'YOUR_QICHACHA_API_KEY',
  },
  {
    name: '质数幻方企业数据',
    provider: '质数幻方',
    description: '企业精确匹配、工商信息、司法信息、风险信息（经营异常、失信、税收违法等）。限时免费。',
    category: '工商/风险',
    icon: '🔍',
    type: 'http',
    url: 'https://mcp.yidian.cn/mcp',
    headersTemplate: '{"Authorization": "Bearer YOUR_YIDIAN_API_KEY"}',
    notes: ['官网 mcp.yidian.cn 注册获取密钥', '限时免费中', '轻量级，适合快速对接'],
    needKey: true,
    keyField: 'YOUR_YIDIAN_API_KEY',
  },
  {
    name: '旷湖企业大数据',
    provider: '旷湖大数据',
    description: '16+ 数据子服务：企业基础信息、风险、专利、商标、海关、政策、电商等多维度查询。',
    category: '企业大数据',
    icon: '📊',
    type: 'http',
    url: 'https://api.kuanghu.com/mcp',
    headersTemplate: '{"Authorization": "Bearer YOUR_KUANGHU_API_KEY"}',
    notes: ['Token 鉴权', '覆盖企业基础信息、诉讼、专利、商标、海关数据', '支持 Streamable HTTP'],
    needKey: true,
    keyField: 'YOUR_KUANGHU_API_KEY',
  },
  {
    name: '启信宝企业查询',
    provider: '启信宝',
    description: '企业搜索、工商详情、综合风险信息、高管信息、诉讼统计。',
    category: '工商查询',
    icon: '📋',
    type: 'http',
    url: 'https://mcp.qixin.com/mcp',
    headersTemplate: '{"Authorization": "Bearer YOUR_QIXIN_API_KEY"}',
    notes: ['需注册启信宝开放平台', '支持企业模糊搜索、多维风险信息查询', '含高管详细信息与诉讼统计'],
    needKey: true,
    keyField: 'YOUR_QIXIN_API_KEY',
  },
  {
    name: 'Legal Knowledge 法律顾问',
    provider: '开源社区',
    description: '覆盖 8 个司法管辖区的法律查询：公司法、劳动法、税务合规、GDPR。开源免费。',
    category: '法律合规',
    icon: '⚖️',
    type: 'stdio',
    command: 'npx',
    args: '-y mcp-legal-advisor',
    notes: ['开源免费', '支持 EU/UK/FR/DE/IT/ES 等多法域', '适合公司设立合规、跨国劳动法查询'],
    needKey: false,
  },
  {
    name: '邓白氏企业信用',
    provider: '邓白氏',
    description: '企业全生命周期数据：工商、关联关系、经营风险、知识产权、企业评分。',
    category: '信用/风控',
    icon: '🌐',
    type: 'http',
    url: 'https://mcp.dnb.com.cn/mcp',
    headersTemplate: '{"Authorization": "Bearer YOUR_DNB_API_KEY"}',
    notes: ['需联系邓白氏获取 API 密钥', '独有的企业评分与信用维度', '适合客户准入 KYC、供应商评价'],
    needKey: true,
    keyField: 'YOUR_DNB_API_KEY',
  },
  {
    name: 'domain-expertise 专业领域',
    provider: 'Domain Expertise',
    description: '注入 24 个专业领域结构化知识：会计、税务、审计、公司法、劳动法等，含决策树与监管语境。',
    category: '专业领域',
    icon: '🧠',
    type: 'stdio',
    command: 'npx',
    args: '-y domain-expertise-mcp',
    notes: ['免费版支持 3 个领域，100 次查询/月', '付费版 $29-$599/月', '适合会计、税务、法律等结构化咨询'],
    needKey: false,
  },
  {
    name: '金蝶云星辰 MCP',
    provider: '金蝶',
    description: '完整的金蝶云星辰 API 支持：资产负债表、利润表、凭证查询、科目余额表、明细账、辅助核算等财务报表查询。',
    category: '财务/ERP',
    icon: '📒',
    type: 'stdio',
    command: 'npx',
    args: '-y @archiesun/kingdee-mcp-server',
    env: '{"KINGDEE_CLIENT_ID": "YOUR_CLIENT_ID", "KINGDEE_CLIENT_SECRET": "YOUR_CLIENT_SECRET", "KINGDEE_OUTER_INSTANCE_ID": "YOUR_INSTANCE_ID"}',
    notes: ['需在金蝶开放平台获取 CLIENT_ID / CLIENT_SECRET', 'OUTER_INSTANCE_ID 为云星辰实例 ID', '支持报表、凭证、账簿、辅助核算全系列查询'],
    needKey: true,
    keyField: 'KINGDEE_CLIENT_ID',
  },
  {
    name: '金蝶云星空 MCP',
    provider: '金蝶',
    description: '金蝶云星空 ERP 15 个 API 工具：单据查询（query_bill_json/view_bill）、销售/采购/库存查询、单据创建/提交/审核/下推。',
    category: '财务/ERP',
    icon: '⭐',
    type: 'stdio',
    command: 'npx',
    args: '-y kingdee-k3cloud-mcp',
    env: '{"KINGDEE_API_URL": "YOUR_API_URL", "KINGDEE_USERNAME": "YOUR_USERNAME", "KINGDEE_PASSWORD": "YOUR_PASSWORD"}',
    notes: ['需配置金蝶云星空 API 地址与账号密码', '支持单据查询、创建、审核、反审核、下推全流程', '配合 k3cloud-skill 知识库效果更佳'],
    needKey: true,
    keyField: 'KINGDEE_API_URL',
  },
  {
    name: '抖音无水印下载+文案提取',
    provider: 'yzfly',
    description: '解析抖音分享链接，获取无水印视频下载链接，AI 语音识别提取视频文案。支持 WebUI 和 MCP 两种方式。',
    category: '内容/视频',
    icon: '🎵',
    type: 'stdio',
    command: 'uvx',
    args: 'douyin-mcp-server',
    env: '{"API_KEY": "YOUR_SILICONFLOW_API_KEY"}',
    notes: ['需安装 Python 3.8+ 和 FFmpeg', 'API Key 可从硅基流动免费获取（新用户有免费额度）', '也支持 DASHSCOPE_API_KEY（阿里云百炼）', '解析视频基本信息无需密钥，AI 文案提取需要'],
    needKey: true,
    keyField: 'API_KEY',
  },
  {
    name: 'AntV 图表生成',
    provider: 'AntV（蚂蚁集团）',
    description: '通过自然语言描述生成统计图表，支持柱状图、折线图、饼图、散点图等多种图表类型。基于 G2 渲染引擎。',
    category: '数据可视化',
    icon: '📈',
    type: 'stdio',
    command: 'npx',
    args: '-y @antv/mcp-server-chart',
    notes: ['自然语言描述即可生成图表', '支持柱状图、折线图、饼图、散点图等', '基于 AntV G2 渲染引擎，输出高质量可视化'],
    needKey: false,
  },
  {
    name: '12306 火车票查询',
    provider: '开源社区',
    description: '查询 12306 火车票信息：余票查询、车次查询、车站查询、票价查询。实时获取全国铁路数据。',
    category: '出行/交通',
    icon: '🚄',
    type: 'stdio',
    command: 'npx',
    args: '-y 12306-mcp',
    notes: ['零配置，无需 API Key', '支持余票查询、车次时刻、车站信息', '数据来源 12306 官方'],
    needKey: false,
  },
  {
    name: 'B站视频搜索',
    provider: '开源社区',
    description: '在 AI 应用中搜索 B站（bilibili）视频内容，获取视频标题、播放量、UP主等信息。',
    category: '内容/视频',
    icon: '📺',
    type: 'stdio',
    command: 'npx',
    args: '-y bilibili-mcp-js',  // 2026-08-26 审计 B2: 补 -y——npx 首次运行需交互确认, stdio 环境会挂住
    notes: ['零配置，无需 API Key', '搜索 B站视频内容', '获取视频标题、播放量、UP 主等基本信息'],
    needKey: false,
  },
  {
    name: 'Lumenx 法务支出管理',
    provider: 'Lumenx',
    description: '整合电子账单平台与 ERP 数据，提供法律支出摘要、供应商绩效分析、预算对比。',
    category: '法务管理',
    icon: '💰',
    type: 'http',
    url: 'https://mcp.lumenx.com/mcp',
    headersTemplate: '{"Authorization": "Bearer YOUR_LUMENX_API_KEY"}',
    notes: ['需注册 Lumenx 获取密钥', '适合企业法务与财务部门成本管控', '可与现有 ERP 系统对接'],
    needKey: true,
    keyField: 'YOUR_LUMENX_API_KEY',
  },
]

const defaultForm: AddServerForm = {
  name: '',
  type: 'stdio',
  command: 'npx',
  args: '',
  env: '',
  url: '',
  headers: '',
  timeout: 30,
  connectTimeout: 10,
  enabled: true,
}

export function MCPConfigSection() {
  const { confirmNode, askConfirm } = useConfirm()
  const [servers, setServers] = useState<MCPServer[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'configured' | 'market'>('configured')
  const [showAddForm, setShowAddForm] = useState(false)
  const [form, setForm] = useState<AddServerForm>({ ...defaultForm })
  const [saving, setSaving] = useState(false)
  const [expandedServer, setExpandedServer] = useState<string | null>(null)
  const [serverTools, setServerTools] = useState<Record<string, MCPTool[]>>({})

  const fetchServers = useCallback(async () => {
    try {
      const result = await apiGet<{ servers: MCPServer[]; stats: { servers: number; connectedServers: number; registeredTools: number } }>('/api/mcp/servers')
      if (result.success && result.data) {
        setServers(result.data.servers)
      }
    } catch (e) {
      console.error('[MCPConfig] 加载 MCP 服务器列表失败:', e)
      toast.error('加载 MCP 服务器列表失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchServers()
  }, [fetchServers])

  const fetchServerTools = useCallback(async (serverName: string) => {
    try {
      const result = await apiGet<{ tools: MCPTool[] }>(`/api/mcp/servers/${encodeURIComponent(serverName)}/tools`)
      if (result.success && result.data) {
        setServerTools(prev => ({ ...prev, [serverName]: result.data!.tools }))
      }
    } catch (e) {
      console.error(`[MCPConfig] 加载服务器工具失败(${serverName}):`, e)
      toast.error('操作失败，请重试')
    }
  }, [])

  const handleAddServer = async () => {
    if (!form.name.trim()) return
    setSaving(true)

    try {
      const serverConfig: Record<string, unknown> = {
        enabled: form.enabled,
        timeout: form.timeout * 1000,
        connectTimeout: form.connectTimeout * 1000,
      }

      if (form.type === 'stdio') {
        serverConfig.command = form.command
        if (form.args.trim()) {
          serverConfig.args = form.args.trim().split(/\s+/)
        }
        if (form.env.trim()) {
          try {
            serverConfig.env = JSON.parse(form.env)
          } catch (e) {
            // 非法 JSON：中止提交（此前仅 toast 提示后仍继续发送损坏的配置）
            console.error('[MCPConfig] env 不是合法 JSON:', e)
            toast.error('env 必须是合法 JSON 格式')
            return
          }
        }
      } else {
        serverConfig.url = form.url
        if (form.headers.trim()) {
          try {
            serverConfig.headers = JSON.parse(form.headers)
          } catch (e) {
            console.error('[MCPConfig] headers 不是合法 JSON:', e)
            toast.error('headers 必须是合法 JSON 格式')
            return
          }
        }
      }

      const result = await apiPost('/api/mcp/servers/add', {
        name: form.name.trim(),
        ...serverConfig,
      })

      if (result.success) {
        setShowAddForm(false)
        setForm({ ...defaultForm })
        await fetchServers()
        if (result.data?.status === 'error') {
          toast.error('服务器连接异常: ' + sanitizeMcpError(result.data.error))
        }
      }
    } catch (e: any) {
      toast.error('添加失败: ' + sanitizeMcpError(e?.message || e))
    } finally {
      setSaving(false)
    }
  }

  const applyPreset = (preset: MCPServicePreset) => {
    setForm({
      name: preset.name,
      type: preset.type,
      command: preset.command || defaultForm.command,
      args: preset.args || '',
      env: preset.env || '',
      url: preset.url || '',
      headers: preset.headersTemplate || '',
      timeout: 30,
      connectTimeout: 10,
      enabled: true,
    })
    setShowAddForm(true)
    setActiveTab('configured')
  }

  // 2026-08-26 审计 B4: per-action busy——重连/断开/删除期间按钮禁用+旋转,
  // 成功给反馈(此前零反馈, 30s 重连期间可重复点击)
  const [busyServer, setBusyServer] = useState<Record<string, string>>({}) // name → 'delete'|'reconnect'|'disconnect'

  const handleDeleteServer = async (name: string) => {
    // 替代原生 confirm——Electron 渲染层不支持 window.confirm（静默返回 false）
    const ok = await askConfirm({ title: '删除 MCP 服务器', message: `确定删除 MCP 服务器 "${name}"?` })
    if (!ok) return
    setBusyServer(prev => ({ ...prev, [name]: 'delete' }))
    try {
      await apiPost('/api/mcp/servers/delete', { name })
      await fetchServers()
      toast.success(`${name} 已删除`)
    } catch (e: any) {
      toast.error('删除失败: ' + sanitizeMcpError(e?.message || e))
    } finally { setBusyServer(prev => { const n = { ...prev }; delete n[name]; return n }) }
  }

  const handleReconnect = async (name: string) => {
    setBusyServer(prev => ({ ...prev, [name]: 'reconnect' }))
    try {
      await apiPost('/api/mcp/servers/connect', { name })
      await fetchServers()
      toast.success(`${name} 已连接`)
    } catch (e: any) {
      toast.error('重连失败: ' + sanitizeMcpError(e?.message || e))
    } finally { setBusyServer(prev => { const n = { ...prev }; delete n[name]; return n }) }
  }

  const handleDisconnect = async (name: string) => {
    setBusyServer(prev => ({ ...prev, [name]: 'disconnect' }))
    try {
      await apiPost('/api/mcp/servers/disconnect', { name })
      await fetchServers()
      toast.success(`${name} 已断开`)
    } catch (e: any) {
      toast.error('断开失败: ' + sanitizeMcpError(e?.message || e))
    } finally { setBusyServer(prev => { const n = { ...prev }; delete n[name]; return n }) }
  }

  const handleReload = async () => {
    setLoading(true)
    try {
      await apiPost('/api/mcp/reload', {})
      await fetchServers()
      toast.success('MCP 服务器已重新加载')
    } catch (e: any) {
      toast.error('重新加载失败: ' + sanitizeMcpError(e?.message || e))
    }
  }

  const toggleExpand = (name: string) => {
    if (expandedServer === name) {
      setExpandedServer(null)
    } else {
      setExpandedServer(name)
      fetchServerTools(name)
    }
  }

  // 2026-08-27 A6: 原 statusColor(文本着色)删除——状态点迁移 StatusBadge;
  // 语义映射: connected=success / connecting=warn / error=disconnected=danger / disabled=neutral
  const statusTone: Record<string, string> = {
    connected: 'success',
    connecting: 'warn',
    error: 'danger',
    disconnected: 'danger',
    disabled: 'neutral',
  }

  const statusLabel = (status: string) => {
    switch (status) {
      case 'connected': return '已连接'
      case 'error': return '错误'
      case 'connecting': return '连接中'
      // 2026-08-26 审计 B6: 传输层子进程死亡置 status='disconnected'——此前原样显英文
      case 'disconnected': return '已断开（进程退出/连接丢失）'
      case 'disabled': return '已停用'
      default: return status
    }
  }

  if (loading) {
    return <div className="text-center py-8 theme-text-muted">加载 MCP 服务器列表...</div>
  }

  return (
    <div className="space-y-4">
      {confirmNode}
      {/* ─── Tab 切换 ─── */}
      <div className="flex gap-2 border-b pb-2" style={{ borderColor: 'var(--border-primary)' }}>
        <button
          onClick={() => setActiveTab('configured')}
          className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
            activeTab === 'configured'
              ? 'theme-accent-bg text-white'
              : 'theme-text-muted hover:theme-bg-hover'
          }`}
        >
          已配置 ({servers.length})
        </button>
        <button
          onClick={() => setActiveTab('market')}
          className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
            activeTab === 'market'
              ? 'theme-accent-bg text-white'
              : 'theme-text-muted hover:theme-bg-hover'
          }`}
        >
          预置服务 ({PRESET_SERVICES.length})
        </button>
      </div>

      {/* ─── Tab: 已配置 ─── */}
      {activeTab === 'configured' && (
        <>
          {/* 工具栏 */}
          <div className="flex items-center justify-between">
            <div className="text-sm theme-text-muted">
              {servers.length} 个服务器，{servers.filter(s => s.status === 'connected').length} 个已连接
            </div>
            <div className="flex gap-2">
              <button onClick={handleReload} className="px-3 py-1.5 text-sm rounded theme-btn theme-btn-secondary">
                重新加载
              </button>
              <button onClick={() => { setShowAddForm(!showAddForm); setForm({ ...defaultForm }) }}
                className="px-3 py-1.5 text-sm rounded theme-btn theme-btn-primary">
                + 添加服务器
              </button>
            </div>
          </div>

          {/* 添加表单 */}
          {showAddForm && (
            <div className="p-4 rounded-lg theme-bg-tertiary space-y-3">
              <h4 className="font-medium theme-text-primary">添加 MCP 服务器</h4>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs mb-1 theme-text-muted">服务器名称</label>
                  <input type="text" value={form.name} onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
                    placeholder="my-server" className="theme-input text-sm" />
                </div>
                <div>
                  <label className="block text-xs mb-1 theme-text-muted">传输类型</label>
                  <select value={form.type} onChange={e => setForm(prev => ({ ...prev, type: e.target.value as 'stdio' | 'http' }))}
                    className="theme-input text-sm">
                    <option value="stdio">Stdio (本地子进程)</option>
                    <option value="http">HTTP (远程端点)</option>
                  </select>
                </div>
              </div>

              {form.type === 'stdio' ? (
                <>
                  <div>
                    <label className="block text-xs mb-1 theme-text-muted">命令</label>
                    <input type="text" value={form.command} onChange={e => setForm(prev => ({ ...prev, command: e.target.value }))}
                      placeholder="npx" className="theme-input text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs mb-1 theme-text-muted">参数（空格分隔）</label>
                    <input type="text" value={form.args} onChange={e => setForm(prev => ({ ...prev, args: e.target.value }))}
                      placeholder="-y @modelcontextprotocol/server-filesystem /tmp" className="theme-input text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs mb-1 theme-text-muted">环境变量（JSON）</label>
                    <textarea value={form.env} onChange={e => setForm(prev => ({ ...prev, env: e.target.value }))}
                      placeholder='{"GITHUB_TOKEN": "ghp_..."}' className="theme-input text-sm font-mono" rows={2} />
                    {form.env.includes('YOUR_') && (
                      <p className="text-xs mt-1 text-amber-500">⚠️ 请将环境变量中的占位符替换为真实值</p>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className="block text-xs mb-1 theme-text-muted">服务器 URL</label>
                    <input type="text" value={form.url} onChange={e => setForm(prev => ({ ...prev, url: e.target.value }))}
                      placeholder="https://mcp.example.com/mcp" className="theme-input text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs mb-1 theme-text-muted">HTTP 头（JSON）</label>
                    <textarea value={form.headers} onChange={e => setForm(prev => ({ ...prev, headers: e.target.value }))}
                      placeholder='{"Authorization": "Bearer ..."}' className="theme-input text-sm font-mono" rows={2} />
                    {form.headers.includes('YOUR_') && (
                      <p className="text-xs mt-1 text-amber-500">⚠️ 请将密钥占位符替换为你实际申请的 API Key</p>
                    )}
                  </div>
                </>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs mb-1 theme-text-muted">超时时间（秒）</label>
                  <input type="number" value={form.timeout}
                    onChange={e => setForm(prev => ({ ...prev, timeout: parseInt(e.target.value) || 30 }))}
                    className="theme-input text-sm" />
                </div>
                <div>
                  <label className="block text-xs mb-1 theme-text-muted">连接超时（秒）</label>
                  <input type="number" value={form.connectTimeout}
                    onChange={e => setForm(prev => ({ ...prev, connectTimeout: parseInt(e.target.value) || 10 }))}
                    className="theme-input text-sm" />
                </div>
              </div>

              <div className="flex gap-2">
                <button onClick={handleAddServer} disabled={saving || !form.name.trim()}
                  className="px-4 py-1.5 text-sm rounded theme-btn theme-btn-primary disabled:opacity-50">
                  {saving ? '保存中...' : '保存并连接'}
                </button>
                <button onClick={() => setShowAddForm(false)}
                  className="px-4 py-1.5 text-sm rounded theme-btn theme-btn-secondary">
                  取消
                </button>
              </div>
            </div>
          )}

          {/* 服务器列表 */}
          {servers.length === 0 ? (
            <div className="text-center py-8 theme-text-muted">
              <p>尚未配置 MCP 服务器</p>
              <p className="text-xs mt-1">点击"添加服务器"连接外部工具，或切换到「预置服务」快速添加</p>
              <button onClick={() => setActiveTab('market')}
                className="mt-3 px-4 py-1.5 text-sm rounded theme-btn theme-btn-primary">
                浏览预置服务
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {servers.map(server => (
                <div key={server.name} className="rounded-lg theme-bg-tertiary overflow-hidden">
                  <div className="flex items-center justify-between p-3 cursor-pointer hover:opacity-80"
                    onClick={() => toggleExpand(server.name)}>
                    <div className="flex items-center gap-3">
                      <span className="font-medium theme-text-primary">{server.name}</span>
                      <span className="text-xs px-2 py-0.5 rounded theme-bg-input theme-text-muted">
                        {server.type === 'stdio' ? 'Stdio' : 'HTTP'}
                      </span>
                      <StatusBadge tone={statusTone[server.status] || 'neutral'} label={statusLabel(server.status)} />
                      {server.status === 'connected' && (
                        <span className="text-xs theme-text-muted">
                          {server.toolCount} 工具 / {server.resourceCount} 资源 / {server.promptCount} 提示
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                      {server.status === 'connected' ? (
                        <button onClick={() => handleDisconnect(server.name)}
                          disabled={!!busyServer[server.name]}
                          className="text-xs px-2 py-1 rounded theme-btn theme-btn-secondary disabled:opacity-40">{busyServer[server.name] === 'disconnect' ? '断开中…' : '断开'}</button>
                      ) : (
                        <button onClick={() => handleReconnect(server.name)}
                          disabled={!!busyServer[server.name]}
                          className="text-xs px-2 py-1 rounded theme-btn theme-btn-primary disabled:opacity-40">{busyServer[server.name] === 'reconnect' ? (server.status === 'disabled' ? '启用中…' : '连接中…') : (server.status === 'disabled' ? '启用' : '连接')}</button>
                      )}
                      <button onClick={() => handleDeleteServer(server.name)}
                        disabled={!!busyServer[server.name]}
                        className="text-xs px-2 py-1 rounded text-red-500 hover:bg-red-500/10 disabled:opacity-40">删除</button>
                    </div>
                  </div>

                  {expandedServer === server.name && (
                    <div className="border-t px-3 py-3 space-y-3" style={{ borderColor: 'var(--border-primary)' }}>
                      <div className="text-xs theme-text-muted">
                        {server.type === 'stdio' ? (
                          <span>命令: <code className="theme-bg-input px-1 rounded">{server.config.command || '-'}</code></span>
                        ) : (
                          <span>URL: <code className="theme-bg-input px-1 rounded">{server.config.url || '-'}</code></span>
                        )}
                        {/* P8(GUI 全量修复): 错误串脱敏——旧实现原样渲染后端错误,
                            常含端点 URL/鉴权片段(与 toast 路径的 sanitizeMcpError 不一致) */}
                        {server.error && <div className="mt-1 text-red-500">错误: {sanitizeMcpError(server.error)}</div>}
                      </div>

                      {serverTools[server.name] && serverTools[server.name].length === 0 && (
                        <p className="text-xs theme-text-muted py-1">该服务器未注册工具（或工具发现失败）</p>
                      )}
                      {serverTools[server.name] && serverTools[server.name].length > 0 && (
                        <div>
                          <h5 className="text-xs font-medium theme-text-secondary mb-2">已注册工具</h5>
                          <div className="space-y-1">
                            {serverTools[server.name].map(tool => (
                              <div key={tool.name} className="flex items-start gap-2 p-2 rounded theme-bg-input">
                                <code className="text-xs font-mono theme-accent">{tool.name}</code>
                                <span className="text-xs theme-text-muted">{tool.description}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* 2026-08-27 审计 B3: 编辑器 state 仅初始化一次——保存后 fetchServers 刷新
                          config 但子组件不重挂 → 面板显示旧值。key 按服务器名强制重建。 */}
                      <ToolFilterEditor key={`${server.name}-tools`} serverName={server.name} config={server.config.tools} onSaved={() => fetchServers()} />
                      <SamplingConfigEditor key={`${server.name}-sampling`} serverName={server.name} config={server.config.sampling} onSaved={() => fetchServers()} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ─── Tab: 预置服务市场 ─── */}
      {activeTab === 'market' && (
        <div className="space-y-3">
          <p className="text-xs theme-text-muted">
            选择以下企业服务 MCP，点击"添加"自动填入配置，补充 API Key 后即可连接。
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {PRESET_SERVICES.map((preset, i) => (
              <div key={i}
                className="rounded-xl p-4 transition-all hover:shadow-md cursor-pointer"
                style={{ background: 'var(--bg-card, var(--bg-secondary))', border: '1px solid var(--border-primary)' }}
              >
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
                    style={{ background: 'var(--accent-muted, rgba(89,168,255,0.12))' }}>
                    <span className="text-lg">{preset.icon}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h4 className="text-sm font-semibold theme-text-primary">{preset.name}</h4>
                      <span className="text-[10px] px-1.5 py-0.5 rounded"
                        style={{ background: 'rgba(89,168,255,0.1)', color: 'var(--accent-primary, #59a8ff)' }}>
                        {preset.category}
                      </span>
                    </div>
                    <p className="text-xs theme-text-muted mt-1 line-clamp-2">{preset.description}</p>

                    <div className="flex items-center gap-3 mt-2 text-[10px] theme-text-muted">
                      <span>提供商: {preset.provider}</span>
                      <span>{preset.type === 'http' ? 'HTTP 远程' : 'Stdio 本地'}</span>
                      {preset.needKey && <span className="text-amber-500">需 API Key</span>}
                    </div>

                    {/* 提示列表 */}
                    <div className="mt-2 space-y-0.5">
                      {preset.notes.map((note, j) => (
                        <p key={j} className="text-[10px] theme-text-muted flex items-start gap-1">
                          <span className="opacity-50">·</span> {note}
                        </p>
                      ))}
                    </div>

                    <button onClick={() => applyPreset(preset)}
                      className="mt-3 px-4 py-1.5 text-xs font-medium rounded-lg transition-colors text-white"
                      style={{ background: 'var(--accent-primary, #3b82f6)' }}>
                      添加配置
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ===== 工具过滤编辑器 =====

function ToolFilterEditor({ serverName, config, onSaved }: {
  serverName: string
  config: { include?: string[]; exclude?: string[]; prompts?: boolean; resources?: boolean }
  onSaved: () => void
}) {
  const [mode, setMode] = useState<'none' | 'include' | 'exclude'>(config.include ? 'include' : config.exclude ? 'exclude' : 'none')
  const [filterList, setFilterList] = useState(config.include?.join(', ') || config.exclude?.join(', ') || '')
  const [prompts, setPrompts] = useState(config.prompts !== false)
  const [resources, setResources] = useState(config.resources !== false)
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    setSaving(true)
    try {
      const toolsConfig: Record<string, unknown> = { prompts, resources }
      if (mode === 'include') toolsConfig.include = filterList.split(',').map(s => s.trim()).filter(Boolean)
      else if (mode === 'exclude') toolsConfig.exclude = filterList.split(',').map(s => s.trim()).filter(Boolean)
      await apiPost('/api/mcp/servers/update', { name: serverName, tools: toolsConfig })
      onSaved()
    } catch (e) {
      console.error(`[MCPConfig] 保存工具配置失败(${serverName}):`, e)
      toast.error('操作失败，请重试')
    } finally { setSaving(false) }
  }

  return (
    <div>
      <h5 className="text-xs font-medium theme-text-secondary mb-2">工具过滤</h5>
      <div className="space-y-2">
        <div className="flex gap-2">
          <label className="text-xs theme-text-muted"><input type="radio" checked={mode === 'none'} onChange={() => setMode('none')} className="mr-1" />不过滤</label>
          <label className="text-xs theme-text-muted"><input type="radio" checked={mode === 'include'} onChange={() => setMode('include')} className="mr-1" />白名单</label>
          <label className="text-xs theme-text-muted"><input type="radio" checked={mode === 'exclude'} onChange={() => setMode('exclude')} className="mr-1" />黑名单</label>
        </div>
        {mode !== 'none' && (
          <input type="text" value={filterList} onChange={e => setFilterList(e.target.value)}
            placeholder={mode === 'include' ? 'tool_a, tool_b' : 'dangerous_tool'} className="theme-input text-sm" />
        )}
        <div className="flex gap-4">
          <label className="text-xs theme-text-muted flex items-center gap-1"><input type="checkbox" checked={prompts} onChange={e => setPrompts(e.target.checked)} />提示工具</label>
          <label className="text-xs theme-text-muted flex items-center gap-1"><input type="checkbox" checked={resources} onChange={e => setResources(e.target.checked)} />资源工具</label>
        </div>
        <button onClick={handleSave} disabled={saving}
          className="text-xs px-3 py-1 rounded theme-btn theme-btn-primary disabled:opacity-50">
          {saving ? '保存中...' : '保存过滤配置'}
        </button>
      </div>
    </div>
  )
}

// ===== 采样配置编辑器 =====

function SamplingConfigEditor({ serverName, config, onSaved }: {
  serverName: string
  config: { enabled?: boolean; model?: string; maxTokensCap?: number; maxRpm?: number; timeout?: number }
  onSaved: () => void
}) {
  const [enabled, setEnabled] = useState(config.enabled !== false)
  const [model, setModel] = useState(config.model || '')
  const [maxTokensCap, setMaxTokensCap] = useState(config.maxTokensCap || 4096)
  const [maxRpm, setMaxRpm] = useState(config.maxRpm || 10)
  const [timeout, setTimeout_] = useState(config.timeout || 30)
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    setSaving(true)
    try {
      await apiPost('/api/mcp/servers/update', { name: serverName, sampling: { enabled, model: model || undefined, maxTokensCap, maxRpm, timeout } })
      onSaved()
    } catch (e) {
      console.error(`[MCPConfig] 保存采样配置失败(${serverName}):`, e)
      toast.error('操作失败，请重试')
    } finally { setSaving(false) }
  }

  return (
    <div>
      <h5 className="text-xs font-medium theme-text-secondary mb-2">采样配置（MCP 服务器请求 LLM 补全）</h5>
      <div className="space-y-2">
        <label className="text-xs theme-text-muted flex items-center gap-1"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />启用采样</label>
        {enabled && (
          <div className="grid grid-cols-2 gap-2">
            <div><label className="block text-xs mb-1 theme-text-muted">采样模型</label><input type="text" value={model} onChange={e => setModel(e.target.value)} placeholder="留空默认" className="theme-input text-sm" /></div>
            <div><label className="block text-xs mb-1 theme-text-muted">最大 Token</label><input type="number" value={maxTokensCap} onChange={e => setMaxTokensCap(parseInt(e.target.value) || 4096)} className="theme-input text-sm" /></div>
            <div><label className="block text-xs mb-1 theme-text-muted">RPM 上限</label><input type="number" value={maxRpm} onChange={e => setMaxRpm(parseInt(e.target.value) || 10)} className="theme-input text-sm" /></div>
            <div><label className="block text-xs mb-1 theme-text-muted">超时(秒)</label><input type="number" value={timeout} onChange={e => setTimeout_(parseInt(e.target.value) || 30)} className="theme-input text-sm" /></div>
          </div>
        )}
        <button onClick={handleSave} disabled={saving} className="text-xs px-3 py-1 rounded theme-btn theme-btn-primary disabled:opacity-50">
          {saving ? '保存中...' : '保存采样配置'}
        </button>
      </div>
    </div>
  )
}
