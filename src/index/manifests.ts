import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GraphStore } from './store.js';

export type ManifestDeps = Map<string, Set<string>>; // pkg -> manifest files declaring it

function readText(root: string, rel: string): string | null {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return null;
  }
}

function add(deps: ManifestDeps, name: string, source: string) {
  const clean = name.trim();
  if (!clean || clean.length < 2 || clean.length > 120) return;
  if (/^[\d._-]+$/.test(clean)) return;
  let set = deps.get(clean);
  if (!set) {
    set = new Set();
    deps.set(clean, set);
  }
  set.add(source);
}

// ---------- per-format parsers ----------

function parsePackageJson(root: string, rel: string, deps: ManifestDeps) {
  const text = readText(root, rel);
  if (!text) return;
  try {
    const pkg = JSON.parse(text);
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const obj = pkg[section];
      if (!obj || typeof obj !== 'object') continue;
      for (const name of Object.keys(obj)) {
        if (name.startsWith('@types/')) continue;
        add(deps, name, rel);
      }
    }
  } catch {
    /* invalid json */
  }
}

function parseRequirementsTxt(root: string, rel: string, deps: ManifestDeps) {
  const text = readText(root, rel);
  if (!text) return;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    // name[extra1,extra2]>=1.0,<2.0 → name
    const m = line.match(/^([A-Za-z0-9._-]+)/);
    if (m) add(deps, m[1], rel);
  }
}

function parsePyprojectToml(root: string, rel: string, deps: ManifestDeps) {
  const text = readText(root, rel);
  if (!text) return;
  // [project] dependencies = [ "flask>=3", ... ]
  const projArr = text.match(/dependencies\s*=\s*\[([^\]]*)\]/s);
  if (projArr) {
    for (const m of projArr[1].matchAll(/["']([A-Za-z0-9._-]+)[^"']*[\"']/g)) {
      add(deps, m[1], rel);
    }
  }
  // [tool.poetry.dependencies] section: name = "^1.0"
  const section = text.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?:\n\[|$)/);
  if (section) {
    for (const line of section[1].split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z0-9._-]+)\s*=/);
      if (m && m[1] !== 'python') add(deps, m[1], rel);
    }
  }
}

function parseGoMod(root: string, rel: string, deps: ManifestDeps) {
  const text = readText(root, rel);
  if (!text) return;
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('require (')) {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ')') {
      inBlock = false;
      continue;
    }
    const m = (inBlock ? line : line.replace(/^require\s+/, '')).match(/^(\S+)\s+v[\w.-]/);
    if (m) {
      const mod = m[1];
      // skip stdlib-style modules (no dot in first segment)
      const first = mod.split('/')[0];
      if (!first.includes('.')) continue;
      add(deps, mod, rel);
    }
  }
}

function parsePomXml(root: string, rel: string, deps: ManifestDeps) {
  const text = readText(root, rel);
  if (!text) return;
  for (const m of text.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)) {
    add(deps, m[1], rel);
  }
}

function parseGradle(root: string, rel: string, deps: ManifestDeps) {
  const text = readText(root, rel);
  if (!text) return;
  for (const m of text.matchAll(/["']([^"']+):([^"']+):[^"']+["']/g)) {
    add(deps, m[2], rel);
  }
}

function parseCargoToml(root: string, rel: string, deps: ManifestDeps) {
  const text = readText(root, rel);
  if (!text) return;
  const section = text.match(/\[dependencies\]([\s\S]*?)(?:\n\[|$)/);
  if (!section) return;
  for (const line of section[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9._-]+)\s*=/);
    if (m) add(deps, m[1], rel);
  }
}

function parseComposerJson(root: string, rel: string, deps: ManifestDeps) {
  const text = readText(root, rel);
  if (!text) return;
  try {
    const pkg = JSON.parse(text);
    for (const section of ['require', 'require-dev']) {
      const obj = pkg[section];
      if (!obj || typeof obj !== 'object') continue;
      for (const name of Object.keys(obj)) {
        if (name.startsWith('ext-') || name === 'php') continue;
        add(deps, name, rel);
      }
    }
  } catch {
    /* invalid json */
  }
}

function parseGemfile(root: string, rel: string, deps: ManifestDeps) {
  const text = readText(root, rel);
  if (!text) return;
  for (const m of text.matchAll(/gem\s+["']([^"']+)["']/g)) {
    add(deps, m[1], rel);
  }
}

function parseCsproj(root: string, rel: string, deps: ManifestDeps) {
  const text = readText(root, rel);
  if (!text) return;
  for (const m of text.matchAll(/<PackageReference\s+Include="([^"]+)"/g)) {
    add(deps, m[1], rel);
  }
}

// ---------- entry point ----------

const MANIFEST_PARSERS: [string, (root: string, rel: string, deps: ManifestDeps) => void][] = [
  ['package.json', parsePackageJson],
  ['requirements.txt', parseRequirementsTxt],
  ['pyproject.toml', parsePyprojectToml],
  ['go.mod', parseGoMod],
  ['pom.xml', parsePomXml],
  ['Cargo.toml', parseCargoToml],
  ['composer.json', parseComposerJson],
  ['Gemfile', parseGemfile],
];

export function loadManifests(root: string, files: string[], store: GraphStore): void {
  const deps: ManifestDeps = new Map();

  const fileSet = new Set(files);
  for (const [name, parser] of MANIFEST_PARSERS) {
    if (fileSet.has(name)) parser(root, name, deps);
  }
  // gradle + csproj can be anywhere/named arbitrarily
  for (const f of files) {
    if (f.endsWith('.gradle') || f.endsWith('.gradle.kts')) parseGradle(root, f, deps);
    else if (f.endsWith('.csproj')) parseCsproj(root, f, deps);
  }

  for (const [name, sources] of deps) {
    store.addManifestDep(name, [...sources].join(', '));
  }
}
