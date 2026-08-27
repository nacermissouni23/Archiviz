import { useEffect, useRef, useState } from 'react';
import { X, KeyRound, ShieldCheck, Trash2 } from 'lucide-react';

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
  const [removed, setRemoved] = useState(false);
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
      setMsg('Saved, annotating...');
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
      setRemoved(true);
      setMsg('Key removed.');
      onSaved();
    } catch {
      setMsg('Could not remove the key.');
    } finally {
      setBusy(false);
    }
  };

  const showInput = !hasKey || removed || key.length > 0;

  return (
    <div className="modal-overlay open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings-card">
        <button className="settings-close" title="Close" onClick={onClose}>
          <X size={14} strokeWidth={2} />
        </button>
        <div className="settings-icon">
          <KeyRound size={20} strokeWidth={1.8} />
        </div>
        <div className="settings-title">AI annotations</div>
        <p className="settings-desc">
          Enable human-readable labels on the Component Overview and System Context views.
          The graph is always built locally. AI only renames things.
        </p>
        <p className="settings-sub">Only Google AI Studio API keys are supported for now.</p>

        {hasKey && !removed && !key && (
          <div className="settings-status">
            <div className="settings-status-row">
              <span className="settings-status-dot" />
              <span>API key saved</span>
            </div>
            <button className="btn-ghost-small settings-remove" onClick={remove} disabled={busy}>
              <Trash2 size={12} strokeWidth={2} />
              Remove key
            </button>
          </div>
        )}

        {showInput && (
          <>
            {hasKey && !removed && !key && (
              <div className="settings-or">Replace with a new key</div>
            )}
            <input
              ref={inputRef}
              className="settings-input"
              type="password"
              placeholder="AIza..."
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && save()}
              spellCheck={false}
            />
          </>
        )}

        <div className="settings-actions">
          <div className="settings-actions-spacer" />
          <button className="btn-ghost-small" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {showInput && (
            <button
              className="btn-ghost-small settings-save"
              onClick={save}
              disabled={busy || !key.trim()}
            >
              Save
            </button>
          )}
        </div>
        {msg && <div className="settings-msg">{msg}</div>}
        <div className="settings-note">
          <ShieldCheck size={14} strokeWidth={1.8} />
          <span>
            Stored locally in <code>~/.archi/config.json</code>. Your code never leaves this
            machine, only the anonymous graph summary is sent to Google for labeling.
          </span>
        </div>
      </div>
    </div>
  );
}
