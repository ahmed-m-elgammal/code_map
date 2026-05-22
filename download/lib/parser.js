/**
 * parser.js — Babel-based AST Parser v3.6 — Deep Semantic Extraction
 *
 * Parses .js, .jsx, .ts, .tsx files with @babel/parser + @babel/traverse.
 * Extracts fine-grained symbols AND deep semantic relationships:
 *
 * NEW in v3.6:
 *   - File exclusion system with .codegraphignore support
 *   - .codegraph/config.json with exclude/include/onlyDirs settings
 *   - CLI flags: --exclude, --only, --only-dirs, --max-file-size
 *   - --init-ignore and --init-config to scaffold config files
 *   - Glob pattern matching (*, **, ?, !negation)
 *   - Directory-level pruning for performance
 *   - File size limit enforcement
 *
 * v3.5 features:
 *   - React Navigation detection (navigate, push, goBack, useNavigation, Stack.Screen)
 *   - Auth pattern detection (useAuth, isAuthenticated, ProtectedRoute, AuthContext, token)
 *   - React Context detection (createContext, useContext, XxxProvider)
 *   - State management detection (createSlice, createStore, useStore, useSelector, useDispatch, zustand create)
 *   - Form handling detection (useForm, handleSubmit, validate, onChange, Formik)
 *   - Error boundary detection (componentDidCatch, ErrorBoundary)
 *   - WebSocket / real-time detection (WebSocket, socket.io, useWebSocket)
 *   - Local storage detection (AsyncStorage, SecureStore, localStorage, mmkv)
 *   - Permission detection (checkPermission, requestPermission)
 *   - Deep link detection (Linking.openURL, useURL, deepLink)
 *   - Push notification detection (PushNotification, registerForPushNotifications)
 *   - Environment variable detection (process.env)
 *   - Route/screen definition detection (Stack.Screen name=, Tab.Screen name=)
 *   - Middleware detection (app.use, router.use)
 *   - Event emitter detection (emit, on, addEventListener)
 *   - richer metadata on every node and edge
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
const NAVIGATION_PATTERNS = [/\/navigation\//i, /\/navigators?\//i, /\/routing\//i, /(navigation|navigator|router)\.(js|jsx|ts|tsx)$/i];
const CONTEXT_PATTERNS  = [/\/contexts?\//i, /\/providers?\//i, /(context|provider)\.(js|jsx|ts|tsx)$/i];
const MIDDLEWARE_PATTERNS = [/\/middleware\//i, /\/middlewares?\//i, /middleware\.(js|jsx|ts|tsx)$/i];

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

function routeNodeId(routeName) {
  return 'route:' + crypto.createHash('md5').update(routeName).digest('hex').slice(0, 10);
}

function inferNodeType(filePath, exports) {
  const normalized = filePath.replace(/\\/g, '/');
  if (SCREEN_PATTERNS.some(p => p.test(normalized))) return 'screen';
  if (NAVIGATION_PATTERNS.some(p => p.test(normalized))) return 'service';
  if (CONTEXT_PATTERNS.some(p => p.test(normalized))) return 'store';
  if (MIDDLEWARE_PATTERNS.some(p => p.test(normalized))) return 'service';
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

// ──────────── File Exclusion / Ignore System ────────────

/**
 * Convert a .codegraphignore glob pattern to a RegExp.
 * Supports:
 *   - * matches anything except /
 *   - ** matches anything including /
 *   - ! prefix negates (re-include)
 *   - # comments
 *   - /dir/ matches directory at any depth
 *   - dir/ matches directory at any depth
 *   - *.ext matches file extension
 *   - path/file matches specific file
 */
function globToRegex(pattern, rootDir) {
  let p = pattern.trim();
  const negated = p.startsWith('!');
  if (negated) p = p.slice(1);

  // Remove leading / (it's relative to root)
  if (p.startsWith('/')) p = p.slice(1);

  // Escape regex special chars, then convert glob wildcards
  let re = p
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape special chars
    .replace(/\*\*/g, '{{GLOBSTAR}}')        // preserve **
    .replace(/\*/g, '[^/]*')                  // * matches non-/
    .replace(/\?/g, '[^/]')                   // ? matches single non-/
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');      // ** matches anything

  // If pattern ends with /, match any file under that dir
  if (re.endsWith('/')) re = re + '.*';

  // If pattern has no / in it, match at any depth (basename match)
  if (!p.includes('/')) {
    re = '(^|.*/)' + re;
  } else {
    re = '.*' + re; // prefix match for path patterns
  }

  try {
    return { regex: new RegExp(re, 'i'), negated };
  } catch {
    return null;
  }
}

/**
 * Parse a .codegraphignore file and return exclusion rules.
 * Returns { exclude: RegExp[], include: RegExp[] }
 */
function parseIgnoreFile(filePath, rootDir) {
  const rules = { exclude: [], include: [] };
  if (!fs.existsSync(filePath)) return rules;

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    for (let line of content.split('\n')) {
      line = line.trim();
      // Skip empty lines and comments
      if (!line || line.startsWith('#')) continue;

      const rule = globToRegex(line, rootDir);
      if (!rule) continue;

      if (rule.negated) {
        rules.include.push(rule.regex);
      } else {
        rules.exclude.push(rule.regex);
      }
    }
  } catch (e) {
    // Silently ignore parse errors
  }
  return rules;
}

/**
 * Load .codegraph/config.json exclusion settings.
 * Config format:
 * {
 *   "exclude": ["pattern1", "pattern2", ...],
 *   "include": ["pattern3", ...],
 *   "excludeDirs": ["dirname1", ...],
 *   "excludeExtensions": [".ext1", ...],
 *   "maxFileSize": 500000,
 *   "onlyDirs": ["src", "app"],
 *   "onlyTypes": ["screen", "component"]
 * }
 */
