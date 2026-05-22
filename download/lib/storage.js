/**
 * storage.js — SQLite Storage Backend
 *
 * Uses Node 24's built-in node:sqlite with WAL mode.
 * Provides the persistence layer for the code graph.
 *
 * Schema inspired by CodeGraph's property-graph model:
 *   nodes  — code symbols (files, functions, components, hooks, etc.)
 *   edges  — relationships (imports, calls, jsx-usage, api-calls, etc.)
 *   files  — tracked source files with content hashes for incremental reindex
 *   FTS5   — full-text search on symbol names and metadata
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const SCHEMA_VERSION = 2;

const MIGRATIONS = [
  // V1: Initial schema
  `
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      language TEXT NOT NULL,
      lines_of_code INTEGER DEFAULT 0,
      indexed_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      qualified_name TEXT,
      kind TEXT,
      start_line INTEGER,
      end_line INTEGER,
      visibility TEXT DEFAULT 'public',
      is_exported INTEGER DEFAULT 0,
      is_async INTEGER DEFAULT 0,
      is_static INTEGER DEFAULT 0,
      signature TEXT,
      metadata TEXT,
      FOREIGN KEY (file_path) REFERENCES files(path)
    );

    CREATE TABLE IF NOT EXISTS edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      kind TEXT NOT NULL,
      label TEXT,
      line INTEGER,
      metadata TEXT,
      FOREIGN KEY (source) REFERENCES nodes(id),
      FOREIGN KEY (target) REFERENCES nodes(id),
      UNIQUE(source, target, kind, line)
    );

    CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
    CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file_path);
    CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
    CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
    CREATE INDEX IF NOT EXISTS idx_nodes_exported ON nodes(is_exported);
    CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);
    CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);

    CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
      name,
      qualified_name,
      signature,
      metadata,
      content=nodes,
      content_rowid=rowid
    );

    CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
      INSERT INTO nodes_fts(rowid, name, qualified_name, signature, metadata)
      VALUES (new.rowid, new.name, new.qualified_name, new.signature, new.metadata);
    END;

    CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
      INSERT INTO nodes_fts(nodes_fts, rowid, name, qualified_name, signature, metadata)
      VALUES ('delete', old.rowid, old.name, old.qualified_name, old.signature, old.metadata);
    END;
  `,
  // V2: Add instability/abstractness metrics columns
  `
    ALTER TABLE nodes ADD COLUMN fan_in INTEGER DEFAULT 0;
    ALTER TABLE nodes ADD COLUMN fan_out INTEGER DEFAULT 0;
    ALTER TABLE nodes ADD COLUMN instability REAL DEFAULT 0;
  `,
];

class Storage {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  open() {
    // Ensure parent dir exists
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA cache_size = -64000'); // 64MB cache
    this.db.exec('PRAGMA foreign_keys = OFF'); // Off during bulk indexing for performance

    // Run migrations
    const currentVersion = this._getVersion();
    for (let v = currentVersion; v < SCHEMA_VERSION; v++) {
      this.db.exec(MIGRATIONS[v]);
      this._setVersion(v + 1);
    }

    return this;
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Execute a function inside a transaction.
   * Compatible with node:sqlite DatabaseSync (no .transaction() method).
   */
  _execTx(fn) {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw e;
    }
  }

  _getVersion() {
    try {
      const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
      return row ? parseInt(row.value, 10) : 0;
    } catch {
      return 0;
    }
  }

  _setVersion(v) {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(v));
  }

  // ──────────── File Operations ────────────

  upsertFile(filePath, language, linesOfCode, source) {
    const hash = crypto.createHash('sha256').update(source).digest('hex');
    this.db.prepare(`
      INSERT INTO files (path, content_hash, language, lines_of_code, indexed_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        content_hash = excluded.content_hash,
        language = excluded.language,
        lines_of_code = excluded.lines_of_code,
        indexed_at = excluded.indexed_at
    `).run(filePath, hash, language, linesOfCode, Date.now());
    return hash;
  }

  getFileHash(filePath) {
    const row = this.db.prepare('SELECT content_hash FROM files WHERE path = ?').get(filePath);
    return row ? row.content_hash : null;
  }

  needsReindex(filePath, source) {
    const hash = crypto.createHash('sha256').update(source).digest('hex');
    const existing = this.getFileHash(filePath);
    return existing !== hash;
  }

  // ──────────── Node Operations ────────────

  upsertNode(node) {
    const meta = node.metadata ? JSON.stringify(node.metadata) : null;
    this.db.prepare(`
      INSERT INTO nodes (id, type, name, file_path, qualified_name, kind, start_line, end_line,
        visibility, is_exported, is_async, is_static, signature, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        name = excluded.name,
        file_path = excluded.file_path,
        qualified_name = excluded.qualified_name,
        kind = excluded.kind,
        start_line = excluded.start_line,
        end_line = excluded.end_line,
        visibility = excluded.visibility,
        is_exported = excluded.is_exported,
        is_async = excluded.is_async,
        is_static = excluded.is_static,
        signature = excluded.signature,
        metadata = excluded.metadata
    `).run(
      node.id, node.type, node.name, node.file_path,
      node.qualified_name || null, node.kind || null,
      node.start_line || null, node.end_line || null,
      node.visibility || 'public',
      node.is_exported ? 1 : 0,
      node.is_async ? 1 : 0,
      node.is_static ? 1 : 0,
      node.signature || null,
      meta
    );
  }

  upsertNodes(nodes) {
    this._execTx(() => {
      for (const n of nodes) this.upsertNode(n);
    });
  }

  deleteNodesByFile(filePath) {
    // Get node IDs first to clean edges
    const nodeIds = this.db.prepare('SELECT id FROM nodes WHERE file_path = ?').all(filePath).map(r => r.id);
    if (nodeIds.length === 0) return;

    this._execTx(() => {
      // Delete edges referencing these nodes
      const placeholders = nodeIds.map(() => '?').join(',');
      this.db.prepare(`DELETE FROM edges WHERE source IN (${placeholders}) OR target IN (${placeholders})`)
        .run(...nodeIds, ...nodeIds);
      // Delete the nodes (triggers FTS cleanup)
      this.db.prepare(`DELETE FROM nodes WHERE id IN (${placeholders})`).run(...nodeIds);
    });
  }

  getNode(id) {
    return this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
  }

  getNodesByType(type) {
    return this.db.prepare('SELECT * FROM nodes WHERE type = ?').all(type);
  }

  getNodesByFile(filePath) {
    return this.db.prepare('SELECT * FROM nodes WHERE file_path = ?').all(filePath);
  }

  getAllNodes() {
    return this.db.prepare('SELECT * FROM nodes').all();
  }

  searchNodes(query, limit = 50) {
    try {
      return this.db.prepare(`
        SELECT n.* FROM nodes n
        JOIN nodes_fts f ON n.rowid = f.rowid
        WHERE nodes_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(query, limit);
    } catch {
      // FTS5 might fail on special chars, fallback to LIKE
      return this.db.prepare(`
        SELECT * FROM nodes
        WHERE name LIKE ? OR qualified_name LIKE ?
        LIMIT ?
      `).all(`%${query}%`, `%${query}%`, limit);
    }
  }

  // ──────────── Edge Operations ────────────

  upsertEdge(edge) {
    const meta = edge.metadata ? JSON.stringify(edge.metadata) : null;
    this.db.prepare(`
      INSERT INTO edges (source, target, kind, label, line, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, target, kind, line) DO UPDATE SET
        label = excluded.label,
        metadata = excluded.metadata
    `).run(edge.source, edge.target, edge.kind, edge.label || null, edge.line || null, meta);
  }

  upsertEdges(edges) {
    this._execTx(() => {
      for (const e of edges) this.upsertEdge(e);
    });
  }

  deleteEdgesByFile(filePath) {
    // Delete edges where source or target node belongs to this file
    this.db.prepare(`
      DELETE FROM edges WHERE source IN (SELECT id FROM nodes WHERE file_path = ?)
        OR target IN (SELECT id FROM nodes WHERE file_path = ?)
    `).run(filePath, filePath);
  }

  getOutgoingEdges(nodeId) {
    return this.db.prepare('SELECT * FROM edges WHERE source = ?').all(nodeId);
  }

  getIncomingEdges(nodeId) {
    return this.db.prepare('SELECT * FROM edges WHERE target = ?').all(nodeId);
  }

  getAllEdges() {
    return this.db.prepare('SELECT * FROM edges').all();
  }

  getEdgesByKind(kind) {
    return this.db.prepare('SELECT * FROM edges WHERE kind = ?').all(kind);
  }

  // ──────────── Stats ────────────

  getStats() {
    const nodeCount = this.db.prepare('SELECT COUNT(*) as c FROM nodes').get().c;
    const edgeCount = this.db.prepare('SELECT COUNT(*) as c FROM edges').get().c;
    const fileCount = this.db.prepare('SELECT COUNT(*) as c FROM files').get().c;
    const totalLOC = this.db.prepare('SELECT COALESCE(SUM(lines_of_code), 0) as c FROM files').get().c;

    const nodeTypes = this.db.prepare('SELECT type, COUNT(*) as count FROM nodes GROUP BY type ORDER BY count DESC').all();
    const edgeKinds = this.db.prepare('SELECT kind, COUNT(*) as count FROM edges GROUP BY kind ORDER BY count DESC').all();

    return { nodeCount, edgeCount, fileCount, totalLOC, nodeTypes, edgeKinds };
  }

  // ──────────── Graph Computation ────────────

  computeMetrics() {
    // Fan-in / Fan-out / Instability for each node
    const metrics = this.db.prepare(`
      SELECT
        n.id,
        COALESCE(in_counts.cnt, 0) as fan_in,
        COALESCE(out_counts.cnt, 0) as fan_out
      FROM nodes n
      LEFT JOIN (SELECT target, COUNT(*) as cnt FROM edges GROUP BY target) in_counts ON n.id = in_counts.target
      LEFT JOIN (SELECT source, COUNT(*) as cnt FROM edges GROUP BY source) out_counts ON n.id = out_counts.source
    `).all();

    this._execTx(() => {
      const stmt = this.db.prepare(`
        UPDATE nodes SET fan_in = ?, fan_out = ?, instability = ? WHERE id = ?
      `);
      for (const m of metrics) {
        const total = m.fan_in + m.fan_out;
        const instability = total > 0 ? m.fan_out / total : 0;
        stmt.run(m.fan_in, m.fan_out, Math.round(instability * 1000) / 1000, m.id);
      }
    });
  }

  // ──────────── Export ────────────

  exportToJSON() {
    const nodes = this.db.prepare('SELECT * FROM nodes').all();
    const edges = this.db.prepare('SELECT * FROM edges').all();
    const stats = this.getStats();

    // Deserialize metadata
    for (const n of nodes) {
      if (n.metadata) try { n.metadata = JSON.parse(n.metadata); } catch {}
    }
    for (const e of edges) {
      if (e.metadata) try { e.metadata = JSON.parse(e.metadata); } catch {}
    }

    return { nodes, edges, stats, version: SCHEMA_VERSION, exportedAt: new Date().toISOString() };
  }
}

module.exports = { Storage };
