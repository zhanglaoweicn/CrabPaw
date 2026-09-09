import { useEffect, useRef, memo } from 'react'
import * as d3 from 'd3'

export interface D3Node extends d3.SimulationNodeDatum {
  id: string
  label: string
  type: string
  /** 事件类型：memory/tool_use/entity/skill/workflow/event */
  event_type?: string
  size?: number
  color?: string
  count?: number
  _deg?: number
  _childCount?: number
  _core?: boolean
  _ts?: number
  _strength?: number
}

export interface D3Edge {
  source: string | D3Node
  target: string | D3Node
  weight: number
  label?: string
  _kind?: 'real' | 'visual_parent' | 'visual_random'
}

// 色板（2026-08-01: 亮暗主题自适应——此前固定暗色系，
// 亮色主题下图谱背景变浅后节点/连线对比度不足）
// 双主题适配（与 ThemeContext 联动，独立于 P6 修复任务范围，后续主题阶段统一评审）
function getGraphTheme() {
  const isLight = typeof document !== 'undefined' &&
    document.documentElement.classList.contains('theme-light')
  return isLight ? {
    warm: '#b45309',
    cool: '#1d4ed8',
    nodeLow: '#3b5b7d',
    nodeHigh: '#1e40af',
    linkStroke: 'rgba(30, 64, 175, 0.3)',
    linkVisual: 'rgba(30, 64, 175, 0.18)',
    linkRandom: 'rgba(30, 64, 175, 0.1)',
  } : {
    warm: '#d39872',
    cool: '#5b9bd5',
    nodeLow: '#3a556e',
    nodeHigh: '#cfe3f5',
    linkStroke: 'rgba(143, 182, 216, 0.32)',
    linkVisual: 'rgba(143, 182, 216, 0.20)',
    linkRandom: 'rgba(143, 182, 216, 0.10)',
  }
}

interface MemoryGraphProps {
  nodes: D3Node[]
  edges: D3Edge[]
  onNodeClick?: (node: D3Node) => void
}

// ── 工具：确定性哈希（deterministicIndex）──
function deterministicIndex(seed: string, mod: number): number {
  let hash = 2166136261
  const text = String(seed)
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return Math.abs(hash >>> 0) % mod
}

// ── 工具：确定性洗牌（deterministicIndex，避免每次刷新结构不同）──
function deterministicShuffle<T>(items: T[], seed: string): T[] {
  // 基于 seed 的哈希做稳定排序（同 seed 永远同顺序）
  const indexed = items.map((item, i) => ({
    item,
    index: i,
    hash: deterministicIndex(`${seed}:${i}`, 1e9),
  }))
  // 按 hash 排序（稳定）
  indexed.sort((a, b) => a.hash - b.hash)
  return indexed.map(x => x.item)
}

// ── 视觉顺序：核心节点在前（createVisualOrder）──
function createVisualOrder(nodes: D3Node[]): D3Node[] {
  const coreNode = nodes.find(n => n._core) || null
  // 使用确定性洗牌（基于节点 id），同数据永远同顺序
  const rest = deterministicShuffle(
    nodes.filter(n => !coreNode || n.id !== coreNode.id),
    'graph-order'
  )
  return coreNode ? [coreNode, ...rest] : rest
}

// ── 视觉父节点最大数量（maxVisualChildren）──
function maxVisualChildren(node: D3Node | undefined): number {
  if (!node) return 2
  if (node._core) return 4
  const degree = node._deg || 0
  const strength = node._strength || 0
  return (degree >= 4 || strength >= 0.72) ? 4 : 2
}

// ── 选择视觉父节点（chooseVisualParent，确定性版本）──
function chooseVisualParent(
  child: D3Node,
  candidates: D3Node[],
  childCounts: Map<string, number>
): D3Node | null {
  if (!candidates.length) return null
  const weighted: D3Node[] = []
  candidates.forEach(candidate => {
    const currentChildren = childCounts.get(candidate.id) || 0
    const maxChildren = maxVisualChildren(candidate)
    const recencyBias = Math.max(0, 400000 - Math.abs((child._ts || 0) - (candidate._ts || 0))) / 100000
    const coreBias = candidate._core ? 1.4 : 0
    const strengthBias = (candidate._strength || 0.4) * 0.8
    const remainingCapacity = Math.max(0, maxChildren - currentChildren)
    const capacityBias = currentChildren === 0 ? 1.2 : 0.35 + remainingCapacity * 0.25
    const entryCount = 1 + Math.max(0, Math.round((recencyBias + coreBias + strengthBias + capacityBias) * 2))
    for (let w = 0; w < entryCount; w++) {
      weighted.push(candidate)
    }
  })
  if (!weighted.length) {
    // 兜底：用确定性索引（不是 Math.random）保证稳定
    const fallback = candidates[deterministicIndex(child.id, candidates.length)]
    return fallback || null
  }
  // 关键：用确定性索引代替 Math.random，同 child 永远选同一父节点
  const idx = deterministicIndex(`parent:${child.id}`, weighted.length)
  return weighted[idx] || null
}