function loadConfig(rootDir) {
  const configPath = path.join(rootDir, '.codegraph', 'config.json');
  const defaultConfig = {
    exclude: [],
    include: [],
    excludeDirs: [],
    excludeExtensions: [],
    maxFileSize: 1_000_000,
    onlyDirs: [],
    onlyTypes: [],
  };

  if (!fs.existsSync(configPath)) return defaultConfig;

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(content);
    return { ...defaultConfig, ...parsed };
  } catch {
    return defaultConfig;
  }
}

/**
 * Build the complete exclusion context from all sources:
 *   1. Default IGNORE_DIRS
 *   2. .codegraph/config.json
 *   3. .codegraphignore file
 *   4. CLI --exclude patterns
 *   5. CLI --include-only patterns
 *
 * Returns an object with:
 *   - excludeRegexes: RegExp[] - patterns that exclude files
 *   - includeRegexes: RegExp[] - patterns that re-include excluded files (negation)
 *   - extraIgnoreDirs: Set<string> - additional directory names to skip
 *   - excludeExtensions: Set<string> - file extensions to skip
 *   - maxFileSize: number - max file size in bytes
 *   - onlyDirs: string[] - if set, only scan these directories
 *   - stats: { rulesFrom... } - debug info
 */
function buildExclusionContext(rootDir, cliOptions = {}) {
  const ctx = {
    excludeRegexes: [],
    includeRegexes: [],
    extraIgnoreDirs: new Set(),
    excludeExtensions: new Set(),
    maxFileSize: cliOptions.maxFileSize || 1_000_000,
    onlyDirs: [],
    stats: {
      rulesFromConfig: 0,
      rulesFromIgnoreFile: 0,
      rulesFromCLI: 0,
      totalExclude: 0,
      totalInclude: 0,
    },
  };

  // 1. Load .codegraph/config.json
  const config = loadConfig(rootDir);
  for (const p of (config.exclude || [])) {
    const rule = globToRegex(p, rootDir);
    if (rule && !rule.negated) ctx.excludeRegexes.push(rule.regex);
    if (rule && rule.negated) ctx.includeRegexes.push(rule.regex);
    ctx.stats.rulesFromConfig++;
  }
  for (const p of (config.include || [])) {
    const rule = globToRegex(p, rootDir);
    if (rule) ctx.includeRegexes.push(rule.regex);
    ctx.stats.rulesFromConfig++;
  }
  for (const d of (config.excludeDirs || [])) {
    ctx.extraIgnoreDirs.add(d);
  }
  for (const ext of (config.excludeExtensions || [])) {
    ctx.excludeExtensions.add(ext.startsWith('.') ? ext : '.' + ext);
  }
  if (config.maxFileSize) ctx.maxFileSize = config.maxFileSize;
  if (config.onlyDirs && config.onlyDirs.length > 0) {
    ctx.onlyDirs = config.onlyDirs;
  }

  // 2. Load .codegraphignore
  const ignorePath = path.join(rootDir, '.codegraphignore');
  const ignoreRules = parseIgnoreFile(ignorePath, rootDir);
  ctx.excludeRegexes.push(...ignoreRules.exclude);
  ctx.includeRegexes.push(...ignoreRules.include);
  ctx.stats.rulesFromIgnoreFile = ignoreRules.exclude.length + ignoreRules.include.length;

  // 3. CLI --exclude patterns
  for (const p of (cliOptions.exclude || [])) {
    const rule = globToRegex(p, rootDir);
    if (rule && !rule.negated) ctx.excludeRegexes.push(rule.regex);
    if (rule && rule.negated) ctx.includeRegexes.push(rule.regex);
    ctx.stats.rulesFromCLI++;
  }

  // 4. CLI --include-only patterns (these become include rules)
  for (const p of (cliOptions.includeOnly || [])) {
    const rule = globToRegex(p, rootDir);
    if (rule) ctx.includeRegexes.push(rule.regex);
  }

  // 5. CLI --only-dirs
  if (cliOptions.onlyDirs && cliOptions.onlyDirs.length > 0) {
    ctx.onlyDirs = cliOptions.onlyDirs;
  }

  ctx.stats.totalExclude = ctx.excludeRegexes.length;
  ctx.stats.totalInclude = ctx.includeRegexes.length;

  return ctx;
}

/**
 * Check if a relative file path should be excluded based on the exclusion context.
 * Returns true if the file should be EXCLUDED (skipped).
 */
function shouldExcludePath(relativePath, ctx) {
  const normalized = relativePath.replace(/\\/g, '/');

  // Check include rules FIRST (they override exclusions)
  for (const re of ctx.includeRegexes) {
    if (re.test(normalized)) return false; // explicitly included
  }

  // Check exclude rules
  for (const re of ctx.excludeRegexes) {
    if (re.test(normalized)) return true; // excluded
  }

  return false; // not excluded
}

/**
 * Check if a directory should be skipped during walk.
 */
function shouldSkipDir(dirName, fullPath, rootDir, ctx) {
  // Default ignore dirs
  if (IGNORE_DIRS.has(dirName)) return true;
  // Extra ignore dirs from config
  if (ctx.extraIgnoreDirs.has(dirName)) return true;
  // Hidden dirs (except .env)
  if (dirName.startsWith('.') && dirName !== '.env') return true;

  // If onlyDirs is set, only enter dirs that match
  if (ctx.onlyDirs && ctx.onlyDirs.length > 0) {
    const relDir = safeRelative(fullPath, rootDir).replace(/\\/g, '/');
    const matchesAllowed = ctx.onlyDirs.some(d => {
      const dn = d.replace(/\\/g, '/');
      return relDir === dn || relDir.startsWith(dn + '/') || dn.startsWith(relDir + '/');
    });
    if (!matchesAllowed) return true;
  }

  // Check directory against exclusion patterns
  const relDir = safeRelative(fullPath, rootDir).replace(/\\/g, '/');
  // Include rules first
  for (const re of ctx.includeRegexes) {
    if (re.test(relDir + '/')) return false;
  }
  for (const re of ctx.excludeRegexes) {
    if (re.test(relDir + '/')) return true;
  }

  return false;
}

