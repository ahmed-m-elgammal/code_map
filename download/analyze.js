#!/usr/bin/env node

/**
 * analyze.js — Codebase Graph Analyzer v3.5
 *
 * Layered architecture with deep semantic tracing:
 *   User Tools (this CLI + Tracer)
 *       ↓
 *   Code Helpers (convenience queries)
 *       ↓
 *   Query Builder (fluent API)
 *       ↓
 *   Core Graph (algorithms: BFS/DFS/cycles/centrality)
 *       ↓
 *   Storage Backend (SQLite, WAL, FTS5)
 *
 * Usage:
 *   node analyze.js [path] [--json] [--full] [--stats-only] [--trace <id>] [--traces] [--init-traces]
 */

const path = require('path');
const fs = require('fs');

// ──── Layer imports ────
const { Storage } = require('./lib/storage');
const { CoreGraph } = require('./lib/graph');
const { QueryBuilder } = require('./lib/query');
const { CodeHelpers } = require('./lib/helpers');
const { analyzeFile, discoverFiles, safeRelative } = require('./lib/parser');
const { Tracer } = require('./lib/tracer');

// ──── CLI args ────
const args = process.argv.slice(2);
const targetDir = args.find(a => !a.startsWith('--')) || process.cwd();
const statsOnly = args.includes('--stats-only');
const traceIdx = args.indexOf('--trace');
const traceId = traceIdx >= 0 ? args[traceIdx + 1] : null;
const listTraces = args.includes('--traces');
const initTraces = args.includes('--init-traces');

