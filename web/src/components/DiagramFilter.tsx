import { useEffect, useRef } from 'react';
import { Filter, X } from 'lucide-react';

export default function DiagramFilter({
  open,
  onToggle,
  query,
  onQueryChange,
  matchCount,
  totalCount,
}: {
  open: boolean;
  onToggle: () => void;
  query: string;
  onQueryChange: (q: string) => void;
  matchCount: number;
  totalCount: number;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  if (!open) {
    return (
      <button title="Filter diagram" onClick={onToggle}>
        <Filter size={14} strokeWidth={2} />
      </button>
    );
  }

  return (
    <div className="diagram-filter-bar">
      <input
        ref={inputRef}
        className="diagram-filter-input"
        placeholder="Filter..."
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            onQueryChange('');
            onToggle();
          }
        }}
        spellCheck={false}
      />
      {query && (
        <span className="diagram-filter-count">
          {matchCount} / {totalCount}
        </span>
      )}
      <button
        className="diagram-filter-clear"
        title="Clear filter"
        onClick={() => {
          onQueryChange('');
          onToggle();
        }}
      >
        <X size={12} strokeWidth={2} />
      </button>
    </div>
  );
}
