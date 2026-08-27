# Concepts

## The 5 levels

| Level | View | Source |
|-------|------|--------|
| L0 | Repository Brief | One paragraph + entry points + built-with |
| L1 | System Context | Systems, actors, libraries, confidence |
| L2 | Component Overview | Top-level folders as components |
| L3 | Dependencies | Per-file imports and dependents |
| L4 | Execution Trace | Call chain from a symbol |
| L5 | Symbol Inspector | Callers, callees, definition |

## Deterministic graph

Same code plus same engines equals same graph. AI only renames, never invents structure. Confidence is HIGH when imported in indexed code, MED when env-only or manifest-only.

## GraphStore

In-memory nodes (`file`, `symbol`) plus edges (`contains`, `imports`, `calls`) with `callersOf` and `calleesOf` indexes.
