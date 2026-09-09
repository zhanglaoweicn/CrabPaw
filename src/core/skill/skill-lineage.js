/**
 * Skill Lineage — 技能血缘追踪
 *
 * Tracks skill derivation/inheritance/combination relationships:
 *   - recordDerivation(parentSkill, childSkill, type, metadata)
 *     type: 'derived' | 'forked' | 'fused' | 'captured' | 'imported_from'
 *   - getAncestors(skillName)     → array of ancestor skills
 *   - getDescendants(skillName)   → array of descendant skills
 *   - getAffectedSkills(changedSkill) → skills that may be affected by a change
 *   - getLineageGraph(skillName)  → complete lineage tree
 *   - exportLineageDot()          → DOT format for visualization
 *
 * Storage:
 *   data/.crabpaw/lineage/lineage.json — edge list
 *   Format:
 *     { "edges": [{ "from": "parent", "to": "child", "type": "derived",
 *                   "timestamp": "...", "metadata": {} }] }
 *
 * Integration points:
 *   - skill-evolver.js: DERIVED → recordDerivation(parent, child, 'derived')
 *   - composition-discovery-engine.js: fusion → recordDerivation(parents, child, 'fused')
 *   - skill-importer.js: import → recordDerivation(source, child, 'imported_from')
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { DATA_DIR } = require('../config');

const VALID_TYPES = new Set([
  'derived',
  'forked',
  'fused',
  'captured',
  'imported_from',
]);

const LINEAGE_DATA_DIR = path.join(DATA_DIR, 'lineage');
const LINEAGE_FILE = path.join(LINEAGE_DATA_DIR, 'lineage.json');

class SkillLineage extends EventEmitter {
  constructor(config = {}) {
    super();
    this._edges = [];
    this._nodesIndex = new Map();
    this._loaded = false;
    this._config = config;
  }

  initialize() {
    if (this._loaded) return;

    this._load();
    this._buildIndex();
    this._loaded = true;
    console.log(`[SkillLineage] Initialized with ${this._edges.length} edges`);
  }

  recordDerivation(parentSkill, childSkill, type, metadata = {}) {
    if (!this._loaded) this.initialize();

    if (!VALID_TYPES.has(type)) {
      throw new Error(
        `Invalid lineage type: "${type}". Must be one of: ${[...VALID_TYPES].join(', ')}`
      );
    }

    const parents = Array.isArray(parentSkill) ? parentSkill : [parentSkill];
    const normalizedParents = parents.map(p => this._normalizeName(p));
    const normalizedChild = this._normalizeName(childSkill);

    if (normalizedParents.length === 0 || !normalizedChild) {
      throw new Error('Both parent and child skill names are required');
    }

    const newEdges = [];

    for (const parent of normalizedParents) {
      const exists = this._edges.some(
        e =>
          this._normalizeName(e.from) === parent &&
          this._normalizeName(e.to) === normalizedChild &&
          e.type === type
      );

      if (exists) continue;

      const edge = {
        from: parent,
        to: normalizedChild,
        type,
        timestamp: new Date().toISOString(),
        metadata: metadata || {},
      };

      this._edges.push(edge);
      newEdges.push(edge);

      this._ensureNode(parent);
      this._ensureNode(normalizedChild);
      this._nodesIndex.get(parent).descendants.add(normalizedChild);
      this._nodesIndex.get(normalizedChild).ancestors.add(parent);
    }

    if (newEdges.length > 0) {
      this._save();
      this.emit('lineage:recorded', {
        parents: normalizedParents,
        child: normalizedChild,
        type,
      });
      console.log(
        `[SkillLineage] Recorded ${type}: ${normalizedParents.join('+')} → ${normalizedChild}`
      );
    }

    return {
      edges: newEdges,
      isNew: newEdges.length > 0,
    };
  }

  getAncestors(skillName) {
    if (!this._loaded) this.initialize();
    const name = this._normalizeName(skillName);
    return this._traverseAncestors(name);
  }

  getDescendants(skillName) {
    if (!this._loaded) this.initialize();
    const name = this._normalizeName(skillName);
    return this._traverseDescendants(name);
  }

  getAffectedSkills(changedSkill) {
    if (!this._loaded) this.initialize();
    const name = this._normalizeName(changedSkill);

    const ancestors = this._traverseAncestors(name);
    const descendants = this._traverseDescendants(name);

    const directDescendants = this._edges
      .filter(e => this._normalizeName(e.from) === name)
      .map(e => ({
        skill: e.to,
        type: e.type,
        timestamp: e.timestamp,
      }));

    return { ancestors, descendants, directDescendants };
  }

  getLineageGraph(skillName) {
    if (!this._loaded) this.initialize();
    const name = this._normalizeName(skillName);

    const ancestors = this._traverseAncestors(name);
    const descendants = this._traverseDescendants(name);

    const relevantSkills = new Set([name, ...ancestors, ...descendants]);
    const edges = this._edges.filter(
      e =>
        relevantSkills.has(this._normalizeName(e.from)) ||
        relevantSkills.has(this._normalizeName(e.to))
    );

    return {
      skill: name,
      ancestors,
      descendants,
      edges,
    };
  }

  exportLineageDot() {
    if (!this._loaded) this.initialize();

    const lines = ['digraph SkillLineage {'];
    lines.push('  rankdir=LR;');
    lines.push('  node [shape=box, style=filled, fillcolor=lightyellow];');
    lines.push('  edge [fontsize=10];');
    lines.push('');

    const nodes = new Set();
    for (const edge of this._edges) {
      nodes.add(edge.from);
      nodes.add(edge.to);
    }

    for (const node of nodes) {
      const safeName = this._dotSafe(node);
      lines.push(`  "${safeName}" [label="${node}"];`);
    }

    lines.push('');

    const typeColors = {
      derived: 'blue',
      forked: 'green',
      fused: 'purple',
      captured: 'orange',
      imported_from: 'gray',
    };

    for (const edge of this._edges) {
      const from = this._dotSafe(edge.from);
      const to = this._dotSafe(edge.to);
      const color = typeColors[edge.type] || 'black';
      lines.push(`  "${from}" -> "${to}" [label="${edge.type}", color=${color}];`);
    }

    lines.push('}');
    return lines.join('\n');
  }

  getAllEdges() {
    if (!this._loaded) this.initialize();
    return [...this._edges];
  }

  getStats() {
    if (!this._loaded) this.initialize();

    const typeCounts = {};
    const nodes = new Set();
    for (const edge of this._edges) {
      typeCounts[edge.type] = (typeCounts[edge.type] || 0) + 1;
      nodes.add(edge.from);
      nodes.add(edge.to);
    }

    const roots = [];
    for (const node of nodes) {
      if (
        this._nodesIndex.has(node) &&
        this._nodesIndex.get(node).ancestors.size === 0
      ) {
        roots.push(node);
      }
    }

    const leaves = [];
    for (const node of nodes) {
      if (
        this._nodesIndex.has(node) &&
        this._nodesIndex.get(node).descendants.size === 0
      ) {
        leaves.push(node);
      }
    }

    return {
      totalEdges: this._edges.length,
      totalNodes: nodes.size,
      byType: typeCounts,
      roots,
      leaves,
      maxDepth: this._computeMaxDepth(),
    };
  }

  shutdown() {
    this._save();
    this.removeAllListeners();
  }

  _normalizeName(name) {
    if (!name) return '';
    return name.trim().toLowerCase();
  }

  _dotSafe(name) {
    return name.replace(/"/g, '\\"').replace(/\n/g, '\\n');
  }

  _ensureNode(name) {
    if (!this._nodesIndex.has(name)) {
      this._nodesIndex.set(name, { ancestors: new Set(), descendants: new Set() });
    }
  }

  _traverseAncestors(name) {
    const result = [];
    const visited = new Set();
    const queue = [name];

    while (queue.length > 0) {
      const current = queue.shift();
      const node = this._nodesIndex.get(current);
      if (!node) continue;

      for (const ancestor of node.ancestors) {
        if (!visited.has(ancestor)) {
          visited.add(ancestor);
          result.push(ancestor);
          queue.push(ancestor);
        }
      }
    }

    return result;
  }

  _traverseDescendants(name) {
    const result = [];
    const visited = new Set();
    const queue = [name];

    while (queue.length > 0) {
      const current = queue.shift();
      const node = this._nodesIndex.get(current);
      if (!node) continue;

      for (const descendant of node.descendants) {
        if (!visited.has(descendant)) {
          visited.add(descendant);
          result.push(descendant);
          queue.push(descendant);
        }
      }
    }

    return result;
  }

  _computeMaxDepth() {
    let maxDepth = 0;
    for (const [name] of this._nodesIndex) {
      const depth = this._getDepth(name, new Set());
      if (depth > maxDepth) maxDepth = depth;
    }
    return maxDepth;
  }

  _getDepth(name, visited) {
    if (visited.has(name)) return 0;
    visited.add(name);

    const node = this._nodesIndex.get(name);
    if (!node || node.ancestors.size === 0) return 0;

    let maxChildDepth = 0;
    for (const ancestor of node.ancestors) {
      const depth = this._getDepth(ancestor, visited) + 1;
      if (depth > maxChildDepth) maxChildDepth = depth;
    }
    return maxChildDepth;
  }

  _load() {
    try {
      if (fs.existsSync(LINEAGE_FILE)) {
        const data = JSON.parse(fs.readFileSync(LINEAGE_FILE, 'utf-8'));
        if (Array.isArray(data.edges)) {
          this._edges = data.edges;
        }
      }
    } catch (err) {
      console.warn('[SkillLineage] Failed to load lineage data:', err.message);
      this._edges = [];
    }
  }

  _save() {
    try {
      if (!fs.existsSync(LINEAGE_DATA_DIR)) {
        fs.mkdirSync(LINEAGE_DATA_DIR, { recursive: true });
      }

      const data = {
        version: 1,
        updatedAt: new Date().toISOString(),
        edges: this._edges,
      };

      const tmpFile = LINEAGE_FILE + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmpFile, LINEAGE_FILE);
    } catch (err) {
      console.error('[SkillLineage] Failed to save lineage data:', err.message);
    }
  }

  _buildIndex() {
    this._nodesIndex.clear();

    for (const edge of this._edges) {
      const from = this._normalizeName(edge.from);
      const to = this._normalizeName(edge.to);

      this._ensureNode(from);
      this._ensureNode(to);

      this._nodesIndex.get(from).descendants.add(to);
      this._nodesIndex.get(to).ancestors.add(from);
    }
  }
}

let _instance = null;

function getSkillLineage(config) {
  if (!_instance) {
    _instance = new SkillLineage(config);
    _instance.initialize();
  }
  return _instance;
}

module.exports = { SkillLineage, getSkillLineage };
