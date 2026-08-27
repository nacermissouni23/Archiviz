import type { GraphStore } from './store.js';

export interface OverviewComponent {
  id: string;
  name: string;
  fileCount: number;
  symbolCount: number;
  topSymbols: string[];
}

export interface OverviewEdge {
  src: string;
  dst: string;
  count: number;
  callsOnly: boolean;
}

export interface OverviewAnnotations {
  /** key = folder path (e.g. "src", "src/index", "(root)") */
  components: Record<string, { label?: string; description?: string }>;
  edges: Record<string, string>;
}

export interface OverviewData {
  components: OverviewComponent[];
  edges: OverviewEdge[];
  ai: { pending: boolean; applied: boolean; error?: string };
  annotations?: OverviewAnnotations;
  /** All folders with at least one indexed file, for AI annotation */
  allFolders: { id: string; name: string; fileCount: number; symbolCount: number; topSymbols: string[] }[];
}

const ROOT = '(root)';

function componentOf(fileId: string): string {
  const idx = fileId.indexOf('/');
  return idx === -1 ? ROOT : fileId.slice(0, idx);
}

function fileOfNodeId(nodeId: string): string {
  // symbol ids look like "<fileId>:kind:<name>"; file ids are paths without ':'
  const idx = nodeId.indexOf(':');
  return idx === -1 ? nodeId : nodeId.slice(0, idx);
}

