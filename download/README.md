# CodeMap — Interactive Codebase Graph Visualizer

> See your entire app at once. Trace every workflow. Detect auth, navigation, state, forms, payments — automatically.

CodeMap is a local static analysis tool that maps your React Native / React / Node.js codebase into an interactive graph. It parses every file with Babel, builds a knowledge graph in SQLite, and serves a rich visual explorer — no cloud, no API keys, no data leaving your machine.

## Features

- **Full Codebase Map** — Every file, function, component, hook, store, service, and API endpoint as interactive graph nodes
- **5 Graph Views** — Dependencies, Component Tree, Call Graph, API Flow, Architecture
- **15+ Auto-Detected Workflow Traces** — Auth (6 sub-flows!), Navigation, Data Fetch, State, Forms, Payment, Errors, Storage, Real-time, Permissions, Notifications, Analytics, Onboarding, Theme, i18n
- **40+ Sub-Flows** — Granular tracing within each workflow (login, logout, token refresh, protected routes, signup, password reset under Auth alone)
- **File Exclusion System** — `.codegraphignore`, `.codegraph/config.json`, and CLI flags to exclude files/dirs from analysis
- **Deep Semantic Extraction** — Detects React Navigation, Auth contexts, Context API, Redux/Zustand, Formik, Error Boundaries, WebSocket, AsyncStorage, Permissions, Deep Links, Push Notifications, Analytics, and more
- **Sub-Flow Architecture** — Each trace contains granular sub-flows (e.g., Auth → Login, Logout, Token Refresh, Protected Route, Signup, Password Reset)
- **Security-Aware** — Flags secure storage access, auth token handling, and sensitive data flows
- **Auto-Detected Traces** — Automatically discovers 15+ workflow categories by semantic tags + naming patterns
- **Custom Traces** — Define your own traces in `.codegraph/traces.json`
- **Graph Algorithms** — Cycle detection, community detection, impact analysis, dead code detection
- **SQLite Storage** — Incremental reindexing, FTS5 full-text search, WAL mode
- **Layered Architecture** — Modular design: Parser → Storage → Graph → Query → Helpers → Tracer

## Quick Start

```bash
# Clone the repo
git clone https://github.com/ahmed-m-elgammal/code_map.git
cd code_map

# Install dependencies
npm install

# Run analysis on a project
node analyze.js /path/to/your/project

# Open the visualizer
open visualizer.html
# Then drag & drop the generated graph.json file
```

## Usage

### Basic Analysis

```bash
# Analyze current directory
node analyze.js

# Analyze a specific project
node analyze.js /path/to/project

# Stats only (no graph.json output)
node analyze.js --stats-only
```

### Workflow Tracing

```bash
# List all auto-detected traces
node analyze.js --traces

# Show details for a specific trace
node analyze.js --trace auth
node analyze.js --trace payment
node analyze.js --trace data-fetch

# Create a custom traces config file
node analyze.js --init-traces
# Edit .codegraph/traces.json to define your own workflows
# Then re-run analyze.js to include your custom traces
```

### Custom Trace Definitions

Create `.codegraph/traces.json` in your project root:

```json
[
  {
    "id": "auth",
    "name": "Authentication Flow",
    "description": "Trace the complete auth workflow from login screen to API token usage",
    "entryPatterns": ["login", "signin", "LoginScreen"],
    "exitPatterns": ["token", "session", "/api/auth"],
    "throughPatterns": ["auth", "credential"],
    "edgeKinds": ["import", "call", "jsx", "api_call"],
    "maxDepth": 8
  },
  {
    "id": "feature-checkout",
    "name": "Checkout Feature Flow",
    "description": "Trace the checkout process from cart to order confirmation",
    "entryPatterns": ["cart", "checkout", "CartScreen"],
    "exitPatterns": ["order", "payment", "/api/orders"],
    "throughPatterns": ["shipping", "billing", "confirm"],
    "edgeKinds": ["import", "call", "jsx", "api_call"],
    "maxDepth": 8
  }
]
```

