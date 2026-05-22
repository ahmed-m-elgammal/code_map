/**
 * graph.js — Core Graph Module
 *
 * Implements graph algorithms on top of the Storage backend.
 * Inspired by dependency-cruiser's IndexedModuleGraph and CodeGraph's GraphTraverser.
 *
 * Algorithms:
 *   - BFS / DFS traversal
 *   - Cycle detection (DFS back-edge)
 *   - Reachability (transitive closure along edge types)
 *   - Topological sort
 *   - Shortest path (BFS)
 *   - Betweenness centrality (approximate)
 *   - Community detection (label propagation)
 *   - Dead code detection (zero in-degree + not exported)
 *   - Orphan detection (zero in + zero out)
 */

class CoreGraph {
  constructor(storage) {
    this.storage = storage;
    this._adjacencyOut = null; // Map<nodeId, Set<nodeId>>
    this._adjacencyIn = null;  // Map<nodeId, Set<nodeId>>
    this._edgeIndex = null;    // Map<sourceId_targetId, edge[]>
  }

  // ──────────── Build In-Memory Indices ────────────

  buildIndex() {
    const nodes = this.storage.getAllNodes();
    const edges = this.storage.getAllEdges();

    this._adjacencyOut = new Map();
    this._adjacencyIn = new Map();
    this._edgeIndex = new Map();
    this._nodeSet = new Set(nodes.map(n => n.id));

    for (const n of nodes) {
      this._adjacencyOut.set(n.id, new Map()); // targetId → [edge]
      this._adjacencyIn.set(n.id, new Map());  // sourceId → [edge]
    }

    for (const e of edges) {
      if (!this._adjacencyOut.has(e.source)) this._adjacencyOut.set(e.source, new Map());
      if (!this._adjacencyIn.has(e.target)) this._adjacencyIn.set(e.target, new Map());

      const outMap = this._adjacencyOut.get(e.source);
      if (!outMap.has(e.target)) outMap.set(e.target, []);
      outMap.get(e.target).push(e);

      const inMap = this._adjacencyIn.get(e.target);
      if (!inMap.has(e.source)) inMap.set(e.source, []);
      inMap.get(e.source).push(e);

      const key = `${e.source}→${e.target}`;
      if (!this._edgeIndex.has(key)) this._edgeIndex.set(key, []);
      this._edgeIndex.get(key).push(e);
    }

    return this;
  }

  // ──────────── Traversal ────────────

  /**
   * BFS from start node. Returns array of {nodeId, depth, path}.
   * Options: direction ('out'|'in'|'both'), edgeKinds, maxDepth, nodeFilter
   */
  bfs(startId, options = {}) {
    const { direction = 'out', edgeKinds = null, maxDepth = Infinity, nodeFilter = null } = options;
    const visited = new Set();
    const result = [];
    const queue = [{ id: startId, depth: 0, path: [startId] }];
    visited.add(startId);

    while (queue.length > 0) {
      const { id, depth, path } = queue.shift();
      if (depth > maxDepth) continue;

      if (nodeFilter ? nodeFilter(id) : true) {
        result.push({ nodeId: id, depth, path: [...path] });
      }

      if (depth >= maxDepth) continue;

      const neighbors = this._getNeighbors(id, direction, edgeKinds);
      for (const neighborId of neighbors) {
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          queue.push({ id: neighborId, depth: depth + 1, path: [...path, neighborId] });
        }
      }
    }

