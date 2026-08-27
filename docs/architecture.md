# Architecture

```
bin/archi.js -> Fastify (src/server.ts)
  -> walk.ts (respects .gitignore, skips sensitive files)
  -> indexers: tsIndexer, pyEngine, goEngine, treeSitterEngine
  -> manifests
  -> GraphStore (nodes + edges)
  -> context.ts (SYSTEM_SIGNATURES)
  -> overview, context, brief, narrative, trace
  -> REST API (/api/*)
  -> Vite + React + Mermaid
```

- In-memory only, no DB
- Single merged Gemini call per indexing for all annotations
- `GET /api/repo` no longer leaks absolute paths, CSP headers enabled
