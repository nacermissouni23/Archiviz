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
import { buildOverview, annotateOverview, type OverviewData } from './index/overview.js';
import { buildContext, annotateContext, type ContextData } from './index/context.js';
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
    /* no .env — fine */
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
      /* no config — fine */
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
      console.warn('  config: could not persist key —', String(e));
    }
  }

  app.get('/api/ai/status', async () => ({ hasKey: Boolean(getApiKey()) }));

  app.post('/api/ai/key', async (req, reply) => {
    const key = String((req.body as any)?.key ?? '').trim();
    if (!key) return reply.code(400).send({ error: 'missing key' });
    persistKey(key);
    // re-trigger AI passes on the current index
    if (overview) {
      overview.ai = { pending: true, applied: false };
      aiPromise = runAiAnnotation().then(() => { aiPromise = null; });
    }
    if (contextData) {
      contextData.ai = { pending: true, applied: false };
      ctxAiPromise = runContextAnnotation().then(() => { ctxAiPromise = null; });
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

  // ---- L5: symbol index ----
  let overview: OverviewData | null = null;
  let lastAnnotations: import('./index/overview.js').OverviewAnnotations | undefined;
  let aiPromise: Promise<void> | null = null;

  async function runAiAnnotation(attempt = 0) {
    const apiKey = getApiKey();
    if (!apiKey || !overview) return;
    const model = process.env.ARCHI_AI_MODEL || 'gemini-flash-lite-latest';
    try {
      const annotations = await annotateOverview(overview, apiKey, model);
      if (overview && annotations) {
        lastAnnotations = annotations;
        overview.annotations = annotations;
        overview.ai = { pending: false, applied: true };
        console.log('  overview: AI annotations applied');
      }
    } catch (e) {
      if (attempt < 1) {
        console.warn('  overview: AI pass failed, retrying once in 8s —', String(e));
        await new Promise(r => setTimeout(r, 8000));
        return runAiAnnotation(attempt + 1);
      }
      if (overview) {
        overview.annotations = lastAnnotations;
        overview.ai = { pending: false, applied: Boolean(overview.annotations) };
      }
      console.warn('  overview: AI annotation failed, using cached/plain labels —', String(e));
    }
  }

  function rebuildOverview() {
    overview = buildOverview(store);
    if (lastAnnotations) overview.annotations = lastAnnotations;
    const hasKey = Boolean(getApiKey());
    overview.ai = { pending: hasKey && !lastAnnotations, applied: Boolean(lastAnnotations) };
    aiPromise = runAiAnnotation().then(() => { aiPromise = null; });
  }

  async function waitForAi() {
    if (aiPromise) await aiPromise;
  }

  // ---- L1: system context ----
  let contextData: ContextData | null = null;
  let lastContextAnnotations: import('./index/context.js').ContextAnnotations | undefined;
  let ctxAiPromise: Promise<void> | null = null;

  async function runContextAnnotation(attempt = 0) {
    const apiKey = getApiKey();
    if (!apiKey || !contextData) return;
    const model = process.env.ARCHI_AI_MODEL || 'gemini-flash-lite-latest';
    try {
      const annotations = await annotateContext(contextData, apiKey, model);
      if (contextData && annotations) {
        lastContextAnnotations = annotations;
        contextData.annotations = annotations;
        contextData.ai = { pending: false, applied: true };
        console.log('  context: AI annotations applied');
      }
    } catch (e) {
      if (attempt < 1) {
        console.warn('  context: AI pass failed, retrying once in 8s —', String(e));
        await new Promise((r) => setTimeout(r, 8000));
        return runContextAnnotation(attempt + 1);
      }
      if (contextData) {
        contextData.annotations = lastContextAnnotations;
        contextData.ai = { pending: false, applied: Boolean(lastContextAnnotations) };
      }
      console.warn('  context: AI annotation failed, using plain labels —', String(e));
    }
  }

  function rebuildContext() {
    contextData = buildContext(store, rootName, target);
    if (lastContextAnnotations) contextData.annotations = lastContextAnnotations;
    const hasKey = Boolean(getApiKey());
    contextData.ai = { pending: hasKey && !lastContextAnnotations, applied: Boolean(lastContextAnnotations) };
    ctxAiPromise = runContextAnnotation().then(() => { ctxAiPromise = null; });
  }

  function reindex() {
    return walkDir(target).then(async (tree) => {
      indexRepo(target, flatten(tree), store);
      indexedFingerprint = await fingerprint(target);
      rebuildOverview();
      rebuildContext();
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
    return { results: store.searchSymbols(q) };
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
        '<body style="background:#10141b;color:#e8ebf1;font-family:monospace;padding:40px">Frontend assets missing in this install — reinstall archi, or run <code>npm run build</code> in the repo and use <code>npm start</code>.</body>'
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
  console.log(`\n  Archi — indexing ${rootName}`);
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
