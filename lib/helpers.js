/**
 * helpers.js — Code Helpers (Convenience API)
 *
 * High-level wrappers around the graph for common codebase questions.
 * These are the "app-level" operations a developer would actually want.
 */

class CodeHelpers {
  constructor(graph) {
    this.graph = graph;
    this.storage = graph.storage;
  }

  // ──────────── "Who..." Queries ────────────

  /** Who imports this file/symbol? */
  whoImports(nodeId) {
    return this.graph.bfs(nodeId, { direction: 'in', edgeKinds: ['import'], maxDepth: 1 })
      .filter(r => r.nodeId !== nodeId);
  }

  /** Who calls this function? */
  whoCalls(nodeId) {
    return this.graph.bfs(nodeId, { direction: 'in', edgeKinds: ['call', 'references'], maxDepth: 1 })
      .filter(r => r.nodeId !== nodeId);
  }

  /** Who uses this component in JSX? */
  whoUsesComponent(nodeId) {
    return this.graph.bfs(nodeId, { direction: 'in', edgeKinds: ['jsx'], maxDepth: 1 })
      .filter(r => r.nodeId !== nodeId);
  }

  /** Who makes this API call? (trace back to screen/component) */
  whoCallsAPI(nodeId) {
    return this.graph.bfs(nodeId, { direction: 'in', maxDepth: 5 })
      .filter(r => r.nodeId !== nodeId);
  }

  // ──────────── "What..." Queries ────────────

  /** What does this node depend on? */
  whatDependsOn(nodeId, depth = 3) {
    return this.graph.bfs(nodeId, { direction: 'out', maxDepth: depth })
      .filter(r => r.nodeId !== nodeId);
  }

  /** What files would be affected by changing this node? (impact analysis) */
  impactOf(nodeId) {
    return this.graph.impactOf(nodeId);
  }

  /** What API calls does this screen/component make? */
  apiCallsFrom(nodeId) {
    return this.graph.bfs(nodeId, { direction: 'out', edgeKinds: ['api_call'], maxDepth: 5 })
      .filter(r => r.nodeId !== nodeId);
  }

  /** What components does this screen render? */
  componentsUsedBy(nodeId) {
    return this.graph.bfs(nodeId, { direction: 'out', edgeKinds: ['jsx'], maxDepth: 3 })
      .filter(r => r.nodeId !== nodeId);
  }

  // ──────────── Architecture Queries ────────────

  /** Get all screens and their direct dependencies */
  getScreenMap() {
    const screens = this.storage.getNodesByType('screen');
    return screens.map(screen => ({
      screen,
      imports: this.storage.getIncomingEdges(screen.id).filter(e => e.kind === 'import'),
      components: this.storage.getIncomingEdges(screen.id).filter(e => e.kind === 'jsx'),
      apiCalls: this.storage.getOutgoingEdges(screen.id).filter(e => e.kind === 'api_call'),
    }));
  }

  /** Get the component tree (parent → child JSX relationships) */
  getComponentTree() {
    const components = this.storage.getNodesByType('component');
    return components.map(comp => ({
      component: comp,
      children: this.storage.getOutgoingEdges(comp.id).filter(e => e.kind === 'jsx'),
      parents: this.storage.getIncomingEdges(comp.id).filter(e => e.kind === 'jsx'),
    }));
  }

  /** Get all API endpoints and their callers */
  getAPIMap() {
    const apiNodes = this.storage.getNodesByType('api');
    const endpoints = this.storage.getNodesByType('endpoint');
    const all = [...apiNodes, ...endpoints];
    return all.map(api => ({
      api,
      callers: this.storage.getIncomingEdges(api.id),
      implementations: this.storage.getOutgoingEdges(api.id),
    }));
  }

  /** Get the data flow: stores → hooks → components → screens */
  getDataFlow() {
    const storeEdges = this.storage.getEdgesByKind('call');
    const hookNodes = this.storage.getNodesByType('hook');
    const storeNodes = this.storage.getNodesByType('store');

    return {
      stores: storeNodes.map(s => ({
        store: s,
        consumers: this.storage.getIncomingEdges(s.id).filter(e => e.kind === 'import' || e.kind === 'call'),
      })),
      hooks: hookNodes.map(h => ({
        hook: h,
        storeUsage: this.storage.getOutgoingEdges(h.id).filter(e => e.kind === 'call' && storeNodes.some(s => s.id === e.target)),
        consumers: this.storage.getIncomingEdges(h.id).filter(e => e.kind === 'import'),
      })),
    };
  }

