export interface OverviewComponent {
  id: string;
  name: string;
  fileCount: number;
  symbolCount: number;
  topSymbols?: string[];
}

export interface OverviewEdge {
  src: string;
  dst: string;
  count: number;
  callsOnly: boolean;
}

export interface OverviewAnnotations {
  components: Record<string, { label?: string; description?: string }>;
  edges: Record<string, string>;
}

export interface OverviewResponse {
  components: OverviewComponent[];
  edges: OverviewEdge[];
  ai: { pending: boolean; applied: boolean; error?: string };
  annotations?: OverviewAnnotations;
}

function esc(s: string): string {
  return s.replace(/"/g, '#quot;').replace(/[\r\n]+/g, ' ');
}

/** label used in the rendered node text (must round-trip for click matching).
 * Always keeps the original folder name, appends the AI explanation after ':'. */
export function componentLabel(c: OverviewComponent, ann?: OverviewAnnotations): string {
  let a = ann?.components[c.id];
  if (!a && ann?.components) {
    const lower = c.id.toLowerCase();
    for (const [k, v] of Object.entries(ann.components)) {
      if (k.toLowerCase() === lower || k.toLowerCase().endsWith('/' + lower) || lower.endsWith('/' + k.toLowerCase())) { a = v; break; }
    }
  }
  const raw = a?.description ?? a?.label;
  if (raw) return `${c.name}: ${raw}`;
  return `${c.name} · ${c.fileCount} files, ${c.symbolCount} symbols`;
}

export function overviewToMermaid(data: OverviewResponse): {
  code: string;
  labelToId: Map<string, string>;
} {
  const lines: string[] = ['flowchart LR'];
  lines.push(`  classDef hub fill:#5b9dd933,stroke:#5b9dd9,color:#e8ebf1,stroke-width:2px`);
  lines.push(`  classDef normal fill:#6f9bd11a,stroke:#6f9bd1,color:#aab3c2`);

  const labelToId = new Map<string, string>();
  for (const c of data.components) {
    const label = componentLabel(c, data.annotations);
    labelToId.set(label, c.id);
    lines.push(`  ${idOf(c.id)}(["${esc(label)}"])`);
  }

  // hubs = top components by total traffic
  const traffic = new Map<string, number>();
  for (const e of data.edges) {
    traffic.set(e.src, (traffic.get(e.src) ?? 0) + e.count);
    traffic.set(e.dst, (traffic.get(e.dst) ?? 0) + e.count);
  }
  const hubs = new Set(
    [...traffic.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(1, Math.ceil(data.components.length / 4)))
      .map(([id]) => id)
  );

  lines.push('');
  for (const e of data.edges.slice(0, 60)) {
    const annLabel =
      data.annotations?.edges[`${e.src}\u0000${e.dst}`] ?? `${e.count} ref${e.count === 1 ? '' : 's'}`;
    lines.push(
      `  ${idOf(e.src)} ${e.callsOnly ? '-.->' : '-->'}|${esc(annLabel)}| ${idOf(e.dst)}`
    );
  }

  lines.push('');
  for (const c of data.components) {
    lines.push(`  ${idOf(c.id)}:::${hubs.has(c.id) ? 'hub' : 'normal'}`);
  }

  return { code: lines.join('\n'), labelToId };
}

function idOf(path: string): string {
  let h = 0;
  for (let i = 0; i < path.length; i++) {
    h = (h * 31 + path.charCodeAt(i)) >>> 0;
  }
  return `c${h.toString(36)}`;
}
