import { useState } from 'react';
import { invoke } from '../../ipc/client.js';
import { TextActionDialog } from '../../layout/TextActionDialog.js';

/** Regenerar conserva el historial y repite el pedido original, con el modelo de esa ejecución. */
export function RegenerateRunButton({ runId, disabled }: { runId: string; disabled: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  async function regenerate(): Promise<void> {
    if (busy || disabled) return;
    setBusy(true);
    try {
      await invoke('run:regenerate', { runId });
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }
  return <>
    <button type="button" className="saurio-btn-ghost" disabled={disabled || busy} onClick={() => setOpen(true)}>
      Regenerar respuesta
    </button>
    {open && <TextActionDialog
      title="Regenerar respuesta"
      description="Repite el pedido original con el mismo modelo y conserva la respuesta anterior. Puede volver a ejecutar herramientas con sus permisos y generar consumo si usás un proveedor por API."
      confirmLabel={busy ? 'Preparando…' : 'Repetir pedido'}
      busy={busy || disabled}
      onCancel={() => { if (!busy) setOpen(false); }}
      onConfirm={regenerate}
    />}
  </>;
}
