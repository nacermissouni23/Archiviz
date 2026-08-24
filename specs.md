# Archi — Product & Technical Specification

> Local-first, deterministic code architecture explorer.
> **Philosophy:** *If the source code says it, Archi knows it. If Archi doesn't know it, it doesn't invent it.*

Version: 1.0 (MVP) · Status: In development · Date: 2026-08-22

---

## 1. Vision

Archi turns any local TypeScript/JavaScript/Python repository into a live, interactive
architecture graph in the browser. A developer runs one command, points at a folder,
and drills from Repository → Folder → File → Class → Function → actual source code,
seeing callers and callees at every step.

No AI. No API keys. No cloud. No database server. Everything runs locally.

### Market context (from SOTA research)

- **Sourcetrail** (closest historical analog) is abandoned — no maintained local-first explorer exists.
- **dependency-cruiser / madge / pydeps** stop at import/file granularity — no function-level call graphs, no UI.
- **Sourcegraph / CodeScene** are server-side/commercial; not local-first.
- **CodeSee** failed commercially; its live-watching feature added more cost than perceived value → validates Archi's manual-refresh MVP decision.

**Gap Archi fills:** local-first + type-checked function-level call resolution + interactive browser drill-down, in a single `npx` command.

---

## 2. Goals / Non-Goals

**Goals (v1)**
1. `npx archi` starts a local web app; user selects any local folder.
2. Index TS/JS and Python repos into a deterministic code graph (symbols, imports, type-checked calls).
3. Interactive explorer: file tree + zoomable node graph side by side.
4. Drill-down: click node → metadata panel (callers/callees/definition) → source code viewer.
5. Ctrl+K search by symbol name + full-text code search.
6. Manual refresh button to re-index after code changes.
7. Works fully offline on Windows/macOS/Linux.

**Non-Goals (v1)**
- Live file watching / hot re-index (fast-follow v1.1)
- AI features, "explain this", refactorings
- MCP server / coding-agent integration (v2)
- Persistence across runs (in-memory only), multi-repo workspaces
- Editing/refactoring code, git integration UI

---

## 3. Users & Core User Journeys

**Persona:** a developer (or student) onboarding into an unfamiliar codebase.

- **J1 First contact:** `npx archi` → browser opens `http://localhost:<port>` → paste/browse folder path → progress shown → explorer appears.
- **J2 Architecture overview:** see folders/modules as graph nodes sized by symbol count, edges = import/call flow between them.
- **J3 Symbol investigation:** click `Agent.run()` → panel shows CALLERS (`main()`), CALLEES (`planner.plan()`, `tools.execute()`, `memory.save()`), DEFINED IN `src/agent/agent.ts:42`.
- **J4 Read the code:** click again → Monaco editor opens that exact range, read-only.
- **J5 Find anything:** Ctrl+K → type "Agent" → jump to node; or full-text tab → grep-style results.
- **J6 After editing code:** click Refresh → index rebuilt → graph reflects reality.

---

## 4. Functional Requirements

| ID | Requirement |
|----|-------------|
| FR-1 | CLI: `archi [path]` and `npx archi`; flags `--port`, `--open/--no-open`. Starts server, prints URL, opens browser by default. |
| FR-2 | Folder selection via typed path or native directory picker in the web UI. Path must be validated with clear errors. |
| FR-3 | File discovery: recursive walk of `.ts .tsx .js .jsx .mjs .cjs .py`; skip `node_modules`, `.venv`, `site-packages`, `.git`, `dist`, `build`, `__pycache__`; respect `.gitignore`, `tsconfig.exclude`, `pyrightconfig` excludes when present. |
| FR-4 | Indexing builds an in-memory graph: Files, Symbols (class, function, method, module), Edges (`imports`, `contains`, `calls`). Canonical POSIX-style slash IDs for all paths. |
| FR-5 | TS/JS resolution via the TypeScript compiler (LanguageService): accurate symbols, imports, and type-checked call edges where determinable; unresolved dynamic calls recorded as unresolved (never guessed). |
| FR-6 | Python resolution via pinned pyright over LSP (`pyright-langserver --stdio`) for definitions/references/call hierarchy; graceful timeout handling. |
| FR-7 | REST API serves: repo summary, tree, graph (nodes+edges, filterable by depth/module), node detail (callers/callees/def location), raw source with line ranges. |
| FR-8 | Web UI: left file tree, center React Flow graph, right detail panel; drill-down navigation with breadcrumb/back stack. |
| FR-9 | Node interactions: hover highlights connected edges; click selects & loads details; double-click expands/collapses container nodes (folder→files→symbols). |
| FR-10 | Source view: read-only Monaco showing the file scrolled to the definition line. |
| FR-11 | Search: Ctrl+K fuzzy symbol search (keyboard-navigable) + full-text search across indexed files with results list → jump to source. |
| FR-12 | Refresh action re-indexes in place; UI shows progress states (idle/indexing/ready/error). |
| FR-13 | Large repo guard: if file count > threshold, warn and continue; indexing runs with progress reporting. |

