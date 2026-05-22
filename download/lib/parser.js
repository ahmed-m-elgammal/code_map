/**
 * parser.js — Babel-based AST Parser (User Tool Layer)
 *
 * Parses .js, .jsx, .ts, .tsx files with @babel/parser + @babel/traverse.
 * Extracts fine-grained symbols (functions, components, hooks, classes, etc.)
 * and relationships (imports, calls, JSX usage, API calls).
 *
 * Outputs to the Storage backend (SQLite) instead of a flat JSON.
 */

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const crypto = require('crypto');

const IGNORE_DIRS = new Set([
  'node_modules', '.expo', 'android', 'ios', 'assets', '.git',
  '__tests__', '__mocks__', '__snapshots__', 'dist', 'build',
  '.cache', '.next', 'coverage', '.vscode', '.idea', '.codegraph',
]);

const VALID_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx']);

const SCREEN_PATTERNS   = [/\/screens?\//i, /\/app\//i, /screen\.(js|jsx|ts|tsx)$/i, /\/pages?\//i, /\/routes?\//i];
const HOOK_PATTERNS     = [/\/hooks?\//i, /^use[A-Z]/, /use[A-Z].*\.(js|jsx|ts|tsx)$/i];
const STORE_PATTERNS    = [/\/store?s?\//i, /\/state\//i, /\/redux\//i, /\/zustand\//i, /(store|reducer|slice|state)\.(js|jsx|ts|tsx)$/i];
const SERVICE_PATTERNS  = [/\/services?\//i, /\/lib\//i, /\/utils?\//i, /\/helpers?\//i, /(service|client|helper)\.(js|jsx|ts|tsx)$/i];
const API_PATTERNS      = [/\/api\//i, /\/api\./i, /(api|endpoint|http)\.(js|jsx|ts|tsx)$/i];
const COMPONENT_PATTERNS = [/\/components?\//i];

function nodeId(filePath, symbolName) {
  return crypto.createHash('md5').update(`${filePath}::${symbolName}`).digest('hex').slice(0, 12);
}

function fileNodeId(filePath) {
  return 'f:' + crypto.createHash('md5').update(filePath).digest('hex').slice(0, 10);
}

function pkgNodeId(pkgName) {
  return 'pkg:' + pkgName;
}

function endpointNodeId(method, url) {
  return 'ep:' + crypto.createHash('md5').update(`${method}:${url}`).digest('hex').slice(0, 10);
}

function inferNodeType(filePath, exports) {
  const normalized = filePath.replace(/\\/g, '/');
  if (SCREEN_PATTERNS.some(p => p.test(normalized))) return 'screen';
  const hasHookExport = exports.some(e => /^use[A-Z]/.test(e));
  if (HOOK_PATTERNS.some(p => p.test(normalized)) || hasHookExport) return 'hook';
  if (STORE_PATTERNS.some(p => p.test(normalized))) return 'store';
  if (API_PATTERNS.some(p => p.test(normalized))) return 'api';
  if (SERVICE_PATTERNS.some(p => p.test(normalized))) return 'service';
  const hasComponentExport = exports.some(e => /^[A-Z]/.test(e) && !/^use[A-Z]/.test(e));
  if (COMPONENT_PATTERNS.some(p => p.test(normalized)) && hasComponentExport) return 'component';
  if (hasComponentExport) return 'component';
  return 'file';
}

function resolveImportPath(importPath, fromFile, rootDir) {
  if (!importPath.startsWith('.')) return null;
  const dir = path.dirname(fromFile);
  let resolved = path.resolve(dir, importPath);
  for (const ext of VALID_EXTENSIONS) {
    if (fs.existsSync(resolved + ext)) return resolved + ext;
  }
  for (const ext of VALID_EXTENSIONS) {
    if (fs.existsSync(path.join(resolved, 'index' + ext))) return path.join(resolved, 'index' + ext);
  }
  return null;
}

function safeRelative(fullPath, root) {
  try { return path.relative(root, fullPath).replace(/\\/g, '/'); } catch { return fullPath; }
}

// ──────────── File Discovery ────────────

function discoverFiles(rootDir) {
  const files = [];
  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.env') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile() && VALID_EXTENSIONS.has(path.extname(entry.name))) files.push(fullPath);
    }
  }
  walk(rootDir);
  return files;
}

// ──────────── AST Analysis ────────────

function analyzeFile(filePath, rootDir, storage) {
  const relativePath = safeRelative(filePath, rootDir);
  let source;
  try { source = fs.readFileSync(filePath, 'utf-8'); } catch { return; }
  if (source.length > 1_000_000) return;

  // Skip if hash unchanged (incremental)
  if (!storage.needsReindex(relativePath, source)) {
    return 'skipped';
  }

  let ast;
  try {
    ast = parser.parse(source, {
      sourceType: 'unambiguous',
      plugins: [
        'jsx', 'typescript',
        ['decorators', { decoratorsBeforeExport: true }],
        'classProperties', 'classPrivateProperties', 'classPrivateMethods',
        'exportDefaultFrom', 'exportNamespaceFrom', 'dynamicImport',
        'nullishCoalescingOperator', 'optionalChaining', 'objectRestSpread',
        'asyncGenerators', 'importMeta', 'logicalAssignment', 'numericSeparator',
        'optionalCatchBinding',
        ['pipelineOperator', { proposal: 'hack', topicToken: '%' }],
        'throwExpressions', 'topLevelAwait', 'doExpressions',
        'decoratorAutoAccessors', 'importAttributes',
      ],
      errorRecovery: true,
    });
  } catch { return; }

  // Language detection
  const ext = path.extname(filePath);
  const language = ext.startsWith('.ts') ? 'typescript' : 'javascript';

  // Upsert file record
  storage.upsertFile(relativePath, language, source.split('\n').length, source);

  // Remove old nodes for this file (incremental reindex)
  storage.deleteNodesByFile(relativePath);

  // Tracking variables
  const exports = [];
  const nodes = [];
  const edges = [];
  const exportToNodeId = new Map(); // exportName → nodeId
  let currentFunction = null;
  const functionStack = [];

  const fid = fileNodeId(relativePath);

  // Create file node
  nodes.push({
    id: fid,
    type: 'file',
    name: path.basename(filePath),
    file_path: relativePath,
    qualified_name: relativePath,
    kind: 'file',
    start_line: 1,
    end_line: source.split('\n').length,
    visibility: 'public',
    is_exported: 0,
    is_async: 0,
    is_static: 0,
    signature: null,
    metadata: { ext, language },
  });

  try {
    traverse(ast, {
      // ── Imports ──
      ImportDeclaration(nodePath) {
        const src = nodePath.node.source.value;
        const specs = nodePath.node.specifiers.map(spec => {
          if (t.isImportDefaultSpecifier(spec) || t.isImportNamespaceSpecifier(spec))
            return { imported: 'default', local: spec.local.name };
          if (t.isImportSpecifier(spec)) {
            const imported = t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value;
            return { imported, local: spec.local.name };
          }
          return null;
        }).filter(Boolean);

        const resolvedPath = resolveImportPath(src, filePath, rootDir);
        const relResolved = resolvedPath ? safeRelative(resolvedPath, rootDir) : null;

        if (relResolved) {
          const targetFileId = fileNodeId(relResolved);
          edges.push({
            source: fid,
            target: targetFileId,
            kind: 'import',
            label: specs.map(s => s.imported).join(', '),
            line: nodePath.node.loc?.start?.line,
          });
        } else if (!src.startsWith('.')) {
          const pkgName = src.split('/')[0];
          const pkgId = pkgNodeId(pkgName);
          edges.push({
            source: fid,
            target: pkgId,
            kind: 'external',
            label: specs.map(s => s.imported).join(', '),
            line: nodePath.node.loc?.start?.line,
            metadata: { package: src },
          });
        }
      },

      // ── Exports ──
      ExportDefaultDeclaration(nodePath) {
        const decl = nodePath.node.declaration;
        let name = null;
        if (t.isIdentifier(decl)) name = decl.name;
        else if (t.isFunctionDeclaration(decl) && decl.id) name = decl.id.name;
        else if (t.isClassDeclaration(decl) && decl.id) name = decl.id.name;
        if (name) exports.push(name);
      },

      ExportNamedDeclaration(nodePath) {
        const decl = nodePath.node.declaration;
        if (t.isVariableDeclaration(decl)) {
          for (const d of decl.declarations) {
            if (t.isIdentifier(d.id)) exports.push(d.id.name);
          }
        } else if (t.isFunctionDeclaration(decl) && decl.id) {
          exports.push(decl.id.name);
        } else if (t.isClassDeclaration(decl) && decl.id) {
          exports.push(decl.id.name);
        }
        for (const spec of nodePath.node.specifiers) {
          if (t.isExportSpecifier(spec)) {
            const name = t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value;
            exports.push(name);
          }
        }
      },

      // ── Function declarations ──
      FunctionDeclaration: {
        enter(nodePath) {
          const name = nodePath.node.id?.name;
          if (!name) return;
          const line = nodePath.node.loc?.start?.line;
          const isAsync = nodePath.node.async ? 1 : 0;
          const isComponent = /^[A-Z]/.test(name);
          const isHook = /^use[A-Z]/.test(name);
          const nId = nodeId(relativePath, name);

          nodes.push({
            id: nId,
            type: isComponent ? 'component' : (isHook ? 'hook' : 'function'),
            name,
            file_path: relativePath,
            qualified_name: `${relativePath}::${name}`,
            kind: isComponent ? 'component' : (isHook ? 'hook' : 'function'),
            start_line: line,
            end_line: nodePath.node.loc?.end?.line,
            is_exported: exports.includes(name) ? 1 : 0,
            is_async: isAsync,
            signature: null,
          });

          // Containment edge: file → function
          edges.push({ source: fid, target: nId, kind: 'contains', line });

          if (exports.includes(name)) exportToNodeId.set(name, nId);

          functionStack.push(currentFunction);
          currentFunction = name;
        },
        exit(nodePath) {
          const name = nodePath.node.id?.name;
          if (name) currentFunction = functionStack.pop();
        },
      },

      // ── Variable declarations (arrow functions, const) ──
      VariableDeclarator(nodePath) {
        if (!t.isIdentifier(nodePath.node.id)) return;
        const name = nodePath.node.id.name;
        const init = nodePath.node.init;
        const line = nodePath.node.loc?.start?.line;

        const isArrowFn = t.isArrowFunctionExpression(init);
        const isFnExpr = t.isFunctionExpression(init);

        if (isArrowFn || isFnExpr) {
          const isComponent = /^[A-Z]/.test(name) && !/^use[A-Z]/.test(name);
          const isHook = /^use[A-Z]/.test(name);
          const isAsync = (isArrowFn && init.async) || (isFnExpr && init.async) ? 1 : 0;
          const nId = nodeId(relativePath, name);

          nodes.push({
            id: nId,
            type: isComponent ? 'component' : (isHook ? 'hook' : 'function'),
            name,
            file_path: relativePath,
            qualified_name: `${relativePath}::${name}`,
            kind: isComponent ? 'component' : (isHook ? 'hook' : 'arrow'),
            start_line: line,
            end_line: nodePath.node.loc?.end?.line,
            is_exported: exports.includes(name) ? 1 : 0,
            is_async: isAsync,
            signature: null,
          });

          edges.push({ source: fid, target: nId, kind: 'contains', line });
          if (exports.includes(name)) exportToNodeId.set(name, nId);
        } else {
          // Regular variable
          const nId = nodeId(relativePath, `var:${name}`);
          nodes.push({
            id: nId,
            type: 'variable',
            name,
            file_path: relativePath,
            qualified_name: `${relativePath}::${name}`,
            kind: 'variable',
            start_line: line,
            is_exported: exports.includes(name) ? 1 : 0,
          });
          edges.push({ source: fid, target: nId, kind: 'contains', line });
          if (exports.includes(name)) exportToNodeId.set(name, nId);
        }
      },

      // ── Class declarations ──
      ClassDeclaration(nodePath) {
        const name = nodePath.node.id?.name;
        if (!name) return;
        const line = nodePath.node.loc?.start?.line;
        const nId = nodeId(relativePath, name);

        nodes.push({
          id: nId,
          type: 'class',
          name,
          file_path: relativePath,
          qualified_name: `${relativePath}::${name}`,
          kind: 'class',
          start_line: line,
          end_line: nodePath.node.loc?.end?.line,
          is_exported: exports.includes(name) ? 1 : 0,
        });

        edges.push({ source: fid, target: nId, kind: 'contains', line });
        if (exports.includes(name)) exportToNodeId.set(name, nId);

        // Check for extends
        if (nodePath.node.superClass && t.isIdentifier(nodePath.node.superClass)) {
          const superName = nodePath.node.superClass.name;
          edges.push({
            source: nId,
            target: superName, // Will be resolved later
            kind: 'extends',
            label: superName,
            line,
            metadata: { unresolved: true },
          });
        }
      },

      // ── Call expressions ──
      CallExpression(nodePath) {
        const { callee, arguments: args } = nodePath.node;
        const line = nodePath.node.loc?.start?.line;

        // fetch()
        if (t.isIdentifier(callee) && callee.name === 'fetch') {
          const method = extractMethodFromArgs(args);
          const url = extractUrlFromArgs(args);
          const epId = endpointNodeId(method || 'GET', url || 'unknown');
          if (currentFunction) {
            const callerId = nodeId(relativePath, currentFunction);
            edges.push({
              source: callerId,
              target: epId,
              kind: 'api_call',
              label: `fetch ${method || 'GET'} ${url || ''}`.trim(),
              line,
              metadata: { type: 'fetch', method, url },
            });
          }
        }

        // axios.get/post/etc.
        if (t.isMemberExpression(callee) && t.isIdentifier(callee.object) && callee.object.name === 'axios' && t.isIdentifier(callee.property)) {
          const method = callee.property.name.toUpperCase();
          const url = extractUrlFromArgs(args);
          const epId = endpointNodeId(method, url || 'unknown');
          if (currentFunction) {
            const callerId = nodeId(relativePath, currentFunction);
            edges.push({
              source: callerId,
              target: epId,
              kind: 'api_call',
              label: `axios.${method.toLowerCase()} ${url || ''}`.trim(),
              line,
              metadata: { type: 'axios', method, url },
            });
          }
        }

        // useQuery / useMutation
        if (t.isIdentifier(callee) && (callee.name === 'useQuery' || callee.name === 'useMutation')) {
          const url = extractUrlFromArgs(args);
          const method = callee.name === 'useQuery' ? 'GET' : 'POST';
          const epId = endpointNodeId(method, url || 'unknown');
          if (currentFunction) {
            const callerId = nodeId(relativePath, currentFunction);
            edges.push({
              source: callerId,
              target: epId,
              kind: 'api_call',
              label: `${callee.name} ${method} ${url || ''}`.trim(),
              line,
              metadata: { type: callee.name, method, url },
            });
          }
        }

        // api.get/post (custom API clients)
        if (t.isMemberExpression(callee) && t.isIdentifier(callee.object) &&
            /api|client|http|apiService/i.test(callee.object.name) &&
            t.isIdentifier(callee.property) && /^(get|post|put|delete|patch)$/i.test(callee.property.name)) {
          const method = callee.property.name.toUpperCase();
          const url = extractUrlFromArgs(args);
          const epId = endpointNodeId(method, url || 'unknown');
          if (currentFunction) {
            const callerId = nodeId(relativePath, currentFunction);
            edges.push({
              source: callerId,
              target: epId,
              kind: 'api_call',
              label: `${callee.object.name}.${callee.property.name} ${url || ''}`.trim(),
              line,
              metadata: { type: 'apiClient', method, url },
            });
          }
        }

        // General function call tracking
        if (t.isIdentifier(callee) && currentFunction) {
          const calleeName = callee.name;
          if (calleeName && calleeName !== 'require' && calleeName !== 'fetch' && calleeName !== 'axios' &&
              !calleeName.startsWith('_') && calleeName.length > 1 &&
              !/^(console|Math|JSON|Object|Array|String|Number|Boolean|Date|Promise|React|process|window|document|parseInt|parseFloat|isNaN|setTimeout|setInterval|clearTimeout|clearInterval)$/.test(calleeName)) {
            const callerId = nodeId(relativePath, currentFunction);
            const calleeId = nodeId(relativePath, calleeName);
            edges.push({
              source: callerId,
              target: calleeId,
              kind: 'call',
              label: `${currentFunction} → ${calleeName}`,
              line,
            });
          }
        }
      },

      // ── JSX elements ──
      JSXOpeningElement(nodePath) {
        const nameNode = nodePath.node.name;
        let componentName = null;

        if (t.isJSXIdentifier(nameNode)) {
          componentName = nameNode.name;
        } else if (t.isJSXMemberExpression(nameNode)) {
          const parts = [];
          let current = nameNode;
          while (t.isJSXMemberExpression(current)) {
            if (t.isJSXIdentifier(current.property)) parts.unshift(current.property.name);
            current = current.object;
          }
          if (t.isJSXIdentifier(current)) parts.unshift(current.name);
          componentName = parts.join('.');
        }

        if (componentName && /^[A-Z]/.test(componentName)) {
          const parentId = currentFunction ? nodeId(relativePath, currentFunction) : fid;
          // Target: try to find the component's node ID via exports map, otherwise use name-based ID
          const targetId = exportToNodeId.get(componentName) || nodeId(relativePath, componentName);
          edges.push({
            source: parentId,
            target: targetId,
            kind: 'jsx',
            label: `<${componentName} />`,
            line: nodePath.node.loc?.start?.line,
          });
        }
      },

      // ── Scope tracking for arrow functions ──
      ArrowFunctionExpression: {
        enter(nodePath) {
          const name = (t.isVariableDeclarator(nodePath.parent) && t.isIdentifier(nodePath.parent.id))
            ? nodePath.parent.id.name : null;
          if (name) {
            functionStack.push(currentFunction);
            currentFunction = name;
          }
        },
        exit(nodePath) {
          const name = (t.isVariableDeclarator(nodePath.parent) && t.isIdentifier(nodePath.parent.id))
            ? nodePath.parent.id.name : null;
          if (name) currentFunction = functionStack.pop();
        },
      },

      FunctionExpression: {
        enter(nodePath) {
          const name = nodePath.node.id?.name ||
            (t.isVariableDeclarator(nodePath.parent) && t.isIdentifier(nodePath.parent.id))
              ? nodePath.parent.id?.name : null;
          if (name) {
            functionStack.push(currentFunction);
            currentFunction = name;
          }
        },
        exit(nodePath) {
          const name = nodePath.node.id?.name ||
            (t.isVariableDeclarator(nodePath.parent) && t.isIdentifier(nodePath.parent.id))
              ? nodePath.parent.id?.name : null;
          if (name) currentFunction = functionStack.pop();
        },
      },
    });
  } catch (e) {
    if (process.env.DEBUG) console.error(`    Traverse error in ${relativePath}: ${e.message.slice(0, 100)}`);
  }

  // Infer file node type and update it
  const fileType = inferNodeType(relativePath, exports);
  const fileNode = nodes.find(n => n.id === fid);
  if (fileNode) fileNode.type = fileType;

  // Create endpoint and package nodes for edges
  const extraNodes = [];
  const seenIds = new Set(nodes.map(n => n.id));

  for (const edge of edges) {
    if (!seenIds.has(edge.target)) {
      if (edge.target.startsWith('pkg:')) {
        extraNodes.push({
          id: edge.target,
          type: 'package',
          name: edge.target.replace('pkg:', ''),
          file_path: edge.target.replace('pkg:', ''),
          qualified_name: edge.metadata?.package || edge.target.replace('pkg:', ''),
          kind: 'package',
        });
      } else if (edge.target.startsWith('ep:')) {
        const meta = edge.metadata || {};
        extraNodes.push({
          id: edge.target,
          type: 'endpoint',
          name: `${meta.method || ''} ${meta.url || ''}`.trim() || edge.target,
          file_path: 'external',
          qualified_name: `API::${meta.method || 'GET'} ${meta.url || ''}`.trim(),
          kind: 'endpoint',
          metadata: meta,
        });
      }
      seenIds.add(edge.target);
    }
  }

  // Batch insert
  storage.upsertNodes([...nodes, ...extraNodes]);
  storage.upsertEdges(edges);

  return { nodes: nodes.length, edges: edges.length, exports: exports.length };
}

// ──────────── URL / Method extractors ────────────

function extractUrlFromArgs(args) {
  if (args.length === 0) return null;
  const first = args[0];
  if (t.isStringLiteral(first)) return first.value;
  if (t.isTemplateLiteral(first) && first.quasis.length > 0) {
    return first.quasis.map(q => q.value.cooked).join('${…}');
  }
  return null;
}

function extractMethodFromArgs(args) {
  if (args.length < 2) return 'GET';
  const second = args[1];
  if (t.isObjectExpression(second)) {
    const methodProp = second.properties.find(p =>
      t.isObjectProperty(p) && t.isIdentifier(p.key) && p.key.name === 'method' && t.isStringLiteral(p.value)
    );
    if (methodProp) return methodProp.value.value.toUpperCase();
  }
  return 'GET';
}

module.exports = { analyzeFile, discoverFiles, inferNodeType, nodeId, fileNodeId, pkgNodeId, endpointNodeId, safeRelative };
