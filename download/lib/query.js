/**
 * query.js — Fluent Query Builder
 *
 * Provides a chainable API for building complex graph queries.
 * Inspired by dependency-cruiser's rule engine and CodeGraph's context builder.
 *
 * Usage:
 *   const results = graph.query()
 *     .fromType('screen')
 *     .edgeKind('import')
 *     .depth(3)
 *     .where(node => node.is_exported)
 *     .run();
 */

class QueryBuilder {
  constructor(graph) {
    this.graph = graph;
    this._startIds = null;
    this._types = null;
    this._edgeKinds = null;
    this._direction = 'out';
    this._maxDepth = Infinity;
    this._filter = null;
    this._includeEdges = false;
    this._limit = null;
    this._excludeTypes = null;
  }

  // ──── Start points ────

  from(nodeId) {
    this._startIds = [nodeId];
    return this;
  }

  fromMany(nodeIds) {
    this._startIds = nodeIds;
    return this;
  }

  fromType(type) {
    this._types = Array.isArray(type) ? type : [type];
    return this;
  }

  // ──── Edge filters ────

  edgeKind(kind) {
    this._edgeKinds = Array.isArray(kind) ? kind : [kind];
    return this;
  }

  direction(dir) {
    this._direction = dir; // 'out' | 'in' | 'both'
    return this;
  }

  // ──── Depth ────

  depth(d) {
    this._maxDepth = d;
    return this;
  }

  // ──── Node filters ────

  where(fn) {
    this._filter = fn;
    return this;
  }

  excludeType(type) {
    this._excludeTypes = Array.isArray(type) ? type : [type];
    return this;
  }

  // ──── Output options ────

  includeEdges() {
    this._includeEdges = true;
    return this;
  }

  limit(n) {
    this._limit = n;
    return this;
  }

  // ──── Execute ────

  run() {
    // If no start IDs, use type filter to find them
    let startIds = this._startIds;
    if (!startIds || startIds.length === 0) {
      if (this._types) {
        const nodes = this.graph.storage.getAllNodes();
        startIds = nodes
          .filter(n => this._types.includes(n.type))
          .map(n => n.id);
      } else {
        // All nodes
        startIds = [...this.graph._nodeSet];
      }
    }

    // Build node filter
    const nodeFilter = (nodeId) => {
      if (this._excludeTypes) {
        const node = this.graph.storage.getNode(nodeId);
        if (node && this._excludeTypes.includes(node.type)) return false;
      }
      if (this._filter) {
        const node = this.graph.storage.getNode(nodeId);
        if (node && !this._filter(node)) return false;
      }
      return true;
    };

    // BFS from each start node
    const visited = new Set();
    let results = [];

    for (const startId of startIds) {
      if (visited.has(startId)) continue;

      const bfsResult = this.graph.bfs(startId, {
        direction: this._direction,
        edgeKinds: this._edgeKinds,
        maxDepth: this._maxDepth,
        nodeFilter,
      });

      for (const r of bfsResult) {
        if (!visited.has(r.nodeId)) {
          visited.add(r.nodeId);
          results.push(r);
        }
      }
    }

    if (this._limit) results = results.slice(0, this._limit);

    // Optionally include edges
    if (this._includeEdges) {
      const edges = [];
      const nodeIds = new Set(results.map(r => r.nodeId));
      for (const r of results) {
        const outEdges = this.graph.storage.getOutgoingEdges(r.nodeId);
        for (const e of outEdges) {
          if (nodeIds.has(e.target) && (!this._edgeKinds || this._edgeKinds.includes(e.kind))) {
            edges.push(e);
          }
        }
      }
      return { nodes: results, edges };
    }

    return results;
  }

  // ──── Convenience Methods ────

  /** Get all nodes that the start node depends on */
  getDependencies(startId, depth = 10) {
    return this.from(startId).direction('out').depth(depth).run();
  }

  /** Get all nodes that depend on the start node */
  getDependents(startId, depth = 10) {
    return this.from(startId).direction('in').depth(depth).run();
  }

  /** Get the full dependency chain from screens to services */
  getScreenToServiceFlow() {
    return this.fromType('screen')
      .direction('out')
      .edgeKind(['import', 'call', 'jsx'])
      .depth(5)
      .includeEdges()
      .run();
  }

  /** Get API call flow */
  getAPIFlow() {
    return this.edgeKind('api_call')
      .direction('out')
      .depth(3)
      .includeEdges()
      .run();
  }

  /** Get component tree (JSX parent → child) */
  getComponentTree() {
    return this.fromType('component')
      .edgeKind('jsx')
      .direction('out')
      .depth(10)
      .includeEdges()
      .run();
  }
}

module.exports = { QueryBuilder };