// ──── Main ────
function main() {
  const rootDir = path.resolve(targetDir);
  const dbPath = path.join(rootDir, '.codegraph', 'codegraph.db');
  const jsonPath = path.join(rootDir, 'graph.json');

  console.log('');
  console.log('  ╔═══════════════════════════════════════════════════════════╗');
  console.log('  ║         Codebase Graph Analyzer v3.5                     ║');
  console.log('  ║         Deep Semantic Analysis + Workflow Tracing         ║');
  console.log('  ╚═══════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Target:  ${rootDir}`);
  console.log(`  Storage: ${dbPath}`);
  console.log('');

  // ── Handle --init-traces ──
  if (initTraces) {
    const tracesDir = path.join(rootDir, '.codegraph');
    const tracesPath = path.join(tracesDir, 'traces.json');
    if (!fs.existsSync(tracesDir)) fs.mkdirSync(tracesDir, { recursive: true });
    const sample = Tracer.generateSampleTraces();
    fs.writeFileSync(tracesPath, JSON.stringify(sample, null, 2), 'utf-8');
    console.log(`  Created ${tracesPath}`);
    console.log('  Edit this file to define your own workflow traces.');
    console.log('');
    process.exit(0);
  }

  // ── Step 1: Open storage ──
  console.log('  Opening SQLite storage (WAL mode)...');
  const storage = new Storage(dbPath).open();
  console.log('  Connected');
  console.log('');

  // ── Step 2: Discover files ──
  console.log('  Discovering source files...');
  const files = discoverFiles(rootDir);
  console.log(`  Found ${files.length} source files`);
  console.log('');

  if (files.length === 0) {
    console.log('  No source files found.');
    storage.close();
    process.exit(1);
  }

  // ── Step 3: Parse and index ──
  console.log('  Parsing with Babel (deep semantic extraction)...');
  let indexed = 0, skipped = 0, errors = 0;
  const startTime = Date.now();

  for (const file of files) {
    const result = analyzeFile(file, rootDir, storage);
    if (result === 'skipped') skipped++;
    else if (result) indexed++;
    else errors++;
  }

  const parseTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  Indexed: ${indexed}  Skipped: ${skipped}  Errors: ${errors}  (${parseTime}s)`);
  console.log('');

  // ── Step 4: Compute metrics ──
  console.log('  Computing graph metrics...');
  storage.computeMetrics();
  console.log('  Done');
  console.log('');

  // ── Step 5: Build graph and run algorithms ──
  console.log('  Building in-memory graph indices...');
  const graph = new CoreGraph(storage);
  graph.buildIndex();

  const cycles = graph.detectCycles();
  const orphans = graph.getOrphans();
  const communities = graph.detectCommunities();

  console.log(`  Cycles: ${cycles.length}  Orphans: ${orphans.length}  Communities: ${communities.length}`);
  console.log('');

  // ── Step 6: Run workflow tracing ──
  console.log('  Running deep semantic workflow tracing...');
  const tracer = new Tracer(graph, storage);
  const traceResults = tracer.runAll(rootDir);

  let totalSubFlows = 0;
  for (const t of traceResults) totalSubFlows += t.subFlows.length;
  console.log(`  Traces discovered: ${traceResults.length} (${totalSubFlows} sub-flows)`);
  for (const t of traceResults) {
    const sfNames = t.subFlows.map(sf => sf.name).join(', ');
    console.log(`    ${t.icon || '🔍'} ${t.name}: ${t.subFlows.length} sub-flows (${t.stats.totalSteps} steps total)`);
  }
  console.log('');

  // ── Handle --traces (list only) ──
  if (listTraces) {
    console.log('  ╔═══════════════════════════════════════════════════════════╗');
    console.log('  ║               Available Workflow Traces                   ║');
    console.log('  ╠═══════════════════════════════════════════════════════════╣');
    for (const t of traceResults) {
      console.log(`  ║  ${t.icon || '🔍'} ${t.name.padEnd(40)}║`);
      console.log(`  ║     ${t.stats.subFlowCount} sub-flows, ${t.stats.totalSteps} steps, ${t.stats.apiCallCount} APIs${''.padEnd(15)}║`);
      for (const sf of t.subFlows) {
        const status = sf.stats.completePaths > 0 ? 'complete' : 'partial';
        console.log(`  ║       - ${sf.name.padEnd(36)} [${status}]║`);
      }
    }
    console.log('  ╚═══════════════════════════════════════════════════════════╝');
    console.log('');
    storage.close();
    process.exit(0);
  }

  // ── Handle --trace <id> (print detailed trace) ──
  if (traceId) {
    const trace = traceResults.find(t => t.traceId === traceId);
    if (!trace) {
      console.log(`  Trace "${traceId}" not found. Use --traces to list available traces.`);
      storage.close();
      process.exit(1);
    }

    console.log('');
    console.log(`  ══════════════════════════════════════════════════════════`);
    console.log(`  ${trace.icon || '🔍'} ${trace.name}`);
    console.log(`  ${trace.description}`);
    console.log(`  ══════════════════════════════════════════════════════════`);
    console.log('');
    console.log(`  Overview: ${trace.stats.totalSteps} steps | ${trace.stats.uniqueFiles} files | ${trace.stats.apiCallCount} APIs | ${trace.stats.secureAccessCount} secure ops`);
    console.log('');

    for (const sf of trace.subFlows) {
      const status = sf.stats.completePaths > 0 ? 'COMPLETE' : 'PARTIAL';
      console.log(`  ─── ${sf.name} [${status}] ───`);
      console.log(`  ${sf.description}`);
      console.log('');

      for (const step of sf.narrative) {
        const indent = '  ' + '  '.repeat(step.depth);
        const marker = step.isEntry ? '[START]' : step.isExit ? '[END]' : '';
        const arrow = step.depth > 0 ? `  <- ${step.edgeKind}` : '';
        const tagStr = step.tags.length > 0 ? ` [${step.tags.join(',')}]` : '';
        console.log(`${indent}${marker} ${step.type}:${step.name} (${step.file_path})${arrow}${tagStr}`);
      }

      if (sf.apiCalls.length > 0) {
        console.log(`  API Calls:`);
        for (const api of sf.apiCalls) {
          const authTag = api.tags.includes('auth-api') ? ' [AUTH]' : '';
          console.log(`    ${api.method || 'CALL'} ${api.url || '-'} (from ${api.fromName || api.from})${authTag}`);
        }
      }
      if (sf.secureAccess.length > 0) {
        console.log(`  Secure Storage Access:`);
        for (const s of sf.secureAccess) {
          console.log(`    ${s.action} key="${s.key}" (from ${s.fromName || s.from})`);
        }
      }
      if (sf.dispatches.length > 0) {
        console.log(`  State Dispatches:`);
        for (const d of sf.dispatches) {
          console.log(`    dispatch(${d.actionType || 'action'}) from ${d.fromName || d.from}`);
        }
      }
      console.log('');
    }

    storage.close();
    process.exit(0);
  }

  // ── Step 7: Build visualization data ──
  console.log('  Building visualization data...');
  const helpers = new CodeHelpers(graph);
  const vizData = helpers.buildVisualizationData();

  // Attach trace results
  vizData.traces = traceResults;
  vizData.version = 3.5;

  // Write graph.json
  fs.writeFileSync(jsonPath, JSON.stringify(vizData, null, 2), 'utf-8');
  console.log(`  Wrote graph.json -> ${jsonPath}`);
  console.log('');

  // ── Step 8: Print stats ──
  const stats = storage.getStats();

  console.log('  ╔═══════════════════════════════════════════════════════════╗');
  console.log('  ║                  Analysis Statistics                      ║');
  console.log('  ╠═══════════════════════════════════════════════════════════╣');
  console.log(`  ║  Source files:       ${String(stats.fileCount).padEnd(36)}║`);
  console.log(`  ║  Total LOC:          ${String(stats.totalLOC.toLocaleString()).padEnd(36)}║`);
  console.log(`  ║  Graph nodes:        ${String(stats.nodeCount).padEnd(36)}║`);
  console.log(`  ║  Graph edges:        ${String(stats.edgeCount).padEnd(36)}║`);
  console.log(`  ║  Cycles:             ${String(cycles.length).padEnd(36)}║`);
  console.log(`  ║  Orphan nodes:       ${String(orphans.length).padEnd(36)}║`);
  console.log(`  ║  Communities:        ${String(communities.length).padEnd(36)}║`);
  console.log(`  ║  Workflow traces:    ${String(traceResults.length).padEnd(36)}║`);
  console.log(`  ║  Sub-flows:          ${String(totalSubFlows).padEnd(36)}║`);
  console.log('  ╠═══════════════════════════════════════════════════════════╣');
  console.log('  ║  Node types:                                             ║');
  for (const { type, count } of stats.nodeTypes) {
    console.log(`  ║    ${type.padEnd(14)} ${String(count).padEnd(35)}║`);
  }
  console.log('  ╠═══════════════════════════════════════════════════════════╣');
  console.log('  ║  Edge kinds:                                             ║');
  for (const { kind, count } of stats.edgeKinds) {
    console.log(`  ║    ${kind.padEnd(18)} ${String(count).padEnd(32)}║`);
  }
  console.log('  ╠═══════════════════════════════════════════════════════════╣');

  // Hotspots
  const hotspots = helpers.findHotspots(5);
  console.log('  ║  Top hotspots:                                           ║');
  for (const hs of hotspots) {
    const name = hs.node.name || hs.node.id;
    console.log(`  ║    ${name.slice(0, 30).padEnd(14)} in:${String(hs.fanIn).padEnd(3)} out:${String(hs.fanOut).padEnd(3)} total:${String(hs.totalConnections).padEnd(6)}║`);
  }

  // Traces summary
  if (traceResults.length > 0) {
    console.log('  ╠═══════════════════════════════════════════════════════════╣');
    console.log('  ║  Workflow Traces:                                        ║');
    for (const t of traceResults) {
      console.log(`  ║  ${t.icon || '🔍'} ${t.name.padEnd(30)} ${String(t.subFlows.length).padEnd(2)} sub-flows${''.padEnd(10)}║`);
      for (const sf of t.subFlows) {
        const status = sf.stats.completePaths > 0 ? 'complete' : 'partial';
        console.log(`  ║      ${sf.name.padEnd(32)} [${status.padEnd(7)}]║`);
      }
    }
  }

  console.log('  ╚═══════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('  Done! Open visualizer.html and load graph.json to explore.');
  console.log('');
  console.log('  Tracing commands:');
  console.log('    node analyze.js --traces              List all detected traces + sub-flows');
  console.log('    node analyze.js --trace auth           Show auth flow (6 sub-flows)');
  console.log('    node analyze.js --trace payment        Show payment flow');
  console.log('    node analyze.js --trace navigation     Show navigation flow');
  console.log('    node analyze.js --trace data-fetch     Show data fetching flow');
  console.log('    node analyze.js --trace state          Show state management flow');
  console.log('    node analyze.js --trace forms          Show form handling flow');
  console.log('    node analyze.js --trace errors         Show error handling flow');
  console.log('    node analyze.js --trace realtime       Show WebSocket flow');
  console.log('    node analyze.js --trace permissions    Show permission flow');
  console.log('    node analyze.js --trace notifications  Show push notification flow');
  console.log('    node analyze.js --init-traces          Create .codegraph/traces.json');
  console.log('');

  storage.close();
}

main();