    return result;
  }

  /**
   * DFS from start node. Returns array of {nodeId, depth, path}.
   */
  dfs(startId, options = {}) {
    const { direction = 'out', edgeKinds = null, maxDepth = Infinity, nodeFilter = null } = options;
    const visited = new Set();
    const result = [];

    const _dfs = (id, depth, path) => {
      if (depth > maxDepth) return;
      visited.add(id);

      if (nodeFilter ? nodeFilter(id) : true) {
        result.push({ nodeId: id, depth, path: [...path] });
      }

      if (depth >= maxDepth) return;

      const neighbors = this._getNeighbors(id, direction, edgeKinds);
      for (const neighborId of neighbors) {
        if (!visited.has(neighborId)) {
          _dfs(neighborId, depth + 1, [...path, neighborId]);
        }
      }
    };

    _dfs(startId, 0, [startId]);
    return result;
  }

  _getNeighbors(nodeId, direction, edgeKinds) {
    const neighbors = new Set();

    if (direction === 'out' || direction === 'both') {
      const outMap = this._adjacencyOut.get(nodeId);
      if (outMap) {
        for (const [targetId, edges] of outMap) {
          if (!edgeKinds || edges.some(e => edgeKinds.includes(e.kind))) {
            neighbors.add(targetId);
          }
        }
      }
    }

    if (direction === 'in' || direction === 'both') {
      const inMap = this._adjacencyIn.get(nodeId);
      if (inMap) {
        for (const [sourceId, edges] of inMap) {
          if (!edgeKinds || edges.some(e => edgeKinds.includes(e.kind))) {
            neighbors.add(sourceId);
          }
        }
      }
    }

    return neighbors;
  }

  // ──────────── Cycle Detection ────────────

  /**
   * Detect all cycles in the graph. Returns array of cycles (each is an array of nodeIds).
   * Uses DFS with coloring (white=unvisited, gray=in-progress, black=done).
   * Edge-kinds filter supported.
   */
  detectCycles(edgeKinds = null) {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map();
    const cycles = [];
    const path = [];
    const pathSet = new Set();

    for (const nodeId of this._nodeSet) {
      color.set(nodeId, WHITE);
    }

    const _dfs = (nodeId) => {
      color.set(nodeId, GRAY);
      path.push(nodeId);
      pathSet.add(nodeId);

      const neighbors = this._getNeighbors(nodeId, 'out', edgeKinds);
      for (const neighborId of neighbors) {
        if (color.get(neighborId) === GRAY && pathSet.has(neighborId)) {
          // Found a cycle — extract it
          const cycleStart = path.indexOf(neighborId);
          if (cycleStart >= 0) {
            cycles.push(path.slice(cycleStart));
          }
        } else if (color.get(neighborId) === WHITE) {
          _dfs(neighborId);
        }
      }

      path.pop();
      pathSet.delete(nodeId);
      color.set(nodeId, BLACK);
    };

    for (const nodeId of this._nodeSet) {
      if (color.get(nodeId) === WHITE) {
        _dfs(nodeId);
      }
    }

    return cycles;
  }

  // ──────────── Reachability ────────────

  /**
   * Can node `fromId` reach node `toId` through any transitive path?
   * Returns the path if reachable, null otherwise.
   */
  canReach(fromId, toId, edgeKinds = null) {
    if (fromId === toId) return [fromId];
    const visited = new Set();
    const queue = [{ id: fromId, path: [fromId] }];
    visited.add(fromId);

    while (queue.length > 0) {
      const { id, path } = queue.shift();
      const neighbors = this._getNeighbors(id, 'out', edgeKinds);
      for (const neighborId of neighbors) {
        if (neighborId === toId) return [...path, neighborId];
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          queue.push({ id: neighborId, path: [...path, neighborId] });
        }
      }
    }

    return null;
  }

  // ──────────── Topological Sort ────────────

  /**
   * Returns nodes in topological order (dependencies first).
   * Returns null if cycles exist.
   */
  topologicalSort(edgeKinds = null) {
    const inDegree = new Map();
    for (const nodeId of this._nodeSet) {
      inDegree.set(nodeId, 0);
    }

    for (const nodeId of this._nodeSet) {
      const neighbors = this._getNeighbors(nodeId, 'out', edgeKinds);
      for (const neighborId of neighbors) {
        inDegree.set(neighborId, (inDegree.get(neighborId) || 0) + 1);
      }
    }

    const queue = [];
    for (const [nodeId, deg] of inDegree) {
      if (deg === 0) queue.push(nodeId);
    }

    const order = [];
    while (queue.length > 0) {
      const nodeId = queue.shift();
      order.push(nodeId);
      const neighbors = this._getNeighbors(nodeId, 'out', edgeKinds);
      for (const neighborId of neighbors) {
        const newDeg = inDegree.get(neighborId) - 1;
        inDegree.set(neighborId, newDeg);
        if (newDeg === 0) queue.push(neighborId);
      }
    }

    return order.length === this._nodeSet.size ? order : null; // null = has cycles
  }

  // ──────────── Shortest Path ────────────

  shortestPath(fromId, toId, edgeKinds = null) {
    return this.canReach(fromId, toId, edgeKinds);
  }

  // ──────────── Orphan Detection ────────────

  getOrphans() {
    const orphans = [];
    for (const nodeId of this._nodeSet) {
      const outMap = this._adjacencyOut.get(nodeId);
      const inMap = this._adjacencyIn.get(nodeId);
      const hasOut = outMap && outMap.size > 0;
      const hasIn = inMap && inMap.size > 0;
      if (!hasOut && !hasIn) orphans.push(nodeId);
    }
    return orphans;
  }

  // ──────────── Dead Code Detection ────────────

  getDeadCode() {
    const dead = [];
    for (const nodeId of this._nodeSet) {
      const inMap = this._adjacencyIn.get(nodeId);
      const hasIncoming = inMap && inMap.size > 0;
      const node = this.storage.getNode(nodeId);
      if (!hasIncoming && node && !node.is_exported && node.type !== 'file') {
        dead.push(nodeId);
      }
    }
    return dead;
  }

  // ──────────── Community Detection (Label Propagation) ────────────

  detectCommunities(maxIterations = 20) {
    const labels = new Map();
    let i = 0;

    // Initialize: each node is its own community
    for (const nodeId of this._nodeSet) {
      labels.set(nodeId, i++);
    }

    // Iterate label propagation
    for (let iter = 0; iter < maxIterations; iter++) {
      let changed = false;
      const nodeIds = [...this._nodeSet];
      // Shuffle for fairness
      for (let j = nodeIds.length - 1; j > 0; j--) {
        const k = Math.floor(Math.random() * (j + 1));
        [nodeIds[j], nodeIds[k]] = [nodeIds[k], nodeIds[j]];
      }

      for (const nodeId of nodeIds) {
        const neighbors = this._getNeighbors(nodeId, 'both');
        if (neighbors.size === 0) continue;

        const labelCounts = new Map();
        for (const neighborId of neighbors) {
          const l = labels.get(neighborId);
          labelCounts.set(l, (labelCounts.get(l) || 0) + 1);
        }

        let bestLabel = labels.get(nodeId);
        let bestCount = 0;
        for (const [label, count] of labelCounts) {
          if (count > bestCount) {
            bestCount = count;
            bestLabel = label;
          }
        }

        if (bestLabel !== labels.get(nodeId)) {
          labels.set(nodeId, bestLabel);
          changed = true;
        }
      }

      if (!changed) break;
    }

    // Group nodes by community
    const communities = new Map();
    for (const [nodeId, label] of labels) {
      if (!communities.has(label)) communities.set(label, []);
      communities.get(label).push(nodeId);
    }

    return [...communities.values()].filter(c => c.length > 1);
  }

  // ──────────── Get Edges Between Two Nodes ────────────

  getEdgesBetween(sourceId, targetId) {
    const key = `${sourceId}→${targetId}`;
    return this._edgeIndex.get(key) || [];
  }

  // ──────────── Impact Analysis ────────────

  /**
   * Returns all nodes that transitively depend on the given node
   * (i.e., the "blast radius" of changing this node).
   */
  impactOf(nodeId, maxDepth = 10) {
    return this.bfs(nodeId, { direction: 'in', maxDepth });
  }

  /**
   * Returns all nodes that the given node transitively depends on
   * (i.e., everything it needs to function).
   */
  dependsOn(nodeId, maxDepth = 10) {
    return this.bfs(nodeId, { direction: 'out', maxDepth });
  }
}

module.exports = { CoreGraph };
