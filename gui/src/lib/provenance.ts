/**
 * provenance.ts — 数据出处链的前端呈现口径（2026-09-30，P2）
 *
 * 后端 /api/business/provenance 已经把**可核验的事实**整理好了（来源表/导入时间/
 * 行数/空值数/对账差异）。本模块只负责把这些事实变成**人能一眼看懂、且不会误读**的
 * 文案与结构；纯函数，因此"显示什么"可断言。
 *
 * 一条铁律（与 HUD / 晨报同口径）：**不猜、不粉饰**。
 *   · 后端 ok:false → 展示失败原因，不显示一条空链路（空链路会被读成"没有来源"）
 *   · 未登记来源 → 明写"未登记"，不猜文件名
 *   · 空值数未知（null）→ 显示"—"，不显示 0（0 是"没有空值"这个结论）
 *   · 对账差异（注册表列名与真实表不符）→ **必须显示**：这说明视图曾建立在错误的
 *     列名上，是老板判断"这数可不可信"的关键信息
 */

/** 后端返回的出处链结构（与 src/core/business/data-provenance.js 对齐） */
export interface ProvenanceSource {
  table: string | null
  rows: number
  sourceFile: string | null
  importedAt: number | null
  fileHash: string | null
  rowCount: number | null
  superseded: boolean
}

export interface ProvenanceData {
  ok: boolean
  metric: string
  label: string
  view: string | null
  triedViews: string[]
  rows: number | null
  nulls: Record<string, number | null>
  sources: ProvenanceSource[]
  notes: string[]
  unavailableReason?: string
}

export interface ProvenanceNode {
  /** 节点角色，决定样式 */
  kind: 'source' | 'view' | 'metric'
  /** 主文案（表名/视图名/指标名） */
  title: string
  /** 次要文案（行数、来源文件等） */
  subtitle: string | null
  /** 该节点是否可信（false → 琥珀告警样式） */
  trustworthy: boolean
}

export interface ProvenanceView {
  /** 是否可用（false 时只渲染 unavailableReason） */
  ok: boolean
  label: string
  /** 链接路：来源 → 视图 → 指标 */
  nodes: ProvenanceNode[]
  /** 可核验事实行（行数/空值/更新时间） */
  facts: Array<{ key: string; text: string }>
  /** 需要注意的事项（对账差异、未登记来源、视图未重建…） */
  warnings: string[]
  /** 不可用原因（ok=false 时有值） */
  unavailableReason: string | null
}

/** 导入时间的简短展示（本地时区，到分钟） */
export function formatImportedAt(ts: number | null | undefined): string | null {
  if (ts == null || !Number.isFinite(ts)) return null
  try {
    const d = new Date(ts)
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    const hh = String(d.getHours()).padStart(2, '0')
    const mi = String(d.getMinutes()).padStart(2, '0')
    return `${mm}-${dd} ${hh}:${mi}`
  } catch { return null }
}

/** 来源文件名（只取文件名，不暴露完整路径——老板不需要看 D:\...） */
export function shortFileName(p: string | null | undefined): string | null {
  if (!p) return null
  const parts = String(p).split(/[\\/]/)
  return parts[parts.length - 1] || null
}

/** 空值数的展示：null → "—"（未知，不是 0） */
export function formatNullCount(n: number | null | undefined): string {
  return n == null ? '—' : String(n)
}

/**
 * 把后端数据编译成可渲染的视图。
 */
export function buildProvenanceView(data: ProvenanceData | null | undefined): ProvenanceView {
  if (!data) {
    return {
      ok: false,
      label: '数据出处',
      nodes: [],
      facts: [],
      warnings: [],
      unavailableReason: '尚未取到出处信息',
    };
  }

  const label = data.label || data.metric || '数据出处';

  if (!data.ok) {
    return {
      ok: false,
      label,
      nodes: [],
      facts: [],
      warnings: data.notes || [],
      unavailableReason: data.unavailableReason || '取数失败',
    };
  }

  const nodes: ProvenanceNode[] = [];

  // 来源节点（多个来源并排；未登记的明确标注"未登记"，不猜文件名）
  for (const s of data.sources || []) {
    const file = shortFileName(s.sourceFile);
    const when = formatImportedAt(s.importedAt);
    const bits = [
      `${s.rows} 行参与`,
      file ? `${file}` : '来源文件未登记',
      when ? `${when} 导入` : null,
      s.superseded ? '⚠ 已被取代' : null,
    ].filter(Boolean);
    nodes.push({
      kind: 'source',
      title: s.table || '(未知来源)',
      subtitle: bits.join(' · '),
      // 未登记来源不代表不可信（可能是手工建表），但已退役仍出现在视图里是警告
      trustworthy: !s.superseded,
    });
  }

  // 视图节点
  if (data.view) {
    nodes.push({
      kind: 'view',
      title: data.view,
      subtitle: `${data.rows ?? '—'} 行汇总`,
      trustworthy: true,
    });
  }

  // 指标节点
  nodes.push({
    kind: 'metric',
    title: label,
    subtitle: data.rows != null ? `基于 ${data.rows} 行` : null,
    trustworthy: true,
  });

  // 可核验事实
  const facts: Array<{ key: string; text: string }> = [];
  facts.push({ key: '参与行数', text: data.rows == null ? '—' : String(data.rows) });
  const nullKeys = Object.keys(data.nulls || {});
  if (nullKeys.length > 0) {
    facts.push({
      key: '空值',
      text: nullKeys.map((k) => `${k} ${formatNullCount(data.nulls[k])}`).join(' / '),
    });
  }
  facts.push({ key: '来源数', text: String((data.sources || []).length) });

  // 警告：后端 notes 全部保留（对账差异、未登记、退役等）
  const warnings = [...(data.notes || [])];

  return { ok: true, label, nodes, facts, warnings, unavailableReason: null };
}
