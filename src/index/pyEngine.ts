import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { LspClient } from './lsp.js';
import type { GraphStore, Sym } from './store.js';

const LSP_TIMEOUT_MS = 120_000;
const MAX_REFERENCE_SYMBOLS = 600;

interface LspPos {
  line: number;
  character: number;
}
interface LspSymbol {
  name: string;
  kind: number;
  range: { start: LspPos; end: LspPos };
  selectionRange: { start: LspPos };
  children?: LspSymbol[];
}
interface InternalSym {
  id: string;
  uri: string;
  start: LspPos;
  end: LspPos;
}

function toRel(root: string, absOrUri: string): string | null {
  let p = absOrUri;
  if (p.startsWith('file://')) {
    try {
      p = fileURLToPath(absOrUri); // handles %3A drive encoding + windows paths
    } catch {
      return null;
    }
  }
  // Normalize drive letter to uppercase (Windows: fileURLToPath may return "c:" but root has "C:")
  if (/^[a-z]:/.test(p)) p = p[0].toUpperCase() + p.slice(1);
  const norm = p.replace(/\\/g, '/');
  const rootNorm = root.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
  return norm.startsWith(rootNorm) ? norm.slice(rootNorm.length) : null;
}

function cmpPos(a: LspPos, b: LspPos): number {
  return a.line - b.line || a.character - b.character;
}

/** extract imported modules from python source */
export function pyImports(text: string): { module: string; level: number }[] {
  const out: { module: string; level: number }[] = [];
  for (const m of text.matchAll(/^\s*import\s+([.\w]+(?:\s*,\s*[.\w]+)*)/gm)) {
    for (const name of m[1].split(',')) {
      const mod = name.trim().split(/\s+as\s+/)[0].trim();
      if (mod) out.push({ module: mod, level: 0 });
    }
  }
  for (const m of text.matchAll(/^\s*from\s+(\.*)([\w.]*)\s+import\s+/gm)) {
    const level = m[1].length;
    out.push({ module: m[2] ?? '', level });
  }
  return out;
}

/** resolve a python module reference to a repo-relative file, if it maps into the repo */
function resolveModule(
  root: string,
  fromFile: string,
  mod: { module: string; level: number },
  pySet: Set<string>
): string | null {
  const tryFile = (dirRel: string, modPath: string): string | null => {
    const base = modPath ? `${dirRel}${dirRel ? '/' : ''}${modPath.split('.').join('/')}` : dirRel;
    for (const cand of [`${base}.py`, `${base}/__init__.py`]) {
      if (pySet.has(cand)) return cand;
    }
    return null;
  };

  if (mod.level > 0) {
    const parts = fromFile.split('/');
    parts.pop(); // drop file → dir
    for (let i = 1; i < mod.level && parts.length > 0; i++) parts.pop();
    const dirRel = parts.join('/');
    if (!mod.module) {
      // from . import sibling — callers resolve names themselves; skip
      return null;
    }
    return tryFile(dirRel, mod.module);
  }
  return tryFile('', mod.module);
}

function kindOf(lspKind: number, parent: InternalSym | null, hasChildren: boolean): 'class' | 'function' | 'method' | null {
  if (lspKind === 5) return 'class'; // Class
  if (lspKind === 6) return 'method'; // Method
  if (lspKind === 12) return parent ? 'method' : 'function'; // Function
  if (hasChildren && lspKind === 2) return null; // Module — skip
  return null;
}

