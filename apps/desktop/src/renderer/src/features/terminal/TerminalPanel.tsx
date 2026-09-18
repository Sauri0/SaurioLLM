// Panel "Terminal": xterm + addon-fit conectado por MessagePort real (doc 01 §4.10 TerminalService:
// "node-pty + xterm"; doc 04 §16 `terminal:create/resize/close` + `onTerminalPort`), con varias
// pestañas básicas (punto 5 del encargo). apps/desktop/src/renderer/src/features/terminal/TerminalPanel.tsx.
//
// Integración: `window.saurio` es exactamente `PreloadApi` desde hace rato (doc 16 §2) — el
// `onTerminalPort` de `ipc/client.ts` YA NO es un stub que devuelve `never`; esta reescritura deja de
// pasar por `layout/ipcRaw.ts` (que existía solo mientras el preload no coincidía con el contrato) y
// agrega el manejo de varias sesiones de terminal por proyecto vía `terminalStore`.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { MessagePortLike } from '@saurio/shared';
import { invoke, onTerminalPort } from '../../ipc/client.js';
import { useTerminalStore } from '../../stores/terminalStore.js';

/** `MessagePortLike` (packages/shared, sin lib DOM) no declara `onmessage` a propósito — un
 *  `MessageEvent` del DOM no es asignable a la forma mínima `{ data: unknown }` que ese paquete
 *  puede tipar sin arrastrar `lib.dom`. Acá, en el renderer (que sí tiene DOM), se amplía
 *  localmente: el `MessagePort` real que entrega el preload (doc 04 §16 Desvíos §5) sí tiene esta
 *  propiedad en runtime. */
type ListenablePort = MessagePortLike & { onmessage: ((event: { data: unknown }) => void) | null };

export interface TerminalPanelProps {
  projectId: string | null;
}

interface TerminalTabViewProps {
  terminalId: string;
  visible: boolean;
}

/** Una pestaña = una sesión de terminal real (un `node-pty` en main, un `xterm` acá). Se mantiene
 *  montada aunque no esté visible (solo `display:none`) para no perder el scrollback al cambiar de
 *  pestaña — el proceso de main sigue vivo igual, cambiar de pestaña no lo toca. */
function TerminalTabView({ terminalId, visible }: TerminalTabViewProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let port: MessagePortLike | undefined;

    const term = new Terminal({
      convertEol: true,
      fontFamily: 'Cascadia Code, Consolas, ui-monospace, monospace',
      fontSize: 13,
      theme: { background: '#1b1d21', foreground: '#e4e4e6' },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.fit();

    const resizeObserver = new ResizeObserver(() => {
      if (container.offsetParent === null) return; // oculta (display:none): fit() da 0x0
      fitAddon.fit();
      void invoke('terminal:resize', { terminalId, cols: term.cols, rows: term.rows });
    });
    resizeObserver.observe(container);

    const unsubscribePort = onTerminalPort((portTerminalId, receivedPort) => {
      if (portTerminalId !== terminalId || disposed) return;
      port = receivedPort;
      (port as ListenablePort).onmessage = (ev) => {
        if (typeof ev.data === 'string') term.write(ev.data);
      };
      port.start();
    });

    term.onData((data) => port?.postMessage(data));

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      unsubscribePort();
      port?.close();
      term.dispose();
    };
  }, [terminalId]);

  return (
    <div style={{ display: visible ? 'flex' : 'none', flexDirection: 'column', height: '100%' }}>
      <div ref={containerRef} style={{ flex: 1, minHeight: 0 }} />
    </div>
  );
}

export function TerminalPanel({ projectId }: TerminalPanelProps): React.JSX.Element {
  const sessions = useTerminalStore((s) => (projectId ? s.sessionsByProject[projectId] ?? [] : []));
  const create = useTerminalStore((s) => s.create);
  const close = useTerminalStore((s) => s.close);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const requestedFirst = useRef<string | null>(null);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const openTab = useCallback(async () => {
    if (!projectId) return;
    setCreating(true);
    setError(null);
    try {
      const terminalId = await create(projectId);
      setActiveId(terminalId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }, [projectId, create]);

  // Primera pestaña automática al abrir el panel con un proyecto (mismo comportamiento que antes de
  // tener pestañas: nunca un panel de terminal vacío sin que el usuario pida nada).
  useEffect(() => {
    if (!projectId) return;
    if (sessions.length > 0) {
      setActiveId((current) => current ?? sessions[0]?.terminalId ?? null);
      return;
    }
    if (requestedFirst.current === projectId) return;
    requestedFirst.current = projectId;
    void openTab();
  }, [projectId, sessions, openTab]);

  // Al desmontar el panel entero (p. ej. cambiar de pestaña en el panel derecho): un `MessagePort`
  // ya transferido no se puede recuperar en un remount (doc 04 §16 Desvíos §5, transferencia
  // única), así que mantener las sesiones vivas en `terminalStore` sin ninguna vista suscripta
  // dejaría procesos `node-pty` huérfanos en main. Se cierran todas al desmontar; el usuario que
  // vuelve a la pestaña Terminal arranca sesiones nuevas (mismo criterio que la versión sin
  // pestañas: cada apertura del panel = terminal nueva).
  useEffect(() => {
    const currentProjectId = projectId;
    return () => {
      if (!currentProjectId) return;
      for (const session of sessionsRef.current) void close(session.terminalId, currentProjectId);
    };
  }, [projectId, close]);

  const closeTab = useCallback(async (terminalId: string) => {
    if (!projectId) return;
    await close(terminalId, projectId).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    setActiveId((current) => (current === terminalId ? null : current));
  }, [projectId, close]);

  if (!projectId) return <p className="saurio-empty">Abrí un proyecto para abrir una terminal.</p>;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {error && <div className="saurio-banner danger">{error}</div>}
      <div className="saurio-tabs" role="tablist" style={{ marginBottom: 4 }}>
        {sessions.map((session, index) => (
          <div
            key={session.terminalId}
            role="tab"
            aria-selected={activeId === session.terminalId}
            className={`saurio-tab${activeId === session.terminalId ? ' active' : ''}`}
            onClick={() => setActiveId(session.terminalId)}
            title={session.terminalId}
          >
            <span className="saurio-tab__label">Terminal {index + 1}</span>
            <span
              onClick={(ev) => { ev.stopPropagation(); void closeTab(session.terminalId); }}
              title="Cerrar pestaña"
              style={{ marginLeft: 6, cursor: 'pointer' }}
            >
              ×
            </span>
          </div>
        ))}
        <button onClick={() => void openTab()} disabled={creating} title="Nueva pestaña de terminal">
          {creating ? '…' : '+ Terminal'}
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {sessions.length === 0 && !creating && <p className="saurio-empty">Sin terminales abiertas.</p>}
        {sessions.map((session) => (
          <TerminalTabView key={session.terminalId} terminalId={session.terminalId} visible={activeId === session.terminalId} />
        ))}
      </div>
    </div>
  );
}
