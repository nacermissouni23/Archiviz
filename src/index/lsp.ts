import { spawn, type ChildProcess } from 'node:child_process';

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** Minimal JSON-RPC over stdio client for language servers (LSP framing). */
export class LspClient {
  private proc: ChildProcess;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;

  constructor(cmd: string, args: string[], cwd: string, onNotify?: (method: string, params: any) => void) {
    this.proc = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false });

    let stderr = '';
    this.proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    this.proc.stdout?.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain(onNotify);
    });

    this.proc.on('exit', () => {
      this.closed = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('language server exited' + (stderr ? `: ${stderr.slice(-300)}` : '')));
      }
      this.pending.clear();
    });
  }

  private drain(onNotify?: (method: string, params: any) => void) {
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = this.buffer.slice(0, headerEnd).toString('utf8');
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) {
        // malformed - drop this header block
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const len = parseInt(m[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + len) return; // wait for full body
      const body = this.buffer.slice(bodyStart, bodyStart + len).toString('utf8');
      this.buffer = this.buffer.slice(bodyStart + len);

      try {
        const msg = JSON.parse(body);
        if (msg.id !== undefined && (msg.method === undefined || msg.result !== undefined || msg.error !== undefined)) {
          const p = this.pending.get(msg.id);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message ?? 'LSP error'));
            else p.resolve(msg.result);
          }
        } else if (msg.method && msg.id !== undefined) {
          // server → client request: must respond to avoid stalling the server
          this.send({ jsonrpc: '2.0', id: msg.id, result: null });
        } else if (msg.method && onNotify) {
          onNotify(msg.method, msg.params);
        }
      } catch {
        /* bad json - ignore */
      }
    }
  }

  private send(msg: object) {
    if (this.closed || !this.proc.stdin?.writable) return;
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    this.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.proc.stdin.write(body);
  }

  request(method: string, params: object | null, timeoutMs = 10_000): Promise<any> {
    if (this.closed) return Promise.reject(new Error('client closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: object) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  async shutdown() {
    try {
      await this.request('shutdown', null, 3000);
    } catch {
      /* ignore */
    }
    this.notify('exit', {});
    const proc = this.proc;
    setTimeout(() => {
      if (!proc.killed) proc.kill();
    }, 1500);
  }

  kill() {
    this.closed = true;
    if (!this.proc.killed) this.proc.kill();
  }
}