export function buildOverview(store: GraphStore): OverviewData {
  const comps = new Map<string, OverviewComponent>();
  const allFolders = new Map<string, OverviewComponent>();

  for (const node of store.nodes.values()) {
    if (node.type !== 'file') continue;
    const c = componentOf(node.id);
    // top-level component
    let comp = comps.get(c);
    if (!comp) {
      comp = { id: c, name: c === ROOT ? '(root files)' : c, fileCount: 0, symbolCount: 0, topSymbols: [] };
      comps.set(c, comp);
    }
    comp.fileCount++;
    comp.symbolCount += (store.symbolsByFile.get(node.id) ?? []).length;

    // ALL folders along the path (for AI annotation of subfolders)
    const parts = node.id.split('/');
    for (let i = 1; i < parts.length; i++) {
      const folderPath = parts.slice(0, i).join('/');
      let folder = allFolders.get(folderPath);
      if (!folder) {
        folder = { id: folderPath, name: folderPath, fileCount: 0, symbolCount: 0, topSymbols: [] };
        allFolders.set(folderPath, folder);
      }
      folder.fileCount++;
      folder.symbolCount += (store.symbolsByFile.get(node.id) ?? []).length;
    }
    // also include the top-level component itself
    if (!allFolders.has(c)) {
      const top = { id: c, name: c === ROOT ? '(root files)' : c, fileCount: 0, symbolCount: 0, topSymbols: [] };
      allFolders.set(c, top);
    }
    const topFolder = allFolders.get(c)!;
    topFolder.fileCount++;
    topFolder.symbolCount += (store.symbolsByFile.get(node.id) ?? []).length;
  }

  // collect top symbols per component (for top-level overview)
  const seenPerComp = new Map<string, number>();
  for (const node of store.nodes.values()) {
    if (node.type !== 'symbol' || !node.sym) continue;
    const c = componentOf(node.sym.fileId);
    const n = seenPerComp.get(c) ?? 0;
    if (n < 25) {
      comps.get(c)?.topSymbols.push(node.sym.name);
      seenPerComp.set(c, n + 1);
    }
  }
  // collect top symbols per subfolder (for AI annotation)
  const seenPerFolder = new Map<string, number>();
  for (const node of store.nodes.values()) {
    if (node.type !== 'symbol' || !node.sym) continue;
    const fileId = node.sym.fileId;
    const parts = fileId.split('/');
    for (let i = 1; i < parts.length; i++) {
      const folderPath = parts.slice(0, i).join('/');
      const n = seenPerFolder.get(folderPath) ?? 0;
      if (n < 25) {
        allFolders.get(folderPath)?.topSymbols.push(node.sym.name);
        seenPerFolder.set(folderPath, n + 1);
      }
    }
    // top-level too
    const c = componentOf(fileId);
    const n2 = seenPerFolder.get(c) ?? 0;
    if (n2 < 25) {
      allFolders.get(c)?.topSymbols.push(node.sym.name);
      seenPerFolder.set(c, n2 + 1);
    }
  }

  const edgeMap = new Map<string, OverviewEdge>();
  const hasImport = new Set<string>();

  const pairKey = (a: string, b: string) => `${a}\u0000${b}`;

  function link(srcFile: string, dstFile: string, viaCall: boolean) {
    const src = componentOf(srcFile);
    const dst = componentOf(dstFile);
    if (src === dst) return;
    const key = pairKey(src, dst);
    if (!viaCall) hasImport.add(key);
    let e = edgeMap.get(key);
    if (!e) {
      e = { src, dst, count: 0, callsOnly: true };
      edgeMap.set(key, e);
    }
    e.count++;
  }

  for (const edge of store.edges) {
    if (edge.type === 'imports') {
      link(edge.src, edge.dst, false);
    } else if (edge.type === 'calls') {
      link(fileOfNodeId(edge.src), fileOfNodeId(edge.dst), true);
    }
  }

  const edges = [...edgeMap.values()];
  for (const e of edges) {
    e.callsOnly = !hasImport.has(pairKey(e.src, e.dst));
  }
  edges.sort((a, b) => b.count - a.count);

  return {
    components: [...comps.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges,
    allFolders: [...allFolders.values()].sort((a, b) => a.id.localeCompare(b.id)),
    ai: { pending: false, applied: false },
  };
}

// ---------- AI annotation pass ----------

function extractionText(text: string): string {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  return t;
}

export async function annotateOverview(
  data: OverviewData,
  apiKey: string,
  model: string
): Promise<OverviewAnnotations | null> {
  const prompt = [
    'You are annotating a deterministic dependency rollup of a code repository.',
    'Folders represent directories with at least one indexed file.',
    'Return ONLY strict JSON, no prose, no markdown fences, shaped exactly like:',
    '{"components":[{"id":"folder/path","label":"Human name","description":"one short sentence"}],"edges":[{"src":"folder/path","dst":"folder/path","label":"2-4 words"}]}',
    'Rules:',
    '- Use ONLY the ids given. Never add, remove, or merge components/edges.',
    '- label: a clean human name for the folder (e.g. "Indexing Engine").',
    '- description: what this part of the codebase does, max 12 words.',
    '- edge labels: the nature of the relationship (e.g. "imports types", "renders", "serves API").',
    '',
    JSON.stringify({
      components: data.allFolders.map((c) => ({ id: c.id, name: c.name, symbols: c.topSymbols, fileCount: c.fileCount, symbolCount: c.symbolCount })),
      edges: data.edges.map((e) => ({ src: e.src, dst: e.dst, count: e.count })),
    }),
  ].join('\n');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2 },
        }),
        signal: ctrl.signal,
      }
    );
    if (!res.ok) throw new Error(`gemini ${res.status}`);
    const json: any = await res.json();
    const text: string | undefined = json?.candidates?.[0]?.content?.parts
      ?.map((p: any) => p?.text ?? '')
      .join('');
    if (!text) throw new Error('empty response');

    const parsed = JSON.parse(extractionText(text));
    const validIds = new Set(data.allFolders.map((c) => c.id));
    const annotations: OverviewAnnotations = { components: {}, edges: {} };

    for (const c of parsed?.components ?? []) {
      if (typeof c?.id !== 'string') continue;
      // try exact match first
      let matchId = validIds.has(c.id) ? c.id : undefined;
      // try stripping leading path segments if AI added extra nesting
      if (!matchId) {
        for (const vid of validIds) {
          if (c.id.endsWith('/' + vid) || vid.endsWith('/' + c.id) || c.id === vid) {
            matchId = vid;
            break;
          }
        }
      }
      if (!matchId) continue;
      const label = typeof c.label === 'string' ? c.label.slice(0, 60).trim() : undefined;
      const desc = typeof c.description === 'string' ? c.description.slice(0, 120).trim() : undefined;
      if (!label && !desc) continue;
      annotations.components[matchId] = {
        label: label || undefined,
        description: desc || undefined,
      };
    }
    const validPairs = new Set(data.edges.map((e) => `${e.src}\u0000${e.dst}`));
    for (const e of parsed?.edges ?? []) {
      if (
        typeof e?.src === 'string' &&
        typeof e?.dst === 'string' &&
        typeof e?.label === 'string' &&
        validPairs.has(`${e.src}\u0000${e.dst}`)
      ) {
        annotations.edges[`${e.src}\u0000${e.dst}`] = e.label.slice(0, 40);
      }
    }
    return annotations;
  } finally {
    clearTimeout(timer);
  }
}
