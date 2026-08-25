import type { GraphStore } from './store.js';
import type { ContextData } from './context.js';
import type { OverviewData } from './overview.js';
import { detectEntryPoints } from './brief.js';

export interface StorySegment {
  text: string;
  /** ref formats: "file:<path>" | "component:<id>" | "system:<name>" | "actor:<id>" */
  ref?: string;
}

export interface StorySkeleton {
  entry: { file: string; label: string }[];
  server: { pkg: string; routeCount: number; sampleRoutes: string[]; file: string } | null;
  components: { id: string; name: string; fileCount: number }[];
  componentEdges: { src: string; dst: string; count: number }[];
  systems: { name: string; label: string; kind: string }[];
  flows: { name: string; file: string; line: number }[];
}

export interface StoryData {
  segments: StorySegment[];
  skeleton: StorySkeleton;
  ai: { pending: boolean; applied: boolean };
}

const SERVER_PACKAGES = ['express', 'fastify', 'koa', '@hapi/hapi', 'hono', 'next'];

export function buildStory(
  store: GraphStore,
  rootName: string,
  rootPath: string,
  overview: OverviewData | null,
  context: ContextData | null
): StoryData {
  // ---------- facts ----------
  const entry = detectEntryPoints(store, rootPath).map((e) => ({ file: e.file, label: e.label }));

  const serverPkg = SERVER_PACKAGES.find((p) => store.externals.has(p)) ?? null;
  let server: StorySkeleton['server'] = null;
  if (serverPkg) {
    const byFile = new Map<string, number>();
    for (const r of store.routes) byFile.set(r.fileId, (byFile.get(r.fileId) ?? 0) + 1);
    const topFile = [...byFile.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topFile) {
      server = {
        pkg: serverPkg,
        routeCount: store.routes.length,
        sampleRoutes: store.routes
          .slice(0, 3)
          .map((r) => `${r.method} ${r.path}`),
        file: topFile[0],
      };
    }
  }

  const components = (overview?.components ?? [])
    .slice()
    .sort((a, b) => b.fileCount - a.fileCount)
    .slice(0, 5)
    .map((c) => ({ id: c.id, name: c.name, fileCount: c.fileCount }));

  const componentEdges = (overview?.edges ?? [])
    .slice()
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((e) => ({ src: e.src, dst: e.dst, count: e.count }));

  const systems = (context?.systems ?? []).map((s) => ({
    name: s.name,
    label: context?.annotations?.systems?.[s.name] ?? s.label,
    kind: s.kind,
  }));

  // flows: busiest zero-caller symbols (same heuristic as Brief flows)
  const flowList: { name: string; file: string; line: number; calls: number }[] = [];
  for (const node of store.nodes.values()) {
    if (node.type !== 'symbol' || !node.sym) continue;
    const callers = store.getCallers(node.sym.id).filter((e) => e.type === 'calls');
    if (callers.length > 0) continue;
    const callees = store.getCallees(node.sym.id).filter((e) => e.type === 'calls');
    if (callees.length === 0) continue;
    flowList.push({ name: node.sym.name, file: node.sym.fileId, line: node.sym.startLine, calls: callees.length });
  }
  flowList.sort((a, b) => b.calls - a.calls);
  const skeleton: StorySkeleton = {
    entry,
    server,
    components,
    componentEdges,
    systems,
    flows: flowList.slice(0, 3).map((f) => ({ name: f.name, file: f.file, line: f.line })),
  };

  const segments = templateSegments(skeleton);
  return { segments, skeleton, ai: { pending: false, applied: false } };
}

// ---------- deterministic fallback narrative ----------

function templateSegments(s: StorySkeleton): StorySegment[] {
  const segs: StorySegment[] = [];

  if (s.entry.length > 0) {
    segs.push({ text: 'The application starts from ' });
    segs.push({ text: s.entry[0].file, ref: `file:${s.entry[0].file}` });
    segs.push({ text: '.' });
  } else {
    segs.push({ text: 'No clear entry point was detected in this repository.' });
  }

  if (s.server) {
    segs.push({ text: ` It runs an HTTP server built with ${s.server.pkg} exposing ${s.server.routeCount} route${s.server.routeCount === 1 ? '' : 's'}` });
    if (s.server.sampleRoutes.length > 0) {
      segs.push({ text: ` (${s.server.sampleRoutes.join(', ')})` });
    }
    segs.push({ text: ' in ' });
    segs.push({ text: s.server.file, ref: `file:${s.server.file}` });
    segs.push({ text: '.' });
  }

  if (s.components.length > 0) {
    segs.push({ text: ' The code is organized into major parts such as ' });
    s.components.slice(0, 3).forEach((c, i) => {
      if (i > 0) segs.push({ text: ', ' });
      segs.push({ text: c.name, ref: `component:${c.id}` });
    });
    segs.push({ text: '.' });
  }

  if (s.systems.length > 0) {
    segs.push({ text: ' It relies on external systems including ' });
    s.systems.slice(0, 3).forEach((sys, i) => {
      if (i > 0) segs.push({ text: ', ' });
      segs.push({ text: sys.label, ref: `system:${sys.name}` });
    });
    segs.push({ text: '.' });
  }

  if (s.flows.length > 0) {
    segs.push({ text: ` Main execution flows begin at ${s.flows[0].name}() in ` });
    segs.push({ text: s.flows[0].file, ref: `file:${s.flows[0].file}` });
    segs.push({ text: '.' });
  }

  return segs;
}

