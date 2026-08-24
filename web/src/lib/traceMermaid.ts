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

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

export function traceToMermaid(data: TraceResponse): string {
  const lines: string[] = ['sequenceDiagram'];

  // collect all files involved
  const allFiles = [data.entry.fileId];
  for (const s of data.steps) {
    allFiles.push(s.from.fileId, s.to.fileId);
  }
  const distinctFiles = dedupe(allFiles);

  // if >6 files, fall back to top-level folders to prevent width explosion
  const useFolders = distinctFiles.length > 6;
  const fileToParticipant = new Map<string, string>();
  const participantIds = new Set<string>();

  function participantId(fileId: string): string {
    if (useFolders) {
      const folder = fileId.includes('/') ? fileId.split('/')[0] : '(root)';
      if (!fileToParticipant.has(fileId)) fileToParticipant.set(fileId, folder);
      return folder;
    }
    if (!fileToParticipant.has(fileId)) {
      fileToParticipant.set(fileId, fileId);
    }
    return fileId;
  }

  // build participants in order of appearance
  for (const f of allFiles) {
    const pid = participantId(f);
    if (!participantIds.has(pid)) {
      participantIds.add(pid);
    }
  }

  // declare participants
  const pidArray = [...participantIds];
  for (const pid of pidArray) {
    const label = useFolders ? pid : pid.split('/').pop()!;
    lines.push(`  participant ${esc(pid)} as ${esc(label)}`);
  }

  // entry note
  const entryPid = participantId(data.entry.fileId);
  lines.push(`  Note over ${esc(entryPid)}: ${esc(data.entry.name)}()`);

  // steps
  for (const step of data.steps) {
    const fromPid = participantId(step.from.fileId);
    const toPid = participantId(step.to.fileId);
    const label = esc(step.callLabel);
    lines.push(`  ${esc(fromPid)}->>${esc(toPid)}: ${label}`);
  }

  return lines.join('\n');
}
