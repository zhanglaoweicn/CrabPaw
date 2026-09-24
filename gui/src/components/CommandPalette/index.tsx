import { useEffect, useMemo, useRef, useState } from 'react'
import { buildCockpitSearchIndex, type CockpitSearchItem } from '../../lib/cockpit-navigation'
import { COMMAND_DEFS, type CommandDef } from '../../lib/command-defs'
import { executeCommand } from '../../lib/ui-command-registry'
import { rankCommandIds, recordCommandUse } from '../../lib/command-usage'
import './styles.css'

interface Command { id: string; label: string; hint?: string; run: () => void }

/**
 * CommandPalette — Ctrl+K/Cmd+K 全局命令面板
 *
 * 2026-09-22 可访问性/交互修复：
 *  ① 高亮跟随——此前 Enter 恒执行 activeList[0]，而界面上没有任何"当前项"标记，
 *     用户看中第 5 条按回车却跑了第 1 条。
 *  ② 方向键导航——此前只能鼠标点或回车跑第一条，键盘用户无法选择列表项。
 *  ③ 补 listbox 语义（role/aria-activedescendant/aria-selected）——此前对读屏
 *     完全不可用。
 */
export default function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // 2026-08-27 全局搜索: 主菜单 + 管理舱搜索双模式（Ctrl+K 保留原命令列表）
  const [searchMode, setSearchMode] = useState<'menu' | 'cockpit'>('menu')
  const [cockpitItems, setCockpitItems] = useState<CockpitSearchItem[]>([])
  const cockpitCacheRef = useRef<{ at: number; items: CockpitSearchItem[] } | null>(null)
  // 2026-09-22: 当前高亮项下标（键盘导航与 Enter 执行的共同依据）
  const [activeIndex, setActiveIndex] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)

  // B2(2026-09-05): 命令清单从 lib/command-defs 派生——与语音别名/全局快捷键同一
  // 命令源, 新增命令只写一处。palette 本地行为(管理舱搜索模式切换)仍在此声明。
  //
  // 2026-09-22 入口自适应: 按使用频次重排（高频浮前）。无记录时保持人工 curated
  // 顺序——新用户看到的与以前完全一致。依赖 open 是刻意的缓存失效键：每次打开
  // 重算一次，用上次会话累计的频次；清单规模很小（十余条），重算成本可忽略。
  const commands = useMemo<Command[]>(() => {
    const byId = new Map(COMMAND_DEFS.map(d => [d.id, d]))
    const ranked = rankCommandIds(COMMAND_DEFS.map(d => d.id)).map(id => {
      const d = byId.get(id) as CommandDef
      return { id: d.id, label: d.label, hint: d.hint, run: d.run }
    })
    // 模式切换项恒排最后——它是"工具"不是"功能"，出现频率与功能选择无关
    ranked.push({ id: 'cockpit-search', label: '搜索管理舱…', hint: '技能/专家/插件/MCP/设置', run: () => { setSearchMode('cockpit'); setQuery('') } })
    return ranked
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

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

  const inCockpit = searchMode === 'cockpit'
  const activeList: Array<Command | CockpitSearchItem> = inCockpit ? cockpitFiltered : filtered

  // 结果集变化时高亮拉回第一项——否则下标可能越界，Enter 会执行到不存在的项
  useEffect(() => { setActiveIndex(0) }, [query, searchMode])

  // 高亮项滚入可视区（键盘下移到列表底部时必需）
  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open])

  // 管理舱搜索结果选中 → __cockpit.openWith(tab, section, keyword) 直达对应面板
  const selectCockpitItem = (item: CockpitSearchItem) => {
    executeCommand('cockpit', 'openWith', item.tab, item.section, item.keyword)
    setOpen(false)
    setSearchMode('menu')
  }

  /** 执行列表项——键盘 Enter 与鼠标点击共用（此前两处各写一份分支） */
  const runItem = (item: Command | CockpitSearchItem | undefined) => {
    if (!item) return
    if (inCockpit) { selectCockpitItem(item as CockpitSearchItem); return }
    const cmd = item as Command
    // 2026-09-22 入口自适应: 记录命中频次，供下次打开时重排。
    // 只记面板通道——语音是自然语言，不需要排名，故不在此模块学习。
    recordCommandUse(cmd.id)
    // 2026-08-27 A4: 'cockpit-search' 切模式且不关闭——run() 置 cockpit 模式, 重开会重置回 menu
    if (cmd.id === 'cockpit-search') { cmd.run(); setQuery('') } else { cmd.run(); setOpen(false) }
  }

  const close = () => { setOpen(false); setSearchMode('menu') }

  if (!open) return null

  const optionId = (i: number) => `cp-opt-${i}`

  return (
    <div className="command-palette-overlay" onClick={close}>
      <div
        className="command-palette"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
      >
        <input
          autoFocus
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={inCockpit ? '搜索技能/专家/插件/MCP 服务/设置项…（Esc 关闭）' : '输入命令或功能名…（↑↓ 选择，Esc 关闭）'}
          role="combobox"
          aria-expanded
          aria-controls="cp-list"
          aria-activedescendant={activeList.length > 0 ? optionId(activeIndex) : undefined}
          aria-autocomplete="list"
          onKeyDown={e => {
            if (e.key === 'Escape') { close(); e.stopPropagation(); return }
            // 2026-09-22: 方向键在列表内循环移动高亮（此前无导航，Enter 恒执行第一条）
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              if (activeList.length === 0) return
              e.preventDefault()
              e.stopPropagation()
              setActiveIndex(i => {
                const n = activeList.length
                const cur = Math.min(Math.max(i, 0), n - 1)
                return e.key === 'ArrowDown' ? (cur + 1) % n : (cur - 1 + n) % n
              })
              return
            }
            if (e.key === 'Enter') {
              // 执行当前高亮项（越界时回落首项，保持旧行为不吞键）
              runItem(activeList[activeIndex] ?? activeList[0])
              e.stopPropagation()
            }
          }}
        />
        <div className="command-palette-list" id="cp-list" role="listbox" ref={listRef}>
          {activeList.length === 0 && query.trim()
            ? <div className="command-palette-empty">{inCockpit ? '无匹配结果' : '无匹配命令'}</div>
            : null}
          {activeList.map((item, idx) => (
            <button
              key={item.id}
              id={optionId(idx)}
              data-idx={idx}
              role="option"
              aria-selected={idx === activeIndex}
              className={`command-palette-item${idx === activeIndex ? ' is-active' : ''}`}
              onMouseEnter={() => setActiveIndex(idx)}
              onClick={() => runItem(item)}
            >
              <span>{item.label}</span>
              {'hint' in item && item.hint ? <em>{item.hint}</em> : null}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