**Trace fields:**
- `id` — Unique identifier (used with `--trace <id>`)
- `name` — Human-readable name shown in the UI
- `description` — What this trace captures
- `entryPatterns` — Regex/string patterns for starting nodes (screens, components)
- `exitPatterns` — Regex/string patterns for ending nodes (API endpoints, mutations)
- `throughPatterns` — Optional intermediate waypoints the flow should pass through
- `edgeKinds` — Which edge types to follow: `import`, `call`, `jsx`, `api_call`, `references`, `contains`, `external`
- `maxDepth` — How deep to traverse (default: 10)

### Auto-Detected Traces

CodeMap automatically detects 15+ workflow categories with 40+ sub-flows:

| Trace | Sub-Flows | What It Detects |
|-------|-----------|-----------------|
| 🔐 **Authentication** | Login, Logout, Token Refresh, Protected Route, Signup, Password Reset | useAuth, isAuthenticated, token, AuthContext, ProtectedRoute |
| 🧭 **Navigation** | Screen Navigation, Deep Links | navigation.navigate, useNavigation, Stack.Screen, Linking |
| 📡 **Data Fetching** | Query/Loading, Mutation/Writing | useQuery, useMutation, fetch, axios, cache invalidation |
| 🗄️ **State Management** | Store Creation, Action Dispatch | createSlice, createStore, useSelector, useDispatch, zustand |
| 📝 **Forms** | Form Submission, Form Validation | useForm, Formik, handleSubmit, validate, yup/zod |
| 💳 **Payment** | Checkout | cart, checkout, stripe, payment, order |
| ⚠️ **Error Handling** | Error Boundary | ErrorBoundary, componentDidCatch, error reporting |
| 💾 **Storage** | Data Persistence | AsyncStorage, SecureStore, localStorage, MMKV, persist |
| ⚡ **Real-time** | WebSocket | WebSocket, socket.io, useWebSocket, emit/on |
| 🔒 **Permissions** | Permission Request | checkPermission, requestPermission, camera, location |
| 🔔 **Notifications** | Push Notifications | registerForPush, FCM, OneSignal, Notifee |
| 📊 **Analytics** | Event Tracking | trackEvent, logEvent, Firebase, Mixpanel, Amplitude |
| 🎯 **Onboarding** | Welcome Steps | onboarding, welcome, tutorial, getting-started |
| 🎨 **Theme** | Theme Switching | ThemeProvider, useTheme, darkMode, Appearance |
| 🌍 **i18n** | Translation | useTranslation, i18n, formatMessage, LanguageProvider |

## File Exclusion

Control which files and directories get analyzed. There are 3 ways to exclude files:

### 1. `.codegraphignore` (like .gitignore)

Create a `.codegraphignore` file in your project root:

```bash
node analyze.js --init-ignore
```

Then edit it:

```gitignore
# Exclude generated files
**/generated/**
**/*.generated.*
**/*.auto.*

# Exclude config files
babel.config.*
metro.config.*
webpack.config.*

# Exclude storybook
**/*.stories.*

# Exclude specific directories
src/legacy/**
src/temp/**

# Exclude by extension
*.d.ts

# Re-include a file that was excluded (use ! prefix)
!src/generated/important.ts
```

**Pattern syntax:**
| Pattern | Matches |
|---------|---------|
| `*` | Any characters except `/` |
| `**` | Any characters including `/` (cross-directory) |
| `?` | Single character |
| `!` prefix | Negation (re-include) |
| `#` | Comment |
| `dir/` | Entire directory at any depth |
| `/dir/` | Directory at root only |

### 2. `.codegraph/config.json` (JSON config)

Create a config file:

```bash
node analyze.js --init-config
```

Then edit `.codegraph/config.json`:

