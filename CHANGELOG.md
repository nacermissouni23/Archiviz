# Changelog

All notable changes to Archi.

## [0.1.0] - 2026-08-27

### Added
- 5 progressive views: Repository Brief (L0), System Context (L1), Component Overview (L2), Dependencies (L3), Execution Trace (L4), Symbol Inspector (L5)
- 4 indexing engines covering 36 languages: TS LanguageService, Pyright LSP, Gopls LSP, Tree-sitter WASM
- Manifest parsers for 10+ formats (package.json, requirements.txt, pyproject.toml, go.mod, pom.xml, etc.)
- Global search (`Ctrl+K`) grouped by type + local diagram filter
- Optional AI annotations (single merged Gemini call per indexing) with truthful `AI annotated` / `AI failed` badges
- Settings UI for API key (stored in `~/.archi/config.json`)
- File tree, read-only code viewer, inspector with callers/callees

### Fixed
- Text overflow in Mermaid nodes, filter dim logic, tab titles, search→code navigation

## [Unreleased]
- CI, security scan, assets/branding, publishing
