# CodeMap — Interactive Codebase Graph Visualizer

> See your entire app at once. Trace every workflow. Detect auth, navigation, state, forms, payments — automatically.

CodeMap is a local static analysis tool that maps your React Native / React / Node.js codebase into an interactive graph. It parses every file with Babel, builds a knowledge graph in SQLite, and serves a rich visual explorer — no cloud, no API keys, no data leaving your machine.

## Features

- **Full Codebase Map** — Every file, function, component, hook, store, service, and API endpoint as interactive graph nodes
- **5 Graph Views** — Dependencies, Component Tree, Call Graph, API Flow, Architecture
- **15+ Auto-Detected Workflow Traces** — Auth (6 sub-flows!), Navigation, Data Fetch, State, Forms, Payment, Errors, Storage, Real-time, Permissions, Notifications, Analytics, Onboarding, Theme, i18n
- **40+ Sub-Flows** — Granular tracing within each workflow (login, logout, token refresh, protected routes, signup, password reset under Auth alone)
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
│   ├── parser.js       # Babel AST parser (file discovery + symbol extraction)
│   ├── storage.js      # SQLite storage backend (WAL, FTS5, migrations)
│   ├── graph.js        # Core graph algorithms (BFS, DFS, cycles, communities)
│   ├── query.js        # Fluent query builder
│   ├── helpers.js      # High-level convenience API
│   └── tracer.js       # Workflow tracing engine
└── .codegraph/
    ├── codegraph.db    # Auto-generated SQLite database
    └── traces.json     # User-defined trace definitions
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