```json
{
  "exclude": [
    "**/generated/**",
    "**/*.stories.*",
    "**/*.d.ts",
    "src/legacy/**"
  ],
  "include": [
    "!src/generated/important.ts"
  ],
  "excludeDirs": [
    "scripts",
    "tools",
    "docs"
  ],
  "excludeExtensions": [
    ".d.ts",
    ".test.ts"
  ],
  "maxFileSize": 500000,
  "onlyDirs": [
    "src",
    "app"
  ]
}
```

**Config fields:**
| Field | Type | Description |
|-------|------|-------------|
| `exclude` | `string[]` | Glob patterns to exclude |
| `include` | `string[]` | Glob patterns to re-include (overrides exclude) |
| `excludeDirs` | `string[]` | Directory names to skip entirely (added to built-in list) |
| `excludeExtensions` | `string[]` | File extensions to skip (e.g., `.d.ts`) |
| `maxFileSize` | `number` | Skip files larger than this (bytes) |
| `onlyDirs` | `string[]` | If set, ONLY scan these directories |

### 3. CLI Flags

```bash
# Exclude specific patterns
node analyze.js --exclude "**/generated/**"
node analyze.js --exclude "*.stories.*" --exclude "src/legacy/**"

# Only include matching files
node analyze.js --only "src/screens/**"

# Only scan specific directories
node analyze.js --only-dirs src
node analyze.js --only-dirs src --only-dirs app

# Skip large files
node analyze.js --max-file-size 500000
```

### Priority Order

Exclusion rules are applied in this priority:

1. **Include rules** (highest) — `!` patterns in `.codegraphignore`, `include` in config, `--only` CLI flag
2. **Exclude rules** — patterns in `.codegraphignore`, `exclude` in config, `--exclude` CLI flag
3. **Directory rules** — `excludeDirs` in config, `--only-dirs` CLI flag
4. **Built-in defaults** — `node_modules`, `.expo`, `android`, `ios`, `dist`, `build`, etc.

### Built-in Excluded Directories

These are always skipped:
`node_modules`, `.expo`, `android`, `ios`, `assets`, `.git`, `__tests__`, `__mocks__`, `__snapshots__`, `dist`, `build`, `.cache`, `.next`, `coverage`, `.vscode`, `.idea`, `.codegraph`

### Common Patterns

```bash
# Only analyze screens and components
node analyze.js --only-dirs src/screens --only-dirs src/components

# Skip generated code and types
node analyze.js --exclude "**/generated/**" --exclude "**/*.d.ts"

# Focus on auth-related files only
node analyze.js --only "**/auth/**" --only "**/login/**"

# Skip storybook and test files
node analyze.js --exclude "**/*.stories.*" --exclude "**/*.test.*" --exclude "**/*.spec.*"
```

## Visualizer Guide

### Views

| View | Shows | Edge Types |
|------|-------|------------|
| All | Everything | All |
| Dependencies | File/module imports | import, external |
| Components | React component tree | jsx, contains |
| Call Graph | Function call relationships | call, references |
| API Flow | Network/API call chains | api_call |
| Architecture | High-level module grouping | import, external, call, api_call |

### Workflow Traces Panel

Click the **Traces** button in the header to open the trace panel:
1. Browse auto-detected and custom workflow traces
2. Click a trace to see the step-by-step timeline
3. Click any step to zoom to that node in the graph
4. See API calls, store accesses, and discovered paths for each trace

### Interactions

- **Click** a node to see details in the side panel
- **Drag** nodes to rearrange the layout
- **Scroll** to zoom in/out
- **Search** to highlight matching nodes
- **Filter pills** toggle node type visibility
- **Trace steps** highlight the full workflow path on the graph

## Architecture

```
User Tools (CLI + Tracer)
    ↓
Code Helpers (convenience API: whoImports, apiCallsFrom, etc.)
    ↓
Query Builder (fluent chainable API: .fromType('screen').edgeKind('import').depth(3).run())
    ↓
Core Graph (algorithms: BFS, DFS, cycles, communities, impact analysis)
    ↓
Storage Backend (SQLite with WAL, FTS5, incremental reindex)
```

### File Structure

