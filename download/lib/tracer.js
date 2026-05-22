/**
 * tracer.js — Workflow Tracer Engine
 *
 * Traces end-to-end system workflows through the code graph.
 * Inspired by distributed tracing (OpenTelemetry) applied to static analysis.
 *
 * Two modes:
 *   1. Auto-detect — discovers common flows by naming/path patterns
 *   2. User-defined — loads trace definitions from .codegraph/traces.json
 *
 * A "Trace" is a named workflow with:
 *   - entry: starting node(s) (screen, component, or function name pattern)
 *   - exit: ending node(s) (API call, store mutation, or function name pattern)
 *   - through: intermediate waypoints the flow must pass through
 *   - edgeKinds: which edge types to follow (default: all)
 *   - maxDepth: how deep to search (default: 10)
 *
 * A "TraceResult" contains:
 *   - traceId: the trace definition name
 *   - spans: ordered steps through the graph, each with:
 *       - nodeId, node info, depth, edge kind used to reach it, line number
 *   - paths: all discovered paths from entry to exit
 *   - stats: total steps, unique files touched, API calls, stores accessed
 */

const fs = require('fs');
const path = require('path');

// ──────────── Built-in Auto-Detection Patterns ────────────

const AUTO_TRACE_PATTERNS = [
  {
    id: 'auth',
    name: 'Authentication Flow',
    description: 'Traces the login/signup → token → API call flow',
    entryPatterns: [/login/i, /signin/i, /sign.in/i, /signup/i, /sign.up/i, /register/i, /auth/i],
    exitPatterns: [/token/i, /session/i, /auth.*api/i, /me\//i, /profile/i],
    throughPatterns: [/auth/i, /token/i, /session/i, /credential/i],
    edgeKinds: ['import', 'call', 'jsx', 'api_call', 'references'],
    nodeTypes: ['screen', 'component', 'hook', 'service', 'api', 'endpoint', 'store', 'function'],
  },
  {
    id: 'navigation',
    name: 'Navigation Flow',
    description: 'Traces screen-to-screen routing and navigation',
    entryPatterns: [/navigation/i, /navigator/i, /router/i, /routing/i, /app\./i],
    exitPatterns: [/screen/i, /page/i, /route/i],
    throughPatterns: [/navigation/i, /navigate/i, /route/i, /push/i, /goBack/i],
    edgeKinds: ['import', 'call', 'jsx'],
    nodeTypes: ['screen', 'component', 'hook', 'function', 'file'],
  },
  {
    id: 'data-fetch',
    name: 'Data Fetching Flow',
    description: 'Traces component → hook → API call → data rendering',
    entryPatterns: [/useQuery/i, /useMutation/i, /fetch/i, /useFetch/i, /useApi/i, /useData/i],
    exitPatterns: [/api/i, /endpoint/i, /fetch/i, /axios/i],
    throughPatterns: [/loading/i, /error/i, /data/i, /cache/i, /query/i],
    edgeKinds: ['import', 'call', 'api_call', 'references'],
    nodeTypes: ['screen', 'component', 'hook', 'service', 'api', 'endpoint', 'function'],
  },
  {
    id: 'state-management',
    name: 'State Management Flow',
    description: 'Traces store creation → dispatch → component consumption',
    entryPatterns: [/store/i, /createStore/i, /createSlice/i, /zustand/i, /reducer/i],
    exitPatterns: [/useStore/i, /useSelector/i, /dispatch/i, /setState/i],
    throughPatterns: [/action/i, /dispatch/i, /selector/i, /state/i],
    edgeKinds: ['import', 'call', 'references'],
    nodeTypes: ['screen', 'component', 'hook', 'store', 'service', 'function'],
  },
  {
    id: 'payment',
    name: 'Payment Flow',
    description: 'Traces payment/checkout → processing → confirmation',
    entryPatterns: [/payment/i, /checkout/i, /purchase/i, /billing/i, /cart/i, /order/i],
    exitPatterns: [/confirm/i, /receipt/i, /success/i, /webhook/i, /stripe/i, /charge/i],
    throughPatterns: [/payment/i, /amount/i, /card/i, /transaction/i, /invoice/i],
    edgeKinds: ['import', 'call', 'jsx', 'api_call', 'references'],
    nodeTypes: ['screen', 'component', 'hook', 'service', 'api', 'endpoint', 'store', 'function'],
  },
  {
    id: 'onboarding',
    name: 'Onboarding Flow',
    description: 'Traces new user onboarding steps',
    entryPatterns: [/onboard/i, /welcome/i, /getting.started/i, /tutorial/i, /setup/i],
    exitPatterns: [/complete/i, /finish/i, /done/i, /dashboard/i, /home/i],
    throughPatterns: [/step/i, /progress/i, /skip/i, /next/i],
    edgeKinds: ['import', 'call', 'jsx', 'references'],
    nodeTypes: ['screen', 'component', 'hook', 'store', 'function'],
  },
  {
    id: 'error-handling',
    name: 'Error Handling Flow',
    description: 'Traces error boundary → error service → error reporting',
    entryPatterns: [/error/i, /ErrorBoundary/i, /catch/i, /try/i],
    exitPatterns: [/sentry/i, /crashlytics/i, /report/i, /log/i, /analytics/i],
    throughPatterns: [/error/i, /exception/i, /fallback/i, /retry/i],
    edgeKinds: ['import', 'call', 'references'],
    nodeTypes: ['screen', 'component', 'hook', 'service', 'api', 'function', 'class'],
  },
];

class Tracer {
  constructor(graph, storage) {
    this.graph = graph;
    this.storage = storage;
    this.traces = [];
  }

  // ──────────── Load User-Defined Traces ────────────

  loadUserTraces(projectRoot) {
    const tracePath = path.join(projectRoot, '.codegraph', 'traces.json');
    if (fs.existsSync(tracePath)) {
      try {
        const userTraces = JSON.parse(fs.readFileSync(tracePath, 'utf-8'));
        if (Array.isArray(userTraces)) {
          this.traces = userTraces;
        }
      } catch (e) {
        console.error(`  Warning: Failed to parse .codegraph/traces.json: ${e.message}`);
      }
    }
  }

  // ──────────── Auto-Detect Traces ────────────

  autoDetectTraces() {
    const allNodes = this.storage.getAllNodes();
    const detectedTraces = [];

    for (const pattern of AUTO_TRACE_PATTERNS) {
      const entryNodes = this._findMatchingNodes(allNodes, pattern.entryPatterns, pattern.nodeTypes);
      const exitNodes = this._findMatchingNodes(allNodes, pattern.exitPatterns, pattern.nodeTypes);

      if (entryNodes.length > 0) {
        detectedTraces.push({
          ...pattern,
          entryNodes: entryNodes.map(n => n.id),
          exitNodes: exitNodes.map(n => n.id),
          autoDetected: true,
        });
      }
    }

    return detectedTraces;
  }

  // ──────────── Run a Single Trace ────────────

  runTrace(traceDef) {
    const allNodes = this.storage.getAllNodes();
    const entryNodeIds = traceDef.entryNodes || this._findMatchingNodes(allNodes, traceDef.entryPatterns, traceDef.nodeTypes).map(n => n.id);
    const exitNodeIds = traceDef.exitNodes || this._findMatchingNodes(allNodes, traceDef.exitPatterns, traceDef.nodeTypes).map(n => n.id);
    const exitIdSet = new Set(exitNodeIds);
    const edgeKinds = traceDef.edgeKinds || null;
    const maxDepth = traceDef.maxDepth || 10;

    const spans = [];
    const paths = [];
    const visitedNodes = new Set();
    const touchedFiles = new Set();
    const apiCalls = [];
    const storeAccess = [];

    // BFS from each entry point
    for (const entryId of entryNodeIds) {
      const bfsResult = this.graph.bfs(entryId, {
        direction: 'out',
        edgeKinds,
        maxDepth,
      });

      const entryPath = [];
      let reachedExit = false;

      for (const step of bfsResult) {
        visitedNodes.add(step.nodeId);
        const node = this.storage.getNode(step.nodeId);
        if (!node) continue;

        // Track files
        if (node.file_path) touchedFiles.add(node.file_path);

        // Track API calls
        const outEdges = this.storage.getOutgoingEdges(step.nodeId);
        for (const e of outEdges) {
          if (e.kind === 'api_call') {
            apiCalls.push({ from: step.nodeId, edge: e });
          }
          if (e.kind === 'call' || e.kind === 'references') {
            const target = this.storage.getNode(e.target);
            if (target && target.type === 'store') {
              storeAccess.push({ from: step.nodeId, to: e.target, edge: e });
            }
          }
        }

        // Build span
        const incomingEdge = step.depth > 0 ? this._findConnectingEdge(step.path[step.depth - 1], step.nodeId, edgeKinds) : null;

        spans.push({
          nodeId: step.nodeId,
          name: node.name || node.id,
          type: node.type,
          file_path: node.file_path,
          depth: step.depth,
          edgeKind: incomingEdge ? incomingEdge.kind : 'entry',
          label: incomingEdge ? incomingEdge.label : null,
          line: incomingEdge ? incomingEdge.line : null,
          is_exported: node.is_exported,
          is_async: node.is_async,
          isEntry: step.depth === 0,
          isExit: exitIdSet.has(step.nodeId),
        });

        entryPath.push(step.nodeId);

        if (exitIdSet.has(step.nodeId)) {
          reachedExit = true;
        }
      }

      if (entryPath.length > 0) {
        paths.push({
          entryId,
          steps: entryPath,
          reachedExit,
          exitNodeId: reachedExit ? entryPath[entryPath.length - 1] : null,
        });
      }
    }

    // Build step-by-step narrative
    const narrative = this._buildNarrative(traceDef, spans);

    return {
      traceId: traceDef.id,
      name: traceDef.name,
      description: traceDef.description,
      spans,
      paths,
      stats: {
        totalSteps: spans.length,
        uniqueNodes: visitedNodes.size,
        filesTouched: touchedFiles.size,
        apiCallCount: apiCalls.length,
        storeAccessCount: storeAccess.length,
        pathCount: paths.length,
        completePaths: paths.filter(p => p.reachedExit).length,
      },
      apiCalls: apiCalls.map(a => ({
        from: a.from,
        fromName: this.storage.getNode(a.from)?.name,
        method: a.edge.metadata?.method || a.edge.label,
        url: a.edge.metadata?.url,
      })),
      storeAccess: storeAccess.map(s => ({
        from: s.from,
        fromName: this.storage.getNode(s.from)?.name,
        store: s.to,
        storeName: this.storage.getNode(s.to)?.name,
      })),
      narrative,
    };
  }

  // ──────────── Run All Traces ────────────

  runAll(projectRoot) {
    // Load user traces
    this.loadUserTraces(projectRoot);

    // Auto-detect traces
    const autoTraces = this.autoDetectTraces();

    // Merge: user traces override auto-detected by id
    const userTraceIds = new Set(this.traces.map(t => t.id));
    const mergedTraces = [
      ...this.traces,
      ...autoTraces.filter(t => !userTraceIds.has(t.id)),
    ];

    // Run each trace
    const results = [];
    for (const traceDef of mergedTraces) {
      const result = this.runTrace(traceDef);
      results.push(result);
    }

    return results;
  }

  // ──────────── Helpers ────────────

  _findMatchingNodes(allNodes, patterns, nodeTypes) {
    if (!patterns || patterns.length === 0) return [];
    return allNodes.filter(n => {
      if (nodeTypes && nodeTypes.length > 0 && !nodeTypes.includes(n.type)) return false;
      const searchable = [n.name, n.id, n.qualified_name, n.file_path, n.kind].filter(Boolean).join(' ').toLowerCase();
      return patterns.some(p => p.test(searchable));
    });
  }

  _findConnectingEdge(sourceId, targetId, edgeKinds) {
    const edges = this.storage.getOutgoingEdges(sourceId);
    const matching = edges.filter(e => e.target === targetId && (!edgeKinds || edgeKinds.includes(e.kind)));
    return matching[0] || null;
  }

  _buildNarrative(traceDef, spans) {
    if (spans.length === 0) return [];

    const steps = [];
    const seen = new Set();

    for (const span of spans) {
      if (seen.has(span.nodeId)) continue;
      seen.add(span.nodeId);

      const parts = [];
      if (span.isEntry) parts.push('START');
      parts.push(`${span.type}:${span.name}`);
      if (span.file_path) parts.push(`(${span.file_path})`);
      if (span.edgeKind && span.edgeKind !== 'entry') parts.push(`via ${span.edgeKind}`);
      if (span.isExit) parts.push('→ END');

      steps.push({
        depth: span.depth,
        description: parts.join(' '),
        nodeId: span.nodeId,
        type: span.type,
        name: span.name,
        file_path: span.file_path,
        isEntry: span.isEntry,
        isExit: span.isExit,
        edgeKind: span.edgeKind,
      });
    }

    return steps;
  }

  // ──────────── Create Sample traces.json ────────────

  static generateSampleTraces() {
    return [
      {
        id: 'auth',
        name: 'Authentication Flow',
        description: 'Trace the complete auth workflow from login screen to API token usage',
        entryPatterns: ['login', 'signin', 'LoginScreen'],
        exitPatterns: ['token', 'session', '/api/auth'],
        throughPatterns: ['auth', 'credential'],
        edgeKinds: ['import', 'call', 'jsx', 'api_call'],
        maxDepth: 8,
      },
      {
        id: 'feature-checkout',
        name: 'Checkout Feature Flow',
        description: 'Trace the checkout process from cart to order confirmation',
        entryPatterns: ['cart', 'checkout', 'CartScreen'],
        exitPatterns: ['order', 'payment', '/api/orders'],
        throughPatterns: ['shipping', 'billing', 'confirm'],
        edgeKinds: ['import', 'call', 'jsx', 'api_call'],
        maxDepth: 8,
      },
    ];
  }
}

module.exports = { Tracer, AUTO_TRACE_PATTERNS };
