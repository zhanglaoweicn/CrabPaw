/**
 * diagram-generator — 架构/流程图生成（真实 Mermaid 源码）
 * 用法：execute({ diagramType: 'flowchart'|'sequence'|'class'|'er', nodes: [...], edges: [...], title })
 */
function escapeLabel(s) {
  return String(s ?? '').replace(/["\n\r]/g, ' ').slice(0, 60);
}

function buildMermaid(params) {
  const type = params.diagramType || 'flowchart';
  const nodes = Array.isArray(params.nodes) ? params.nodes : [];
  const edges = Array.isArray(params.edges) ? params.edges : [];
  const title = params.title ? `---\ntitle: ${escapeLabel(params.title)}\n---\n` : '';

  if (type === 'sequence') {
    const lines = ['sequenceDiagram'];
    for (const e of edges) {
      lines.push(`  ${escapeLabel(e.from)}->>${escapeLabel(e.to)}: ${escapeLabel(e.label || '')}`);
    }
    return title + lines.join('\n');
  }
  if (type === 'class') {
    const lines = ['classDiagram'];
    for (const n of nodes) {
      const name = String(n.id ?? n.name ?? 'Class');
      const fields = Array.isArray(n.fields) ? n.fields.map(f => `    +${escapeLabel(f)}`) : [];
      lines.push(`  class ${name} {`);
      lines.push(...fields);
      lines.push('  }');
    }
    for (const e of edges) {
      lines.push(`  ${escapeLabel(e.from)} <|-- ${escapeLabel(e.to)}`);
    }
    return title + lines.join('\n');
  }
  // flowchart / er 默认
  const lines = [type === 'er' ? 'erDiagram' : 'flowchart LR'];
  for (const n of nodes) {
    const id = String(n.id ?? n.name ?? 'Node');
    lines.push(`  ${id}["${escapeLabel(n.label || n.name || id)}"]`);
  }
  for (const e of edges) {
    const from = String(e.from ?? '');
    const to = String(e.to ?? '');
    if (from && to) {
      lines.push(`  ${from} -->|"${escapeLabel(e.label || '')}"| ${to}`);
    }
  }
  return title + lines.join('\n');
}

async function execute(params = {}) {
  try {
    const mermaid = buildMermaid(params);
    // class 类型的连线是 <|--，一并纳入校验
    if (!/-->|->>|<\|--/.test(mermaid)) {
      return { success: false, error: '缺少有效的节点连线（edges）', mermaid };
    }
    return { success: true, mermaid, note: '前端 MermaidBlock 可直接渲染；导出 PNG 需 mermaid-cli' };
  } catch (err) {
    console.error('[diagram-generator] 失败:', err);
    return { success: false, error: `图解生成失败: ${err.message}` };
  }
}

module.exports = { execute };
