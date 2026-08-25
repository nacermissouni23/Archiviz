import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { TreeNode } from './types.js';

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out',
  '.venv', 'venv', '__pycache__', 'site-packages', '.idea', '.vscode',
  '.next', '.cache', 'coverage',
]);

async function readGitignore(dir: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');
    return raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('!'));
  } catch {
    return [];
  }
}

function matchesIgnore(relPath: string, patterns: string[]): boolean {
  const parts = relPath.split('/');
  for (const p of patterns) {
    const base = p.replace(/\/+$/, '');
    if (!base) continue;
    if (parts.some((seg) => seg === base)) return true;
    if (relPath === base || relPath.startsWith(base + '/')) return true;
  }
  return false;
}

export async function walkDir(root: string): Promise<TreeNode> {
  const gitignores = await readGitignore(root);

  async function walk(absDir: string, relPrefix: string, depth: number): Promise<TreeNode[]> {
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const localIgnores = depth === 0 ? gitignores : [...gitignores, ...(await readGitignore(absDir))];

    const nodes: TreeNode[] = [];
    for (const entry of entries) {
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || matchesIgnore(rel, localIgnores)) continue;
        const children = await walk(path.join(absDir, entry.name), rel, depth + 1);
        if (children.length === 0) continue;
        nodes.push({ name: entry.name, path: rel, type: 'dir', children });
      } else if (entry.isFile()) {
        // show every file in the tree, even ones we can't render (videos, images, ...)
        const ext = path.extname(entry.name).toLowerCase();
        if (matchesIgnore(rel, localIgnores)) continue;
        nodes.push({ name: entry.name, path: rel, type: 'file', ext });
      }
    }

    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return nodes;
  }

  const children = await walk(root, '', 0);
  const rootName = path.basename(path.resolve(root));
  return { name: rootName, path: '', type: 'dir', children };
}
