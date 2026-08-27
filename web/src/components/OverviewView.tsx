import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Check, Plus, Minus, Maximize2, ChevronLeft } from 'lucide-react';
import { useZoomPan } from '../lib/useZoomPan';
import { renderMermaid, wireNodeClicks } from '../lib/mermaidInit';
import {
  overviewToMermaid,
  type OverviewResponse,
} from '../lib/overviewMermaid';
import {
  folderToMermaid,
  type FolderDepsResponse,
  type CompAnnotations,
} from '../lib/folderDepsMermaid';
import DiagramFilter from './DiagramFilter';

type Ann = CompAnnotations | undefined;

export default function OverviewView({
  repoName,
  onOpenFile,
}: {
  repoName: string;
  onOpenFile: (path: string, ext: string) => void;
}) {
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [folderData, setFolderData] = useState<FolderDepsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [stack, setStack] = useState<string[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const dir = stack[stack.length - 1] ?? '';

  const { viewportRef, canvasRef, scale, offset, zoomBy, fit, inject, viewportProps } =
    useZoomPan();
  const labelMap = useRef<Map<string, string>>(new Map());
  const boxMap = useRef<Map<string, string>>(new Map());

  const loadOverview = useCallback(() => {
    fetch('/api/overview')
      .then((r) => r.json())
      .then(setOverview)
      .catch(() => setError('Could not load the overview.'));
  }, []);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  // poll until ai.pending becomes false
  useEffect(() => {
    if (!overview?.ai.pending) return;
    const t = setTimeout(loadOverview, 3000);
    return () => clearTimeout(t);
  }, [overview?.ai.pending, loadOverview]);

  useEffect(() => {
    if (!dir) return;
    setFolderData(null);
    fetch(`/api/folderdeps?dir=${encodeURIComponent(dir)}`)
      .then((r) => r.json())
      .then(setFolderData)
      .catch(() => setError('Could not load the folder graph.'));
  }, [dir]);

  const ann: Ann = overview?.annotations;

  useEffect(() => {
    if (!canvasRef.current) return;
    if (!dir && !overview) return;
    if (dir && !folderData) return;

    let code = '';
    if (dir) {
      const r = folderToMermaid(folderData!, ann);
      labelMap.current = r.fileLabelToId;
      boxMap.current = r.boxLabelToDir;
      code = r.code;
    } else {
      const r = overviewToMermaid(overview!);
      labelMap.current = r.labelToId;
      boxMap.current = new Map();
      code = r.code;
    }

    let cancelled = false;
    renderMermaid(dir ? 'fdeps' : 'ovw', code)
      .then((svg) => {
        if (cancelled || !canvasRef.current) return;
        inject(svg);
        wireNodeClicks(canvasRef.current, (label) => {
          if (dir) {
            const fileId = labelMap.current.get(label);
            if (fileId) {
              const ext = fileId.slice(fileId.lastIndexOf('.'));
              onOpenFile(fileId, ext);
              return;
            }
            const comp = boxMap.current.get(label) ?? [...boxMap.current.entries()].find(([l]) => l === label)?.[1];
            if (comp) setStack((s) => [...s, comp]);
          } else {
            const id =
              labelMap.current.get(label) ??
              [...labelMap.current.entries()].find(
                ([l]) => l === label || l.split(':')[0] === label.split(':')[0]
              )?.[1];
            if (id) setStack((s) => [...s, id]);
          }
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
  }, [dir, folderData, overview, ann]);

  const copyCode = () => {
    let text = '';
    if (dir && folderData) text = folderToMermaid(folderData, ann).code;
    else if (overview) text = overviewToMermaid(overview).code;
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const hasGraph =
    dir ? Boolean(folderData && folderData.files.length > 0) : Boolean(overview && overview.components.length > 0);

  // apply diagram filter: dim non-matching SVG nodes
  const [matchCount, setMatchCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);

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

  return (
    <>
      <div className="code-header">
        <div className="code-breadcrumb">
          <span className="current">
            {repoName}
            {' - '}
            {dir ? `${dir} - files & dependencies` : 'Component Overview'}
          </span>
          {!dir && overview?.ai.applied && <span className="ai-badge">AI annotated</span>}
          {overview?.ai.pending && <span className="ai-badge pending">AI annotating…</span>}
          {!dir && overview?.ai.error && !overview?.ai.pending && !overview?.ai.applied && <span className="ai-badge error" title={overview.ai.error}>AI failed: {overview.ai.error}</span>}
        </div>
      </div>
      {error ? (
        <div className="center-empty">
          <div className="empty-card">
            <div className="empty-desc">{error}</div>
          </div>
        </div>
      ) : !hasGraph ? (
        <div className="center-empty">
          <div className="empty-card">
            <div className="empty-title">{dir ? 'Empty folder' : 'Nothing indexed'}</div>
            <div className="empty-desc">
              {dir ? 'No indexed files here.' : 'No components found for this repository.'}
            </div>
          </div>
        </div>
      ) : (
        <div className="deps-viewport grab" ref={viewportRef} {...viewportProps}>
          <div
            className="deps-canvas"
            ref={canvasRef}
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            }}
          />
          {stack.length > 0 && (
            <div className="nav-controls">
              <button title="Back" onClick={() => setStack((s) => s.slice(0, -1))}>
                <ChevronLeft size={14} strokeWidth={2} />
                Back
              </button>
            </div>
          )}
          <div className="graph-actions">
            <div className="zoom-controls">
              {hasGraph && (
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
      )}
    </>
  );
}
