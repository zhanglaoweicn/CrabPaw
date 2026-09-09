import { useEffect, useMemo, useRef, useState } from 'react'
import { buildCockpitSearchIndex, type CockpitSearchItem } from '../../lib/cockpit-navigation'
import { COMMAND_DEFS } from '../../lib/command-defs'
import { executeCommand } from '../../lib/ui-command-registry'
import './styles.css'

interface Command { id: string; label: string; hint?: string; run: () => void }

export default function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // 2026-08-27 全局搜索: 主菜单 + 管理舱搜索双模式（Ctrl+K 保留原命令列表）
  const [searchMode, setSearchMode] = useState<'menu' | 'cockpit'>('menu')
  const [cockpitItems, setCockpitItems] = useState<CockpitSearchItem[]>([])
  const cockpitCacheRef = useRef<{ at: number; items: CockpitSearchItem[] } | null>(null)

  // B2(2026-09-05): 命令清单从 lib/command-defs 派生——与语音别名/全局快捷键同一
  // 命令源, 新增命令只写一处。palette 本地行为(管理舱搜索模式切换)仍在此声明。
  const commands = useMemo<Command[]>(() => [
    ...COMMAND_DEFS.map(d => ({ id: d.id, label: d.label, hint: d.hint, run: d.run })),
    { id: 'cockpit-search', label: '搜索管理舱…', hint: '技能/专家/插件/MCP/设置', run: () => { setSearchMode('cockpit'); setQuery('') } },
  ], [])

  // 重新打开时回到主菜单（管理舱搜索模式仅本次会话内有效）
  useEffect(() => {
    if (open) setSearchMode('menu')
  }, [open])

  // 管理舱搜索模式: 打开时构建索引, useRef 缓存 + 15s 过期刷新
  useEffect(() => {
    if (!open || searchMode !== 'cockpit') return
    let cancelled = false
    const cache = cockpitCacheRef.current
    if (cache && Date.now() - cache.at < 15000) {
      setCockpitItems(cache.items)
      return
    }
    buildCockpitSearchIndex()
      .then(items => {
        if (cancelled) return
        cockpitCacheRef.current = { at: Date.now(), items }
        setCockpitItems(items)
      })
      .catch(err => console.error('[command-palette] 管理舱搜索索引构建失败:', err))
    return () => { cancelled = true }
  }, [open, searchMode])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(o => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const filtered = query.trim()
    ? commands.filter(c => c.label.includes(query.trim()))
    : commands

  const cockpitFiltered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return cockpitItems
    return cockpitItems.filter(i =>
      i.label.toLowerCase().includes(q) ||
      (i.hint || '').toLowerCase().includes(q) ||
      (i.keyword || '').toLowerCase().includes(q)
    )
  }, [query, cockpitItems])

  // 管理舱搜索结果选中 → __cockpit.openWith(tab, section, keyword) 直达对应面板
  const selectCockpitItem = (item: CockpitSearchItem) => {
    executeCommand('cockpit', 'openWith', item.tab, item.section, item.keyword)
    setOpen(false)
    setSearchMode('menu')
  }

  if (!open) return null

  const inCockpit = searchMode === 'cockpit'
  const activeList = inCockpit ? cockpitFiltered : filtered

  return (
    <div className="command-palette-overlay" onClick={() => { setOpen(false); setSearchMode('menu') }}>
      <div className="command-palette" onClick={e => e.stopPropagation()}>
        <input
          autoFocus
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={inCockpit ? '搜索技能/专家/插件/MCP 服务/设置项…（Esc 关闭）' : '输入命令或功能名…（Esc 关闭）'}
          onKeyDown={e => {
            if (e.key === 'Escape') { setOpen(false); setSearchMode('menu'); e.stopPropagation() }
            if (e.key === 'Enter' && activeList[0]) {
              if (inCockpit) selectCockpitItem(activeList[0] as CockpitSearchItem)
              else {
                const cmd = activeList[0] as Command
                // 2026-08-27 A4: 'cockpit-search' 切模式且不关闭——run() 置 cockpit 模式, 重开会重置回 menu
                if (cmd.id === 'cockpit-search') { cmd.run(); setQuery('') }
                else { cmd.run(); setOpen(false) }
              }
              e.stopPropagation()
            }
          }}
        />
        <div className="command-palette-list">
          {activeList.length === 0 && query.trim()
            ? <div className="command-palette-empty">{inCockpit ? '无匹配结果' : '无匹配命令'}</div>
            : null}
          {inCockpit
            ? cockpitFiltered.map(item => (
              <button key={item.id} className="command-palette-item" onClick={() => selectCockpitItem(item)}>
                <span>{item.label}</span>
                <em>{item.hint}</em>
              </button>
            ))
            : filtered.map(c => (
              <button key={c.id} className="command-palette-item" onClick={() => { c.run(); setOpen(false) }}>
                <span>{c.label}</span>
                {c.hint ? <em>{c.hint}</em> : null}
              </button>
            ))}
        </div>
      </div>
    </div>
  )
}
