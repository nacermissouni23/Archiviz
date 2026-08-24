import { useEffect, useRef, useState } from 'react';
import { Copy, Check, Plus, Minus, Maximize2 } from 'lucide-react';
import { renderMermaid } from './lib/mermaidInit';
import { traceToMermaid, type TraceResponse } from './lib/traceMermaid';

export default function TraceView({
  symbolId,
  onOpenFile,
}: {
  symbolId: string;
  onOpenFile: (path: string, ext: string) => void;
}) {
  const [trace, setTrace] = useState<TraceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [scale, setScale] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTrace(null);
    setError(null);
    setScale(1);
    fetch(`/api/trace?id=${encodeURIComponent(symbolId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else setTrace(d);
      })
      .catch(() => setError('Could not load trace.'));
  }, [symbolId]);

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

        // measure max actor bottom for sticky height
        let maxBottom = 0;
        actors.forEach((actor) => {
          const box = actor.querySelector<SVGRectElement>('rect');
          if (!box) return;
          const y = parseFloat(box.getAttribute('y') || '0');
          const h = parseFloat(box.getAttribute('height') || '40');
          if (y + h > maxBottom) maxBottom = y + h;
        });

        // extract participant boxes as HTML
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
            position: absolute;
            left: ${x}px;
            top: ${y}px;
            width: ${w}px;
            height: ${h}px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: ${fill};
            border: 1.5px solid ${stroke};
            border-radius: 6px;
            color: var(--text-0);
            font-size: 12px;
            font-family: var(--font-mono);
            pointer-events: none;
            transform-origin: top left;
            transform: scale(${scale});
            z-index: 2;
          `;
          labels.appendChild(div);
        });

        // sticky covers only the actor area, not the full SVG
        labels.style.height = (maxBottom * scale + 4) + 'px';
        labels.style.display = 'block';
      })
      .catch((e) => {
        console.error('mermaid render failed:', e, '\ncode:\n', code);
        setError('Could not render the graph.');
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

  return (
    <>
      <div className="code-header">
        <div className="code-breadcrumb">
          <span className="current">{trace?.entry.name ?? 'Trace'}()</span>
          <span className="sep">—</span>
          <span>{trace?.entry.fileId}</span>
        </div>
      </div>
      {error ? (
        <div className="center-empty">
          <div className="empty-card"><div className="empty-desc">{error}</div></div>
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
              {copied ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={2} />}
            </button>
            <div className="zoom-controls">
              <button title="Zoom in" onClick={() => zoomBy(1.2)}>
                <Plus size={14} strokeWidth={2} />
              </button>
              <button title="Fit width" onClick={fitWidth}>
                <Maximize2 size={13} strokeWidth={2} />
              </button>
              <button title="Zoom out" onClick={() => zoomBy(1 / 1.2)}>
                <Minus size={14} strokeWidth={2} />
              </button>
              <span className="zoom-label">{Math.round(scale * 100)}%</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