// ──────────── File Discovery ────────────

function discoverFiles(rootDir, options = {}) {
  const ctx = buildExclusionContext(rootDir, options);
  const files = [];
  let excludedCount = 0;

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name, fullPath, rootDir, ctx)) continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        // Check extension
        const ext = path.extname(entry.name);
        if (!VALID_EXTENSIONS.has(ext)) continue;
        // Check excluded extensions
        if (ctx.excludeExtensions.has(ext)) continue;

        const relPath = safeRelative(fullPath, rootDir);

        // Check exclusion patterns
        if (shouldExcludePath(relPath, ctx)) {
          excludedCount++;
          continue;
        }

        // Check file size
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > ctx.maxFileSize) {
            excludedCount++;
            continue;
          }
        } catch {
          continue;
        }

        files.push(fullPath);
      }
    }
  }

  walk(rootDir);

  // Attach exclusion stats for reporting
  files._exclusionStats = {
    excludedFiles: excludedCount,
    excludeRules: ctx.stats.totalExclude,
    includeRules: ctx.stats.totalInclude,
    rulesFromConfig: ctx.stats.rulesFromConfig,
    rulesFromIgnoreFile: ctx.stats.rulesFromIgnoreFile,
    rulesFromCLI: ctx.stats.rulesFromCLI,
    onlyDirs: ctx.onlyDirs,
    extraIgnoreDirs: [...ctx.extraIgnoreDirs],
  };

  return files;
}

// ──────────── Semantic Tagging Helpers ────────────

function tagNode(node, tags) {
  if (!node.metadata) node.metadata = {};
  if (!node.metadata.tags) node.metadata.tags = [];
  for (const tag of tags) {
    if (!node.metadata.tags.includes(tag)) node.metadata.tags.push(tag);
  }
}

function tagEdge(edge, tags) {
  if (!edge.metadata) edge.metadata = {};
  if (!edge.metadata.tags) edge.metadata.tags = [];
  for (const tag of tags) {
    if (!edge.metadata.tags.includes(tag)) edge.metadata.tags.push(tag);
  }
}

