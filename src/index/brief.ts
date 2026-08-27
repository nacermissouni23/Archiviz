import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GraphStore, Sym } from './store.js';
import { findEntryPoints } from './trace.js';
import type { ContextData } from './context.js';
import type { OverviewData } from './overview.js';

export interface BriefEntryPoint {
  kind: 'bin' | 'script' | 'main';
  label: string;
  file: string;
  boot?: { fn: string; line: number; calls: { name: string; file: string }[] };
}

export interface BriefFlow {
  symbolId: string;
  name: string;
  file: string;
  line: number;
  callCount: number;
}

export interface BriefComponent {
  id: string;
  label: string;
  description?: string;
  fileCount: number;
  symbolCount: number;
}

export interface BriefData {
  name: string;
  description: string;
  systems: ContextData['systems'];
  libraryCount: number;
  topLibraries: { name: string; role?: string }[];
  entryPoints: BriefEntryPoint[];
  flows: BriefFlow[];
  components: BriefComponent[];
  ai: { pending: boolean; applied: boolean; error?: string };
}

/** extract candidate file paths from a package.json script/main/bin value */
function extractFileCandidates(value: string): string[] {
  const out: string[] = [];
  const re = /([\w./@-]+\.(?:ts|tsx|js|jsx|mjs|cjs))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    out.push(m[1].replace(/^\.\//, ''));
  }
  return out;
}

export /** the busiest symbol in the file and its first outbound calls = the boot chain */
function bootChain(store: GraphStore, file: string): BriefEntryPoint['boot'] | undefined {
  const syms = store.getSymbolsInFile(file);
  let best: Sym | undefined;
  let bestCount = 0;
  for (const s of syms) {
    const calls = store.getCallees(s.id).filter((e) => e.type === 'calls');
    if (calls.length > bestCount) {
      best = s;
      bestCount = calls.length;
    }
  }
  if (!best) return undefined;
  const calls = store
    .getCallees(best.id)
    .filter((e) => e.type === 'calls')
    .slice(0, 4)
    .map((e) => {
      const t = store.getSymbol(e.dst);
      return t ? { name: t.name, file: t.fileId } : null;
    })
    .filter((c): c is { name: string; file: string } => c !== null);
  return { fn: best.name, line: best.startLine, calls };
}

export function detectEntryPoints(store: GraphStore, rootPath: string): BriefEntryPoint[] {
  const eps: BriefEntryPoint[] = [];
  const seen = new Set<string>();
  let pkg: any = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(rootPath, 'package.json'), 'utf8'));
  } catch {
    return eps;
  }

  const tryAdd = (kind: BriefEntryPoint['kind'], label: string, value: unknown) => {
    if (typeof value !== 'string') return;
    for (const cand of extractFileCandidates(value)) {
      if (store.nodes.has(cand) && !seen.has(cand)) {
        seen.add(cand);
        eps.push({ kind, label, file: cand, boot: bootChain(store, cand) });
        return;
      }
    }
  };

  if (pkg.bin) {
    const binVal = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin)[0];
    tryAdd('bin', 'Command-line app', binVal);
  }
  tryAdd('script', 'Start script', pkg.scripts?.start);
  tryAdd('main', 'Main module', pkg.main);

  return eps;
}

export function buildBrief(
  store: GraphStore,
  rootName: string,
  rootPath: string,
  overview: OverviewData | null,
  context: ContextData | null
): BriefData {
  const ai = context?.ai ?? { pending: false, applied: false };
  const appAnn = context?.annotations?.app;

  const entryPoints = detectEntryPoints(store, rootPath);

  // flows: zero-caller symbols that call others, busiest first
  const flows: BriefFlow[] = findEntryPoints(store)
    .map((ep) => {
      const sym = store.getSymbol(ep.id);
      if (!sym) return null;
      const callCount = store.getCallees(sym.id).filter((e) => e.type === 'calls').length;
      return { symbolId: sym.id, name: sym.name, file: sym.fileId, line: sym.startLine, callCount };
    })
    .filter((f): f is BriefFlow => f !== null && f.callCount > 0)
    .sort((a, b) => b.callCount - a.callCount)
    .slice(0, 6);

  // components from the overview rollup, AI labels if present
  const components: BriefComponent[] = (overview?.components ?? [])
    .slice()
    .sort((a, b) => b.fileCount - a.fileCount)
    .slice(0, 8)
    .map((c) => {
      const ann = overview?.annotations?.components[c.id];
      return {
        id: c.id,
        label: c.name,
        description: ann?.description,
        fileCount: c.fileCount,
        symbolCount: c.symbolCount,
      };
    });

  const topLibraries = (context?.libraries ?? [])
    .map((l) => ({ name: l.name, role: context?.annotations?.libraries?.[l.name] }));

  const description =
    appAnn?.description ??
    (context?.systems.length || context?.actors.length
      ? ''
      : '');

  return {
    name: rootName,
    description,
    systems: context?.systems ?? [],
    libraryCount: context?.stats.libraries ?? 0,
    topLibraries,
    entryPoints,
    flows,
    components,
    ai,
  };
}
