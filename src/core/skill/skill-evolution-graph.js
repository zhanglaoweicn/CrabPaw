/**
 * Skill Evolution Graph - 技能进化图谱
 *
 * 超越 Hermes-Agent 的创新模块：
 * - 构建技能间的进化关系图（衍生、合并、分裂、替代）
 * - 追踪技能的进化谱系（从哪个技能演变而来）
 * - 基于进化图谱预测技能碎片化风险
 * - 自适应学习：根据使用模式推荐技能进化方向
 *
 * 进化关系类型：
 *   - derived_from: A 从 B 演变而来（B 是 A 的祖先）
 *   - merged_into: A 被合并进 B（A 是 B 的组成部分）
 *   - split_from: A 从 B 分裂而来（B 太大，A 独立出去）
 *   - replaced_by: A 被 B 替代（A 过时，B 是现代版本）
 *   - references: A 引用了 B 的内容（弱依赖）
 */

const fs = require('fs');
const path = require('path');
const { getCrabPawSubDir } = require('../path-utils');

const EVOLUTION_RELATIONS = {
  DERIVED_FROM: 'derived_from',
  MERGED_INTO: 'merged_into',
  SPLIT_FROM: 'split_from',
  REPLACED_BY: 'replaced_by',
  REFERENCES: 'references',
};

const GRAPH_FILE = '.skill-evolution-graph.json';

function _graphPath() {
  return path.join(getCrabPawSubDir('skills'), GRAPH_FILE);
}

function loadGraph() {
  const gPath = _graphPath();
  if (!fs.existsSync(gPath)) {
    return { nodes: {}, edges: [] };
  }
  try {
    const data = JSON.parse(fs.readFileSync(gPath, 'utf-8'));
    return data || { nodes: {}, edges: [] };
  } catch {
    return { nodes: {}, edges: [] };
  }
}

function saveGraph(graph) {
  const gPath = _graphPath();
  const dir = path.dirname(gPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = gPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(graph, null, 2), 'utf-8');
  fs.renameSync(tmpPath, gPath);
}

function addNode(skillName, metadata = {}) {
  const graph = loadGraph();
  graph.nodes[skillName] = {
    name: skillName,
    createdAt: metadata.createdAt || new Date().toISOString(),
    lastEvolvedAt: metadata.lastEvolvedAt || null,
    generation: metadata.generation || 0,
    fitnessScore: metadata.fitnessScore || 1.0,
    ...metadata,
  };
  saveGraph(graph);
  return graph.nodes[skillName];
}

function addEdge(fromSkill, toSkill, relation, metadata = {}) {
  const graph = loadGraph();
  const existing = graph.edges.find(
    e => e.from === fromSkill && e.to === toSkill && e.relation === relation
  );
  if (existing) {
    Object.assign(existing, metadata, { updatedAt: new Date().toISOString() });
  } else {
    graph.edges.push({
      from: fromSkill,
      to: toSkill,
      relation,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...metadata,
    });
  }
  saveGraph(graph);
}

function getAncestors(skillName) {
  const graph = loadGraph();
  const ancestors = [];
  const visited = new Set();
  const queue = [skillName];

  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);

    const parentEdges = graph.edges.filter(
      e => e.from === current && (e.relation === EVOLUTION_RELATIONS.DERIVED_FROM || e.relation === EVOLUTION_RELATIONS.SPLIT_FROM)
    );
    for (const edge of parentEdges) {
      if (!visited.has(edge.to)) {
        ancestors.push({ name: edge.to, relation: edge.relation });
        queue.push(edge.to);
      }
    }
  }

  return ancestors;
}

function getDescendants(skillName) {
  const graph = loadGraph();
  const descendants = [];
  const visited = new Set();
  const queue = [skillName];

  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);

    const childEdges = graph.edges.filter(
      e => e.to === current && (e.relation === EVOLUTION_RELATIONS.DERIVED_FROM || e.relation === EVOLUTION_RELATIONS.SPLIT_FROM)
    );
    for (const edge of childEdges) {
      if (!visited.has(edge.from)) {
        descendants.push({ name: edge.from, relation: edge.relation });
        queue.push(edge.from);
      }
    }
  }

  return descendants;
}

function recordConsolidation(sourceSkills, umbrellaSkill) {
  for (const source of sourceSkills) {
    addEdge(source, umbrellaSkill, EVOLUTION_RELATIONS.MERGED_INTO, {
      consolidationReason: 'umbrella_consolidation',
    });
  }
  const generation = Math.max(
    0,
    ...sourceSkills.map(s => {
      const graph = loadGraph();
      return (graph.nodes[s] && graph.nodes[s].generation) || 0;
    })
  ) + 1;
  addNode(umbrellaSkill, { generation, lastEvolvedAt: new Date().toISOString() });
}

