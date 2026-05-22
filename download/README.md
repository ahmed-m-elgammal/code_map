# CodeMap — Interactive Codebase Graph Visualizer

> See your entire app at once. Trace workflows. Understand dependencies. Find what's connected.

CodeMap is a local static analysis tool that maps your React Native / React / Node.js codebase into an interactive graph. It parses every file with Babel, builds a knowledge graph in SQLite, and serves a rich visual explorer — no cloud, no API keys, no data leaving your machine.

## Features

- **Full Codebase Map** — Every file, function, component, hook, store, service, and API endpoint as interactive graph nodes
- **5 Graph Views** — Dependencies, Component Tree, Call Graph, API Flow, Architecture
- **Workflow Tracing** — Trace end-to-end flows like Authentication, Payment, Data Fetching, State Management
- **Auto-Detected Traces** — Automatically discovers common workflows by naming patterns
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

CodeMap automatically detects these common workflows:
- **Authentication** — Login/signup → auth service → token → API calls
- **Navigation** — Screen routing and navigation flows
- **Data Fetching** — Component → hook → API call → data rendering
- **State Management** — Store → dispatch → selector → component
- **Payment** — Checkout → processing → confirmation
- **Onboarding** — Welcome → steps → completion
- **Error Handling** — Error boundary → error service → reporting

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