```
code_map/
├── analyze.js          # CLI entry point (User Tools layer)
├── visualizer.html     # Self-contained interactive web UI
├── package.json        # Dependencies
├── lib/
│   ├── parser.js       # Babel AST parser + file exclusion system
│   ├── storage.js      # SQLite storage backend (WAL, FTS5, migrations)
│   ├── graph.js        # Core graph algorithms (BFS, DFS, cycles, communities)
│   ├── query.js        # Fluent query builder
│   ├── helpers.js      # High-level convenience API
│   └── tracer.js       # Workflow tracing engine
└── .codegraph/
    ├── codegraph.db    # Auto-generated SQLite database
    ├── config.json     # Exclusion config (exclude/include/onlyDirs)
    └── traces.json     # User-defined trace definitions

# In your project root:
your-project/
├── .codegraphignore    # .gitignore-style exclusion patterns
└── .codegraph/
    └── config.json     # JSON exclusion configuration
```

### Node Types

| Type | Icon | Description |
|------|------|-------------|
| screen | 📱 | App screens / pages |
| component | 🧩 | React components |
| hook | 🪝 | Custom React hooks |
| store | 🗄️ | State stores (Zustand, Redux) |
| service | ⚙️ | Service/utility modules |
| api | 🌐 | API client modules |
| endpoint | 🔌 | API endpoints (fetch/axios calls) |
| function | ƒ | Regular functions |
| class | C | ES6 classes |
| file | 📄 | File-level nodes |
| package | 📦 | External npm packages |
| variable | v | Const/let variables |

### Edge Types

| Type | Style | Description |
|------|-------|-------------|
| import | Solid | ES module import |
| external | Long dash | External package import |
| jsx | Short dash | JSX component usage |
| call | Dotted | Function call |
| api_call | Medium dash | API/network request |
| contains | Fine dot | File contains symbol |
| extends | Long dash | Class inheritance |
| references | Dash-dot | Variable/symbol reference |
| navigates_to | Blue solid | React Navigation: navigate/push/replace |
| uses_context | Purple dash | useContext() call |
| dispatches | Orange dotted | Redux/Zustand dispatch |
| storage_access | Cyan dash | AsyncStorage/SecureStore access |
| defines_route | Blue dotted | Stack.Screen/Tab.Screen route definition |
| deep_link | Green dash | Linking.openURL / deep link |
| tracks_event | Yellow dotted | Analytics event tracking |
| emits_event | Teal dash | WebSocket/socket emit |
| subscribes_event | Teal dotted | WebSocket/socket on/listen |

## Graph Algorithms

- **Cycle Detection** — Find circular dependencies using DFS back-edge detection
- **Community Detection** — Label propagation to find clusters of tightly connected modules
- **Impact Analysis** — BFS traversal to find the "blast radius" of changing a node
- **Dead Code Detection** — Find nodes with no incoming edges and not exported
- **Orphan Detection** — Find completely disconnected nodes
- **Hotspot Analysis** — Find the most connected nodes (high fan-in + fan-out)
- **Instability Metric** — `fan_out / (fan_in + fan_out)` — measures how hard a module is to change

## Requirements

- **Node.js 24+** (for built-in `node:sqlite` module)
- **npm** for installing Babel dependencies

## Dependencies

```json
{
  "@babel/parser": "^7.27",
  "@babel/traverse": "^7.27",
  "@babel/types": "^7.27"
}
```

## Output

Running `node analyze.js` produces:

1. **`.codegraph/codegraph.db`** — SQLite database with all parsed data
2. **`graph.json`** — Visualization-ready JSON for the web UI

The `graph.json` contains:
- `nodes` — All code symbols with types, metrics, and metadata
- `edges` — All relationships between symbols
- `traces` — Workflow trace results with step-by-step timelines
- `cycles` — Detected circular dependencies
- `communities` — Module clusters
- `hotspots` — Most connected nodes
- `stats` — Aggregate statistics
- `layers` — Architecture layer breakdown

## License

MIT