// ---------- AI pass ----------

function extractionText(text: string): string {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  return t;
}

/** parse the model response defensively: try each part separately before joining */
function parseModelJson(json: any): any | null {
  const parts: string[] = (json?.candidates?.[0]?.content?.parts ?? [])
    .map((p: any) => p?.text ?? '')
    .filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length > 1) {
    for (const p of parts) {
      try {
        return JSON.parse(extractionText(p));
      } catch {
        /* try next */
      }
    }
  }
  try {
    return JSON.parse(extractionText(parts.join('')));
  } catch {
    return null;
  }
}

const MARKER_RE = /\{\{(file|component|system|actor):([^}]+)\}\}/g;

export async function annotateStory(
  skeleton: StorySkeleton,
  allowed: { files: Set<string>; components: Set<string>; systems: Set<string>; actors: Set<string> },
  apiKey: string,
  model: string
): Promise<StorySegment[] | null> {
  const prompt = [
    'You are writing a short "how it works" explanation of a code repository for a developer seeing it for the first time.',
    'Write 3 to 6 short sentences. Use ONLY the facts given below — never invent files, components, systems, or behaviors.',
    'Mark references by wrapping them exactly like {{file:src/main.ts}}, {{component:src}}, {{system:pg}}, or {{actor:cli}}.',
    'Only reference the exact files/components/systems/actors listed. Plain sentences between markers must not contain file paths.',
    '',
    'FACTS:',
    JSON.stringify(skeleton),
    '',
    'Allowed reference values:',
    `files: ${[...allowed.files].slice(0, 40).join(', ')}`,
    `components: ${[...allowed.components].join(', ')}`,
    `systems: ${[...allowed.systems].join(', ')}`,
    `actors: ${[...allowed.actors].join(', ')}`,
    '',
    'Return ONLY strict JSON: {"segments":[{"text":"...","ref":"file:src/main.ts"}]}',
    'Split the story into segments so that each reference is its own segment with a ref field. Text segments have no ref.',
  ].join('\n');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3 },
        }),
        signal: ctrl.signal,
      }
    );
    if (!res.ok) throw new Error(`gemini ${res.status}`);
    const json: any = await res.json();
    const parsed = parseModelJson(json);
    if (!parsed) throw new Error('empty response');

    const raw: any[] = Array.isArray(parsed?.segments) ? parsed.segments : [];
    const segments: StorySegment[] = [];

    for (const seg of raw.slice(0, 60)) {
      if (typeof seg?.text !== 'string' || !seg.text.trim()) continue;
      const clean = seg.text.replace(/[*#`]/g, '').replace(/\s+/g, ' ');
      let ref: string | undefined;
      if (typeof seg?.ref === 'string') {
        const [kind, ...rest] = seg.ref.split(':');
        const val = rest.join(':').trim();
        const ok =
          (kind === 'file' && allowed.files.has(val)) ||
          (kind === 'component' && allowed.components.has(val)) ||
          (kind === 'system' && allowed.systems.has(val)) ||
          (kind === 'actor' && allowed.actors.has(val));
        if (ok) ref = `${kind}:${val}`;
      }
      // also catch markers the model left inside the text
      const inner: StorySegment[] = [];
      let last = 0;
      MARKER_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      let foundMarker = false;
      while ((m = MARKER_RE.exec(clean))) {
        foundMarker = true;
        if (m.index > last) inner.push({ text: clean.slice(last, m.index) });
        const kind = m[1];
        const val = m[2].trim();
        const ok =
          (kind === 'file' && allowed.files.has(val)) ||
          (kind === 'component' && allowed.components.has(val)) ||
          (kind === 'system' && allowed.systems.has(val)) ||
          (kind === 'actor' && allowed.actors.has(val));
        if (ok) inner.push({ text: val, ref: `${kind}:${val}` });
        else inner.push({ text: val });
        last = m.index + m[0].length;
      }
      if (foundMarker) {
        if (last < clean.length) inner.push({ text: clean.slice(last) });
        segments.push(...inner.filter((s) => s.text.length > 0));
      } else {
        segments.push({ text: clean, ref });
      }
      if (inner.length > 0) {
        if (last < clean.length) inner.push({ text: clean.slice(last) });
        segments.push(...inner);
      } else {
        segments.push({ text: clean, ref });
      }
    }
    // consecutive-duplicate guard (small models sometimes echo segments twice)
    const deduped: StorySegment[] = [];
    for (const s of segments) {
      const prev = deduped[deduped.length - 1];
      if (prev && prev.text === s.text && prev.ref === s.ref) continue;
      deduped.push(s);
    }
    // whole-story duplication guard: [A, A] → [A]
    if (deduped.length >= 4 && deduped.length % 2 === 0) {
      const half = deduped.length / 2;
      if (JSON.stringify(deduped.slice(0, half)) === JSON.stringify(deduped.slice(half))) {
        deduped.length = half;
      }
    }
    return deduped.length > 0 ? deduped : null;
  } finally {
    clearTimeout(timer);
  }
}
