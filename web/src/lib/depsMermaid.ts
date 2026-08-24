export interface DepFile {
  id: string;
  name: string;
}

export interface DepsResponse {
  file: string;
  dependencies: DepFile[];
  dependents: DepFile[];
}

function esc(s: string): string {
  return s.replace(/"/g, '#quot;');
}

export function depsToMermaid(deps: DepsResponse): string {
  const lines: string[] = ['flowchart LR'];

  const selId = 'nSel';
  const selName = deps.file.split('/').pop() ?? deps.file;
  lines.push(
    `  classDef selected fill:#5b9dd933,stroke:#5b9dd9,color:#e8ebf1,stroke-width:2px`
  );
  lines.push(
    `  classDef dependent fill:#6f9bd11a,stroke:#6f9bd1,color:#aab3c2`
  );
  lines.push(
    `  classDef dependency fill:#c893d81a,stroke:#c893d8,color:#aab3c2`
  );

  const edges: string[] = [];
  deps.dependents.forEach((d) => {
    lines.push(`  ${idOf(d.id)}(["${esc(d.name)}"])`);
    edges.push(`${idOf(d.id)} --> ${selId}`);
  });
  lines.push(`  ${selId}(["${esc(selName)}"])`);
  deps.dependencies.forEach((d) => {
    lines.push(`  ${idOf(d.id)}(["${esc(d.name)}"])`);
    edges.push(`${selId} --> ${idOf(d.id)}`);
  });

  lines.push('');
  for (const e of edges) lines.push(`  ${e}`);

  for (const d of deps.dependents) lines.push(`  ${idOf(d.id)}:::dependent`);
  for (const d of deps.dependencies) lines.push(`  ${idOf(d.id)}:::dependency`);
  lines.push(`  ${selId}:::selected`);

  return lines.join('\n');
}

function idOf(path: string): string {
  let h = 0;
  for (let i = 0; i < path.length; i++) {
    h = (h * 31 + path.charCodeAt(i)) >>> 0;
  }
  return `n${h.toString(36)}`;
}
