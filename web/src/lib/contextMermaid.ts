export interface ContextSystem {
  name: string;
  kind: string;
  label: string;
  relation: string;
  confidence: 'high' | 'medium';
  importFiles: string[];
  envVars: string[];
  usedBy: string[];
  declaredIn?: string;
}

export interface ContextActor {
  id: string;
  label: string;
  relation: string;
  evidence: { bin?: string; argv?: boolean; pkg?: string; routes?: string[] };
}

export interface ContextResponse {
  name: string;
  stats: { files: number; symbols: number; calls: number; libraries: number };
  systems: ContextSystem[];
  actors: ContextActor[];
  libraries: { name: string; count: number; role?: string }[];
  ai: { pending: boolean; applied: boolean };
  annotations?: {
    app?: { label?: string; description?: string };
    systems?: Record<string, string>;
    actors?: Record<string, string>;
    libraries?: Record<string, string>;
  };
}

function esc(s: string): string {
  return s.replace(/"/g, '#quot;').replace(/[\r\n]+/g, ' ');
}

export function appLabel(data: ContextResponse): string {
  const a = data.annotations?.app;
  return a?.description
    ? `${a.label ?? data.name}: ${a.description}`
    : `${data.name} · ${data.stats.files}f ${data.stats.symbols}s`;
}

/** target key for click round-trip: 'APP' | 'actor:<id>' | 'sys:<name>' */
export type ContextTarget = string;

export function contextToMermaid(data: ContextResponse): {
  code: string;
  labelToTarget: Map<string, ContextTarget>;
} {
  const lines: string[] = ['flowchart LR'];
  lines.push(`  classDef app fill:#5b9dd933,stroke:#5b9dd9,color:#e8ebf1,stroke-width:2px`);
  lines.push(`  classDef actor fill:#6f9bd11a,stroke:#6f9bd1,color:#aab3c2`);
  lines.push(`  classDef ext fill:#d9b06a1a,stroke:#d9b06a,color:#aab3c2`);

  const labelToTarget = new Map<string, ContextTarget>();
  const ann = data.annotations;

  const aLabel = appLabel(data);
  labelToTarget.set(aLabel, 'APP');

  // actors (left side)
  for (const actor of data.actors) {
    const label = ann?.actors?.[actor.id] ?? actor.label;
    labelToTarget.set(label, `actor:${actor.id}`);
    lines.push(`  ${actorId(actor.id)}(["${esc(label)}"])`);
    lines.push(`  ${actorId(actor.id)} -->|"${esc(actor.relation)}"| APP`);
    lines.push(`  ${actorId(actor.id)}:::actor`);
  }

  // system boundary + app
  lines.push(`  subgraph SYS ["SYSTEM"]`);
  lines.push(`    APP(["${esc(aLabel)}"])`);
  lines.push(`  end`);
  lines.push(`  style SYS stroke:#3a4557,stroke-dasharray: 5 5`);

  // systems (right side), grouped by kind
  const kindOrder = ['database', 'queue', 'api', 'cloud', 'email', 'search'];
  const ordered = [...data.systems].sort(
    (a, b) => kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind)
  );
  for (const sys of ordered) {
    const label = ann?.systems?.[sys.name] ?? sys.label;
    labelToTarget.set(label, `sys:${sys.name}`);
    lines.push(`    ${sysId(sys.name)}(["${esc(label)}"])`);
    lines.push(`    APP -->|"${esc(sys.relation)}"| ${sysId(sys.name)}`);
    lines.push(`    ${sysId(sys.name)}:::ext`);
  }

  lines.push('  APP:::app');

  return { code: lines.join('\n'), labelToTarget };
}

function sysId(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return `s${h.toString(36)}`;
}

function actorId(id: string): string {
  return `a_${id.replace(/[^a-z0-9]/gi, '')}`;
}
