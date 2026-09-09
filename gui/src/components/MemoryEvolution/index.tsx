import { Zap, Database, TrendingUp, Moon, BarChart3, RefreshCw, Play, Brain, User } from 'lucide-react'

interface Props {
  evolutionStatus: any
  evolutionProfile: any
  loadingEvolution: boolean
  evolving: boolean
  onTriggerEvolution: () => void
}

export function MemoryEvolution({
  evolutionStatus, evolutionProfile, loadingEvolution, evolving, onTriggerEvolution,
}: Props) {
  return (
    <div className="space-y-4 mt-6">
      {/* 进化状态概览 */}
      <div className="theme-card p-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg flex items-center justify-center theme-color-info-bg">
              <Zap className="w-5 h-5 theme-color-info" />
            </div>
            <div>
              <h3 className="font-bold theme-text-primary">记忆进化引擎</h3>
              <p className="text-xs theme-text-muted">
                {evolutionStatus?.available ? '进化系统已就绪' : '进化系统未初始化'}
                {evolutionStatus?.hasEnhancedMemory && ' · 增强记忆已桥接'}
                {evolutionStatus?.hasDecayEngine && ' · 衰减引擎已桥接'}
              </p>
            </div>
          </div>
          <button
            onClick={onTriggerEvolution}
            disabled={evolving || !evolutionStatus?.available}
            className="flex items-center gap-2 px-4 py-2 rounded-lg hover:opacity-90 transition-colors disabled:opacity-50 text-sm text-white"
            style={{ backgroundColor: 'var(--color-info, #3b82f6)' }}
          >
            {evolving ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            {evolving ? '进化中...' : '触发进化'}
          </button>
        </div>

        {evolutionStatus?.engine && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="rounded-lg p-3 theme-bg-tertiary">
                <div className="flex items-center gap-2 mb-1">
                  <Database className="w-3.5 h-3.5 text-blue-500" />
                  <span className="text-xs theme-text-muted">总记忆数</span>
                </div>
                <p className="text-lg font-bold theme-text-primary">
                  {evolutionStatus.engine.stats?.totalMemories || 0}
                </p>
              </div>
              <div className="rounded-lg p-3 theme-bg-tertiary">
                <div className="flex items-center gap-2 mb-1">
                  <TrendingUp className="w-3.5 h-3.5 text-green-500" />
                  <span className="text-xs theme-text-muted">已压缩</span>
                </div>
                <p className="text-lg font-bold theme-text-primary">
                  {evolutionStatus.engine.stats?.compressedMemories || 0}
                </p>
              </div>
              <div className="rounded-lg p-3 theme-bg-tertiary">
                <div className="flex items-center gap-2 mb-1">
                  <Moon className="w-3.5 h-3.5 text-yellow-500" />
                  <span className="text-xs theme-text-muted">已遗忘</span>
                </div>
                <p className="text-lg font-bold theme-text-primary">
                  {evolutionStatus.engine.stats?.forgottenMemories || 0}
                </p>
              </div>
              <div className="rounded-lg p-3 theme-bg-tertiary">
                <div className="flex items-center gap-2 mb-1">
                  <BarChart3 className="w-3.5 h-3.5 text-purple-500" />
                  <span className="text-xs theme-text-muted">画像完整度</span>
                </div>
                <p className="text-lg font-bold theme-text-primary">
                  {((evolutionStatus.engine.profileCompleteness || 0) * 100).toFixed(0)}%
                </p>
              </div>
            </div>

            {evolutionStatus.engine.memoryDistribution && (
              <div className="mt-3 grid grid-cols-3 gap-3">
                <div className="rounded-lg p-3 theme-bg-tertiary">
                  <span className="text-xs theme-text-muted">工作记忆 (短期)</span>
                  <p className="font-medium theme-text-primary">{evolutionStatus.engine.memoryDistribution.working || 0}</p>
                </div>
                <div className="rounded-lg p-3 theme-bg-tertiary">
                  <span className="text-xs theme-text-muted">情景记忆 (中期)</span>
                  <p className="font-medium theme-text-primary">{evolutionStatus.engine.memoryDistribution.episodic || 0}</p>
                </div>
                <div className="rounded-lg p-3 theme-bg-tertiary">
                  <span className="text-xs theme-text-muted">语义记忆 (长期)</span>
                  <p className="font-medium theme-text-primary">{evolutionStatus.engine.memoryDistribution.semantic || 0}</p>
                </div>
              </div>
            )}
          </>
        )}

      </div>

      {/* 用户画像 */}
      {evolutionProfile && Object.keys(evolutionProfile).length > 0 && (
        <div className="theme-card p-4">
          <div className="flex items-center gap-2 mb-3">
              <User className="w-4 h-4 theme-color-info" />
              <h3 className="font-medium theme-text-primary">用户画像</h3>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {evolutionProfile.communicationStyle && Object.keys(evolutionProfile.communicationStyle).length > 0 && (
                <div className="rounded-lg p-3 theme-bg-tertiary">
                  <span className="text-xs theme-text-muted block mb-2">沟通风格</span>
                  <div className="space-y-1 text-sm">
                    {evolutionProfile.communicationStyle.formality && (
                      <div className="flex justify-between">
                        <span className="theme-text-secondary">正式度</span>
                        <span className="theme-text-primary font-medium">{evolutionProfile.communicationStyle.formality}</span>
                      </div>
                    )}
                    {evolutionProfile.communicationStyle.tonePreference && (
                      <div className="flex justify-between">
                        <span className="theme-text-secondary">语气偏好</span>
                        <span className="theme-text-primary font-medium">{evolutionProfile.communicationStyle.tonePreference}</span>
                      </div>
                    )}
                    {evolutionProfile.communicationStyle.preferredLength && (
                      <div className="flex justify-between">
                        <span className="theme-text-secondary">长度偏好</span>
                        <span className="theme-text-primary font-medium">{evolutionProfile.communicationStyle.preferredLength}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
              {evolutionProfile.workHabits && Object.keys(evolutionProfile.workHabits).length > 0 && (
                <div className="rounded-lg p-3 theme-bg-tertiary">
                  <span className="text-xs theme-text-muted block mb-2">工作习惯</span>
                  <div className="space-y-1 text-sm">
                    {evolutionProfile.workHabits.peakHours?.length > 0 && (
                      <div className="flex justify-between">
                        <span className="theme-text-secondary">活跃时段</span>
                        <span className="theme-text-primary font-medium">{evolutionProfile.workHabits.peakHours.join(', ')}时</span>
                      </div>
                    )}
                    {evolutionProfile.workHabits.preferredTools?.length > 0 && (
                      <div className="flex justify-between">
                        <span className="theme-text-secondary">常用工具</span>
                        <span className="theme-text-primary font-medium">{evolutionProfile.workHabits.preferredTools.slice(0, 3).join(', ')}</span>
                      </div>
                    )}
                    {evolutionProfile.workHabits.taskPatterns?.length > 0 && (
                      <div className="flex justify-between">
                        <span className="theme-text-secondary">任务模式</span>
                        <span className="theme-text-primary font-medium">{evolutionProfile.workHabits.taskPatterns.slice(0, 3).map((p: any) => p.type).join(', ')}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
              {evolutionProfile.preferences && Object.keys(evolutionProfile.preferences).length > 0 && (
                <div className="rounded-lg p-3 theme-bg-tertiary">
                  <span className="text-xs theme-text-muted block mb-2">偏好</span>
                  <div className="space-y-1 text-sm">
                    {Object.entries(evolutionProfile.preferences).slice(0, 4).map(([key, value]: [string, any]) => (
                      <div key={key} className="flex justify-between">
                        <span className="theme-text-secondary">{key}</span>
                        <span className="theme-text-primary font-medium truncate ml-2 max-w-[120px]">{typeof value === 'object' ? JSON.stringify(value) : String(value)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {evolutionProfile.evolutionHistory?.length > 0 && (
                <div className="rounded-lg p-3 theme-bg-tertiary">
                  <span className="text-xs theme-text-muted block mb-2">画像进化历史</span>
                  <div className="space-y-1 text-sm max-h-32 overflow-y-auto">
                    {evolutionProfile.evolutionHistory.slice(-5).reverse().map((entry: any, idx: number) => (
                      <div key={idx} className="flex justify-between">
                        <span className="theme-text-secondary">
                          {entry.timestamp ? new Date(entry.timestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) : ''}
                        </span>
                        <span className="theme-text-primary font-medium">{((entry.completeness || 0) * 100).toFixed(0)}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 增强记忆统计 */}
        {evolutionStatus?.enhancedMemory && (
          <div className="mt-4 theme-card p-4">
            <div className="flex items-center gap-2 mb-3">
              <Brain className="w-4 h-4 theme-color-info" />
              <h3 className="font-medium theme-text-primary">增强记忆系统</h3>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div className="rounded-lg p-3 theme-bg-tertiary">
                <span className="text-xs theme-text-muted">事实总数</span>
                <p className="font-medium theme-text-primary">{evolutionStatus.enhancedMemory.totalFacts || 0}</p>
              </div>
              {evolutionStatus.enhancedMemory.entities && (
                <div className="rounded-lg p-3 theme-bg-tertiary">
                  <span className="text-xs theme-text-muted">实体数</span>
                  <p className="font-medium theme-text-primary">{evolutionStatus.enhancedMemory.entities.totalEntities || 0}</p>
                </div>
              )}
              {evolutionStatus.enhancedMemory.agents && (
                <div className="rounded-lg p-3 theme-bg-tertiary">
                  <span className="text-xs theme-text-muted">Agent数</span>
                  <p className="font-medium theme-text-primary">{evolutionStatus.enhancedMemory.agents.totalAgents || 0}</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 加载/空状态 */}
        {loadingEvolution && !evolutionStatus && (
          <div className="text-center py-12 theme-text-muted">
            <RefreshCw className="w-8 h-8 mx-auto mb-2 animate-spin" />
            <p>加载进化数据...</p>
          </div>
        )}

        {!loadingEvolution && !evolutionStatus && (
          <div className="text-center py-12 theme-text-muted">
            <Zap className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p>进化系统未初始化</p>
            <p className="text-sm mt-2">记忆进化引擎会在系统运行时自动初始化</p>
          </div>
        )}
      </div>
  )
}
