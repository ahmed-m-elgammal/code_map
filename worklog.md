---
Task ID: 1
Agent: Main
Task: Build layered codebase visualization tool v2 with architecture from dependency-cruiser, ReacTree, CodeGraph

Work Log:
- Researched dependency-cruiser (pipeline architecture, IndexedModuleGraph, enhanced-resolve, 22 reporters)
- Researched ReacTree (Babel + ReactFlow, component tree visualization)
- Researched CodeGraph (tree-sitter + SQLite, property-graph model, BFS/DFS/impact analysis)
- Designed 5-layer architecture: Storage → Core Graph → Query Builder → Code Helpers → User Tools
- Built lib/storage.js — SQLite backend with WAL mode, FTS5 search, schema migrations, incremental reindex
- Built lib/graph.js — Core graph with BFS/DFS, cycle detection, reachability, topological sort, community detection, impact analysis
- Built lib/query.js — Fluent chainable query builder (from, fromType, edgeKind, direction, depth, where, includeEdges)
- Built lib/helpers.js — High-level convenience API (whoImports, whoCalls, impactOf, getScreenMap, getComponentTree, getAPIMap, getDataFlow, findCycles, findOrphans, findHotspots)
- Built lib/parser.js — Upgraded Babel parser with fine-grained symbol extraction (functions, components, hooks, classes, variables, endpoints)
- Rebuilt analyze.js as CLI entry point using the layered stack
- Upgraded visualizer.html with 6 views (All, Dependencies, Components, Call Graph, API Flow, Architecture)
- Fixed node:sqlite compatibility (no .transaction() — manual BEGIN/COMMIT/ROLLBACK)
- Fixed FK constraints during bulk indexing
- Verified full analysis: 1118 nodes, 1640 edges, 3 cycles, 26 communities, incremental reindex works

Stage Summary:
- Complete 5-layer codebase analysis tool with SQLite persistence
- graph.json includes multi-view data: dependency edges, component tree, call graph, API flow
- Architecture view shows layered layout (screens → components → hooks → stores → services → APIs)
- All metrics computed: fan-in, fan-out, instability per node
- Files: analyze.js, visualizer.html, lib/{storage,graph,query,helpers,parser}.js, graph.json
