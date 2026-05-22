#!/usr/bin/env node

/**
 * analyze.js — Static codebase analyzer for React Native / Expo projects
 *
 * Crawls source files, parses with @babel/parser, traverses with @babel/traverse,
 * and outputs a graph.json with nodes (files, components, hooks, screens, stores,
 * services, apis) and edges (imports, JSX usage, API calls, function calls).
 *
 * Usage:
 *   node analyze.js [path]              # analyze a project directory
 *   node analyze.js                      # defaults to current directory
 */

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');

// ──────────────────────────── Configuration ────────────────────────────

const IGNORE_DIRS = new Set([
  'node_modules', '.expo', 'android', 'ios', 'assets', '.git',
  '__tests__', '__mocks__', '__snapshots__', 'dist', 'build',
  '.cache', '.next', 'coverage', '.vscode', '.idea',
]);

const VALID_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx']);

const SCREEN_PATTERNS = [/\/screens?\//i, /\/app\//i, /screen\.(js|jsx|ts|tsx)$/i];
const HOOK_PATTERNS  = [/\/hooks?\//i, /^use[A-Z]/, /use[A-Z].*\.(js|jsx|ts|tsx)$/i];
const STORE_PATTERNS = [/\/store?s?\//i, /\/state\//i, /\/redux\//i, /\/zustand\//i, /(store|reducer|slice|state)\.(js|jsx|ts|tsx)$/i];
const SERVICE_PATTERNS = [/\/services?\//i, /\/lib\//i, /\/utils?\//i, /\/helpers?\//i, /(service|client|helper)\.(js|jsx|ts|tsx)$/i];
const API_PATTERNS = [/\/api\//i, /\/api\./i, /(api|endpoint|http)\.(js|jsx|ts|tsx)$/i];
const COMPONENT_PATTERNS = [/\/components?\//i, /\.style\.(js|jsx|ts|tsx)$/i];

// ──────────────────────────── Helpers ────────────────────────────

function resolveImportPath(importPath, fromFile, srcRoot) {
  // Only resolve relative imports
  if (!importPath.startsWith('.')) return null;

  const dir = path.dirname(fromFile);
  let resolved = path.resolve(dir, importPath);

  // Try adding extensions
  for (const ext of VALID_EXTENSIONS) {
    const withExt = resolved + ext;
    if (fs.existsSync(withExt)) return withExt;
  }
  // Try index files
  for (const ext of VALID_EXTENSIONS) {
    const indexPath = path.join(resolved, 'index' + ext);
    if (fs.existsSync(indexPath)) return indexPath;
  }
  return null;
}

function inferNodeType(filePath, exports) {
  const normalized = filePath.replace(/\\/g, '/');

  // Check screens first (most specific)
  if (SCREEN_PATTERNS.some(p => p.test(normalized))) return 'screen';

  // Check hooks (useX naming convention in exports)
  const hasHookExport = exports.some(e => /^use[A-Z]/.test(e));
  if (HOOK_PATTERNS.some(p => p.test(normalized)) || hasHookExport) return 'hook';

  // Check stores
  if (STORE_PATTERNS.some(p => p.test(normalized))) return 'store';

  // Check API layer
  if (API_PATTERNS.some(p => p.test(normalized))) return 'api';

  // Check services
  if (SERVICE_PATTERNS.some(p => p.test(normalized))) return 'service';

  // Check components (must have a React component export)
  const hasComponentExport = exports.some(e => /^[A-Z]/.test(e));
  if (COMPONENT_PATTERNS.some(p => p.test(normalized)) && hasComponentExport) return 'component';
  if (hasComponentExport && !hasHookExport) return 'component';

  // Fallback
  return 'file';
}

function getNodeTypeIcon(type) {
  switch (type) {
    case 'screen':    return '📱';
    case 'component': return '🧩';
    case 'hook':      return '🪝';
    case 'store':     return '🗄️';
    case 'service':   return '⚙️';
    case 'api':       return '🌐';
    default:          return '📄';
  }
}

function safeRelative(fullPath, root) {
  try {
    return path.relative(root, fullPath).replace(/\\/g, '/');
  } catch {
    return fullPath;
  }
}

// ──────────────────────────── File Discovery ────────────────────────────

function discoverFiles(rootDir) {
  const files = [];

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.env') continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (VALID_EXTENSIONS.has(ext)) {
          files.push(fullPath);
        }
      }
    }
  }

  walk(rootDir);
  return files;
}

// ──────────────────────────── AST Analysis ────────────────────────────

function analyzeFile(filePath, rootDir) {
  const relativePath = safeRelative(filePath, rootDir);
  let source;
  try {
    source = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  // Skip very large files (>1MB)
  if (source.length > 1_000_000) return null;

  let ast;
  try {
    ast = parser.parse(source, {
      sourceType: 'unambiguous',
      plugins: [
        'jsx',
        'typescript',
        ['decorators', { decoratorsBeforeExport: true }],
        'classProperties',
        'classPrivateProperties',
        'classPrivateMethods',
        'exportDefaultFrom',
        'exportNamespaceFrom',
        'dynamicImport',
        'nullishCoalescingOperator',
        'optionalChaining',
        'objectRestSpread',
        'asyncGenerators',
        'importMeta',
        'logicalAssignment',
        'numericSeparator',
        'optionalCatchBinding',
        ['pipelineOperator', { proposal: 'hack', topicToken: '%' }],
        'throwExpressions',
        'topLevelAwait',
        'doExpressions',
        'decoratorAutoAccessors',
        'explicitResourceManagement',
        'importAttributes',
      ],
      errorRecovery: true,
    });
  } catch (e) {
    // Skip files that can't be parsed — log for debugging
    if (process.env.DEBUG) console.error(`    Parse error in ${relativePath}: ${e.message.slice(0, 100)}`);
    return null;
  }

  const imports = [];          // { source, specifiers, resolvedPath }
  const jsxUsages = [];        // { componentName, line }
  const apiCalls = [];         // { type, method, url, line }
  const functionCalls = [];    // { caller, callee, line }
  const exports = [];          // export names
  const functionDefs = [];     // { name, type: 'function'|'arrow'|'method', line }
  const reactComponents = [];  // { name, type: 'function'|'arrow'|'class', line }

  let currentFunction = null;  // Track the function we're inside
  const functionStack = [];

  try {
    traverse(ast, {
      // ── Import declarations ──
      ImportDeclaration(nodePath) {
        const source = nodePath.node.source.value;
        const specifiers = nodePath.node.specifiers.map(spec => {
          if (t.isImportDefaultSpecifier(spec) || t.isImportNamespaceSpecifier(spec)) {
            return { imported: 'default', local: spec.local.name };
          }
          if (t.isImportSpecifier(spec)) {
            const imported = t.isIdentifier(spec.imported)
              ? spec.imported.name
              : spec.imported.value;
            return { imported, local: spec.local.name };
          }
          return null;
        }).filter(Boolean);

        const resolvedPath = resolveImportPath(source, filePath, rootDir);

        imports.push({
          source,
          specifiers,
          resolvedPath: resolvedPath ? safeRelative(resolvedPath, rootDir) : null,
          line: nodePath.node.loc?.start?.line,
        });
      },

      // ── Require calls (CommonJS) ──
      CallExpression(nodePath) {
        const { callee, arguments: args } = nodePath.node;

        // require('...')
        if (t.isIdentifier(callee) && callee.name === 'require' && args.length === 1 && t.isStringLiteral(args[0])) {
          const source = args[0].value;
          const resolvedPath = resolveImportPath(source, filePath, rootDir);
          imports.push({
            source,
            specifiers: [{ imported: 'default', local: null }],
            resolvedPath: resolvedPath ? safeRelative(resolvedPath, rootDir) : null,
            line: nodePath.node.loc?.start?.line,
          });
        }

        // ── API / Network calls ──

        // fetch(url, { method })
        if (t.isIdentifier(callee) && callee.name === 'fetch') {
          const method = extractMethodFromArgs(args);
          const url = extractUrlFromArgs(args);
          apiCalls.push({ type: 'fetch', method, url, line: nodePath.node.loc?.start?.line });
        }

        // axios.get/post/put/delete/patch(url)
        if (t.isMemberExpression(callee) &&
            t.isIdentifier(callee.object) && callee.object.name === 'axios' &&
            t.isIdentifier(callee.property)) {
          const method = callee.property.name.toUpperCase();
          const url = extractUrlFromArgs(args);
          apiCalls.push({ type: 'axios', method, url, line: nodePath.node.loc?.start?.line });
        }

        // axios({ method, url })
        if (t.isIdentifier(callee) && callee.name === 'axios' && args.length > 0 && t.isObjectExpression(args[0])) {
          const method = extractMethodFromObject(args[0]);
          const url = extractUrlFromObject(args[0]);
          apiCalls.push({ type: 'axios', method, url, line: nodePath.node.loc?.start?.line });
        }

        // useQuery(key, queryFn) / useMutation(mutationFn)
        if (t.isIdentifier(callee) && (callee.name === 'useQuery' || callee.name === 'useMutation')) {
          const url = extractUrlFromArgs(args);
          apiCalls.push({
            type: callee.name,
            method: callee.name === 'useQuery' ? 'GET' : 'POST',
            url,
            line: nodePath.node.loc?.start?.line,
          });
        }

        // api.get/post(...)  — custom api clients
        if (t.isMemberExpression(callee) &&
            t.isIdentifier(callee.object) && /api|client|http|apiService/i.test(callee.object.name) &&
            t.isIdentifier(callee.property) && /^(get|post|put|delete|patch|head|options)$/i.test(callee.property.name)) {
          const method = callee.property.name.toUpperCase();
          const url = extractUrlFromArgs(args);
          apiCalls.push({ type: 'apiClient', method, url, line: nodePath.node.loc?.start?.line });
        }

        // ── General function call tracking ──
        if (t.isIdentifier(callee) && currentFunction && !/^(console|Math|JSON|Object|Array|String|Number|Boolean|Date|Promise|React|require|fetch|axios)$/.test(callee.object?.name || callee.name)) {
          // Only track calls to identifiers that might be user-defined
          const calleeName = callee.name;
          if (calleeName && calleeName !== 'require' && calleeName !== 'fetch' && calleeName !== 'axios' &&
              !calleeName.startsWith('_') && calleeName.length > 1) {
            functionCalls.push({
              caller: currentFunction,
              callee: calleeName,
              line: nodePath.node.loc?.start?.line,
            });
          }
        }
      },

      // ── Export declarations ──
      ExportDefaultDeclaration(nodePath) {
        const decl = nodePath.node.declaration;
        if (t.isIdentifier(decl)) {
          exports.push(decl.name);
        } else if (t.isFunctionDeclaration(decl) && decl.id) {
          exports.push(decl.id.name);
        } else if (t.isClassDeclaration(decl) && decl.id) {
          exports.push(decl.id.name);
        }
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
        // export { foo, bar }
        for (const spec of nodePath.node.specifiers) {
          if (t.isExportSpecifier(spec)) {
            const name = t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value;
            exports.push(name);
          }
        }
      },

      // ── Function definitions ──
      FunctionDeclaration(nodePath) {
        const name = nodePath.node.id?.name;
        if (!name) return;
        const line = nodePath.node.loc?.start?.line;
        functionDefs.push({ name, type: 'function', line });

        // React component check: starts with uppercase
        if (/^[A-Z]/.test(name)) {
          reactComponents.push({ name, type: 'function', line });
        }
      },

      // Arrow functions assigned to variables: const Foo = () => {}
      VariableDeclarator(nodePath) {
        const init = nodePath.node.init;
        if (!t.isArrowFunctionExpression(init) && !t.isFunctionExpression(init)) return;
        if (!t.isIdentifier(nodePath.node.id)) return;

        const name = nodePath.node.id.name;
        const line = nodePath.node.loc?.start?.line;
        functionDefs.push({ name, type: 'arrow', line });

        // React component check
        if (/^[A-Z]/.test(name)) {
          reactComponents.push({ name, type: 'arrow', line });
        }

        // Hook check
        if (/^use[A-Z]/.test(name)) {
          // It's a hook, tracked via exports
        }
      },

      // Class methods
      ClassMethod(nodePath) {
        const name = t.isIdentifier(nodePath.node.key) ? nodePath.node.key.name : null;
        if (!name) return;
        const line = nodePath.node.loc?.start?.line;
        functionDefs.push({ name, type: 'method', line });
      },

      // ── JSX element usage ──
      JSXOpeningElement(nodePath) {
        const nameNode = nodePath.node.name;
        let componentName = null;

        if (t.isJSXIdentifier(nameNode)) {
          componentName = nameNode.name;
        } else if (t.isJSXMemberExpression(nameNode)) {
          // e.g. <NavigationContainer>
          const parts = [];
          let current = nameNode;
          while (t.isJSXMemberExpression(current)) {
            if (t.isJSXIdentifier(current.property)) {
              parts.unshift(current.property.name);
            }
            current = current.object;
          }
          if (t.isJSXIdentifier(current)) {
            parts.unshift(current.name);
          }
          componentName = parts.join('.');
        }

        // Only track user-defined components (start with uppercase)
        if (componentName && /^[A-Z]/.test(componentName)) {
          jsxUsages.push({
            componentName,
            line: nodePath.node.loc?.start?.line,
          });
        }
      },

      // ── Track current function scope for call graph (enter) ──
      FunctionDeclaration: {
        enter(nodePath) {
          const name = nodePath.node.id?.name;
          if (name) {
            functionStack.push(currentFunction);
            currentFunction = name;
          }
        },
        exit(nodePath) {
          const name = nodePath.node.id?.name;
          if (name) {
            currentFunction = functionStack.pop();
          }
        },
      },

      FunctionExpression: {
        enter(nodePath) {
          const name = nodePath.node.id?.name ||
                       (t.isVariableDeclarator(nodePath.parent) && t.isIdentifier(nodePath.parent.id)
                         ? nodePath.parent.id.name : null);
          if (name) {
            functionStack.push(currentFunction);
            currentFunction = name;
          }
        },
        exit(nodePath) {
          const name = nodePath.node.id?.name ||
                       (t.isVariableDeclarator(nodePath.parent) && t.isIdentifier(nodePath.parent.id)
                         ? nodePath.parent.id.name : null);
          if (name) {
            currentFunction = functionStack.pop();
          }
        },
      },

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
          if (name) {
            currentFunction = functionStack.pop();
          }
        },
      },
    });
  } catch (e) {
    // If traversal fails, return partial results
    if (process.env.DEBUG) console.error(`    Traverse error in ${relativePath}: ${e.message.slice(0, 100)}`);
  }

  // Infer node type
  const nodeType = inferNodeType(filePath, exports);

  return {
    id: relativePath,
    type: nodeType,
    path: relativePath,
    exports,
    imports,
    jsxUsages,
    apiCalls,
    functionCalls,
    functionDefs,
    reactComponents,
    linesOfCode: source.split('\n').length,
  };
}

// ──────────────────────────── URL / Method extractors ────────────────────────────

function extractUrlFromArgs(args) {
  if (args.length === 0) return null;
  const first = args[0];
  if (t.isStringLiteral(first)) return first.value;
  if (t.isTemplateLiteral(first) && first.quasis.length > 0) {
    return first.quasis.map(q => q.value.cooked).join('${...}');
  }
  return null;
}

function extractMethodFromArgs(args) {
  if (args.length < 2) return 'GET';
  const second = args[1];
  if (t.isObjectExpression(second)) {
    const methodProp = second.properties.find(p =>
      t.isObjectProperty(p) &&
      t.isIdentifier(p.key) && p.key.name === 'method' &&
      t.isStringLiteral(p.value)
    );
    if (methodProp) return methodProp.value.value.toUpperCase();
  }
  return 'GET';
}

function extractMethodFromObject(objExpr) {
  const methodProp = objExpr.properties.find(p =>
    t.isObjectProperty(p) &&
    t.isIdentifier(p.key) && p.key.name === 'method' &&
    t.isStringLiteral(p.value)
  );
  return methodProp ? methodProp.value.value.toUpperCase() : null;
}

function extractUrlFromObject(objExpr) {
  const urlProp = objExpr.properties.find(p =>
    t.isObjectProperty(p) &&
    t.isIdentifier(p.key) && (p.key.name === 'url' || p.key.name === 'baseURL') &&
    t.isStringLiteral(p.value)
  );
  return urlProp ? urlProp.value.value : null;
}

// ──────────────────────────── Graph Builder ────────────────────────────

function buildGraph(filesData) {
  const nodes = [];
  const edges = [];

  // Build a lookup: exported name → file
  const exportToFiles = new Map(); // name → [filePath, ...]
  for (const fd of filesData) {
    for (const exp of fd.exports) {
      if (!exportToFiles.has(exp)) exportToFiles.set(exp, []);
      exportToFiles.get(exp).push(fd.id);
    }
  }

  for (const fd of filesData) {
    // Node
    nodes.push({
      id: fd.id,
      type: fd.type,
      path: fd.path,
      exports: fd.exports,
      linesOfCode: fd.linesOfCode,
      reactComponents: fd.reactComponents.map(c => c.name),
      functionDefs: fd.functionDefs.map(f => ({ name: f.name, type: f.type, line: f.line })),
      apiCalls: fd.apiCalls,
    });

    // ── Edges: file imports ──
    for (const imp of fd.imports) {
      if (imp.resolvedPath) {
        edges.push({
          source: fd.id,
          target: imp.resolvedPath,
          type: 'import',
          label: imp.specifiers.map(s => s.imported).join(', '),
          line: imp.line,
        });
      } else if (imp.source && !imp.source.startsWith('.')) {
        // External dependency — create a package node
        const pkgName = imp.source.split('/')[0];
        const pkgId = `pkg:${pkgName}`;
        // We'll add these nodes later if not already present
        edges.push({
          source: fd.id,
          target: pkgId,
          type: 'external',
          label: imp.specifiers.map(s => s.imported).join(', '),
          line: imp.line,
        });
      }
    }

    // ── Edges: JSX component usage ──
    for (const jsx of fd.jsxUsages) {
      const targetFiles = exportToFiles.get(jsx.componentName);
      if (targetFiles && targetFiles.length > 0) {
        // Prefer the component defined in a components/ directory
        const best = targetFiles.find(f => /components?\//i.test(f)) || targetFiles[0];
        edges.push({
          source: fd.id,
          target: best,
          type: 'jsx',
          label: jsx.componentName,
          line: jsx.line,
        });
      }
    }

    // ── Edges: API calls ──
    for (const api of fd.apiCalls) {
      const label = api.url
        ? `${api.type} ${api.method || ''} ${api.url}`.trim()
        : `${api.type} ${api.method || ''}`.trim();

      // Try to find a matching API service file
      const apiFile = filesData.find(f => f.type === 'api' && f.path.includes(api.url?.split('/')[0] || '___'));
      if (apiFile) {
        edges.push({
          source: fd.id,
          target: apiFile.id,
          type: 'api',
          label,
          line: api.line,
        });
      } else {
        // Create a virtual API endpoint node
        const endpointId = `api:${api.url || api.type}`;
        edges.push({
          source: fd.id,
          target: endpointId,
          type: 'api',
          label,
          line: api.line,
        });
      }
    }

    // ── Edges: function calls (within file) ──
    for (const call of fd.functionCalls) {
      // Try to resolve the called function to a file
      const targetFiles = exportToFiles.get(call.callee);
      if (targetFiles && targetFiles.length > 0) {
        const best = targetFiles.find(f => f !== fd.id) || targetFiles[0];
        if (best !== fd.id) {
          edges.push({
            source: fd.id,
            target: best,
            type: 'call',
            label: `${call.caller} → ${call.callee}`,
            line: call.line,
          });
        }
      }
    }
  }

  // Add package nodes for external deps
  const pkgIds = new Set();
  for (const e of edges) {
    if (e.target.startsWith('pkg:')) {
      pkgIds.add(e.target);
    }
  }
  // Add API endpoint nodes
  const apiIds = new Set();
  for (const e of edges) {
    if (e.target.startsWith('api:')) {
      apiIds.add(e.target);
    }
  }

  for (const pkgId of pkgIds) {
    const name = pkgId.replace('pkg:', '');
    nodes.push({
      id: pkgId,
      type: 'package',
      path: name,
      exports: [],
      linesOfCode: 0,
      reactComponents: [],
      functionDefs: [],
      apiCalls: [],
    });
  }

  for (const apiId of apiIds) {
    const name = apiId.replace('api:', '');
    nodes.push({
      id: apiId,
      type: 'endpoint',
      path: name,
      exports: [],
      linesOfCode: 0,
      reactComponents: [],
      functionDefs: [],
      apiCalls: [],
    });
  }

  return { nodes, edges };
}

// ──────────────────────────── Main ────────────────────────────

function main() {
  const targetDir = process.argv[2] || process.cwd();
  const rootDir = path.resolve(targetDir);

  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════╗');
  console.log('  ║         Codebase Graph Analyzer v1.0                ║');
  console.log('  ║         Static analysis → graph.json                ║');
  console.log('  ╚══════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  📂 Target: ${rootDir}`);
  console.log('');

  // Step 1: Discover files
  console.log('  🔍 Discovering source files...');
  const files = discoverFiles(rootDir);
  console.log(`     Found ${files.length} source files\n`);

  if (files.length === 0) {
    console.log('  ⚠️  No source files found. Check the target directory.');
    process.exit(1);
  }

  // Step 2: Analyze each file
  console.log('  🔬 Analyzing with Babel parser...');
  const filesData = [];
  const errors = [];

  for (const file of files) {
    const result = analyzeFile(file, rootDir);
    if (result) {
      filesData.push(result);
    } else {
      errors.push(safeRelative(file, rootDir));
    }
  }

  console.log(`     Analyzed: ${filesData.length} files`);
  if (errors.length > 0) {
    console.log(`     Skipped:  ${errors.length} files (parse errors)`);
  }
  console.log('');

  // Step 3: Build graph
  console.log('  🕸️  Building graph...');
  const graph = buildGraph(filesData);
  console.log(`     Nodes: ${graph.nodes.length}`);
  console.log(`     Edges: ${graph.edges.length}`);
  console.log('');

  // Step 4: Compute stats
  const stats = {
    totalFiles: filesData.length,
    totalLines: filesData.reduce((s, f) => s + f.linesOfCode, 0),
    nodeTypes: {},
    edgeTypes: {},
    reactComponents: 0,
    hooks: 0,
    apiCalls: 0,
    imports: 0,
  };

  for (const n of graph.nodes) {
    stats.nodeTypes[n.type] = (stats.nodeTypes[n.type] || 0) + 1;
  }
  for (const e of graph.edges) {
    stats.edgeTypes[e.type] = (stats.edgeTypes[e.type] || 0) + 1;
  }
  for (const fd of filesData) {
    stats.reactComponents += fd.reactComponents.length;
    stats.hooks += fd.exports.filter(e => /^use[A-Z]/.test(e)).length;
    stats.apiCalls += fd.apiCalls.length;
    stats.imports += fd.imports.length;
  }

  // Attach stats to graph
  graph.stats = stats;

  // Step 5: Write output
  const outputPath = path.join(rootDir, 'graph.json');
  fs.writeFileSync(outputPath, JSON.stringify(graph, null, 2), 'utf-8');
  console.log(`  💾 Wrote graph.json to: ${outputPath}`);
  console.log('');

  // Step 6: Print stats
  console.log('  ╔══════════════════════════════════════════════════════╗');
  console.log('  ║                  Analysis Stats                      ║');
  console.log('  ╠══════════════════════════════════════════════════════╣');
  console.log(`  ║  Source files analyzed:  ${String(stats.totalFiles).padEnd(27)}║`);
  console.log(`  ║  Total lines of code:   ${String(stats.totalLines).padEnd(27)}║`);
  console.log(`  ║  React components:      ${String(stats.reactComponents).padEnd(27)}║`);
  console.log(`  ║  Custom hooks:          ${String(stats.hooks).padEnd(27)}║`);
  console.log(`  ║  API/network calls:     ${String(stats.apiCalls).padEnd(27)}║`);
  console.log(`  ║  Import statements:     ${String(stats.imports).padEnd(27)}║`);
  console.log('  ╠══════════════════════════════════════════════════════╣');
  console.log('  ║  Node types:                                         ║');
  for (const [type, count] of Object.entries(stats.nodeTypes).sort((a, b) => b[1] - a[1])) {
    console.log(`  ║    ${type.padEnd(12)} ${String(count).padEnd(37)}║`);
  }
  console.log('  ╠══════════════════════════════════════════════════════╣');
  console.log('  ║  Edge types:                                         ║');
  for (const [type, count] of Object.entries(stats.edgeTypes).sort((a, b) => b[1] - a[1])) {
    console.log(`  ║    ${type.padEnd(12)} ${String(count).padEnd(37)}║`);
  }
  console.log('  ╚══════════════════════════════════════════════════════╝');
  console.log('');
  console.log('  ✅ Done! Open visualizer.html and load graph.json to explore.');
  console.log('');
}

main();
