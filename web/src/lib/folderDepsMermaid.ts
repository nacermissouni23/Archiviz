export interface FolderFile {
  id: string;
  name: string;
  comp: string;
}

export interface FolderEdge {
  src: string;
  dst: string;
  count: number;
  callsOnly: boolean;
}

export interface FolderDepsResponse {
  dir: string;
  files: FolderFile[];
  edges: FolderEdge[];
}

/** AI folder annotations from /api/overview, keyed by top-level dir */
export interface CompAnnotations {
  components: Record<string, { label?: string; description?: string }>;
}

function esc(s: string): string {
  return s.replace(/"/g, '#quot;').replace(/[\r\n]+/g, ' ');
}

export function folderTitle(comp: string, ann?: CompAnnotations): string {
  const desc = ann?.components[comp]?.description;
  return desc ? `${comp}: ${desc}` : `${comp} (external)`;
}

/** Title for internal subfolder box: "name/ : description" */
export function subfolderTitle(relPath: string, ann?: CompAnnotations): string {
  let a = ann?.components[relPath];
  if (!a && ann?.components) {
    const lower = relPath.toLowerCase();
    for (const [k, v] of Object.entries(ann.components)) {
      if (k.toLowerCase() === lower || k.toLowerCase().endsWith('/' + lower) || lower.endsWith('/' + k.toLowerCase())) { a = v; break; }
    }
  }
  const name = relPath.split('/').pop() + '/';
  return a?.description ? `${name}: ${a.description}` : a?.label ? `${name}: ${a.label}` : name;
}

export function folderToMermaid(
  data: FolderDepsResponse,
  ann?: CompAnnotations
): {
  code: string;
  fileLabelToId: Map<string, string>;
  boxLabelToDir: Map<string, string>;
} {
  const dir = data.dir;
  const inDir = (id: string) => id === dir || id.startsWith(dir + '/');

  const lines: string[] = ['flowchart LR'];
  lines.push(`  classDef internal fill:#5b9dd933,stroke:#5b9dd9,color:#e8ebf1,stroke-width:2px`);
  lines.push(`  classDef subfolder fill:#d9b06a1a,stroke:#d9b06a,color:#d9b06a`);
  lines.push(`  classDef external fill:#c893d81a,stroke:#c893d8,color:#aab3c2`);

  const fileLabelToId = new Map<string, string>();
  const boxLabelToDir = new Map<string, string>();
  const subBoxes = new Map<string, string>(); // boxId -> drillable dir
  const extBoxes = new Map<string, string>(); // boxId -> top-level comp

  // map a file id to its node: direct file, collapsed subfolder box, or external folder box
  const nodeFor = (fileId: string): string => {
    if (inDir(fileId)) {
      const rel = dir ? fileId.slice(dir.length + 1) : fileId;
      if (!rel.includes('/')) return idOf(fileId);
      const seg = rel.split('/')[0];
      const subDir = dir ? `${dir}/${seg}` : seg;
      const bid = subBoxId(subDir);
      subBoxes.set(bid, subDir);
      return bid;
    }
    const comp = fileId.includes('/') ? fileId.split('/')[0] : '(root)';
    const bid = compBoxId(comp);
    extBoxes.set(bid, comp);
    return bid;
  };

  // direct child files of dir → individual nodes
  for (const f of data.files) {
    if (!inDir(f.id)) continue;
    const rel = dir ? f.id.slice(dir.length + 1) : f.id;
    if (rel.includes('/')) continue;
    const l = esc(f.name);
    fileLabelToId.set(l, f.id);
  }

  // edges first (they populate box sets via nodeFor)
  const agg = new Map<string, { src: string; dst: string; count: number; callsOnly: boolean }>();
  for (const e of data.edges) {
    const src = nodeFor(e.src);
    const dst = nodeFor(e.dst);
    if (src === dst) continue;
    const key = `${src}\u0000${dst}`;
    let a = agg.get(key);
    if (!a) {
      a = { src, dst, count: 0, callsOnly: true };
      agg.set(key, a);
    }
    a.count++;
    if (!e.callsOnly) a.callsOnly = false;
  }

  // declare subfolder boxes (label "name/ : description")
  for (const [bid, subDir] of subBoxes) {
    const label = subfolderTitle(subDir, ann);
    boxLabelToDir.set(label, subDir);
    lines.push(`  ${bid}(["${esc(label)}"])`);
  }

  // declare external folder boxes (label "comp: description")
  for (const [bid, comp] of extBoxes) {
    const title = folderTitle(comp, ann);
    boxLabelToDir.set(title, comp);
    lines.push(`  ${bid}(["${esc(title)}"])`);
  }

  // declare file nodes
  for (const l of fileLabelToId.keys()) {
    lines.push(`  ${idOf(fileLabelToId.get(l)!)}(["${l}"])`);
  }

  lines.push('');
  for (const a of agg.values()) {
    const arrow = a.callsOnly ? '-.->' : '-->';
    const lbl = a.callsOnly ? `|${a.count} call${a.count === 1 ? '' : 's'}|` : '';
    lines.push(`  ${a.src} ${arrow}${lbl} ${a.dst}`);
  }

  lines.push('');
  for (const l of fileLabelToId.keys()) {
    lines.push(`  ${idOf(fileLabelToId.get(l)!)}:::internal`);
  }
  for (const bid of subBoxes.keys()) lines.push(`  ${bid}:::subfolder`);
  for (const bid of extBoxes.keys()) lines.push(`  ${bid}:::external`);

  return { code: lines.join('\n'), fileLabelToId, boxLabelToDir };
}

function subBoxId(dir: string): string {
  return `sb${idOf('sub:' + dir).slice(1)}`;
}

function compBoxId(comp: string): string {
  return `cb${idOf('comp:' + comp).slice(1)}`;
}

function idOf(path: string): string {
  let h = 0;
  for (let i = 0; i < path.length; i++) {
    h = (h * 31 + path.charCodeAt(i)) >>> 0;
  }
  return `f${h.toString(36)}`;
}
