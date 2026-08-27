import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Check, Plus, Minus, Maximize2, X } from 'lucide-react';
import { useZoomPan } from '../lib/useZoomPan';
import { renderMermaid, wireNodeClicks } from '../lib/mermaidInit';
import { contextToMermaid, type ContextResponse } from '../lib/contextMermaid';
import DiagramFilter from './DiagramFilter';

type Info =
  | { type: 'system'; name: string }
  | { type: 'actor'; id: string }
  | { type: 'libs' }
  | null;

export default function ContextView({
  repoName,
  onOpenFile,
  onOpenOverview,
}: {
  repoName: string;
  onOpenFile: (path: string, ext: string) => void;
  onOpenOverview: () => void;
}) {
  const [ctx, setCtx] = useState<ContextResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [info, setInfo] = useState<Info>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const [matchCount, setMatchCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const { viewportRef, canvasRef, scale, offset, zoomBy, fit, inject, viewportProps } =
    useZoomPan();
  const lastCode = useRef('');
  const clickMap = useRef<Map<string, string>>(new Map());

  const loadCtx = useCallback(() => {
    fetch('/api/context')
      .then((r) => r.json())
      .then(setCtx)
      .catch(() => setError('Could not load the system context.'));
  }, []);

  useEffect(() => {
    loadCtx();
  }, [loadCtx]);

  // poll while AI is annotating; render immediately regardless
  useEffect(() => {
    if (!ctx?.ai.pending) return;
    const t = setTimeout(loadCtx, 3000);
    return () => clearTimeout(t);
  }, [ctx?.ai.pending, loadCtx]);

  // index still warming up → retry instead of showing a false "nothing indexed"
  useEffect(() => {
    if (!ctx || ctx.stats.files > 0) return;
    const t = setTimeout(loadCtx, 2000);
    return () => clearTimeout(t);
  }, [ctx, loadCtx]);

  useEffect(() => {
    if (!ctx || !canvasRef.current) return;
    if (ctx.stats.files === 0) return;
    const { code, labelToTarget } = contextToMermaid(ctx);
    clickMap.current = labelToTarget;
    lastCode.current = code;
    let cancelled = false;
    renderMermaid('ctx', code)
      .then((svg) => {
        if (cancelled || !canvasRef.current) return;
        inject(svg);
        wireNodeClicks(canvasRef.current, (label) => {
          const target = clickMap.current.get(label);
          if (target === 'APP') onOpenOverview();
          else if (target?.startsWith('sys:')) setInfo({ type: 'system', name: target.slice(4) });
          else if (target?.startsWith('actor:')) setInfo({ type: 'actor', id: target.slice(6) });
        });
      })
      .catch((e) => {
        console.error('mermaid render failed:', e, '\ncode:\n', code);
        setError('Could not render the graph.');
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx]);

  const copyCode = () => {
    if (!lastCode.current) return;
    navigator.clipboard.writeText(lastCode.current).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const openFileFrom = (f: string) => onOpenFile(f, f.slice(f.lastIndexOf('.')));

  const sys = info?.type === 'system' ? ctx?.systems.find((s) => s.name === info.name) : undefined;
  const actor = info?.type === 'actor' ? ctx?.actors.find((a) => a.id === info.id) : undefined;

  // apply diagram filter: dim non-matching SVG nodes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const svgEl = canvas.querySelector('svg');
    if (!svgEl) return;

    const nodes = svgEl.querySelectorAll('g.node, g.cluster');
    const edges = svgEl.querySelectorAll('g.edge');

    if (!filterQuery) {
      nodes.forEach((n) => {
        (n as HTMLElement).style.opacity = '';
        (n as HTMLElement).style.transition = '';
      });
      edges.forEach((e) => {
        (e as HTMLElement).style.opacity = '';
        (e as HTMLElement).style.transition = '';
      });
      setMatchCount(0);
      setTotalCount(0);
      return;
    }

    const needle = filterQuery.toLowerCase();
    let matches = 0;

    const getNodeText = (n: Element): string => {
      const parts: string[] = [];
      n.querySelectorAll('text').forEach((t) => parts.push(t.textContent ?? ''));
      n.querySelectorAll('foreignObject div').forEach((d) => parts.push(d.textContent ?? ''));
      return parts.join(' ').toLowerCase();
    };

    nodes.forEach((n) => {
      const text = getNodeText(n);
      if (text.includes(needle)) {
        matches++;
        (n as HTMLElement).style.opacity = '1';
      } else {
        (n as HTMLElement).style.opacity = '0.15';
      }
      (n as HTMLElement).style.transition = 'opacity 0.2s';
    });

    edges.forEach((e) => {
      (e as HTMLElement).style.opacity = '0.1';
      (e as HTMLElement).style.transition = 'opacity 0.2s';
    });

    setMatchCount(matches);
    setTotalCount(nodes.length);
  }, [filterQuery, canvasRef]);

  const empty = ctx && ctx.stats.files === 0;

  return (
    <>
      <div className="code-header">
        <div className="code-breadcrumb">
          <span className="current">{repoName} - System Context</span>
          {ctx?.ai.applied && <span className="ai-badge">AI annotated</span>}
          {ctx?.ai.pending && <span className="ai-badge pending">AI annotating…</span>}
          {ctx?.ai.error && !ctx?.ai.pending && !ctx?.ai.applied && <span className="ai-badge error" title={ctx.ai.error}>AI failed: {ctx.ai.error}</span>}
        </div>
        <div className="toolbar-spacer" />
      </div>
      {error ? (
        <div className="center-empty">
          <div className="empty-card">
            <div className="empty-desc">{error}</div>
          </div>
        </div>
      ) : !ctx ? (
        <div className="center-empty">
          <div className="empty-card">
            <div className="empty-desc">Loading…</div>
          </div>
        </div>
      ) : empty ? (
        <div className="center-empty">
          <div className="empty-card">
            <div className="empty-title">Nothing indexed</div>
            <div className="empty-desc">No files found for this repository.</div>
          </div>
        </div>
      ) : (
        <>
          <div className="deps-viewport grab" ref={viewportRef} {...viewportProps}>
            <div
              className="deps-canvas"
              ref={canvasRef}
              style={{
                transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
              }}
            />
            {info?.type === 'system' && sys && (
              <div className="ov-info">
                <button className="ov-info-close" title="Close" onClick={() => setInfo(null)}>
                  <X size={13} strokeWidth={2} />
                </button>
                <div className="ov-info-title">
                  {ctx.annotations?.systems?.[sys.name] ?? sys.label}
                  <span
                    className={`conf conf-${sys.confidence}`}
                    style={{ marginLeft: 8, verticalAlign: 'middle' }}
                    title={
                      sys.confidence === 'high'
                        ? 'Imported in indexed code'
                        : 'Inferred from environment variables only'
                    }
                  >
                    {sys.confidence === 'high' ? 'HIGH' : 'MED'}
                  </span>
                </div>
                <div className="ov-info-meta">{sys.kind}</div>
                {(sys.importFiles.length > 0 || sys.envVars.length > 0 || sys.declaredIn) && (
                  <div className="insp-section-title">Detected because</div>
                )}
                {sys.declaredIn && (
                  <div className="ov-info-meta">declared in {sys.declaredIn}</div>
                )}
                {sys.importFiles.map((f) => (
                  <div key={f} className="ov-info-row file-link" onClick={() => openFileFrom(f)}>
                    {f}
                  </div>
                ))}
                {sys.envVars.length > 0 && (
                  <div className="ov-info-row" style={{ marginTop: 4 }}>
                    {sys.envVars.map((v) => (
                      <span key={v} className="env-chip">
                        {v}
                      </span>
                    ))}
                  </div>
                )}
                {sys.usedBy.length > 0 && (
                  <>
                    <div className="insp-section-title">Used by</div>
                    {sys.usedBy.map((f) => (
                      <div key={f} className="ov-info-row file-link" onClick={() => openFileFrom(f)}>
                        {f}
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
            {info?.type === 'actor' && actor && (
              <div className="ov-info">
                <button className="ov-info-close" title="Close" onClick={() => setInfo(null)}>
                  <X size={13} strokeWidth={2} />
                </button>
                <div className="ov-info-title">
                  {ctx.annotations?.actors?.[actor.id] ?? actor.label}
                </div>
                <div className="insp-section-title">Detected because</div>
                {actor.evidence.bin && (
                  <div className="ov-info-meta">bin: {actor.evidence.bin}</div>
                )}
                {actor.evidence.argv && <div className="ov-info-meta">process.argv usage</div>}
                {actor.evidence.pkg && (
                  <div className="ov-info-meta">package: {actor.evidence.pkg}</div>
                )}
                {actor.evidence.routes?.map((r) => (
                  <div key={r} className="ov-info-row" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                    {r}
                  </div>
                ))}
              </div>
            )}
            {info?.type === 'libs' && (
              <div className="ov-info">
                <button className="ov-info-close" title="Close" onClick={() => setInfo(null)}>
                  <X size={13} strokeWidth={2} />
                </button>
                <div className="ov-info-title">Libraries ({ctx.libraries.length})</div>
                {ctx.libraries.map((l) => (
                  <div key={l.name} className="ov-info-row" style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }} title={ctx.annotations?.libraries?.[l.name]}>
                      {l.name}
                    </span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)' }}>
                      {l.count}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div className="graph-actions">
              <div className="zoom-controls">
                {ctx && !empty && (
                  <button title="Copy Mermaid" onClick={copyCode}>
                    {copied ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={2} />}
                  </button>
                )}
                <button title="Zoom in" onClick={() => zoomBy(1.2)}>
                  <Plus size={14} strokeWidth={2} />
                </button>
                <button title="Fit" onClick={fit}>
                  <Maximize2 size={13} strokeWidth={2} />
                </button>
                <button title="Zoom out" onClick={() => zoomBy(1 / 1.2)}>
                  <Minus size={14} strokeWidth={2} />
                </button>
                <span className="zoom-label">{Math.round(scale * 100)}%</span>
                <DiagramFilter
                  open={filterOpen}
                  onToggle={() => { setFilterOpen(!filterOpen); setFilterQuery(''); }}
                  query={filterQuery}
                  onQueryChange={setFilterQuery}
                  matchCount={matchCount}
                  totalCount={totalCount}
                />
              </div>
            </div>
          </div>
          <div className="ctx-stats">
            <span><strong>{ctx.stats.files}</strong> files</span>
            <span><strong>{ctx.stats.symbols}</strong> symbols</span>
            <span><strong>{ctx.stats.calls}</strong> calls resolved</span>
            {ctx.systems.length > 0 && (
              <span><strong>{ctx.systems.length}</strong> external systems</span>
            )}
            {ctx.libraries.length > 0 && (
              <span
                className="libs-chip"
                title="Show libraries"
                onClick={() => setInfo({ type: 'libs' })}
              >
                <strong>{ctx.libraries.length}</strong> libraries
              </span>
            )}
          </div>
        </>
      )}
    </>
  );
}