function recordReplacement(oldSkill, newSkill, reason) {
  addEdge(oldSkill, newSkill, EVOLUTION_RELATIONS.REPLACED_BY, { reason });
  const graph = loadGraph();
  const oldGen = (graph.nodes[oldSkill] && graph.nodes[oldSkill].generation) || 0;
  addNode(newSkill, { generation: oldGen + 1, lastEvolvedAt: new Date().toISOString() });
}

function detectFragmentation() {
  const graph = loadGraph();
  const { agentCreatedReport } = require('./skill-usage-telemetry');
  const agentSkills = agentCreatedReport();

  const prefixGroups = new Map();
  for (const skill of agentSkills) {
    const parts = skill.name.toLowerCase().split(/[-_]/);
    if (parts.length < 2) continue;
    const prefix = parts[0];
    if (!prefixGroups.has(prefix)) prefixGroups.set(prefix, []);
    prefixGroups.get(prefix).push(skill);
  }

  const fragmentationAlerts = [];
  for (const [prefix, members] of prefixGroups) {
    if (members.length < 3) continue;

    const hasUmbrella = members.some(m => {
      const node = graph.nodes[m.name];
      return node && node.generation > 0;
    });

    const totalUsage = members.reduce((sum, m) => sum + m.use_count, 0);
    const avgUsage = totalUsage / members.length;

    if (!hasUmbrella && avgUsage < 5) {
      fragmentationAlerts.push({
        prefix,
        count: members.length,
        members: members.map(m => m.name),
        avgUsage: avgUsage.toFixed(1),
        recommendation: `Consider consolidating ${members.length} "${prefix}-*" skills into an umbrella skill`,
        severity: members.length >= 5 ? 'high' : 'medium',
      });
    }
  }

  return fragmentationAlerts;
}

function calculateFitnessScore(skillName) {
  const { getRecord } = require('./skill-usage-telemetry');
  const { getSkillOrigin } = require('./skill-provenance');
  const graph = loadGraph();
  const record = getRecord(skillName);
  // eslint-disable-next-line no-unused-vars
  const origin = getSkillOrigin(skillName);
  const node = graph.nodes[skillName] || {};

  let score = 1.0;

  // Usage bonus
  const useCount = record.use_count || 0;
  if (useCount > 20) score += 0.3;
  else if (useCount > 5) score += 0.15;

  // Patch frequency indicates active maintenance
  const patchCount = record.patch_count || 0;
  if (patchCount > 3) score += 0.2;
  else if (patchCount > 0) score += 0.1;

  // Generation bonus (evolved skills are more refined)
  const generation = node.generation || 0;
  score += Math.min(generation * 0.1, 0.3);

  // Descendant penalty (if skill has been replaced by descendants)
  const descendants = getDescendants(skillName);
  if (descendants.length > 0) score -= 0.2;

  // Staleness penalty
  const lastActivity = record.last_used_at || record.last_viewed_at;
  if (lastActivity) {
    const daysSinceUse = (Date.now() - new Date(lastActivity).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceUse > 30) score -= 0.2;
    else if (daysSinceUse > 14) score -= 0.1;
  }

  return Math.max(0, Math.min(2, score));
}

function getEvolutionRecommendations() {
  const alerts = detectFragmentation();
  const { agentCreatedReport } = require('./skill-usage-telemetry');
  const agentSkills = agentCreatedReport();

  const recommendations = [];

  // Fragmentation-based recommendations
  for (const alert of alerts) {
    recommendations.push({
      type: 'consolidate',
      priority: alert.severity,
      skills: alert.members,
      rationale: alert.recommendation,
    });
  }

  // Low fitness recommendations
  for (const skill of agentSkills) {
    const fitness = calculateFitnessScore(skill.name);
    if (fitness < 0.5) {
      recommendations.push({
        type: 'archive_or_replace',
        priority: 'medium',
        skills: [skill.name],
        rationale: `Low fitness score (${fitness.toFixed(2)}): consider archiving or replacing`,
      });
    }
  }

  // Stale skills with high patch count (candidates for replacement)
  const staleWithPatches = agentSkills.filter(
    s => s.state === 'stale' && s.patch_count > 2
  );
  for (const skill of staleWithPatches) {
    recommendations.push({
      type: 'replace',
      priority: 'high',
      skills: [skill.name],
      rationale: `Stale skill with ${skill.patch_count} patches: likely needs a fresh rewrite`,
    });
  }

  return recommendations.sort((a, b) => {
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    return (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2);
  });
}