// Detect semantic role from name patterns
function detectSemanticRole(name, kind) {
  const roles = [];
  const n = name.toLowerCase();

  // Auth roles
  if (/^(login|signin|signup|register|logout|signout|authenticate|forgotpassword|resetpassword|changepassword|verifyotp|verifyemail|refreshtoken|useauth|useisauthenticated|authprovider|authcontext|protectedroute|authguard|authservice|authslice|authreducer|authstore|credential|identityserver|oauth|saml|sso|twofactor|mfa|totp)$/i.test(name)) {
    roles.push('auth');
  }
  if (/isauthenticated|isloggedin|isauth|haspermission|hasrole|cantoken|tokenexpired|isexpired/i.test(name)) {
    roles.push('auth-check');
  }
  if (/token|accesstoken|refreshtoken|idtoken|bearertoken|jwt|jwttoken/i.test(name)) {
    roles.push('auth-token');
  }

  // Navigation roles
  if (/^(navigation|navigator|useNavigation|useRoute|useFocusEffect|useIsFocused|Stack|Tab|Drawer|NavigationContainer|Link|DeepLink|useLinking|useURL|Linking)$/i.test(name)) {
    roles.push('navigation');
  }
  if (/^(navigate|push|replace|goBack|pop|reset|navigateAndReset|openDrawer|closeDrawer|jumpTo)$/i.test(name)) {
    roles.push('nav-action');
  }

  // State management roles
  if (/^(createStore|configureStore|createSlice|createReducer|createAction|createSelector|create|useStore|useSelector|useDispatch|useReducer|Provider|connect|mapStateToProps|mapDispatchToProps|combineReducers|applyMiddleware|createContext|useContext)$/i.test(name)) {
    roles.push('state');
  }
  if (/dispatch|setstate|set\w+|update\w+|mutate|action$/i.test(name)) {
    roles.push('state-mutation');
  }

  // Form roles
  if (/^(useForm|useField|useFormik|Formik|Form|Field|useController|useFieldArray|handleSubmit|validate|onSubmit|onChange|onBlur|onFocus|setFieldValue|setFieldError|setFieldTouched|resetForm|validateForm|isSubmitting|isValid|isDirty|touched|errors)$/i.test(name)) {
    roles.push('form');
  }
  if (/^(FormikForm|ReactHookForm|FormControl|FormGroup|FormBuilder|InputField|TextField|SelectField|CheckboxField|RadioField)$/i.test(name)) {
    roles.push('form-component');
  }

  // Error handling roles
  if (/^(ErrorBoundary|componentDidCatch|catchError|handleError|reportError|logError|errorHandler|errorService|errorReporter|ErrorFallback|ErrorScreen|ErrorMessage)$/i.test(name)) {
    roles.push('error');
  }

  // Storage roles
  if (/^(AsyncStorage|SecureStore|localStorage|sessionStorage|MMKV|useMMKV|useStorage|getItem|setItem|removeItem|clearAll|multiGet|multiSet|persistor|persistConfig|rehydrate)$/i.test(name)) {
    roles.push('storage');
  }
  if (/secure|encrypted|sensitive|secret|credential|password/i.test(name)) {
    roles.push('secure-storage');
  }

  // Permission roles
  if (/^(checkPermission|requestPermission|usePermission|hasPermission|PermissionDenied|PermissionGranted|useCameraPermission|useLocationPermission|useNotificationPermission|authorize|requestAccess)$/i.test(name)) {
    roles.push('permission');
  }

  // Notification roles
  if (/^(PushNotification|registerForPushNotifications|usePushNotification|NotificationService|registerNotification|onNotification|notificationListener|RemoteMessage|FCM|APNS|OneSignal|Notifee)$/i.test(name)) {
    roles.push('notification');
  }

  // Analytics roles
  if (/^(analytics|track|trackEvent|logEvent|identify|screenView|pageView|useAnalytics|AnalyticsService|FirebaseAnalytics|Mixpanel|Amplitude|Segment)$/i.test(name)) {
    roles.push('analytics');
  }

  // WebSocket / Real-time roles
  if (/^(WebSocket|socket\.io|useWebSocket|useSocket|connectSocket|disconnectSocket|onMessage|sendMessage|subscribe|unsubscribe|realtime|liveData|stream)$/i.test(name)) {
    roles.push('realtime');
  }

  // i18n / localization roles
  if (/^(useTranslation|i18n|t\(|translate|localize|formatMessage|FormattedMessage|LanguageProvider|setLocale|getLocale)$/i.test(name)) {
    roles.push('i18n');
  }

  // Theme roles
  if (/^(ThemeProvider|useTheme|useColorScheme|ThemeContext|darkMode|toggleTheme|createTheme|makeStyles|useStyles|styled|useStyled)$/i.test(name)) {
    roles.push('theme');
  }

  // Deep link roles
  if (/^(Linking|openURL|canOpenURL|useURL|useLinking|deepLink|universalLink|addEventListener|url|getInitialURL)$/i.test(name)) {
    roles.push('deep-link');
  }

  // Middleware roles
  if (/^(middleware|app\.use|router\.use|useMiddleware|withMiddleware|compose|applyMiddleware)$/i.test(name)) {
    roles.push('middleware');
  }

  // Cache roles
  if (/^(cache|useCache|cacheManager|invalidateCache|clearCache|revalidate|staleWhileRevalidate|SWR|useSWR|useSWRInfinite)$/i.test(name)) {
    roles.push('cache');
  }

  // Testing roles
  if (/^(mock|jest|describe|it|test|expect|beforeEach|afterEach|beforeAll|afterAll|spyOn|fn|render|screen|fireEvent|waitFor)$/i.test(name)) {
    roles.push('test');
  }

  return roles;
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
  const exportToNodeId = new Map();
  const importMap = new Map(); // localName → { source, imported }
  let currentFunction = null;
  const functionStack = [];

  const fid = fileNodeId(relativePath);

  // Create file node
  const fileNodeObj = {
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
    metadata: { ext, language, tags: [] },
  };

  // Pre-scan source for semantic file-level tags
  const srcLower = source.toLowerCase();
  if (/login|signin|signup|authenticate|authcontext|useauth|isauthenticated|token|session/i.test(source)) {
    tagNode(fileNodeObj, ['auth-file']);
  }
  if (/navigation|navigate|useNavigation|Stack\.Screen|Tab\.Screen|useRoute/i.test(source)) {
    tagNode(fileNodeObj, ['navigation-file']);
  }
  if (/createStore|createSlice|useSelector|useDispatch|useStore|zustand|reducer/i.test(source)) {
    tagNode(fileNodeObj, ['state-file']);
  }
  if (/useForm|formik|handleSubmit|validate|onSubmit/i.test(source)) {
    tagNode(fileNodeObj, ['form-file']);
  }
  if (/AsyncStorage|SecureStore|localStorage|MMKV|persist/i.test(source)) {
    tagNode(fileNodeObj, ['storage-file']);
  }
  if (/WebSocket|socket\.io|useWebSocket|useSocket/i.test(source)) {
    tagNode(fileNodeObj, ['realtime-file']);
  }
  if (/process\.env/i.test(source)) {
    tagNode(fileNodeObj, ['env-usage']);
  }

  nodes.push(fileNodeObj);

  try {
    traverse(ast, {
      // ── Imports (enhanced with importMap tracking) ──
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

        // Track in importMap for cross-file resolution
        for (const spec of specs) {
          importMap.set(spec.local, { source: src, imported: spec.imported });
        }

        const resolvedPath = resolveImportPath(src, filePath, rootDir);
        const relResolved = resolvedPath ? safeRelative(resolvedPath, rootDir) : null;

        const edgeTags = [];
        // Tag auth-related imports
        if (/auth|login|signin|session|token|credential|oauth/i.test(src)) edgeTags.push('auth-import');
        if (/navigation|navigator|routing|router/i.test(src)) edgeTags.push('navigation-import');
        if (/store|state|redux|zustand|reducer|slice/i.test(src)) edgeTags.push('state-import');
        if (/form|formik|hookform/i.test(src)) edgeTags.push('form-import');
        if (/api|http|axios|fetch|client|service/i.test(src)) edgeTags.push('api-import');

        if (relResolved) {
          const targetFileId = fileNodeId(relResolved);
          const edge = {
            source: fid,
            target: targetFileId,
            kind: 'import',
            label: specs.map(s => s.imported).join(', '),
            line: nodePath.node.loc?.start?.line,
          };
          if (edgeTags.length) tagEdge(edge, edgeTags);
          edges.push(edge);
        } else if (!src.startsWith('.')) {
          const pkgName = src.split('/')[0];
          const pkgId = pkgNodeId(pkgName);
          const edge = {
            source: fid,
            target: pkgId,
            kind: 'external',
            label: specs.map(s => s.imported).join(', '),
            line: nodePath.node.loc?.start?.line,
            metadata: { package: src },
          };
          if (edgeTags.length) tagEdge(edge, edgeTags);
          edges.push(edge);
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

      // ── Function declarations (enhanced with semantic roles) ──
      FunctionDeclaration: {
        enter(nodePath) {
          const name = nodePath.node.id?.name;
          if (!name) return;
          const line = nodePath.node.loc?.start?.line;
          const isAsync = nodePath.node.async ? 1 : 0;
          const isComponent = /^[A-Z]/.test(name);
          const isHook = /^use[A-Z]/.test(name);
          const nId = nodeId(relativePath, name);

          const nodeObj = {
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
            metadata: { tags: [] },
          };

          // Detect semantic roles
          const roles = detectSemanticRole(name, 'function');
          if (roles.length) tagNode(nodeObj, roles);

          nodes.push(nodeObj);
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

      // ── Variable declarations (enhanced with semantic roles) ──
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

          const nodeObj = {
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
            metadata: { tags: [] },
          };

          const roles = detectSemanticRole(name, 'variable');
          if (roles.length) tagNode(nodeObj, roles);

          nodes.push(nodeObj);
          edges.push({ source: fid, target: nId, kind: 'contains', line });
          if (exports.includes(name)) exportToNodeId.set(name, nId);

          // ── Detect createContext calls ──
          if (isArrowFn || isFnExpr) {
            // Check if the init body contains createContext
            try {
              traverse(init, {
                CallExpression(cp) {
                  const cc = cp.node.callee;
                  if (t.isIdentifier(cc) && cc.name === 'createContext') {
                    tagNode(nodeObj, ['context-creator']);
                    // Extract context name from variable
                    if (name.endsWith('Context') || name.includes('Context')) {
                      tagNode(nodeObj, ['auth-context']);
                    }
                  }
                }
              }, { scope: nodePath.scope });
            } catch {}
          }
        } else {
          // Regular variable — check for special patterns
          const nId = nodeId(relativePath, `var:${name}`);
          const nodeObj = {
            id: nId,
            type: 'variable',
            name,
            file_path: relativePath,
            qualified_name: `${relativePath}::${name}`,
            kind: 'variable',
            start_line: line,
            is_exported: exports.includes(name) ? 1 : 0,
            metadata: { tags: [] },
          };

          const roles = detectSemanticRole(name, 'variable');
          if (roles.length) tagNode(nodeObj, roles);

          // Check for createContext assignment
          if (init && t.isCallExpression(init) && t.isIdentifier(init.callee) && init.callee.name === 'createContext') {
            tagNode(nodeObj, ['context-creator']);
            if (/auth|user|session|token/i.test(name)) tagNode(nodeObj, ['auth-context']);
          }

          // Check for createSlice / createStore / zustand create
          if (init && t.isCallExpression(init)) {
            const callee = init.callee;
            if (t.isIdentifier(callee)) {
              if (callee.name === 'createSlice') tagNode(nodeObj, ['state-slice']);
              if (callee.name === 'createStore' || callee.name === 'configureStore') tagNode(nodeObj, ['state-store']);
              if (callee.name === 'create' && /store|slice|state/i.test(name)) tagNode(nodeObj, ['state-store']);
            }
            // zustand: create()(state => ...)
            if (t.isCallExpression(callee) && t.isIdentifier(callee.callee) && callee.callee.name === 'create') {
              tagNode(nodeObj, ['state-store']);
            }
          }

          // Check for process.env
          if (init && t.isMemberExpression(init)) {
            if (t.isMemberExpression(init.object) &&
                t.isIdentifier(init.object.object) && init.object.object.name === 'process' &&
                t.isIdentifier(init.object.property) && init.object.property.name === 'env') {
              tagNode(nodeObj, ['env-var']);
              const envKey = t.isIdentifier(init.property) ? init.property.name : 'UNKNOWN';
              nodeObj.metadata.envKey = envKey;
            }
          }

          nodes.push(nodeObj);
          edges.push({ source: fid, target: nId, kind: 'contains', line });
          if (exports.includes(name)) exportToNodeId.set(name, nId);
        }
      },

      // ── Class declarations (enhanced) ──
      ClassDeclaration(nodePath) {
        const name = nodePath.node.id?.name;
        if (!name) return;
        const line = nodePath.node.loc?.start?.line;
        const nId = nodeId(relativePath, name);

        const nodeObj = {
          id: nId,
          type: 'class',
          name,
          file_path: relativePath,
          qualified_name: `${relativePath}::${name}`,
          kind: 'class',
          start_line: line,
          end_line: nodePath.node.loc?.end?.line,
          is_exported: exports.includes(name) ? 1 : 0,
          metadata: { tags: [] },
        };

        // Detect ErrorBoundary
        if (/errorboundary|errorfallback/i.test(name)) tagNode(nodeObj, ['error']);

        // Detect extends
        if (nodePath.node.superClass) {
          const superName = t.isIdentifier(nodePath.node.superClass) ? nodePath.node.superClass.name :
            t.isMemberExpression(nodePath.node.superClass) && t.isIdentifier(nodePath.node.superClass.object) ?
              `${nodePath.node.superClass.object.name}.${nodePath.node.superClass.property?.name || ''}` : null;

          if (superName) {
            if (/errorboundary|component/i.test(superName)) tagNode(nodeObj, ['react-component']);
            edges.push({
              source: nId,
              target: superName,
              kind: 'extends',
              label: superName,
              line,
              metadata: { unresolved: true },
            });
          }
        }

        const roles = detectSemanticRole(name, 'class');
        if (roles.length) tagNode(nodeObj, roles);

        nodes.push(nodeObj);
        edges.push({ source: fid, target: nId, kind: 'contains', line });
        if (exports.includes(name)) exportToNodeId.set(name, nId);

        // Check for componentDidCatch method
        nodePath.node.body.body.forEach(member => {
          if (t.isClassMethod(member) && t.isIdentifier(member.key) && member.key.name === 'componentDidCatch') {
            tagNode(nodeObj, ['error']);
          }
        });
      },

      // ── Call expressions (MASSIVELY enhanced) ──
      CallExpression(nodePath) {
        const { callee, arguments: args } = nodePath.node;
        const line = nodePath.node.loc?.start?.line;
        const callerId = currentFunction ? nodeId(relativePath, currentFunction) : null;

        // ── fetch() ──
        if (t.isIdentifier(callee) && callee.name === 'fetch') {
          const method = extractMethodFromArgs(args);
          const url = extractUrlFromArgs(args);
          const epId = endpointNodeId(method || 'GET', url || 'unknown');
          if (callerId) {
            const edge = {
              source: callerId, target: epId, kind: 'api_call',
              label: `fetch ${method || 'GET'} ${url || ''}`.trim(),
              line, metadata: { type: 'fetch', method, url, tags: [] },
            };
            if (/auth|login|token|session|refresh/i.test(url || '')) tagEdge(edge, ['auth-api']);
            if (/payment|charge|stripe|order/i.test(url || '')) tagEdge(edge, ['payment-api']);
            edges.push(edge);
          }
        }

        // ── axios.get/post/etc. ──
        if (t.isMemberExpression(callee) && t.isIdentifier(callee.object) && callee.object.name === 'axios' && t.isIdentifier(callee.property)) {
          const method = callee.property.name.toUpperCase();
          const url = extractUrlFromArgs(args);
          const epId = endpointNodeId(method, url || 'unknown');
          if (callerId) {
            const edge = {
              source: callerId, target: epId, kind: 'api_call',
              label: `axios.${method.toLowerCase()} ${url || ''}`.trim(),
              line, metadata: { type: 'axios', method, url, tags: [] },
            };
            if (/auth|login|token|session|refresh/i.test(url || '')) tagEdge(edge, ['auth-api']);
            if (/payment|charge|stripe|order/i.test(url || '')) tagEdge(edge, ['payment-api']);
            edges.push(edge);
          }
        }

        // ── useQuery / useMutation ──
        if (t.isIdentifier(callee) && (callee.name === 'useQuery' || callee.name === 'useMutation')) {
          const url = extractUrlFromArgs(args);
          const method = callee.name === 'useQuery' ? 'GET' : 'POST';
          const epId = endpointNodeId(method, url || 'unknown');
          if (callerId) {
            const edge = {
              source: callerId, target: epId, kind: 'api_call',
              label: `${callee.name} ${method} ${url || ''}`.trim(),
              line, metadata: { type: callee.name, method, url, tags: [] },
            };
            if (/auth|login|token|session/i.test(url || '')) tagEdge(edge, ['auth-api']);
            edges.push(edge);
          }
        }

        // ── api.get/post (custom API clients) ──
        if (t.isMemberExpression(callee) && t.isIdentifier(callee.object) &&
            /api|client|http|apiService/i.test(callee.object.name) &&
            t.isIdentifier(callee.property) && /^(get|post|put|delete|patch)$/i.test(callee.property.name)) {
          const method = callee.property.name.toUpperCase();
          const url = extractUrlFromArgs(args);
          const epId = endpointNodeId(method, url || 'unknown');
          if (callerId) {
            const edge = {
              source: callerId, target: epId, kind: 'api_call',
              label: `${callee.object.name}.${callee.property.name} ${url || ''}`.trim(),
              line, metadata: { type: 'apiClient', method, url, tags: [] },
            };
            if (/auth|login|token|session/i.test(url || '')) tagEdge(edge, ['auth-api']);
            if (/payment|charge|stripe|order/i.test(url || '')) tagEdge(edge, ['payment-api']);
            edges.push(edge);
          }
        }

        // ── React Navigation calls ──
        if (t.isMemberExpression(callee) && t.isIdentifier(callee.property)) {
          const propName = callee.property.name;
          // navigation.navigate('ScreenName'), navigation.push, etc.
          if (/^(navigate|push|replace|reset|goBack|pop|popToTop|dismiss|jumpTo|openDrawer|closeDrawer|toggleDrawer)$/.test(propName)) {
            const screenName = args.length > 0 && t.isStringLiteral(args[0]) ? args[0].value : null;
            if (callerId) {
              const targetId = screenName ? routeNodeId(screenName) : null;
              if (targetId) {
                const edge = {
                  source: callerId, target: targetId, kind: 'navigates_to',
                  label: `navigate → ${screenName}`,
                  line,
                  metadata: { action: propName, screenName, tags: ['navigation'] },
                };
                edges.push(edge);
              }
            }
          }

          // AsyncStorage methods
          if (/^(getItem|setItem|removeItem|multiGet|multiSet|clear)$/.test(propName)) {
            const objName = t.isIdentifier(callee.object) ? callee.object.name : '';
            if (/AsyncStorage|SecureStore|localStorage|sessionStorage|MMKV|storage/i.test(objName) && callerId) {
              const key = args.length > 0 && t.isStringLiteral(args[0]) ? args[0].value : null;
              const action = propName === 'getItem' ? 'read' : propName === 'setItem' ? 'write' : propName === 'removeItem' ? 'delete' : 'multi';
              const edge = {
                source: callerId, target: `storage:${key || 'unknown'}`, kind: 'storage_access',
                label: `${objName}.${propName}(${key || '...'})`,
                line,
                metadata: { type: 'storage', action, key, tags: [] },
              };
              if (/token|session|auth|credential/i.test(key || '')) tagEdge(edge, ['auth-storage']);
              if (/secure|encrypted|password/i.test(key || objName)) tagEdge(edge, ['secure-storage']);
              edges.push(edge);
            }
          }

          // dispatch() calls
          if (propName === 'dispatch' && t.isIdentifier(callee.object)) {
            const objName = callee.object.name;
            if (callerId) {
              // Try to extract action type
              let actionType = null;
              if (args.length > 0 && t.isObjectExpression(args[0])) {
                const typeProp = args[0].properties.find(p =>
                  t.isObjectProperty(p) && t.isIdentifier(p.key) && p.key.name === 'type' && t.isStringLiteral(p.value)
                );
                if (typeProp) actionType = typeProp.value.value;
              }
              const edge = {
                source: callerId,
                target: nodeId(relativePath, `dispatch:${actionType || objName}`),
                kind: 'dispatches',
                label: actionType ? `dispatch({type: ${actionType}})` : `dispatch via ${objName}`,
                line,
                metadata: { actionType, tags: ['state-mutation'] },
              };
              edges.push(edge);
            }
          }

          // socket.emit / socket.on
          if (/^(emit|on|off|once)$/.test(propName) && t.isIdentifier(callee.object)) {
            const objName = callee.object.name;
            if (/socket|ws|connection|io|realtime/i.test(objName) && callerId) {
              const eventName = args.length > 0 && t.isStringLiteral(args[0]) ? args[0].value : null;
              edges.push({
                source: callerId,
                target: `event:${eventName || 'unknown'}`,
                kind: propName === 'emit' ? 'emits_event' : 'subscribes_event',
                label: `${objName}.${propName}(${eventName || '...'})`,
                line,
                metadata: { eventName, action: propName, tags: ['realtime'] },
              });
            }
          }
        }

        // ── React Navigation: useNavigation() ──
        if (t.isIdentifier(callee) && callee.name === 'useNavigation') {
          if (callerId) {
            tagNode(nodes.find(n => n.id === callerId) || {}, ['navigation-consumer']);
          }
        }

        // ── useAuth / isAuthenticated hooks ──
        if (t.isIdentifier(callee) && /^use(Auth|IsAuth|Session|Token|Credential|Login|Logout|User|Permission|Role)/i.test(callee.name)) {
          if (callerId) {
            tagNode(nodes.find(n => n.id === callerId) || {}, ['auth-consumer']);
          }
        }

        // ── useSelector / useDispatch ──
        if (t.isIdentifier(callee) && (callee.name === 'useSelector' || callee.name === 'useDispatch')) {
          if (callerId) {
            tagNode(nodes.find(n => n.id === callerId) || {}, ['state-consumer']);
          }
        }

        // ── useForm / Formik hooks ──
        if (t.isIdentifier(callee) && /^(useForm|useFormik|useField|useController|useFieldArray)$/i.test(callee.name)) {
          if (callerId) {
            tagNode(nodes.find(n => n.id === callerId) || {}, ['form-consumer']);
          }
        }

        // ── useContext ──
        if (t.isIdentifier(callee) && callee.name === 'useContext') {
          const contextName = args.length > 0 && t.isIdentifier(args[0]) ? args[0].name : null;
          if (callerId && contextName) {
            const edge = {
              source: callerId,
              target: nodeId(relativePath, contextName),
              kind: 'uses_context',
              label: `useContext(${contextName})`,
              line,
              metadata: { contextName, tags: [] },
            };
            if (/auth|user|session|token/i.test(contextName)) tagEdge(edge, ['auth-context-usage']);
            edges.push(edge);
          }
        }

        // ── createContext ──
        if (t.isIdentifier(callee) && callee.name === 'createContext') {
          // Already handled in VariableDeclarator, but tag the file
          tagNode(fileNodeObj, ['context-creator-file']);
        }

        // ── Linking.openURL (deep links) ──
        if (t.isMemberExpression(callee) && t.isIdentifier(callee.object) && callee.object.name === 'Linking' &&
            t.isIdentifier(callee.property) && callee.property.name === 'openURL') {
          const url = args.length > 0 && t.isStringLiteral(args[0]) ? args[0].value : null;
          if (callerId) {
            edges.push({
              source: callerId, target: `deeplink:${url || 'unknown'}`, kind: 'deep_link',
              label: `Linking.openURL(${url || '...'})`,
              line,
              metadata: { url, tags: ['deep-link'] },
            });
          }
        }

        // ── Permission requests ──
        if (t.isMemberExpression(callee) && t.isIdentifier(callee.property) &&
            /^(request|check|ask|authorize)/i.test(callee.property.name)) {
          if (callerId) {
            tagNode(nodes.find(n => n.id === callerId) || {}, ['permission-request']);
          }
        }

        // ── Analytics tracking ──
        if (t.isIdentifier(callee) && /^(track|logEvent|identify|screenView|pageView|reportAnalytics)$/i.test(callee.name)) {
          if (callerId) {
            const eventName = args.length > 0 && t.isStringLiteral(args[0]) ? args[0].value : null;
            edges.push({
              source: callerId, target: `analytics:${eventName || 'unknown'}`, kind: 'tracks_event',
              label: `${callee.name}(${eventName || '...'})`,
              line,
              metadata: { eventName, tags: ['analytics'] },
            });
          }
        }

        // ── Notification registration ──
        if (t.isIdentifier(callee) && /registerForPush|requestNotification|usePushNotification/i.test(callee.name)) {
          if (callerId) {
            tagNode(nodes.find(n => n.id === callerId) || {}, ['notification-consumer']);
          }
        }

        // ── General function call tracking ──
        if (t.isIdentifier(callee) && currentFunction) {
          const calleeName = callee.name;
          if (calleeName && calleeName !== 'require' && calleeName !== 'fetch' && calleeName !== 'axios' &&
              !calleeName.startsWith('_') && calleeName.length > 1 &&
              !/^(console|Math|JSON|Object|Array|String|Number|Boolean|Date|Promise|React|process|window|document|parseInt|parseFloat|isNaN|setTimeout|setInterval|clearTimeout|clearInterval|useNavigation|useAuth|useSelector|useDispatch|useContext|useForm|useFormik|useField|useQuery|useMutation|createContext|createSlice|createStore|navigate|push|replace|goBack|getItem|setItem|dispatch|track|logEvent|useCallback|useMemo|useEffect|useRef|useState|useReducer)$/.test(calleeName)) {
            const callerFnId = nodeId(relativePath, currentFunction);
            const calleeFnId = nodeId(relativePath, calleeName);
            const edge = {
              source: callerFnId,
              target: calleeFnId,
              kind: 'call',
              label: `${currentFunction} → ${calleeName}`,
              line,
              metadata: { tags: [] },
            };
            // Auto-tag call edges by semantic role
            const calleeRoles = detectSemanticRole(calleeName, 'call');
            if (calleeRoles.length) tagEdge(edge, calleeRoles.map(r => `calls-${r}`));
            edges.push(edge);
          }
        }
      },

      // ── JSX elements (enhanced with Provider/Screen detection) ──
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
          const targetId = exportToNodeId.get(componentName) || nodeId(relativePath, componentName);
          const edge = {
            source: parentId,
            target: targetId,
            kind: 'jsx',
            label: `<${componentName} />`,
            line: nodePath.node.loc?.start?.line,
            metadata: { tags: [] },
          };

          // Detect Provider usage (Context)
          if (/Provider$/.test(componentName)) {
            tagEdge(edge, ['provides-context']);
            if (/Auth|User|Session|Token/i.test(componentName)) tagEdge(edge, ['auth-provider']);
          }

          // Detect NavigationContainer / Stack.Screen / Tab.Screen
          if (/NavigationContainer|Stack|Tab|Drawer/.test(componentName)) {
            tagEdge(edge, ['navigation-component']);
          }

          // Detect Screen components with name prop
          if (/Screen$/.test(componentName)) {
            const nameAttr = nodePath.node.attributes?.find(a =>
              t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === 'name' && t.isStringLiteral(a.value)
            );
            if (nameAttr) {
              const screenName = nameAttr.value.value;
              const routeId = routeNodeId(screenName);
              edges.push({
                source: parentId, target: routeId, kind: 'defines_route',
                label: `<${componentName} name="${screenName}" />`,
                line: nodePath.node.loc?.start?.line,
                metadata: { screenName, tags: ['navigation'] },
              });
            }
          }

          // Detect ErrorBoundary
          if (/ErrorBoundary|ErrorFallback/i.test(componentName)) {
            tagEdge(edge, ['error-boundary']);
          }

          // Detect ProtectedRoute / AuthGuard
          if (/ProtectedRoute|AuthGuard|PrivateRoute|RequireAuth|AuthenticatedRoute/i.test(componentName)) {
            tagEdge(edge, ['auth-guard']);
          }

          edges.push(edge);
        }
      },

      // ── JSX Attributes (extract route params, event handlers) ──
      JSXAttribute(nodePath) {
        const name = nodePath.node.name?.name;
        // Detect onPress handlers that navigate
        if (name === 'onPress' && t.isJSXExpressionContainer(nodePath.node.value)) {
          const expr = nodePath.node.value.expression;
          if (t.isCallExpression(expr) && t.isMemberExpression(expr.callee)) {
            if (t.isIdentifier(expr.callee.property) && /^(navigate|push|replace|goBack)$/.test(expr.callee.property.name)) {
              // This is a navigation trigger from JSX
            }
          }
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

  // Create extra nodes for edge targets
  const extraNodes = [];
  const seenIds = new Set(nodes.map(n => n.id));

  for (const edge of edges) {
    if (!seenIds.has(edge.target)) {
      if (edge.target.startsWith('pkg:')) {
        extraNodes.push({
          id: edge.target, type: 'package',
          name: edge.target.replace('pkg:', ''),
          file_path: edge.target.replace('pkg:', ''),
          qualified_name: edge.metadata?.package || edge.target.replace('pkg:', ''),
          kind: 'package',
        });
      } else if (edge.target.startsWith('ep:')) {
        const meta = edge.metadata || {};
        extraNodes.push({
          id: edge.target, type: 'endpoint',
          name: `${meta.method || ''} ${meta.url || ''}`.trim() || edge.target,
          file_path: 'external',
          qualified_name: `API::${meta.method || 'GET'} ${meta.url || ''}`.trim(),
          kind: 'endpoint', metadata: meta,
        });
      } else if (edge.target.startsWith('route:')) {
        const meta = edge.metadata || {};
        extraNodes.push({
          id: edge.target, type: 'screen',
          name: meta.screenName || edge.target,
          file_path: 'route-definition',
          qualified_name: `Route::${meta.screenName || edge.target}`,
          kind: 'route', metadata: meta,
        });
      } else if (edge.target.startsWith('storage:')) {
        const key = edge.target.replace('storage:', '');
        extraNodes.push({
          id: edge.target, type: 'store',
          name: `Storage:${key}`,
          file_path: 'device-storage',
          qualified_name: `Storage::${key}`,
          kind: 'storage-key',
          metadata: edge.metadata,
        });
      } else if (edge.target.startsWith('event:')) {
        const eventName = edge.target.replace('event:', '');
        extraNodes.push({
          id: edge.target, type: 'service',
          name: `Event:${eventName}`,
          file_path: 'realtime',
          qualified_name: `Event::${eventName}`,
          kind: 'event',
          metadata: edge.metadata,
        });
      } else if (edge.target.startsWith('deeplink:')) {
        const url = edge.target.replace('deeplink:', '');
        extraNodes.push({
          id: edge.target, type: 'endpoint',
          name: `DeepLink:${url}`,
          file_path: 'external',
          qualified_name: `DeepLink::${url}`,
          kind: 'deeplink',
          metadata: edge.metadata,
        });
      } else if (edge.target.startsWith('analytics:')) {
        const eventName = edge.target.replace('analytics:', '');
        extraNodes.push({
          id: edge.target, type: 'service',
          name: `Analytics:${eventName}`,
          file_path: 'analytics',
          qualified_name: `Analytics::${eventName}`,
          kind: 'analytics-event',
          metadata: edge.metadata,
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
  // Handle URL as second arg for some APIs
  if (args.length > 1 && t.isStringLiteral(args[1])) return args[1].value;
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

module.exports = {
  analyzeFile, discoverFiles, inferNodeType, nodeId, fileNodeId, pkgNodeId,
  endpointNodeId, routeNodeId, safeRelative, detectSemanticRole,
  globToRegex, parseIgnoreFile, loadConfig, buildExclusionContext,
  shouldExcludePath, shouldSkipDir,
};
