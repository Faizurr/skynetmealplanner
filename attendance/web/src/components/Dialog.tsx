import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Button, IconButton, InlineError, TextArea, Field } from './ui';
import { errorMessage } from '../lib/api';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
let openCount = 0;

/** Modal dialog; becomes a bottom sheet on mobile. `side` renders a right-side panel on desktop. */
export function Dialog({ open, onClose, title, description, children, footer, wide, side, labelledBy }: {
  open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children?: ReactNode; footer?: ReactNode; wide?: boolean; side?: boolean; labelledBy?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const autoId = useId();
  const titleId = labelledBy ?? `${autoId}-title`;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    const prev = document.activeElement as HTMLElement | null;
    openCount++;
    document.body.style.overflow = 'hidden';
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>('.dialog-body ' + FOCUSABLE) ?? el;
    window.setTimeout(() => first?.focus(), 10);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === 'Tab' && el) {
        const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.offsetParent !== null);
        if (!items.length) return;
        const a = items[0];
        const b = items[items.length - 1];
        if (e.shiftKey && document.activeElement === a) {
          e.preventDefault();
          b.focus();
        } else if (!e.shiftKey && document.activeElement === b) {
          e.preventDefault();
          a.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      openCount--;
      if (openCount <= 0) document.body.style.overflow = '';
      prev?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className={`overlay ${side ? 'sheet-side' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={`dialog ${wide ? 'dialog-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="dialog-head">
          <div className="grow">
            <h2 id={titleId}>{title}</h2>
            {description && <div className="desc">{description}</div>}
          </div>
          <IconButton icon={X} label="Close" size="sm" onClick={onClose} />
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Confirmation with optional required note / typed confirmation; shows API errors inline. */
export function ConfirmDialog({ open, onClose, title, description, confirmLabel = 'Confirm', danger, onConfirm, note, typeToConfirm, children }: {
  open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; confirmLabel?: string; danger?: boolean;
  onConfirm: (note: string) => Promise<unknown> | unknown; note?: { label: string; required?: boolean; placeholder?: string }; typeToConfirm?: string; children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [typed, setTyped] = useState('');
  const noteId = useId();
  const typeId = useId();
  useEffect(() => {
    if (open) {
      setErr(null);
      setText('');
      setTyped('');
      setBusy(false);
    }
  }, [open]);
  const blocked = (note?.required && text.trim().length < 3) || (typeToConfirm !== undefined && typed.trim().toUpperCase() !== typeToConfirm.toUpperCase());
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onConfirm(text.trim());
      onClose();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={danger ? 'danger' : 'primary'} loading={busy} disabled={blocked} onClick={submit}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="stack">
        {description && <div className="muted small">{description}</div>}
        {children}
        {note && (
          <Field label={note.label} optional={!note.required} htmlFor={noteId} help={note.required ? 'At least 3 characters. Saved in the audit log.' : 'Saved in the audit log.'}>
            <TextArea id={noteId} value={text} onChange={(e) => setText(e.target.value)} placeholder={note.placeholder} maxLength={300} />
          </Field>
        )}
        {typeToConfirm !== undefined && (
          <Field label={<>Type <strong>{typeToConfirm}</strong> to confirm</>} htmlFor={typeId}>
            <input id={typeId} className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="characters" />
          </Field>
        )}
        <InlineError>{err}</InlineError>
      </div>
    </Dialog>
  );
}
