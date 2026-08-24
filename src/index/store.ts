export type SymbolKind = 'class' | 'function' | 'method';

export interface Sym {
  id: string;
  kind: SymbolKind;
  name: string;
  fileId: string; // posix rel path
  startLine: number; // 1-based
  endLine: number;
  signature: string;
  parent?: string; // containing class id
  async?: boolean;
}

export type EdgeType = 'contains' | 'imports' | 'calls';

export interface Edge {
  src: string;
  dst: string;
  type: EdgeType;
}

export interface Node {
  id: string;
  type: 'file' | 'symbol';
  sym?: Sym;
}

export class GraphStore {
  nodes = new Map<string, Node>();
  edges: Edge[] = [];
  private callersOf = new Map<string, Edge[]>();
  private calleesOf = new Map<string, Edge[]>();
  symbolsByFile = new Map<string, string[]>();
  /** bare package name -> number of import sites */
  externals = new Map<string, number>();
  /** bare package name -> indexed files that import it */
  externalUsers = new Map<string, Set<string>>();
  /** env var name -> indexed files referencing it */
  envVars = new Map<string, Set<string>>();
  /** detected HTTP route literals */
  routes: { fileId: string; method: string; path: string }[] = [];
  /** any file references process.argv */
  hasArgv = false;

  clear() {
    this.nodes.clear();
    this.edges = [];
    this.callersOf.clear();
    this.calleesOf.clear();
    this.symbolsByFile.clear();
    this.externals.clear();
    this.externalUsers.clear();
    this.envVars.clear();
    this.routes = [];
    this.hasArgv = false;
  }

  addExternal(name: string, fileId?: string) {
    if (!name) return;
    this.externals.set(name, (this.externals.get(name) ?? 0) + 1);
    if (fileId) {
      let set = this.externalUsers.get(name);
      if (!set) {
        set = new Set();
        this.externalUsers.set(name, set);
      }
      set.add(fileId);
    }
  }

  addFile(fileId: string) {
    if (!this.nodes.has(fileId)) this.nodes.set(fileId, { id: fileId, type: 'file' });
  }

  addSymbol(sym: Sym) {
    this.nodes.set(sym.id, { id: sym.id, type: 'symbol', sym });
    const list = this.symbolsByFile.get(sym.fileId) ?? [];
    list.push(sym.id);
    this.symbolsByFile.set(sym.fileId, list);
  }

  addEdge(src: string, dst: string, type: EdgeType) {
    if (!src || !dst || src === dst) return;
    const key = `${src}\u0000${dst}\u0000${type}`;
    // dedupe cheaply via maps for calls/imports; contains can duplicate too
    const existing = this.calleesOf.get(src)?.some(
      (e) => e.dst === dst && e.type === type
    );
    if (existing && type !== 'contains') return;
    const edge = { src, dst, type };
    this.edges.push(edge);
    const cal = this.calleesOf.get(src) ?? [];
    cal.push(edge);
    this.calleesOf.set(src, cal);
    const rer = this.callersOf.get(dst) ?? [];
    rer.push(edge);
    this.callersOf.set(dst, rer);
    void key;
  }

  getCallers(id: string): Edge[] {
    return this.callersOf.get(id) ?? [];
  }

  getCallees(id: string): Edge[] {
    return this.calleesOf.get(id) ?? [];
  }

  getSymbol(id: string): Sym | undefined {
    return this.nodes.get(id)?.type === 'symbol' ? this.nodes.get(id)!.sym : undefined;
  }

  getSymbolsInFile(fileId: string): Sym[] {
    const ids = this.symbolsByFile.get(fileId) ?? [];
    const out: Sym[] = [];
    for (const id of ids) {
      const s = this.getSymbol(id);
      if (s) out.push(s);
    }
    return out.sort((a, b) => a.startLine - b.startLine);
  }

  searchSymbols(q: string, limit = 30): Sym[] {
    const needle = q.toLowerCase();
    const hits: Sym[] = [];
    for (const node of this.nodes.values()) {
      if (node.type !== 'symbol' || !node.sym) continue;
      if (node.sym.name.toLowerCase().includes(needle)) {
        hits.push(node.sym);
        if (hits.length >= limit) break;
      }
    }
    return hits;
  }

  stats() {
    let files = 0;
    let syms = 0;
    let imports = 0;
    let calls = 0;
    for (const n of this.nodes.values()) n.type === 'file' ? files++ : syms++;
    for (const e of this.edges) {
      if (e.type === 'imports') imports++;
      else if (e.type === 'calls') calls++;
    }
    return { files, syms, imports, calls };
  }
}