// ── 主算法：随机视觉连线（addRandomVisualLinks）──
function addRandomVisualLinks(nodeData: D3Node[]): D3Edge[] {
  if (nodeData.length < 2) return []
  const ordered = createVisualOrder(nodeData)
  const childCounts = new Map<string, number>(ordered.map(n => [n.id, 0]))
  const links: D3Edge[] = []
  const linkSet = new Set<string>()

  for (let i = 1; i < ordered.length; i++) {
    const child = ordered[i]
    const candidates = ordered
      .slice(0, i)
      .filter(node => (childCounts.get(node.id) || 0) < maxVisualChildren(node))

    const parent = chooseVisualParent(child, candidates, childCounts)
    if (!parent || parent.id === child.id) continue

    const lid = `visual:${child.id}=>${parent.id}`
    const rev = `visual:${parent.id}=>${child.id}`
    if (linkSet.has(lid) || linkSet.has(rev)) continue

    linkSet.add(lid)
    links.push({ source: child.id, target: parent.id, weight: 0.3, _kind: 'visual_parent' })
    childCounts.set(parent.id, (childCounts.get(parent.id) || 0) + 1)
  }

  // 补充视觉连线（addSupplementalVisualLinks，确定性版）
  const extraLinks = Math.min(18, Math.max(2, Math.floor(nodeData.length / 5)))
  let added = 0
  for (let i = 1; i < ordered.length && added < extraLinks; i++) {
    const source = ordered[i]
    // 确定性洗牌（基于 source.id），同 source 永远同顺序
    const candidates = deterministicShuffle(
      ordered.slice(0, i).filter(node => {
        if (node.id === source.id) return false
        return (childCounts.get(node.id) || 0) < maxVisualChildren(node)
      }),
      `extra:${source.id}`
    )
    const target = candidates[0]
    if (!target) continue
    const lid = `visual-extra:${source.id}=>${target.id}`
    const rev = `visual-extra:${target.id}=>${source.id}`
    const base = `visual:${source.id}=>${target.id}`
    const baseRev = `visual:${target.id}=>${source.id}`
    if (linkSet.has(lid) || linkSet.has(rev) || linkSet.has(base) || linkSet.has(baseRev)) continue
    linkSet.add(lid)
    links.push({ source: source.id, target: target.id, weight: 0.15, _kind: 'visual_random' })
    childCounts.set(target.id, (childCounts.get(target.id) || 0) + 1)
    added += 1
  }
  return links
}

function nodeStrength(d: D3Node): number {
  if (d._strength !== undefined) return d._strength
  const deg = Math.min(1, (d._deg || 0) / 12)
  d._strength = 0.35 + deg * 0.55
  return d._strength
}

function nodeColor(d: D3Node): string {
  const THEME = getGraphTheme()
  if (d._core) return THEME.warm
  const age = (Date.now() - (d._ts || Date.now())) / 18000
  const fade = Math.max(0.25, 1 - age)
  const t = 0.18 + nodeStrength(d) * 0.5 * fade
  const interp = d3.interpolateRgb(THEME.nodeLow, THEME.nodeHigh)
  let color = interp(Math.min(1, t))
  const base = d3.color(color)
  if (base) color = base.darker(0.55) + ''
  return color
}

function nodeRadius(d: D3Node, sizeMultiplier: number = 1): number {
  const base = d._core ? 9 : 3.4 + Math.min((d._deg || 0) * 0.9, 5.4)
  const childScale = 1 + Math.min(1.5, (d._childCount || 0) * 0.18)
  const scaledBase = base * sizeMultiplier
  return Math.min(scaledBase * 2.5, scaledBase * childScale)
}

