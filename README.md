# Archi

Local-first, deterministic code architecture explorer. No AI, no API keys, no cloud, no database — everything runs on your machine.

```bash
npx archi C:\path\to\your\project
```

Then open **http://127.0.0.1:4840** (opens automatically).

## What it does

```text
npx archi <folder>
   ↓
localhost web app
   ↓
Index codebase (TypeScript compiler API + pyright)
   ↓
Deterministic code graph
   ↓
Interactive explorer:  graph + tree side by side
   ↓
Drill down:  Repository → Folder → File → Class → Function → source code
```

- Click any node to see its **callers**, **callees**, and definition location.
- Click a file in the tree to see its symbols and read-only source.
- `Ctrl+K` searches symbol names and full-text code.
- Edited your code? Hit refresh / re-run — Archi re-indexes on demand.

## Supported languages

| Language | Symbols | Imports | Call edges |
|---|---|---|---|
| TypeScript / JavaScript | ✅ (ts-morph) | ✅ | ✅ type-checked (TS LanguageService) |
| Python | ✅ (pyright LSP) | ✅ | ✅ type-checked (pyright references) |

> If the source code says it, Archi knows it. If Archi doesn't know it, it doesn't invent it.

## CLI options

```text
archi [path]            folder to index immediately
archi --port 5000       custom port (default 4840)
archi --no-open         don't auto-open the browser
```

You can also start without a path (`npx archi`) and paste one into the UI.

## Development

```bash
npm install          # server deps (+ pyright bundled for Python support)
cd web && npm install && cd ..
npm run build        # compile server (dist/) + frontend (dist/web/)
npm test             # vitest suite incl. live pyright integration test
npm run dev          # watch mode for the server
```

Frontend dev server with hot reload:

```bash
cd web && npm run dev     # proxies /api to the backend port
```

## Architecture

See [specs.md](./specs.md) for the full product/technical specification.

```text
CLI (bin/archi) ── Fastify server
                     ├── Indexer: FileWalker · TsEngine · PyEngine(LSP) · GraphStore
                     ├── REST API (/api/repos/:id/…)
                     └── Static React app (React Flow + elkjs + Monaco)
```

In-memory index; `node_modules`, `.venv`, `dist`, `.git`, etc. are skipped; `.gitignore` is respected.

## Known MVP limits

- No live watching — re-index manually after changes.
- Dynamic dispatch (`obj.method()` where the type is `any`) is intentionally not resolved.
- Very large repos (>100k LOC) may take a while to index and use significant memory.
