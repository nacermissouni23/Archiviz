import { useEffect, useRef, useState } from 'react';
import { X, KeyRound, ShieldCheck } from 'lucide-react';

export default function SettingsModal({
  hasKey,
  onClose,
  onSaved,
}: {
  hasKey: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 30);
    const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [onClose]);

  const save = async () => {
    if (!key.trim() || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch('/api/ai/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: key.trim() }),
      });
      if (!r.ok) throw new Error('failed');
      setMsg('Saved — annotating…');
      onSaved();
      setTimeout(onClose, 700);
    } catch {
      setMsg('Could not save the key.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await fetch('/api/ai/key', { method: 'DELETE' });
      setMsg('Key removed.');
      onSaved();
      setTimeout(onClose, 500);
    } catch {
      setMsg('Could not remove the key.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings-card">
        <button className="ov-info-close" title="Close" onClick={onClose}>
          <X size={13} strokeWidth={2} />
        </button>
        <div className="settings-title">
          <KeyRound size={15} strokeWidth={1.8} />
          AI annotations
        </div>
        <p className="settings-desc">
          Paste a Google AI Studio API key to enable human-readable labels on the Component
          Overview and System Context views. The graph itself is always built locally — AI only
          renames things.
        </p>
        <input
          ref={inputRef}
          className="settings-input"
          type="password"
          placeholder="AIza…"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
          spellCheck={false}
        />
        <div className="settings-actions">
          {hasKey && (
            <button className="btn-ghost-small" onClick={remove} disabled={busy}>
              Remove key
            </button>
          )}
          <span className="toolbar-spacer" />
          <button className="btn-ghost-small" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn-ghost-small settings-save"
            onClick={save}
            disabled={busy || !key.trim()}
          >
            Save
          </button>
        </div>
        {msg && <div className="settings-msg">{msg}</div>}
        <div className="settings-note">
          <ShieldCheck size={12} strokeWidth={1.8} />
          Stored locally in <code>~/.archi/config.json</code>. Your code never leaves this machine —
          only the anonymous graph summary is sent to Google for labeling.
        </div>
      </div>
    </div>
  );
}