function getLineage(skillName) {
  const ancestors = getAncestors(skillName);
  const descendants = getDescendants(skillName);
  const graph = loadGraph();
  const node = graph.nodes[skillName] || {};

  return {
    skill: skillName,
    generation: node.generation || 0,
    fitnessScore: calculateFitnessScore(skillName),
    ancestors,
    descendants,
    relatedEdges: graph.edges.filter(e => e.from === skillName || e.to === skillName),
  };
}

function getStats() {
  const graph = loadGraph();
  const nodeCount = Object.keys(graph.nodes).length;
  const edgeCount = graph.edges.length;

  const relationCounts = {};
  for (const edge of graph.edges) {
    relationCounts[edge.relation] = (relationCounts[edge.relation] || 0) + 1;
  }

  const maxGeneration = Math.max(0, ...Object.values(graph.nodes).map(n => n.generation || 0));

  return {
    nodeCount,
    edgeCount,
    relationCounts,
    maxGeneration,
    fragmentationAlerts: detectFragmentation().length,
  };
}

function toMermaid() {
  const graph = loadGraph();
  const lines = ['graph TD'];

  const RELATION_LABELS = {
    [EVOLUTION_RELATIONS.DERIVED_FROM]: 'derived from',
    [EVOLUTION_RELATIONS.MERGED_INTO]: 'merged into',
    [EVOLUTION_RELATIONS.SPLIT_FROM]: 'split from',
    [EVOLUTION_RELATIONS.REPLACED_BY]: 'replaced by',
    [EVOLUTION_RELATIONS.REFERENCES]: 'references',
  };

  const RELATION_STYLES = {
    [EVOLUTION_RELATIONS.DERIVED_FROM]: '-->',
    [EVOLUTION_RELATIONS.MERGED_INTO]: '-->',
    [EVOLUTION_RELATIONS.SPLIT_FROM]: '-->',
    [EVOLUTION_RELATIONS.REPLACED_BY]: '-.->',
    [EVOLUTION_RELATIONS.REFERENCES]: '-.->',
  };

  // Add nodes with generation and fitness info
  for (const [name, node] of Object.entries(graph.nodes)) {
    const gen = node.generation || 0;
    const fitness = typeof node.fitnessScore === 'number'
      ? node.fitnessScore.toFixed(2)
      : calculateFitnessScore(name).toFixed(2);
    const label = `${name}\\nGen${gen} F:${fitness}`;
    lines.push(`  ${_mermaidId(name)}["${label}"]`);
  }

  lines.push('');

  // Add edges
  for (const edge of graph.edges) {
    const arrow = RELATION_STYLES[edge.relation] || '-->';
    const label = RELATION_LABELS[edge.relation] || edge.relation;
    lines.push(`  ${_mermaidId(edge.from)} ${arrow}|${label}| ${_mermaidId(edge.to)}`);
  }

  // Add style classes for generation levels
  lines.push('');
  lines.push('  classDef gen0 fill:#e1f5fe,stroke:#0288d1');
  lines.push('  classDef gen1 fill:#e8f5e9,stroke:#388e3c');
  lines.push('  classDef gen2 fill:#fff3e0,stroke:#f57c00');
  lines.push('  classDef gen3 fill:#fce4ec,stroke:#c62828');

  for (const [name, node] of Object.entries(graph.nodes)) {
    const gen = Math.min(node.generation || 0, 3);
    lines.push(`  class ${_mermaidId(name)} gen${gen}`);
  }

  return lines.join('\n');
}

function _mermaidId(name) {
  return name.replace(/[^a-zA-Z0-9]/g, '_');
}

function toLineageTree(skillName) {
  const lineage = getLineage(skillName);
  const lines = ['graph TD'];

  function addNode(name, depth) {
    const gen = lineage.generation || 0;
    const fitness = lineage.fitnessScore.toFixed(2);
    lines.push(`  ${_mermaidId(name)}["${name}\\nGen:${gen} F:${fitness}"]`);

    for (const anc of lineage.ancestors) {
      lines.push(`  ${_mermaidId(name)} -->|${anc.relation}| ${_mermaidId(anc.name)}`);
      addNode(anc.name, depth + 1);
    }

    for (const desc of lineage.descendants) {
      lines.push(`  ${_mermaidId(desc.name)} -->|${desc.relation}| ${_mermaidId(name)}`);
    }
  }

  addNode(skillName, 0);
  return lines.join('\n');
}

module.exports = {
  EVOLUTION_RELATIONS,
  loadGraph,
  saveGraph,
  addNode,
  addEdge,
  getAncestors,
  getDescendants,
  recordConsolidation,
  recordReplacement,
  detectFragmentation,
  calculateFitnessScore,
  getEvolutionRecommendations,
  getLineage,
  getStats,
  toMermaid,
  toLineageTree,
};
