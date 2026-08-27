import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, ArrowUp, ArrowDown, CornerDownLeft, X } from 'lucide-react';

interface SearchResult {
  type: 'component' | 'system' | 'library' | 'symbol' | 'file';
  name: string;
  detail: string;
  id: string;
  view: 'overview' | 'context' | 'trace' | 'code';
}

const GROUP_LABELS: Record<string, string> = {
  component: 'COMPONENTS',
  system: 'SYSTEMS',
  library: 'LIBRARIES',
  symbol: 'SYMBOLS',
  file: 'FILES',
};

const VIEW_LABELS: Record<string, string> = {
  overview: 'Components',
  context: 'System Context',
  trace: 'Trace',
  code: 'Code',
};

export default function SearchModal({
  open,
  onClose,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (result: SearchResult) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // autofocus on open
  useEffect(() => {
    if (open) {
      setQuery('');
      setResults([]);
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // debounced search
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    setLoading(true);
    const t = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(query.trim())}`)
        .then((r) => r.json())
        .then((d) => {
          setResults(d.results ?? []);
          setActive(0);
        })
        .catch(() => setResults([]))
        .finally(() => setLoading(false));
    }, 150);
    return () => clearTimeout(t);
  }, [query]);

  // group results
  const grouped = results.reduce<Record<string, SearchResult[]>>((acc, r) => {
    (acc[r.type] ??= []).push(r);
    return acc;
  }, {});

  const flatResults = Object.values(grouped).flat();

  const scrollActiveIntoView = useCallback(() => {
    const el = listRef.current?.querySelector('[data-active="true"]');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, []);

  useEffect(() => {
    scrollActiveIntoView();
  }, [active, scrollActiveIntoView]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, flatResults.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (flatResults[active]) {
        onSelect(flatResults[active]);
        onClose();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  if (!open) return null;

  let idx = -1;

  return (
    <div className="search-overlay" onClick={onClose}>
      <div className="search-modal" onClick={(e) => e.stopPropagation()}>
        <div className="search-input-row">
          <Search size={15} strokeWidth={2} className="search-icon" />
          <input
            ref={inputRef}
            className="search-input"
            placeholder="Search codebase..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            spellCheck={false}
            autoComplete="off"
          />
          {query && (
            <button className="search-clear" onClick={() => setQuery('')} title="Clear">
              <X size={13} strokeWidth={2} />
            </button>
          )}
        </div>
        <div className="search-list" ref={listRef}>
          {loading && <div className="search-empty">Searching...</div>}
          {!loading && query && results.length === 0 && (
            <div className="search-empty">No results found.</div>
          )}
          {!loading &&
            Object.entries(grouped).map(([type, items]) => (
              <div key={type}>
                <div className="search-group-label">{GROUP_LABELS[type] ?? type}</div>
                {items.map((r) => {
                  idx++;
                  const i = idx;
                  return (
                    <div
                      key={`${r.type}:${r.id}`}
                      className={`search-result${i === active ? ' active' : ''}`}
                      data-active={i === active ? 'true' : undefined}
                      onClick={() => {
                        onSelect(r);
                        onClose();
                      }}
                      onMouseEnter={() => setActive(i)}
                    >
                      <div className="search-result-name">{r.name}</div>
                      <div className="search-result-meta">
                        {r.detail && <span className="search-result-detail">{r.detail}</span>}
                        <span className="search-result-view">{VIEW_LABELS[r.view]}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
        </div>
        <div className="search-footer">
          <span className="search-hint">
            <ArrowUp size={11} /> <ArrowDown size={11} /> navigate
          </span>
          <span className="search-hint">
            <CornerDownLeft size={11} /> select
          </span>
          <span className="search-hint">esc close</span>
        </div>
      </div>
    </div>
  );
}
