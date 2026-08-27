import type { OverviewData, OverviewAnnotations } from './overview.js';
import type { ContextData, ContextAnnotations } from './context.js';
import type { StorySkeleton, StorySegment } from './narrative.js';

function extractionText(text: string): string {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  return t;
}

function parseModelJson(json: any): any | null {
  const parts: string[] = (json?.candidates?.[0]?.content?.parts ?? [])
    .map((p: any) => p?.text ?? '')
    .filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length > 1) {
    for (const p of parts) {
      try { return JSON.parse(extractionText(p)); } catch { /* next */ }
    }
  }
  try { return JSON.parse(extractionText(parts.join(''))); } catch { return null; }
}

export interface AllAnnotations {
  overview: OverviewAnnotations;
  context: ContextAnnotations;
  story: StorySegment[];
}

export async function annotateAll(
  overview: OverviewData,
  context: ContextData,
  skeleton: StorySkeleton,
  allowed: { files: Set<string>; components: Set<string>; systems: Set<string>; actors: Set<string> },
  apiKey: string,
  model: string,
): Promise<AllAnnotations | null> {
  const prompt = [
    'You are annotating a code repository for a developer. Return ONLY strict JSON, no prose, no markdown fences.',
    'The JSON must have exactly 3 top-level keys: overview, context, story.',
    '',
    '## overview: human labels for the folder dependency rollup',
    'Shape: {"components":[{"id":"folder/path","label":"Human name","description":"one short sentence"}],"edges":[{"src":"folder/path","dst":"folder/path","label":"2-4 words"}]}',
    'Rules: Use ONLY the ids given. Never add/remove/merge. label=clean human name, description=max 12 words, edge label=2-4 words.',
    JSON.stringify({
      components: overview.allFolders.map(c => ({ id: c.id, name: c.name, symbols: c.topSymbols, fileCount: c.fileCount, symbolCount: c.symbolCount })),
      edges: overview.edges.map(e => ({ src: e.src, dst: e.dst, count: e.count })),
    }),
    '',
    '## context: what the repo IS and what it talks to',
    'Shape: {"app":{"label":"short human name","description":"one sentence: what this application is"},"systems":[{"name":"pg","label":"PostgreSQL database"}],"actors":[{"id":"http","label":"Browser clients"}],"libraries":[{"name":"react","role":"React UI framework"}]}',
    'Rules: system/actor labels describe WHAT the thing is, never repeat raw id. Use ONLY the names/ids given. libraries roles must be SPECIFIC, never bare "library". app.description max 20 words.',
    JSON.stringify({
      repoName: context.name,
      systems: context.systems.map(s => ({ name: s.name, kind: s.kind, evidence: [...s.importFiles, ...s.envVars] })),
      actors: context.actors.map(a => ({ id: a.id, evidence: a.evidence })),
      libraries: context.libraries.slice(0, 20).map(l => l.name),
    }),
    '',
    '## story: 3 to 6 short sentences explaining how this repo works',
    'Use ONLY the facts given, never invent files/components/systems/behaviors.',
    'Mark references exactly like {{file:src/main.ts}}, {{component:src}}, {{system:pg}}, or {{actor:cli}}. Only reference exact values listed.',
    'FACTS:',
    JSON.stringify(skeleton),
    `Allowed: files: ${[...allowed.files].slice(0, 40).join(', ')} | components: ${[...allowed.components].join(', ')} | systems: ${[...allowed.systems].join(', ')} | actors: ${[...allowed.actors].join(', ')}`,
    'Shape: {"segments":[{"text":"...","ref":"file:src/main.ts"}]} - split so each reference is its own segment with ref, plain text segments have no ref.',
    '',
    'Return: {"overview":{...},"context":{...},"story":{"segments":[...]}}',
  ].join('\n');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2 } }), signal: ctrl.signal },
    );
    if (!res.ok) throw new Error(`gemini ${res.status}`);
    const json: any = await res.json();
    const parsed = parseModelJson(json);
    if (!parsed) throw new Error('empty response');

    // --- overview ---
    const validIds = new Set(overview.allFolders.map(c => c.id));
    const ovAnn: OverviewAnnotations = { components: {}, edges: {} };
    for (const c of parsed?.overview?.components ?? parsed?.components ?? []) {
      if (typeof c?.id !== 'string') continue;
      let matchId = validIds.has(c.id) ? c.id : undefined;
      if (!matchId) { for (const vid of validIds) if (c.id.endsWith('/' + vid) || vid.endsWith('/' + c.id)) { matchId = vid; break; } }
      if (!matchId) continue;
      const label = typeof c.label === 'string' ? c.label.slice(0, 60).trim() : undefined;
      const desc = typeof c.description === 'string' ? c.description.slice(0, 120).trim() : undefined;
      if (!label && !desc) continue;
      ovAnn.components[matchId] = { label: label || undefined, description: desc || undefined };
    }
    const validPairs = new Set(overview.edges.map(e => `${e.src}\u0000${e.dst}`));
    for (const e of parsed?.overview?.edges ?? parsed?.edges ?? []) {
      if (typeof e?.src === 'string' && typeof e?.dst === 'string' && typeof e?.label === 'string' && validPairs.has(`${e.src}\u0000${e.dst}`)) {
        ovAnn.edges[`${e.src}\u0000${e.dst}`] = e.label.slice(0, 40);
      }
    }

    // --- context ---
    const ctxParsed = parsed?.context ?? {};
    const ctxAnn: ContextAnnotations = {};
    if (ctxParsed?.app && typeof ctxParsed.app.label === 'string') {
      ctxAnn.app = { label: ctxParsed.app.label.slice(0, 60), description: typeof ctxParsed.app.description === 'string' ? ctxParsed.app.description.slice(0, 120) : undefined };
    }
    if (Array.isArray(ctxParsed?.systems)) {
      ctxAnn.systems = {};
      for (const s of ctxParsed.systems) if (typeof s?.name === 'string' && typeof s?.label === 'string') ctxAnn.systems[s.name] = s.label.slice(0, 60);
    }
    if (Array.isArray(ctxParsed?.actors)) {
      ctxAnn.actors = {};
      for (const a of ctxParsed.actors) if (typeof a?.id === 'string' && typeof a?.label === 'string') ctxAnn.actors[a.id] = a.label.slice(0, 60);
    }
    if (Array.isArray(ctxParsed?.libraries)) {
      ctxAnn.libraries = {};
      for (const l of ctxParsed.libraries) if (typeof l?.name === 'string' && typeof l?.role === 'string') ctxAnn.libraries[l.name] = l.role.slice(0, 60);
    }

    // --- story ---
    const storyParsed = parsed?.story ?? parsed;
    const raw: any[] = Array.isArray(storyParsed?.segments) ? storyParsed.segments : [];
    const markerRe = /\{\{(file|component|system|actor):([^}]+)\}\}/g;
    const segments: StorySegment[] = [];
    for (const s of raw) {
      if (typeof s?.text !== 'string') continue;
      // if already has ref field and valid, keep it
      if (typeof s.ref === 'string' && /^(file|component|system|actor):/.test(s.ref)) {
        const kind = s.ref.split(':')[0] as 'file'|'component'|'system'|'actor';
        const val = s.ref.slice(kind.length + 1);
        const ok = kind === 'file' ? allowed.files.has(val) : kind === 'component' ? allowed.components.has(val) : kind === 'system' ? allowed.systems.has(val) : allowed.actors.has(val);
        if (ok) { segments.push({ text: s.text, ref: s.ref }); continue; }
      }
      // parse markers inside text
      let last = 0;
      let m: RegExpExecArray | null;
      markerRe.lastIndex = 0;
      while ((m = markerRe.exec(s.text)) !== null) {
        if (m.index > last) segments.push({ text: s.text.slice(last, m.index) });
        const kind = m[1] as 'file'|'component'|'system'|'actor';
        const val = m[2];
        const ok = kind === 'file' ? allowed.files.has(val) : kind === 'component' ? allowed.components.has(val) : kind === 'system' ? allowed.systems.has(val) : allowed.actors.has(val);
        if (ok) segments.push({ text: val, ref: `${kind}:${val}` });
        else segments.push({ text: m[0] });
        last = m.index + m[0].length;
      }
      if (last < s.text.length) segments.push({ text: s.text.slice(last) });
      if (last === 0 && segments.length === 0) segments.push({ text: s.text });
    }

    return { overview: ovAnn, context: ctxAnn, story: segments.length > 0 ? segments : [] };
  } finally {
    clearTimeout(timer);
  }
}