function linkDistance(link: D3Edge, nodeCount: number): number {
  const countFactor = Math.min(34, Math.sqrt(Math.max(1, nodeCount)) * 4.2)
  if (link._kind === 'visual_parent') return 82 + countFactor * 0.45
  if (link._kind === 'visual_random') return 108 + countFactor
  return 76 + countFactor * 0.55
}

function linkStrength(link: D3Edge): number {
  if (link._kind === 'visual_parent') return 0.2
  if (link._kind === 'visual_random') return 0.035
  return 0.16
}

function chargeStrength(node: D3Node, nodeCount: number): number {
  const countBoost = Math.min(76, Math.sqrt(Math.max(1, nodeCount)) * 3.5)
  return -92 - countBoost * 0.4 - (node._deg || 0) * 2.4 - (node._childCount || 0) * 1.2
}

function collisionRadius(d: D3Node, nodeCount: number): number {
  const padding = nodeCount > 36 ? 6 : 4
  return nodeRadius(d) + padding
}

export function MemoryGraph({ nodes, edges, onNodeClick }: MemoryGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  // 用 ref 缓存 onNodeClick，避免父组件每次渲染都重建导致 useEffect 重跑（图谱闪动）
  const onNodeClickRef = useRef(onNodeClick)
  useEffect(() => {
    onNodeClickRef.current = onNodeClick
  }, [onNodeClick])

  // 关键：缓存上次节点位置（prevPositions），重建图谱时保留 x/y
  // 避免每次重渲染都"清空重启"导致图谱闪动
  const prevPositionsRef = useRef<Map<string, { x?: number; y?: number; vx?: number; vy?: number; fx?: number | null; fy?: number | null }>>(new Map())

  // 把 nodes 序列化成稳定 key（按 id 排序 + 用 _ts 校验）
  // 同数据保留位置，避免每次重建图谱
  const nodesKey = nodes.map(n => `${n.id}:${n._ts || 0}`).sort().join('|')
  const edgesKey = edges.map(e => {
    const s = typeof e.source === 'object' ? (e.source as D3Node).id : e.source
    const t = typeof e.target === 'object' ? (e.target as D3Node).id : e.target
    return `${s}->${t}`
  }).sort().join('|')

  // MG1: ref to track current wheel handler for proper cleanup/removal
  const wheelHandlerRef = useRef<((e: WheelEvent) => void) | null>(null)

  useEffect(() => {
    const container = containerRef.current
    const svgEl = svgRef.current
    if (!container || !svgEl || nodes.length === 0) return

    const W = container.clientWidth || 800
    const H = container.clientHeight || 600

    const svg = d3.select(svgEl)
    svg.selectAll('*').remove()

    // ── 1. SVG defs：辉光滤镜 ──
    const defs = svg.append('defs')
    const filter = defs.append('filter')
      .attr('id', 'neb-glow')
      .attr('x', '-70%').attr('y', '-70%')
      .attr('width', '240%').attr('height', '240%')
    filter.append('feGaussianBlur')
      .attr('stdDeviation', '3.2')
      .attr('result', 'blur')
    const merge = filter.append('feMerge')
    merge.append('feMergeNode').attr('in', 'blur')
    merge.append('feMergeNode').attr('in', 'SourceGraphic')

    // ── 2. 数据预处理 ──
    // 关键：基于节点 id 确定性生成时间戳和初始位置（保证同数据每次结构一致）
    // 关键：保留上次位置（prevPositions），避免每次重渲染都从中心开始
    const nodeData: D3Node[] = nodes.map(n => {
      const hash = deterministicIndex(`init:${n.id}`, 1000)
      const prev = prevPositionsRef.current.get(n.id)
      return {
        ...n,
        _deg: 0,
        _childCount: 0,
        // 确定性时间戳：id 相同的节点永远得到相同 _ts
        _ts: n._ts || (Date.now() - (hash * 5)),
        // 保留上次位置（loadMemories 911-913）
        x: prev?.x,
        y: prev?.y,
        vx: prev?.vx,
        vy: prev?.vy,
        fx: prev?.fx,
        fy: prev?.fy,
      }
    })

    nodeData.forEach(n => {
      if (n.id === 'welcome' || n.id === 'memory' || n.id === 'knowledge') {
        n._core = true
      }
    })

    // ── 3. 真实连线 + 自动视觉连线（addRandomVisualLinks）──
    // 关键：先构建 nodeById，再过滤掉引用不存在节点的边（d3-force 会因孤儿边崩溃）
    const nodeById = new Map(nodeData.map(n => [String(n.id), n]))
    const realLinks: D3Edge[] = edges
      .map(e => ({ ...e, _kind: 'real' as const }))
      .filter(e => {
        const s = typeof e.source === 'object' ? (e.source as D3Node).id : e.source
        const t = typeof e.target === 'object' ? (e.target as D3Node).id : e.target
        const hasS = nodeById.has(String(s))
        const hasT = nodeById.has(String(t))
        if (!hasS || !hasT) {
          // 孤儿边：后端可能在多轮提取过程中产生引用缺失节点的边（如 doc_xxx）
          // 静默丢弃，仅开发模式打印
          if (typeof console !== 'undefined' && console.debug) {
            console.debug('[MemoryGraph] 丢弃孤儿边:', s, '->', t)
          }
        }
        return hasS && hasT
      })
    const visualLinks: D3Edge[] = addRandomVisualLinks(nodeData)
    const linkData: D3Edge[] = [...realLinks, ...visualLinks]

    linkData.forEach(l => {
      const s = typeof l.source === 'object' ? l.source : nodeById.get(String(l.source))
      const t = typeof l.target === 'object' ? l.target : nodeById.get(String(l.target))
      if (s) s._deg = (s._deg || 0) + 1
      if (t) t._deg = (t._deg || 0) + 1
    })
    linkData.forEach(l => {
      const s = typeof l.source === 'object' ? l.source : nodeById.get(String(l.source))
      if (s) s._childCount = (s._childCount || 0) + 1
    })

    // ── 4. tooltip（showTip）──
    // 优化：tooltip 用 transform: translate 替代 left/top，避免 mousemove 强制 reflow
    // 这是 251ms "Forced reflow" 的根因之一
    let tipMoveRaf: number | null = null
    const tip = d3.select(container)
      .append('div')
      .style('position', 'fixed')           // 脱离文档流，不影响布局
      .style('top', '0')
      .style('left', '0')
      .style('will-change', 'transform')    // 提示浏览器走 GPU 合成层
      .style('display', 'none')
      .style('background', 'rgba(15, 23, 42, 0.92)')
      .style('color', '#e2e8f0')
      .style('padding', '8px 12px')
      .style('border-radius', '6px')
      .style('font-size', '12px')
      .style('line-height', '1.4')
      .style('max-width', '280px')
      .style('pointer-events', 'none')
      .style('z-index', '1000')
      .style('border', '1px solid rgba(143, 182, 216, 0.3)')
      .style('box-shadow', '0 4px 12px rgba(0, 0, 0, 0.4)')

    function showTip(event: MouseEvent, d: D3Node) {
      const label = d.label || String(d.id)
      const eventType = d._core ? 'self' : (d.event_type || d.type || 'memory')
      // 安全: 用 text() 而非 html() 拼接 —— label/eventType 来自后端数据,可能含 HTML
      tip.selectAll('*').remove()
      tip.append('div')
        .style('font-weight', '600')
        .style('color', d._core ? '#d39872' : '#cfe3f5')
        .text(label)
      tip.append('div')
        .style('opacity', '0.7')
        .style('font-size', '11px')
        .text(`类型: ${eventType}`)
      if (d._deg) {
        tip.append('div').style('opacity', '0.7').style('font-size', '11px').text(`连接: ${d._deg}`)
      }
      if (d._childCount) {
        tip.append('div').style('opacity', '0.7').style('font-size', '11px').text(`子节点: ${d._childCount}`)
      }
      tip.style('display', 'block')
        .style('transform', `translate(${event.clientX + 14}px, ${event.clientY + 12}px)`)
    }

    // ── 5. 力模拟（参数）──
    const nodeCount = nodeData.length
    const centerX = W / 2
    const centerY = H / 2 - 10

    const sim = d3.forceSimulation(nodeData)
      .force('link', d3.forceLink<D3Node, D3Edge>(linkData)
        .id(d => String(d.id))
        .distance(l => linkDistance(l, nodeCount))
        .strength(l => linkStrength(l)))
      .force('charge', d3.forceManyBody<D3Node>()
        .strength(n => chargeStrength(n, nodeCount)))
      .force('center', d3.forceCenter(centerX, centerY).strength(0.04))
      .force('x', d3.forceX(centerX).strength(0.04))
      .force('y', d3.forceY(centerY - 10).strength(0.04))
      .force('radial', d3.forceRadial(180, centerX, centerY).strength(0.1))
      .force('collide', d3.forceCollide<D3Node>()
        .radius(d => collisionRadius(d, nodeCount))
        .strength(0.82)
        // 优化：节点多时降级迭代次数
        .iterations(nodeCount > 80 ? 1 : (nodeCount > 40 ? 2 : 3)))
      // 优化：alphaDecay 提速（原 0.028 → 0.05）让 200+ 节点更快收敛
      .alphaDecay(nodeCount > 80 ? 0.05 : 0.035)
      .alphaMin(0.02)
      .velocityDecay(0.35)

    // ── 6. 渲染层（带 zoom 变换）──
    const world = svg.append('g')
    const gLink = world.append('g').attr('stroke-linecap', 'round')
    const gNode = world.append('g')

    // 连线
    const linkSel = gLink.selectAll<SVGLineElement, D3Edge>('line')
      .data(linkData)
      .join('line')
      .attr('stroke', d => {
        // 视觉连线更淡（亮暗主题自适应色板）
        const THEME = getGraphTheme()
        if (d._kind === 'visual_parent') return THEME.linkVisual
        if (d._kind === 'visual_random') return THEME.linkRandom
        return THEME.linkStroke
      })
      .attr('stroke-width', d => d._kind === 'real' ? 0.6 : 0.4)

    // neb-blink 关键原理：96% 时闪 0.35 透明度（4% 占比）
  // 入场用 CSS 动画，不抖动节点位置
  // hover 不改 r（只改发光强度）
  // ── neb-node-use 动画：10s 缓动淡入（0.88 → 1 → 0.9 → 1）──
  const style = document.createElement('style')
  style.id = 'memory-graph-animations'
  style.textContent = `
    @keyframes neb-node-use {
      0% { opacity: 0.88; }
      28% { opacity: 1; }
      58% { opacity: 0.9; }
      100% { opacity: 1; }
    }
    @keyframes neb-blink {
      0%, 92%, 100% { opacity: 1; }
      96% { opacity: 0.35; }
    }
    .neb-node-blink {
      animation: neb-blink 2.6s ease-in-out infinite;
      transform-origin: center;
    }
    .neb-node-pulse {
      animation: neb-node-use 10s ease-out;
    }
  `
  if (!document.getElementById('memory-graph-animations')) {
    document.head.appendChild(style)
  }

  // 节点
  const nodeSel = gNode.selectAll<SVGCircleElement, D3Node>('circle')
    .data(nodeData)
    .join('circle')
    .attr('r', d => nodeRadius(d))
    .attr('fill', d => nodeColor(d))
    .attr('filter', d => d._core ? 'url(#neb-glow)' : null)
    .style('cursor', 'pointer')
    .classed('neb-node-blink', d => d._core || (d._strength || 0) > 0.7)
    .classed('neb-node-pulse', d => (d._strength || 0) > 0.85)
    // 拖拽（740-751）
    .call(d3.drag<SVGCircleElement, D3Node>()
      .on('start', (event, d) => {
        if (!event.active) sim.alphaTarget(2).restart()
        d.fx = d.x
        d.fy = d.y
      })
      .on('drag', (event, d) => {
        d.fx = event.x
        d.fy = event.y
      })
      .on('end', (event, d) => {
        if (!event.active) sim.alphaTarget(0)
        d.fx = null
        d.fy = null
      })
    )
    .on('click', (_e, d) => {
      // 758-761：点击高亮节点
      d._ts = Date.now()
      d._strength = Math.min(1, (d._strength || 0.5) + 0.25)
      // 触发 neb-node-pulse 动画
      const sel = d3.select(_e.currentTarget as SVGCircleElement)
      sel.classed('neb-node-pulse', true)
      setTimeout(() => sel.classed('neb-node-pulse', false), 10000)
      // 优化：异步调用 onNodeClick（避免同步触发的 React re-render 阻塞事件循环）
      // 此前在事件循环中同步调用会触发 onNodeClick 闭包里的 setState
      // 序列化多个 click 任务，避免 376ms 累计
      setTimeout(() => onNodeClickRef.current?.(d), 0)
    })
    .on('mouseover', function (event, d) {
      // 不改 r，只显示 tooltip
      showTip(event as MouseEvent, d)
    })
    .on('mousemove', (event) => {
      // 优化：mousemove 用 rAF 批处理 + transform 替代 left/top
      // 解决 "Forced reflow" 警告
      const e = event as MouseEvent
      if (tipMoveRaf) return  // 已有待执行帧，丢弃
      tipMoveRaf = requestAnimationFrame(() => {
        tipMoveRaf = null
        tip.style('transform', `translate(${e.clientX + 14}px, ${e.clientY + 12}px)`)
      })
    })
    .on('mouseout', function () {
      // 只隐藏 tooltip
      if (tipMoveRaf) { cancelAnimationFrame(tipMoveRaf); tipMoveRaf = null }
      tip.style('display', 'none')
    })

    // ── 7. zoom 缩放（295-313）──
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 5])
      .filter((event: any) => event.type === 'wheel')
      .on('zoom', (event) => {
        world.attr('transform', event.transform.toString())
      })

    svg.call(zoom)
    svg.on('wheel.zoom', null)
    svg.on('dblclick.zoom', null)

    // P5 fix: 保存 wheel handler 引用，以便在 cleanup 中移除
    // MG1: remove previous wheel handler before adding a new one
    if (wheelHandlerRef.current) {
      svg.node()?.removeEventListener('wheel', wheelHandlerRef.current)
    }
    const wheelHandler = (event: WheelEvent) => {
      event.preventDefault()
      const current = d3.zoomTransform(svg.node() as Element)
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12
      const nextScale = Math.max(0.1, Math.min(5, current.k * factor))
      const k = nextScale / current.k
      const cx = W / 2
      const cy = H / 2
      const nextX = current.x - (cx - current.x) * (1 - k) + (event.clientX - cx) * (1 - k)
      const nextY = current.y - (cy - current.y) * (1 - k) + (event.clientY - cy) * (1 - k)
      svg.call(zoom.transform, d3.zoomIdentity.translate(nextX, nextY).scale(nextScale))
    }
    wheelHandlerRef.current = wheelHandler
    svg.node()?.addEventListener('wheel', wheelHandler, { passive: false })

    // ── 8. 切向阻尼 ──
    function dampTangentialMotion() {
      const cx = centerX
      const cy = centerY
      const twitching = sim.alpha() > 0.45

      nodeData.forEach(node => {
        if (!node || node.fx != null || node.fy != null) return
        const dx = (node.x ?? cx) - cx
        const dy = (node.y ?? cy) - cy
        const dist = Math.hypot(dx, dy)
        if (dist < 0.001) return
        const rx = dx / dist
        const ry = dy / dist
        const tx = -ry
        const ty = rx
        const vx = node.vx || 0
        const vy = node.vy || 0
        const radialVelocity = vx * rx + vy * ry
        const tangentialVelocity = vx * tx + vy * ty
        const tangentialDamping = twitching ? 0.14 : 0.24
        node.vx = radialVelocity * rx + tangentialVelocity * tangentialDamping * tx
        node.vy = radialVelocity * ry + tangentialVelocity * tangentialDamping * ty
      })
    }

    // ── 9. tick：30fps 节流（598-605）──
    // 优化 1：用 performance.now 限频到 30fps（原来 60fps，CPU 占用减半）
    // 优化 2：alpha 极低时直接跳过整个 tick（避免热循环浪费）
    // 优化 3：用 sub-selection 分组写入，D3 内部已批量处理
    let tickParity = 0
    let lastTickTime = 0
    const TICK_INTERVAL_MS = 1000 / 30
    sim.on('tick', () => {
      dampTangentialMotion()

      const now = performance.now()
      if (now - lastTickTime < TICK_INTERVAL_MS) return
      lastTickTime = now

      // 模拟已收敛：跳过渲染但仍更新 alpha 衰减
      if (sim.alpha() < 0.005 && sim.alphaTarget() === 0) {
        tickParity = 0
        return
      }
      tickParity ^= 1
      if (tickParity && sim.alphaTarget() === 0) return

      linkSel
        .attr('x1', d => (d.source as D3Node).x ?? 0)
        .attr('y1', d => (d.source as D3Node).y ?? 0)
        .attr('x2', d => (d.target as D3Node).x ?? 0)
        .attr('y2', d => (d.target as D3Node).y ?? 0)

      nodeSel
        .attr('cx', d => d.x ?? 0)
        .attr('cy', d => d.y ?? 0)
    })

    // ── 10. 强度衰减（988：每 2.5s 强度 × 0.97）──
    const decayInterval = setInterval(() => {
      nodeData.forEach(n => {
        if (n._strength) n._strength *= 0.97
      })
    }, 2500)

    // ── 11. 自然抽动 5-9 秒 ──
    let isVisible = !document.hidden
    const visibilityHandler = () => {
      isVisible = !document.hidden
    }
    document.addEventListener('visibilitychange', visibilityHandler)

    let twitchTimer: ReturnType<typeof setTimeout> | null = null
    function scheduleTwitch() {
      if (twitchTimer) clearTimeout(twitchTimer)
      if (!isVisible) return
      const delay = 5000 + Math.random() * 4000
      twitchTimer = setTimeout(() => {
        if (isVisible) {
          sim.alpha(0.18).restart()
        }
        scheduleTwitch()
      }, delay)
    }
    scheduleTwitch()

    // ── 12. 窗口 resize ──
    const handleResize = () => {
      const nw = container.clientWidth
      const nh = container.clientHeight
      svg.attr('width', nw).attr('height', nh)
      sim.force('center', d3.forceCenter(nw / 2, nh / 2))
      sim.force('x', d3.forceX(nw / 2))
      sim.force('y', d3.forceY(nh / 2 - 10))
      sim.alpha(0.3).restart()
    }
    const ro = new ResizeObserver(handleResize)
    ro.observe(container)

    return () => {
      // 关键：清理前保存所有节点位置，下一次重建时恢复
      try {
        nodeData.forEach(n => {
          prevPositionsRef.current.set(n.id, {
            x: n.x, y: n.y, vx: n.vx, vy: n.vy, fx: n.fx, fy: n.fy
          })
        })
        // 限制缓存大小，避免内存泄漏
        if (prevPositionsRef.current.size > 500) {
          const keys = Array.from(prevPositionsRef.current.keys()).slice(0, 200)
          keys.forEach(k => prevPositionsRef.current.delete(k))
        }
      } catch (e) { console.error('[MemoryGraph] 保存节点位置失败:', e) }
      // 优化：清理 mousemove 的 rAF（避免组件卸载后还在跑）
      if (tipMoveRaf) { cancelAnimationFrame(tipMoveRaf); tipMoveRaf = null }
      sim.stop()
      ro.disconnect()
      document.removeEventListener('visibilitychange', visibilityHandler)
      // P5 fix: 移除 wheel 事件监听器
      // MG1: also clear the ref
      if (wheelHandlerRef.current) {
        svg.node()?.removeEventListener('wheel', wheelHandlerRef.current)
        wheelHandlerRef.current = null
      }
      // P8 fix: 移除注入的 style 元素
      const styleEl = document.getElementById('memory-graph-animations')
      if (styleEl) styleEl.remove()
      if (twitchTimer) clearTimeout(twitchTimer)
      clearInterval(decayInterval)
      tip.remove()
    }
  }, [nodesKey, edgesKey])

  return (
    <div ref={containerRef} style={{
      width: '100%', height: '100%', position: 'relative',
      overflow: 'hidden',
      // 2026-08-01: 亮暗主题自适应——此前硬编码深黑蓝径向渐变，
      // 亮色主题下 Home 图谱（中间栏）整块深色，与整体色系不搭配
      background: 'var(--graph-bg, radial-gradient(ellipse at center, #0a0a18 0%, #000003 100%))',
    }}>
      {nodes.length === 0 ? (
        <div style={{
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          height: '100%', gap: 16,
          color: '#64748b',
        }}>
          <div style={{ fontSize: 64, opacity: 0.2 }}>🧠</div>
          <div style={{ fontSize: 16, fontWeight: 300, color: '#94a3b8' }}>
            暂无记忆节点
          </div>
          <div style={{ fontSize: 12, color: '#64748b' }}>
            开始对话后图谱将自动构建
          </div>
        </div>
      ) : (
        <svg ref={svgRef} width="100%" height="100%" style={{ display: 'block' }} />
      )}
    </div>
  )
}

// 优化：React.memo 防止父组件无数据变化的 setState 触发整个图谱重渲染
// （200 节点 + 455 边的 useEffect 重跑成本很高）
export default memo(MemoryGraph)
