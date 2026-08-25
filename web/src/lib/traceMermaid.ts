export interface TraceStep {
  seq: number;
  from: { id: string; name: string; fileId: string; line: number };
  to: { id: string; name: string; fileId: string; line: number };
  callLabel: string;
}

export interface TraceResponse {
  entry: { id: string; name: string; fileId: string; startLine: number; kind: string };
  steps: TraceStep[];
}

function esc(s: string): string {
  return s.replace(/"/g, '#quot;').replace(/[\r\n]+/g, ' ');
}

export function traceToMermaid(data: TraceResponse): string {
  const lines: string[] = ['sequenceDiagram'];

  // distinct files in order of appearance
  const fileOrder: string[] = [];
  const seen = new Set<string>();
  const addFile = (f: string) => {
    if (!seen.has(f)) {
      seen.add(f);
      fileOrder.push(f);
    }
  };
  addFile(data.entry.fileId);
  for (const s of data.steps) {
    addFile(s.from.fileId);
    addFile(s.to.fileId);
  }

  // participant id = p<index>; label = basename, disambiguated by parent folder on collision
  const nameCount = new Map<string, number>();
  for (const f of fileOrder) {
    const base = f.split('/').pop() ?? f;
    nameCount.set(base, (nameCount.get(base) ?? 0) + 1);
  }
  const usedLabels = new Map<string, string>(); // fileId -> final label
  for (const f of fileOrder) {
    const base = f.split('/').pop() ?? f;
    let label = base;
    if ((nameCount.get(base) ?? 0) > 1) {
      const parts = f.split('/');
      const parent = parts.length > 1 ? parts[parts.length - 2] : '(root)';
      label = `${parent}/${base}`;
    }
    usedLabels.set(f, label);
  }

  const pidOf = (fileId: string): string => `p${fileOrder.indexOf(fileId)}`;

  // declare participants
  fileOrder.forEach((f, i) => {
    lines.push(`  participant p${i} as ${esc(usedLabels.get(f) ?? f)}`);
  });

  // entry note
  lines.push(`  Note over ${pidOf(data.entry.fileId)}: ${esc(data.entry.name)}()`);

  // steps
  for (const step of data.steps) {
    lines.push(
      `  ${pidOf(step.from.fileId)}->>${pidOf(step.to.fileId)}: ${esc(step.callLabel)}`
    );
  }

  return lines.join('\n');
}