## 5. Non-Functional Requirements

| ID | Requirement |
|----|-------------|
| NFR-1 | Determinism: identical input repo ⇒ identical graph output. No invented edges. |
| NFR-2 | Performance targets: ≤60s cold index for ≤100k LOC TS repo on a dev laptop; graph interactions stay ≥30fps up to ~2k visible nodes. |
| NFR-3 | Memory: in-memory index acceptable to several hundred MB for very large repos; interned strings/flat structures for occurrences. |
| NFR-4 | Privacy: zero network egress besides localhost; works offline. |
| NFR-5 | Cross-platform paths: internal IDs always POSIX-slash normalized; all path ops via `node:path`. |
| NFR-6 | Robustness: one broken/unparsable file must never fail the whole index; per-file errors surfaced in a diagnostics list. |

---

## 6. Architecture (decided stack)

```text
CLI (bin/archi)            Node.js + TypeScript
      │
      ▼
Fastify server             serves REST API + static frontend build
      │
      ├── Indexer
      │     ├─ FileWalker        (FR-3 ignore rules)
      │     ├─ TsEngine          (typescript LanguageService)
      │     ├─ PyEngine          (pyright LSP client)
      │     └─ GraphStore        (in-memory {nodes, edges})
      │
      └── Static: React + TypeScript + Vite build
            ├─ React Flow   (graph, memoized custom nodes)
            ├─ elkjs        (hierarchical layout; SCC-collapse cycles first)
            ├─ Monaco       (read-only source)
            └─ Fast-fuzzy / fuse.js (symbol search)
```

Key technical decisions (research-backed):
- **ts-morph wrapper** around the TS LanguageService for ergonomics/perf guidance; reuse a single LanguageService instance per index run.
- **pyright pinned version**; spawn langserver per indexing run with timeout/kill.
- **Graph schema**: SCIP-inspired flat model — `Symbol{id, kind, name, fileId, range}`, `Edge{type: imports|contains|calls, src, dst}`; cycles handled by Tarjan SCC collapse before layout, never during data modeling.
- **React Flow performance**: memoized node components, immutable node data, hide-don't-unmount collapsed subtrees, layout computed off-thread where possible.

## 7. API Sketch (v1)

```text
GET  /api/ping                     → { ok }
POST /api/repos                    { path } → starts indexing, returns repoId
GET  /api/repos/:id/status         → { state: idle|walking|indexing|ready|error, progress, files[], errors[] }
GET  /api/repos/:id/tree           → nested folder tree with counts
GET  /api/repos/:id/graph          ?scope=fileId|symbolId&depth=n → { nodes, edges }
GET  /api/repos/:id/symbols/:sid   → { symbol, callers[], callees[], definition }
GET  /api/repos/:id/source         ?fileId=&start=&end= → raw text
GET  /api/repos/:id/search         ?q=&mode=symbols|text → results[]
```

## 8. Acceptance Criteria (Definition of Done — MVP)

1. On a fresh machine with Node ≥20: `npx archi <path-to-ts-repo>` opens the working explorer.
2. The J2–J6 journeys above complete without errors on a real ~10k+ LOC repo.
3. Callers/callees shown for a normal (non-dynamic) method are correct vs manual reading of the code.
4. Full-text + symbol search return relevant hits under 1s on a 100k-symbol index.
5. A deliberately corrupted file produces a diagnostic entry, not a crashed indexer.
6. `npm run build` passes clean typecheck; unit tests cover walker, graph store, and TS engine core.
7. README quickstart works as written.