export async function indexPython(
  root: string,
  pyFiles: string[],
  store: GraphStore
): Promise<{ symbols: number; calls: number; imports: number }> {
  if (pyFiles.length === 0) return { symbols: 0, calls: 0, imports: 0 };

  let langserver: string;
  try {
    const req = createRequire(import.meta.url);
    langserver = req.resolve('pyright/langserver.index.js');
  } catch {
    throw new Error('pyright is not installed');
  }

  const pySet = new Set(pyFiles);
  const texts = new Map<string, string>();
  for (const rel of pyFiles) {
    try {
      texts.set(rel, fs.readFileSync(path.join(root, rel), 'utf8'));
    } catch {
      /* unreadable — skip */
    }
  }
  const openable = [...texts.keys()];
  if (openable.length === 0) return { symbols: 0, calls: 0, imports: 0 };

  const client = new LspClient(
    process.execPath,
    [langserver, '--stdio'],
    root
  );

  const withTimeout = <T,>(p: Promise<T>, label: string): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`python index timed out: ${label}`)), LSP_TIMEOUT_MS)),
    ]);

  try {
    const initResult = await withTimeout(
      client.request('initialize', {
        processId: process.pid,
        rootUri: pathToFileURL(root).href,
        capabilities: {
          textDocument: {
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          },
        },
        initializationOptions: {},
      }),
      'initialize'
    );
    client.notify('initialized', {});

    // ---------- open files + symbols ----------
    const symbolsByUri = new Map<string, InternalSym[]>(); // key = repo-rel path
    let symbolCount = 0;

    for (const rel of openable) {
      const uri = pathToFileURL(path.join(root, rel)).href;
      client.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: 'python', version: 1, text: texts.get(rel)! },
      });
    }

    for (const rel of openable) {
      const uri = pathToFileURL(path.join(root, rel)).href;
      const root_syms: LspSymbol[] = await withTimeout(
        client.request('textDocument/documentSymbol', { textDocument: { uri } }, 20_000),
        `documentSymbol ${rel}`
      );
      if (!Array.isArray(root_syms)) continue;
      const internal: InternalSym[] = [];

      const walk = (nodes: LspSymbol[], parent: InternalSym | null, qPrefix: string) => {
        for (const n of nodes) {
          if (!n.range || !n.selectionRange) continue; // defensive: skip malformed
          const kind = kindOf(n.kind, parent, Array.isArray(n.children) && n.children.length > 0);
          let created: InternalSym | null = null;
          if (kind) {
            const qname = qPrefix ? `${qPrefix}.${n.name}` : n.name;
            const id = `${rel}:pysym:${qname}`;
            const sym: Sym = {
              id,
              kind,
              name: n.name,
              fileId: rel,
              startLine: n.range.start.line + 1,
              endLine: n.range.end.line + 1,
              signature: `${qname}()`,
              parent: parent?.id,
            };
            store.addSymbol(sym);
            store.addEdge(rel, id, 'contains');
            if (parent) store.addEdge(parent.id, id, 'contains');
            created = { id, uri, start: n.selectionRange.start, end: n.range.end };
            internal.push(created);
            symbolCount++;
          }
          if (n.children) walk(n.children, created ?? parent, created ? `${qPrefix}${qPrefix ? '.' : ''}${n.name}` : qPrefix);
        }
      };
      walk(root_syms, null, '');
      symbolsByUri.set(rel, internal);
    }

    // ---------- imports (regex + module resolution) ----------
    let importCount = 0;
    for (const rel of openable) {
      const text = texts.get(rel)!;
      for (const mod of pyImports(text)) {
        const target = resolveModule(root, rel, mod, pySet);
        if (target && target !== rel) {
          store.addEdge(rel, target, 'imports');
          importCount++;
        }
      }
    }

    // ---------- calls via references ----------
    let callCount = 0;
    const refTargets: InternalSym[] = [];
    for (const list of symbolsByUri.values()) {
      for (const s of list) {
        const sym = store.getSymbol(s.id);
        if (sym && (sym.kind === 'function' || sym.kind === 'method')) refTargets.push(s);
      }
    }
    const capped = refTargets.slice(0, MAX_REFERENCE_SYMBOLS);

    for (const target of capped) {
      let locations: { uri: string; range: { start: LspPos } }[] | null = null;
      try {
        locations = await withTimeout(
          client.request('textDocument/references', {
            textDocument: { uri: target.uri },
            position: target.start,
            context: { includeDeclaration: false },
          }, 15_000),
          'references'
        );
      } catch {
        continue;
      }
      if (!Array.isArray(locations)) continue;

      for (const loc of locations) {
        const rel = toRel(root, loc.uri);
        if (!rel) continue;
        const list = symbolsByUri.get(rel);
        if (!list || list.length === 0) continue;
        // innermost symbol containing the reference position
        let best: InternalSym | null = null;
        for (const s of list) {
          if (cmpPos(loc.range.start, s.start) >= 0 && cmpPos(loc.range.start, s.end) <= 0) {
            if (!best || cmpPos(s.start, best.start) >= 0) best = s;
          }
        }
        if (best && best.id !== target.id) {
          const before = store.edges.length;
          store.addEdge(best.id, target.id, 'calls');
          if (store.edges.length > before) callCount++;
        }
      }
    }

    await client.shutdown();
    return { symbols: symbolCount, calls: callCount, imports: importCount };
  } catch (e) {
    client.kill();
    throw e;
  }
}
