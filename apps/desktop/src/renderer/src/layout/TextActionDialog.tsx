import { useCallback, useEffect, useRef, useState } from 'react';
import { focusTrapTarget, shouldRestoreOverlayFocus } from './dialogFocus.js';
import './textActionDialog.css';

export interface TextActionDialogProps {
  title: string;
  description?: string;
  label?: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  /** Disparador conocido cuando el diálogo reemplaza un menú que se desmonta al abrirse. */
  restoreFocusTo?: HTMLElement | null;
  /** Destino estable si la acción confirmó y desmontó el disparador original. */
  restoreFocusFallbackTo?: HTMLElement | null;
  onCancel(): void;
  onConfirm(value?: string): void | Promise<void>;
}

/** Diálogo pequeño para acciones de Sidebar; evita depender de prompt/confirm nativos de Electron. */
export function TextActionDialog({
  title,
  description,
  label,
  initialValue = '',
  placeholder,
  confirmLabel,
  cancelLabel = 'Cancelar',
  destructive = false,
  busy = false,
  restoreFocusTo,
  restoreFocusFallbackTo,
  onCancel,
  onConfirm,
}: TextActionDialogProps): React.JSX.Element {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const submittingRef = useRef(false);
  const openerRef = useRef<HTMLElement | null>(null);
  const requiresText = label !== undefined || placeholder !== undefined || initialValue !== '';
  const initialRequiresTextRef = useRef(requiresText);
  const [actionError, setActionError] = useState<string | null>(null);

  const submit = useCallback((): void => {
    if (busy || submittingRef.current || (requiresText && !value.trim())) return;
    submittingRef.current = true;
    setActionError(null);
    void Promise.resolve(onConfirm(requiresText ? value.trim() : undefined)).catch((err: unknown) => {
      setActionError(err instanceof Error ? err.message : String(err));
    }).finally(() => { submittingRef.current = false; });
  }, [busy, onConfirm, requiresText, value]);

  useEffect(() => {
    const dialog = dialogRef.current;
    const opener = restoreFocusTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    openerRef.current = opener;
    if (initialRequiresTextRef.current) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else {
      confirmRef.current?.focus();
    }
    return () => {
      const active = document.activeElement;
      if (shouldRestoreOverlayFocus(active, document.body, (target) => dialog?.contains(target) ?? false)) {
        const target = opener?.isConnected ? opener : restoreFocusFallbackTo?.isConnected ? restoreFocusFallbackTo : null;
        target?.focus({ preventScroll: true });
      }
    };
  }, [restoreFocusFallbackTo, restoreFocusTo]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape' && !busy) onCancel();
      if (event.key === 'Enter' && !requiresText && !busy) submit();
      if (event.key === 'Tab') {
        const dialog = document.querySelector<HTMLElement>('.saurio-text-dialog');
        if (!dialog) return;
        const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])'))
          .filter((element) => !element.hidden
            && !element.closest('[hidden], [aria-hidden="true"]')
            && getComputedStyle(element).display !== 'none'
            && getComputedStyle(element).visibility !== 'hidden');
        if (focusable.length === 0) return;
        const target = focusTrapTarget(focusable, document.activeElement as HTMLElement | null, event.shiftKey);
        if (target) { event.preventDefault(); target.focus(); }
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [busy, onCancel, requiresText, submit]);

  return (
    <div className="saurio-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onCancel();
    }}>
      <section ref={dialogRef} className="saurio-text-dialog" role="dialog" aria-modal="true" aria-labelledby="saurio-text-dialog-title">
        <h2 id="saurio-text-dialog-title">{title}</h2>
        {description && <p>{description}</p>}
        {actionError && <div className="saurio-banner danger saurio-text-dialog__error" role="alert">{actionError}</div>}
        {requiresText && (
          <label className="saurio-text-dialog__field">
            <span>{label ?? 'Nombre'}</span>
            <input
              ref={inputRef}
              value={value}
              placeholder={placeholder}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submit(); } }}
              disabled={busy}
            />
          </label>
        )}
        <div className="saurio-text-dialog__actions">
          <button type="button" className="saurio-btn-ghost" onClick={onCancel} disabled={busy}>{cancelLabel}</button>
          <button ref={confirmRef} type="button" className={destructive ? 'saurio-btn-danger' : 'saurio-btn-primary'} onClick={submit} disabled={busy || (requiresText && !value.trim())}>
            {busy ? 'Guardando…' : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
