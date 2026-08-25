import { useEffect, useRef, useState } from 'react';
import { marked } from 'marked';
import { FileQuestion } from 'lucide-react';

interface Sym {
  id: string;
  kind: string;
  name: string;
  fileId: string;
  startLine: number;
  endLine: number;
}

const READABLE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py',
  '.json', '.md', '.txt', '.html', '.css', '.yml', '.yaml', '.toml',
]);

export default function CodeView({
  filePath,
  ext,
  selectedSymbolId,
  onSymbolClick,
}: {
  filePath: string;
  ext?: string;
  selectedSymbolId: string | null;
  onSymbolClick: (id: string) => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [symbols, setSymbols] = useState<Sym[]>([]);
  const [error, setError] = useState<string | null>(null);

  const isMarkdown = ext === '.md';
  const readable = READABLE_EXTS.has((ext ?? '').toLowerCase());

  useEffect(() => {
    if (!readable) return;
    setContent(null);
    setError(null);
    setSymbols([]);
    fetch(`/api/file?path=${encodeURIComponent(filePath)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error('failed to load');
        return r.json();
      })
      .then((d) => setContent(d.content))
      .catch(() => setError('Could not load this file.'));
    if (!isMarkdown) {
      fetch(`/api/symbols?file=${encodeURIComponent(filePath)}`)
        .then((r) => r.json())
        .then((d) => setSymbols(d.symbols ?? []))
        .catch(() => {});
    }
  }, [filePath]);

  if (!readable)
    return (
      <>
        <div className="code-header">
          <div className="code-breadcrumb">
            {filePath.split('/').map((seg, i, arr) => (
              <span key={i}>
                {i > 0 && <span className="sep">&nbsp;/&nbsp;</span>}
                <span className={i === arr.length - 1 ? 'current' : ''}>{seg}</span>
              </span>
            ))}
          </div>
        </div>
        <div className="center-empty">
          <div className="empty-card">
            <FileQuestion size={28} strokeWidth={1.5} style={{ color: 'var(--text-3)', marginBottom: 12 }} />
            <div className="empty-title">No preview available</div>
            <div className="empty-desc">
              Archi indexes the structure of <code>.{ext ?? '?'}</code> files but can't render
              their contents. The file is part of the tree and watched for changes.
            </div>
          </div>
        </div>
      </>
    );

  if (error)
    return (
      <div className="center-empty">
        <div className="empty-card">
          <div className="empty-title">Cannot open file</div>
          <div className="empty-desc">{error}</div>
        </div>
      </div>
    );

  if (content === null)
    return (
      <div className="center-empty">
        <div className="empty-card">
          <div className="empty-desc">Loading…</div>
        </div>
      </div>
    );

  if (isMarkdown) {
    return <MarkdownView md={content} />;
  }

  return (
    <RawView
      content={content}
      symbols={symbols}
      selectedSymbolId={selectedSymbolId}
      onSymbolClick={onSymbolClick}
    />
  );
}

function MarkdownView({ md }: { md: string }) {
  const html = marked.parse(md, { async: false }) as string;
  return (
    <div className="md-preview">
      <div className="md-content" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function RawView({
  content,
  symbols,
  selectedSymbolId,
  onSymbolClick,
}: {
  content: string;
  symbols: Sym[];
  selectedSymbolId: string | null;
  onSymbolClick: (id: string) => void;
}) {
  const lines = content.split(/\r?\n/);
  const selected = symbols.find((s) => s.id === selectedSymbolId);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const programmaticScroll = useRef<number>(0);

  useEffect(() => {
    if (!selected || !bodyRef.current) return;
    requestAnimationFrame(() => {
      const el = document.getElementById(`L${selected.startLine}`);
      if (el && bodyRef.current) {
        programmaticScroll.current = Date.now();
        bodyRef.current.scrollTop = el.offsetTop - bodyRef.current.offsetTop;
      }
    });
  }, [selectedSymbolId, symbols.length, content]);

  // user scrolling away clears the selection
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onScroll = () => {
      if (Date.now() - programmaticScroll.current < 200) return;
      if (selectedSymbolId) onSymbolClick('');
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, [selectedSymbolId, onSymbolClick]);

  const symbolForLine = (line: number): Sym | undefined => {
    let best: Sym | undefined;
    let bestLen = Infinity;
    for (const s of symbols) {
      if (line >= s.startLine && line <= s.endLine && s.endLine - s.startLine <= bestLen) {
        best = s;
        bestLen = s.endLine - s.startLine;
      }
    }
    return best;
  };

  const jumpTo = (s: Sym) => {
    onSymbolClick(s.id);
  };

  const inRange = (line: number): boolean =>
    !!selected && line >= selected.startLine && line <= selected.endLine;

  return (
    <>
      {symbols.length > 0 && (
        <div className="sym-strip">
          {symbols.map((s) => (
            <button
              key={s.id}
              className={`sym-chip ${s.kind}${selected?.id === s.id ? ' active' : ''}`}
              onClick={() => jumpTo(s)}
            >
              {s.kind === 'class' ? 'C' : 'ƒ'} {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="code-body" ref={bodyRef}>
        <div className="code-gutter">
          {lines.map((_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>
        <div className="code-lines">
          {lines.map((line, i) => {
            const n = i + 1;
            return (
              <span
                key={i}
                id={`L${n}`}
                className={`line${inRange(n) ? ' hl' : ''}`}
                onClick={() => {
                  const sym = symbolForLine(n);
                  if (sym) onSymbolClick(sym.id);
                }}
              >
                {line || ' '}
              </span>
            );
          })}
        </div>
      </div>
    </>
  );
}

export { MarkdownView };
