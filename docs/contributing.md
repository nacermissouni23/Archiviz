# Contributing

1. Fork, branch, change, `npm run build`, PR.

## Adding a language

- Add entry in `src/index/treeSitterEngine.ts` (`symbolTypes`, `importType`, `callTypes`, `kindFromNode`) and `EXT_LANG`.
- Add framework hints to `SYSTEM_SIGNATURES` in `src/index/context.ts`.
- Test on a real repo.

## Adding framework awareness

Add package to `SYSTEM_SIGNATURES` with known symbols.

## Style

- No em dashes in user-facing text.
- Keep Mermaid rendering native (no custom foreignObject overrides).
- `npm run build` must pass.
