import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, Activity } from 'lucide-react';
import { useZoomPan } from './lib/useZoomPan';
import { renderMermaid } from './lib/mermaidInit';
import { traceToMermaid, type TraceResponse } from './lib/traceMermaid';

interface EntryPoint {
  id: string;
  name: string;
  fileId: string;
  kind: string;
}

interface Grouped {
  [folder: string]: {
    [file: string]: EntryPoint[];
  };
}

export default function TracePickerView({
  onTrace,
}: {
  onTrace: (symId: string, symName: string) => void;
}) {
  const [entries, setEntries] = useState<EntryPoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  // drill-down stack: '' = picker, otherwise symbol id being traced
  const [stack, setStack] = useState<string[]>([]);
  const currentSymId = stack[stack.length - 1] ?? '';

  const [trace, setTrace] = useState<TraceResponse | null>(null);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [scale, setScale] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/entrypoints')
      .then((r) => r.json())
      .then((d) => setEntries(d.entryPoints ?? []))
      .catch(() => setError('Could not load traceable symbols.'));
  }, []);

  // fetch trace when drilled in
  useEffect(() => {
    if (!currentSymId) {
      setTrace(null);
      return;
    }
    setTrace(null);
    setTraceError(null);
    setScale(1);
    fetch(`/api/trace?id=${encodeURIComponent(currentSymId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setTraceError(d.error);
        else setTrace(d);
      })
      .catch(() => setTraceError('Could not load trace.'));
  }, [currentSymId]);

  // render mermaid
  useEffect(() => {
    if (!trace || !canvasRef.current || !stickyRef.current) return;
    if (trace.steps.length === 0) return;
    const code = traceToMermaid(trace);
    let cancelled = false;
    renderMermaid('trace', code)
      .then((svg) => {
        if (cancelled || !canvasRef.current || !stickyRef.current) return;
        canvasRef.current.innerHTML = svg;

        const svgEl = canvasRef.current.querySelector('svg');
        if (!svgEl) return;

        const actors = svgEl.querySelectorAll<SVGGElement>('.actor');
        if (actors.length === 0) return;

        let maxBottom = 0;
        actors.forEach((actor) => {
          const box = actor.querySelector<SVGRectElement>('rect');
          if (!box) return;
          const y = parseFloat(box.getAttribute('y') || '0');
          const h = parseFloat(box.getAttribute('height') || '40');
          if (y + h > maxBottom) maxBottom = y + h;
        });

        const labels = stickyRef.current;
        labels.innerHTML = '';
        actors.forEach((actor) => {
          const box = actor.querySelector<SVGRectElement>('rect');
          const text = actor.querySelector<SVGTextElement>('text');
          if (!box || !text) return;
          const x = parseFloat(box.getAttribute('x') || '0');
          const y = parseFloat(box.getAttribute('y') || '0');
          const w = parseFloat(box.getAttribute('width') || '80');
          const h = parseFloat(box.getAttribute('height') || '40');
          const fill = box.getAttribute('fill') || '#1e2430';
          const stroke = box.getAttribute('stroke') || '#3d4450';
          const label = text.textContent || '';
          const div = document.createElement('div');
          div.className = 'trace-actor-box';
          div.textContent = label;
          div.style.cssText = `
            position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;
            display:flex;align-items:center;justify-content:center;
            background:${fill};border:1.5px solid ${stroke};border-radius:6px;
            color:var(--text-0);font-size:12px;font-family:var(--font-mono);
            pointer-events:none;transform-origin:top left;transform:scale(${scale});z-index:2;
          `;
          labels.appendChild(div);
        });
        labels.style.height = (maxBottom * scale + 4) + 'px';
        labels.style.display = 'block';
      })
      .catch((e) => {
        console.error('mermaid render failed:', e);
        setTraceError('Could not render the graph.');
      });
    return () => { cancelled = true; };
  }, [trace, scale]);

  const zoomBy = (f: number) => setScale((s) => Math.min(Math.max(s * f, 0.3), 3));
  const fitWidth = () => {
    const sv = scrollRef.current?.querySelector('svg');
    if (!sv || !scrollRef.current) return;
    setScale(Math.min((scrollRef.current.clientWidth - 40) / sv.clientWidth, 2));
  };
  const copyCode = () => {
    if (!trace) return;
    navigator.clipboard.writeText(traceToMermaid(trace)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  // group by folder then file
  const grouped: Grouped = {};
  for (const s of entries) {
    const parts = s.fileId.split('/');
    const folder = parts.length > 1 ? parts[0] : '(root)';
    if (!grouped[folder]) grouped[folder] = {};
    if (!grouped[folder][s.fileId]) grouped[folder][s.fileId] = [];
    grouped[folder][s.fileId].push(s);
  }
  const folders = Object.keys(grouped).sort();

  // tracing view
  if (currentSymId) {
    const sym = entries.find((e) => e.id === currentSymId);
    return (
      <>
        <div className="code-header">
          <div className="code-breadcrumb">
            <button
              className="btn-ghost-small"
              onClick={() => setStack((s) => s.slice(0, -1))}
            >
              <ChevronLeft size={13} /> Back
            </button>
            <span className="current">{sym?.name ?? 'Trace'}()</span>
            <span className="sep">—</span>
            <span>{sym?.fileId}</span>
          </div>
        </div>
        {traceError ? (
          <div className="center-empty">
            <div className="empty-card"><div className="empty-desc">{traceError}</div></div>
          </div>
        ) : !trace ? (
          <div className="center-empty">
            <div className="empty-card"><div className="empty-title">Loading…</div></div>
          </div>
        ) : trace.steps.length === 0 ? (
          <div className="center-empty">
            <div className="empty-card">
              <div className="empty-title">No calls traced</div>
              <div className="empty-desc">This function doesn't call any indexed symbol.</div>
            </div>
          </div>
        ) : (
          <div className="trace-wrap">
            <div className="trace-scroll" ref={scrollRef}>
              <div ref={stickyRef} className="trace-sticky" />
              <div
                className="trace-canvas"
                ref={canvasRef}
                style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}
              />
            </div>
            <div className="trace-actions">
              <button title="Copy Mermaid" onClick={copyCode}>
                {copied ? '✓' : '⧉'}
              </button>
              <div className="zoom-controls">
                <button title="Zoom in" onClick={() => zoomBy(1.2)}>+</button>
                <button title="Fit width" onClick={fitWidth}>⤢</button>
                <button title="Zoom out" onClick={() => zoomBy(1 / 1.2)}>−</button>
                <span className="zoom-label">{Math.round(scale * 100)}%</span>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  // picker view
  return (
    <>
      <div className="code-header">
        <div className="code-breadcrumb">
          <span className="current">Trace Flow</span>
          <span className="sep">—</span>
          <span>{entries.length} traceable symbols</span>
        </div>
      </div>
      {error ? (
        <div className="center-empty">
          <div className="empty-card"><div className="empty-desc">{error}</div></div>
        </div>
      ) : entries.length === 0 ? (
        <div className="center-empty">
          <div className="empty-card">
            <div className="empty-title">No symbols found</div>
            <div className="empty-desc">Index a repository first.</div>
          </div>
        </div>
      ) : (
        <div className="trace-picker-scroll">
          {folders.map((folder) => (
            <div key={folder} className="tp-folder">
              <div className="tp-folder-title">{folder}/</div>
              {Object.keys(grouped[folder]).sort().map((fileId) => (
                <div key={fileId} className="tp-file">
                  <div className="tp-file-title">{fileId.split('/').pop()}</div>
                  <div className="tp-file-path">{fileId}</div>
                  <div className="tp-symbols">
                    {grouped[folder][fileId].map((s) => (
                      <button
                        key={s.id}
                        className="tp-symbol"
                        onClick={() => setStack((st) => [...st, s.id])}
                        title={`Trace ${s.name}`}
                      >
                        <Activity size={12} strokeWidth={2} />
                        <span className="tp-sym-name">{s.name}</span>
                        <span className="tp-sym-kind">{s.kind}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
