import { promises as fs, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { walkDir } from './walk.js';
import { parseArgs } from './cli.js';
import { GraphStore } from './index/store.js';
import { indexRepo } from './index/tsIndexer.js';
import { buildOverview, type OverviewData } from './index/overview.js';
import { buildContext, type ContextData } from './index/context.js';
import { buildBrief } from './index/brief.js';
import { buildStory, type StoryData } from './index/narrative.js';
import { annotateAll } from './index/ai.js';
import { loadManifests } from './index/manifests.js';
import { indexPython } from './index/pyEngine.js';
import { indexGo } from './index/goEngine.js';
import { indexTreeSitter, getTreeSitterLang } from './index/treeSitterEngine.js';
import { traceCallChain, findEntryPoints } from './index/trace.js';
import type { TreeNode } from './types.js';

// minimal .env loader (no dependency): fills process.env without overriding existing
function loadDotEnv() {
  try {
    const raw = readFileSync('.env', 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    /* no .env - fine */
  }
}

function flatten(tree: TreeNode, out: string[] = []): string[] {
  for (const c of tree.children ?? []) {
    if (c.type === 'file') out.push(c.path);
    else flatten(c, out);
  }
  return out;
}

const store = new GraphStore();

async function fingerprint(target: string): Promise<string> {
  const tree = await walkDir(target);
  const files = flatten(tree);
  const parts: string[] = [];
  for (const rel of files) {
    try {
      const st = await fs.stat(path.join(target, rel));
      parts.push(`${rel}:${st.mtimeMs}:${st.size}`);
    } catch {
      parts.push(`${rel}:gone`);
    }
  }
  return parts.join('|');
}

let indexedFingerprint = '';

const parsed = parseArgs(process.argv.slice(2));
const { target, open } = parsed;
let port = parsed.port;

async function validateTarget() {
  try {
    const st = await fs.stat(target);
    if (!st.isDirectory()) throw new Error('not a directory');
  } catch {
    console.error(`archi: "${target}" is not a readable folder.`);
    process.exit(1);
  }
}

async function main() {
  loadDotEnv();
  await validateTarget();

  const app = Fastify({ logger: false });
  const rootName = path.basename(target);

  // ---- AI key management (env > ~/.archi/config.json) ----
  const configPath = path.join(os.homedir(), '.archi', 'config.json');
  let aiKey: string | undefined = process.env.ARCHI_AI_KEY;

  function loadKeyFromConfig() {
    if (aiKey) return;
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
      if (typeof cfg.ARCHI_AI_KEY === 'string' && cfg.ARCHI_AI_KEY) aiKey = cfg.ARCHI_AI_KEY;
    } catch {
      /* no config - fine */
    }
  }
  loadKeyFromConfig();
  const getApiKey = () => aiKey;

  function persistKey(key: string | null) {
    aiKey = key ?? undefined;
    try {
      if (key) {
        mkdirSync(path.dirname(configPath), { recursive: true });
        writeFileSync(configPath, JSON.stringify({ ARCHI_AI_KEY: key }, null, 2), 'utf8');
      } else {
        rmSync(configPath, { force: true });
      }
    } catch (e) {
      console.warn('  config: could not persist key -', String(e));
    }
  }

  app.get('/api/ai/status', async () => ({ hasKey: Boolean(getApiKey()) }));

  app.post('/api/ai/key', async (req, reply) => {
    const key = String((req.body as any)?.key ?? '').trim();
    if (!key) return reply.code(400).send({ error: 'missing key' });
    persistKey(key);
    if (overview) overview.ai = { pending: true, applied: false };
    if (contextData) contextData.ai = { pending: true, applied: false };
    if (storyData) storyData.ai = { pending: true, applied: false };
    if (overview && contextData && storyData) {
      aiPromise = runAiAll().then(() => { aiPromise = null; });
    }
    return { ok: true };
  });

  app.delete('/api/ai/key', async () => {
    persistKey(null);
    return { ok: true };
  });

  app.get('/api/repo', async () => ({ name: rootName, root: target }));

  app.get('/api/tree', async () => {
    const tree = await walkDir(target);
    return tree;
  });

  // ---- AI: single merged call for overview + context + story (1 credit per indexing) ----
  let overview: OverviewData | null = null;
  let lastAnnotations: import('./index/overview.js').OverviewAnnotations | undefined;
  let contextData: ContextData | null = null;
  let lastContextAnnotations: import('./index/context.js').ContextAnnotations | undefined;
  let storyData: StoryData | null = null;
  let aiPromise: Promise<void> | null = null;

  function aiErrorMessage(e: unknown): string {
    const s = String(e);
    if (s.includes('API_KEY_INVALID') || s.includes('API key') || s.includes('PERMISSION_DENIED')) return 'Invalid API key';
    if (s.includes('NOT_FOUND') || s.includes('model not found') || s.includes('404')) return 'Model not found';
    if (s.includes('RESOURCE_EXHAUSTED') || s.includes('429') || s.includes('quota')) return 'Rate limited / quota exceeded';
    if (s.includes('AbortError') || s.includes('aborted')) return 'Request timed out';
    if (s.includes('empty annotations')) return 'AI returned empty annotations';
    if (s.length > 120) return s.slice(0, 120);
    return s;
  }

  async function runAiAll(attempt = 0) {
    const apiKey = getApiKey();
    if (!apiKey || !overview || !contextData || !storyData) return;
    const model = process.env.ARCHI_AI_MODEL || 'gemini-flash-lite-latest';
    try {
      const allowed = {
        files: new Set([...store.nodes.values()].filter((n) => n.type === 'file').map((n) => n.id)),
        components: new Set(storyData.skeleton.components.map((c) => c.id)),
        systems: new Set(storyData.skeleton.systems.map((s) => s.name)),
        actors: new Set(['cli', 'http', 'webhook', 'cron']),
      };
      const result = await annotateAll(overview, contextData, storyData.skeleton, allowed, apiKey, model);
      if (!result) throw new Error('AI returned empty result');
      const hasOv = Object.values(result.overview.components).some(v => v.label || v.description);
      if (!hasOv) throw new Error('AI returned empty annotations');
      // apply all three
      lastAnnotations = result.overview;
      if (overview) { overview.annotations = result.overview; overview.ai = { pending: false, applied: true }; }
      lastContextAnnotations = result.context;
      if (contextData) { contextData.annotations = result.context; contextData.ai = { pending: false, applied: true }; }
      if (storyData && result.story.length > 0) { storyData.segments = result.story; storyData.ai = { pending: false, applied: true }; }
      else if (storyData) { storyData.ai = { pending: false, applied: false }; }
      console.log('  AI: all annotations applied (1 call)');
    } catch (e) {
      if (attempt < 1) {
        console.warn('  AI: pass failed, retrying once in 8s -', String(e));
        await new Promise(r => setTimeout(r, 8000));
        return runAiAll(attempt + 1);
      }
      if (overview) {
        const hasOv = Boolean(lastAnnotations && Object.values(lastAnnotations.components).some(v => v.label || v.description));
        if (hasOv) overview.annotations = lastAnnotations;
        overview.ai = { pending: false, applied: hasOv, error: hasOv ? undefined : aiErrorMessage(e) };
      }
      if (contextData) {
        if (lastContextAnnotations) contextData.annotations = lastContextAnnotations;
        const hasCtx = Boolean(lastContextAnnotations);
        contextData.ai = { pending: false, applied: hasCtx, error: hasCtx ? undefined : aiErrorMessage(e) };
      }
      if (storyData) storyData.ai = { pending: false, applied: false, error: aiErrorMessage(e) };
      console.warn('  AI: annotation failed, using cached/plain labels -', String(e));
    }
  }

  function rebuildOverview() {
    overview = buildOverview(store);
    const hasOv = Boolean(lastAnnotations && Object.values(lastAnnotations.components).some(v => v.label || v.description));
    if (hasOv) overview.annotations = lastAnnotations;
    const hasKey = Boolean(getApiKey());
    overview.ai = { pending: hasKey && !hasOv, applied: hasOv };
  }

  function rebuildContext() {
    contextData = buildContext(store, rootName, target);
    if (lastContextAnnotations) contextData.annotations = lastContextAnnotations;
    const hasKey = Boolean(getApiKey());
    const hasCtx = Boolean(lastContextAnnotations);
    contextData.ai = { pending: hasKey && !hasCtx, applied: hasCtx };
  }

  function rebuildStory() {
    storyData = buildStory(store, rootName, target, overview, contextData);
    const hasKey = Boolean(getApiKey());
    storyData.ai = { pending: hasKey, applied: false };
  }

  async function waitForAi() {
    if (aiPromise) await aiPromise;
  }

  function reindex() {
    return walkDir(target).then(async (tree) => {
      const files = flatten(tree);
      indexRepo(target, files, store);
      loadManifests(target, files, store);
      const pyFiles = files.filter((f) => f.endsWith('.py'));
      if (pyFiles.length > 0) {
        try {
          const py = await indexPython(target, pyFiles, store);
          console.log(`  python: ${JSON.stringify(py)}`);
        } catch (e) {
          console.warn(`  python engine skipped - ${String(e)}`);
        }
      }
      const goFiles = files.filter((f) => f.endsWith('.go'));
      if (goFiles.length > 0) {
        try {
          const go = await indexGo(target, goFiles, store);
          console.log(`  go: ${JSON.stringify(go)}`);
        } catch (e) {
          console.warn(`  go engine skipped - ${String(e)}`);
        }
      }
      // tree-sitter: index remaining languages not covered by TS/Python/Go LSPs
      const treeSitterLangs = new Set<string>();
      const treeSitterFiles = files.filter((f) => {
        const lang = getTreeSitterLang(f);
        if (!lang) return false;
        // skip languages already handled by dedicated LSP engines
        if (lang === 'python' || lang === 'go' || lang === 'typescript' || lang === 'javascript') return false;
        treeSitterLangs.add(lang);
        return true;
      });
      if (treeSitterFiles.length > 0) {
        try {
          const ts = await indexTreeSitter(target, treeSitterFiles, store);
          console.log(`  tree-sitter[${[...treeSitterLangs].join(',')}]: ${JSON.stringify(ts)}`);
        } catch (e) {
          console.warn(`  tree-sitter engine skipped - ${String(e)}`);
        }
      }
      indexedFingerprint = await fingerprint(target);
      rebuildOverview();
      rebuildContext();
      rebuildStory();
      if (getApiKey() && overview && contextData && storyData) {
        const needsAi = overview.ai.pending || contextData.ai.pending || storyData.ai.pending;
        if (needsAi) aiPromise = runAiAll().then(() => { aiPromise = null; });
      }
      console.log(`  indexed: ${JSON.stringify(store.stats())}`);
    });
  }

  await reindex();

  app.get('/api/index/status', async () => ({ ready: true, ...store.stats() }));

  // ---- L2: component overview ----
  app.get('/api/overview', async () => {
    return overview ?? { components: [], edges: [], allFolders: [], ai: { pending: false, applied: false } };
  });

  // ---- L1: system context ----
  app.get('/api/context', async () => {
    return contextData ?? { name: rootName, stats: store.stats(), internals: [], externals: [], ai: { pending: false, applied: false } };
  });

  // ---- L0: repository brief ----
  app.get('/api/brief', async () => {
    return buildBrief(store, rootName, target, overview, contextData);
  });

  // ---- How it works narrative ----
  app.get('/api/story', async () => {
    return storyData ?? { segments: [], skeleton: {}, ai: { pending: false, applied: false } };
  });

  app.get('/api/index/fresh', async () => {
    try {
      const current = await fingerprint(target);
      return { fresh: current === indexedFingerprint };
    } catch {
      return { fresh: false };
    }
  });

  app.post('/api/index/refresh', async (_req, reply) => {
    try {
      await reindex();
      return { ok: true, ...store.stats() };
    } catch (e) {
      return reply.code(500).send({ error: String(e) });
    }
  });

  app.get('/api/symbols', async (req) => {
    const file = String((req.query as any).file ?? '');
    return { symbols: store.getSymbolsInFile(file) };
  });

  app.get('/api/symbol', async (req) => {
    const id = String((req.query as any).id ?? '');
    const sym = store.getSymbol(id);
    if (!sym) return { error: 'not found' };
    const nameOf = (edgeId: string) => store.getSymbol(edgeId)?.name ?? edgeId;
    const loc = (edgeId: string) => {
      const s = store.getSymbol(edgeId);
      return s ? `${s.fileId}:${s.startLine}` : '';
    };
    return {
      symbol: sym,
      callers: store
        .getCallers(sym.id)
        .filter((e) => e.type === 'calls')
        .map((e) => ({ id: e.src, name: nameOf(e.src), location: loc(e.src) })),
      callees: store
        .getCallees(sym.id)
        .filter((e) => e.type === 'calls')
        .map((e) => ({ id: e.dst, name: nameOf(e.dst), location: loc(e.dst) })),
    };
  });

  // ---- L3: file dependency view ----
  app.get('/api/deps', async (req) => {
    const file = String((req.query as any).file ?? '');
    const base = (id: string) => id.split('/').pop() ?? id;
    const dependencies = store
      .getCallees(file)
      .filter((e) => e.type === 'imports')
      .map((e) => ({ id: e.dst, name: base(e.dst) }));
    const dependents = store
      .getCallers(file)
      .filter((e) => e.type === 'imports')
      .map((e) => ({ id: e.src, name: base(e.src) }));
    return { file, dependencies, dependents };
  });

  // ---- L2.5: folder-scoped file dependency graph ----
  app.get('/api/folderdeps', async (req) => {
    const dir = String((req.query as any).dir ?? '').replace(/\/+$/, '');
    const base = (id: string) => id.split('/').pop() ?? id;
    const inDir = (f: string) =>
      dir === '' || f === dir || f.startsWith(dir + '/');

    const internal = [...store.nodes.values()]
      .filter((n) => n.type === 'file' && inDir(n.id))
      .map((n) => ({ id: n.id, name: base(n.id), comp: n.id.includes('/') ? n.id.split('/')[0] : '(root)' }));
    const internalIds = new Set(internal.map((f) => f.id));

    const nodeMap = new Map<string, { id: string; name: string; comp: string }>();
    for (const f of internal) nodeMap.set(f.id, f);

    const edgeMap = new Map<string, { src: string; dst: string; count: number; callsOnly: boolean }>();
    const hasImport = new Set<string>();
    const pairKey = (a: string, b: string) => `${a}\u0000${b}`;
    const compOf = (f: string) => (f.includes('/') ? f.split('/')[0] : '(root)');

    const link = (srcFile: string, dstFile: string, viaCall: boolean) => {
      if (srcFile === dstFile) return;
      if (!internalIds.has(srcFile) && !internalIds.has(dstFile)) return;
      if (!viaCall) hasImport.add(pairKey(srcFile, dstFile));
      let e = edgeMap.get(pairKey(srcFile, dstFile));
      if (!e) {
        e = { src: srcFile, dst: dstFile, count: 0, callsOnly: true };
        edgeMap.set(pairKey(srcFile, dstFile), e);
      }
      e.count++;
    };

    for (const edge of store.edges) {
      if (edge.type === 'imports') {
        link(edge.src, edge.dst, false);
      } else if (edge.type === 'calls') {
        const sf = edge.src.slice(0, edge.src.indexOf(':'));
        const df = edge.dst.slice(0, edge.dst.indexOf(':'));
        link(sf, df, true);
      }
    }

    // ensure external endpoint nodes exist
    for (const e of edgeMap.values()) {
      for (const f of [e.src, e.dst]) {
        if (!nodeMap.has(f)) nodeMap.set(f, { id: f, name: base(f), comp: compOf(f) });
      }
    }
    for (const e of edgeMap.values()) {
      e.callsOnly = !hasImport.has(pairKey(e.src, e.dst));
    }

    return {
      dir,
      files: [...nodeMap.values()],
      edges: [...edgeMap.values()],
    };
  });

  app.get('/api/search', async (req) => {
    const q = String((req.query as any).q ?? '');
    if (!q.trim()) return { results: [] };
    return { results: store.search(q, overview, contextData) };
  });

  // ---- L4: execution flow trace ----
  app.get('/api/trace', async (req, reply) => {
    const id = String((req.query as any).id ?? '');
    if (!id || !id.includes(':')) {
      return reply.code(400).send({ error: 'invalid symbol id' });
    }
    const result = traceCallChain(store, id);
    if (!result) {
      return reply.code(404).send({ error: 'symbol not found' });
    }
    return result;
  });

  app.get('/api/entrypoints', async () => {
    return { entryPoints: findEntryPoints(store) };
  });

  app.get('/api/file', async (req, reply) => {
    const rel = String((req.query as any).path ?? '');
    if (!rel || rel.includes('..') || path.isAbsolute(rel)) {
      return reply.code(400).send({ error: 'invalid path' });
    }
    const abs = path.join(target, rel);
    try {
      const st = await fs.stat(abs);
      if (!st.isFile() || st.size > 2_000_000) {
        return reply.code(400).send({ error: 'not a readable file' });
      }
      const content = await fs.readFile(abs, 'utf8');
      return { path: rel, content };
    } catch {
      return reply.code(404).send({ error: 'not found' });
    }
  });

  // resolve the bundled frontend relative to this file (works from any cwd / global install)
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDist = path.join(here, 'web');
  try {
    await fs.access(webDist);
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((_req, reply) => reply.sendFile('index.html'));
  } catch {
    app.get('/', async (_req, reply) => {
      reply.type('text/html; charset=utf-8').send(
        '<body style="background:#10141b;color:#e8ebf1;font-family:monospace;padding:40px">Frontend assets missing in this install. Reinstall archi, or run <code>npm run build</code> in the repo and use <code>npm start</code>.</body>'
      );
    });
  }

  // ---- listen: auto-fallback if the port is taken (Vite-style) ----
  const MAX_PORT_TRIES = 10;
  let bound = 0;
  for (let attempt = 0; attempt < MAX_PORT_TRIES; attempt++) {
    const candidate = port + attempt;
    try {
      await app.listen({ port: candidate, host: '127.0.0.1' });
      bound = candidate;
      break;
    } catch (e: any) {
      if (e?.code !== 'EADDRINUSE') throw e;
      if (attempt === 0) {
        console.log(`  port ${candidate} is busy, trying ${candidate + 1}…`);
      }
    }
  }
  if (!bound) {
    console.error(`  archi: ports ${port}–${port + MAX_PORT_TRIES - 1} are all busy. Pass --port <n>.`);
    process.exit(1);
  }
  port = bound;

  const url = `http://127.0.0.1:${port}`;
  console.log(`\n  Archi - indexing ${rootName}`);
  console.log(`  ${url}\n`);
  if (open) {
    const { exec } = await import('node:child_process');
    const cmd =
      process.platform === 'win32' ? `start "" "${url}"` :
      process.platform === 'darwin' ? 'open "$url"' :
      'xdg-open "$url"';
    exec(cmd, () => {});
  }
}

main();
