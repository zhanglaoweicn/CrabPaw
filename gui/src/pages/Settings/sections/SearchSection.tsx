import React from 'react'
import { Search, Eye, EyeOff } from 'lucide-react'

interface SearchSectionProps {
  activeSection: string
  searchConfig: {
    tavilyApiKey: string
    bingApiKey: string
    baiduApiKey: string
  }
  setSearchConfig: React.Dispatch<React.SetStateAction<{
    tavilyApiKey: string
    bingApiKey: string
    baiduApiKey: string
  }>>
  showApiKeys: Record<string, boolean>
  onToggleApiKeyVisibility: (key: string) => void
}

export function SearchSection({ activeSection, searchConfig, setSearchConfig, showApiKeys, onToggleApiKeyVisibility }: SearchSectionProps) {
  return (
    <div className="theme-card p-6" style={{ display: activeSection === 'search' ? 'block' : 'none' }}>
      <h3 className="font-medium mb-4 flex items-center gap-2 theme-text-primary">
        <Search className="w-5 h-5 theme-accent" />
        搜索配置
      </h3>
      <p className="text-sm theme-text-secondary mb-6">配置搜索 API Key，提升搜索质量和可靠性。当前支持百度千帆 AI 搜索、Tavily 和 Bing Search API，均为国内直连、免费额度。中文查询优先使用百度。</p>

      <div className="space-y-6">
        {/* Tavily API Key */}
        <div className="p-4 rounded-lg border theme-border">
          <div className="flex items-center justify-between mb-3">
            <div>
              <span className="font-medium theme-text-primary">Tavily</span>
              <p className="text-xs theme-text-muted mt-0.5">AI 专用搜索引擎，免费 1000 次/月，国内直连</p>
            </div>
            <a href="https://tavily.com" target="_blank" rel="noopener noreferrer" className="text-xs theme-accent hover:underline">
              获取 Key ↗
            </a>
          </div>
          <div>
            <label className="block text-xs mb-1 theme-text-muted">API Key</label>
            <div className="relative">
              <input
                type={showApiKeys["tavily"] ? "text" : "password"}
                value={searchConfig.tavilyApiKey}
                onChange={(e) => setSearchConfig(prev => ({ ...prev, tavilyApiKey: e.target.value }))}
                placeholder="tvly-..."
                className="theme-input text-sm pr-10"
              />
              <button
                type="button"
                onClick={() => onToggleApiKeyVisibility("tavily")}
                className="absolute right-2 top-1/2 -translate-y-1/2 theme-text-muted hover:theme-text-primary"
              >
                {showApiKeys["tavily"] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>

        {/* 百度千帆 AI 搜索 API Key */}
        <div className="p-4 rounded-lg border theme-border">
          <div className="flex items-center justify-between mb-3">
            <div>
              <span className="font-medium theme-text-primary">百度千帆 AI 搜索</span>
              <p className="text-xs theme-text-muted mt-0.5">百度官方搜索 API，免费 1500 次/月，中文检索质量最优，返回带正文可直接引用</p>
            </div>
            <a href="https://console.bce.baidu.com/qianfan/aisearch" target="_blank" rel="noopener noreferrer" className="text-xs theme-accent hover:underline">
              获取 Key ↗
            </a>
          </div>
          <div>
            <label className="block text-xs mb-1 theme-text-muted">API Key</label>
            <div className="relative">
              <input
                type={showApiKeys["baidu"] ? "text" : "password"}
                value={searchConfig.baiduApiKey}
                onChange={(e) => setSearchConfig(prev => ({ ...prev, baiduApiKey: e.target.value }))}
                placeholder="bce-v3/ALTAK-..."
                className="theme-input text-sm pr-10"
              />
              <button
                type="button"
                onClick={() => onToggleApiKeyVisibility("baidu")}
                className="absolute right-2 top-1/2 -translate-y-1/2 theme-text-muted hover:theme-text-primary"
              >
                {showApiKeys["baidu"] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>

        {/* Bing API Key */}
        <div className="p-4 rounded-lg border theme-border">
          <div className="flex items-center justify-between mb-3">
            <div>
              <span className="font-medium theme-text-primary">Bing Search API</span>
              <p className="text-xs theme-text-muted mt-0.5">Azure 官方搜索 API，免费 1000 次/月，国内直连</p>
            </div>
            <a href="https://portal.azure.com/#create/Microsoft.BingSearch" target="_blank" rel="noopener noreferrer" className="text-xs theme-accent hover:underline">
              获取 Key ↗
            </a>
          </div>
          <div>
            <label className="block text-xs mb-1 theme-text-muted">API Key</label>
            <div className="relative">
              <input
                type={showApiKeys["bing"] ? "text" : "password"}
                value={searchConfig.bingApiKey}
                onChange={(e) => setSearchConfig(prev => ({ ...prev, bingApiKey: e.target.value }))}
                placeholder="输入 Azure Bing Search API Key..."
                className="theme-input text-sm pr-10"
              />
              <button
                type="button"
                onClick={() => onToggleApiKeyVisibility("bing")}
                className="absolute right-2 top-1/2 -translate-y-1/2 theme-text-muted hover:theme-text-primary"
              >
                {showApiKeys["bing"] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>

      </div>
    </div>
  )
}