  // ──────────── Health Queries ────────────

  /** Detect circular dependencies */
  findCycles() {
    return this.graph.detectCycles();
  }

  /** Find orphaned nodes (no connections) */
  findOrphans() {
    return this.graph.getOrphans();
  }

  /** Find potentially dead code */
  findDeadCode() {
    return this.graph.getDeadCode();
  }

  /** Find highly coupled nodes (high fan-in + fan-out) */
  findHotspots(topN = 10) {
    const nodes = this.storage.getAllNodes();
    return nodes
      .map(n => ({
        node: n,
        fanIn: n.fan_in || 0,
        fanOut: n.fan_out || 0,
        totalConnections: (n.fan_in || 0) + (n.fan_out || 0),
      }))
      .sort((a, b) => b.totalConnections - a.totalConnections)
      .slice(0, topN);
  }

  /** Find unstable modules (instability near 1.0 = hard to change, many dependents) */
  findUnstableModules(topN = 10) {
    const nodes = this.storage.getAllNodes();
    return nodes
      .filter(n => n.instability !== undefined && n.instability !== null)
      .sort((a, b) => a.instability - b.instability)
      .slice(0, topN)
      .map(n => ({ node: n, instability: n.instability }));
  }

  /** Get communities (clusters of tightly connected nodes) */
  findCommunities() {
    return this.graph.detectCommunities();
  }

  // ──────────── Export for Visualizer ────────────

  /**
   * Build a visualization-ready JSON with multiple "views" of the codebase.
   * Each view focuses on a different aspect:
   *   - dependency: file/module import graph
   *   - component: React component tree (JSX parent→child)
   *   - callgraph: function call relationships
   *   - apiflow: API/network call flow
   *   - architecture: high-level module grouping
   */
  buildVisualizationData() {
    const nodes = this.storage.getAllNodes();
    const edges = this.storage.getAllEdges();
    const stats = this.storage.getStats();

    // Compute communities for architecture view
    this.graph.buildIndex();
    const communities = this.graph.detectCommunities();
    const communityMap = new Map();
    communities.forEach((members, idx) => {
      for (const m of members) communityMap.set(m, idx);
    });

    // Add community info to nodes
    const vizNodes = nodes.map(n => ({
      ...n,
      community: communityMap.get(n.id) ?? -1,
    }));

    // Categorize edges by kind for view filtering
    const edgeViews = {
      dependency: edges.filter(e => ['import', 'external'].includes(e.kind)),
      component:  edges.filter(e => ['jsx', 'contains'].includes(e.kind)),
      callgraph:  edges.filter(e => ['call', 'references'].includes(e.kind)),
      apiflow:    edges.filter(e => ['api_call'].includes(e.kind)),
    };

    // Build layer map for architecture view
    const layers = this._computeLayers(nodes, edges);

    // Cycles
    const cycles = this.graph.detectCycles();

    // Hotspots
    const hotspots = this.findHotspots(20);

    return {
      nodes: vizNodes,
      edges,
      edgeViews,
      layers,
      cycles,
      communities,
      hotspots,
      stats,
      version: 2,
      exportedAt: new Date().toISOString(),
    };
  }

  /**
   * Compute architectural layers based on node types.
   * Inspired by dependency-cruiser's folder aggregation.
   */
  _computeLayers(nodes, edges) {
    const LAYER_ORDER = ['screen', 'component', 'hook', 'store', 'service', 'api', 'file', 'package', 'endpoint'];
    const layers = {};

    for (const type of LAYER_ORDER) {
      const typeNodes = nodes.filter(n => n.type === type);
      if (typeNodes.length === 0) continue;

      const typeEdges = edges.filter(e =>
        typeNodes.some(n => n.id === e.source) || typeNodes.some(n => n.id === e.target)
      );

      layers[type] = {
        nodes: typeNodes,
        internalEdges: edges.filter(e =>
          typeNodes.some(n => n.id === e.source) && typeNodes.some(n => n.id === e.target)
        ),
        incomingEdges: edges.filter(e =>
          !typeNodes.some(n => n.id === e.source) && typeNodes.some(n => n.id === e.target)
        ),
        outgoingEdges: edges.filter(e =>
          typeNodes.some(n => n.id === e.source) && !typeNodes.some(n => n.id === e.target)
        ),
      };
    }

    return layers;
  }
}

module.exports = { CodeHelpers };
