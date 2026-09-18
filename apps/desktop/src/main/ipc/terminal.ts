// Handlers IPC del dominio "terminal" (doc 02 §1: apps/desktop/src/main/ipc/terminal.ts, doc 01 §6,
// §4.10). A diferencia del resto de los dominios, TerminalService es 100% de apps/desktop (node-pty +
// MessagePort), sin dependencia de packages/runtime: estos handlers son funcionales ya, no quedan
// pendientes de integración.
import { ipc } from '@saurio/shared';
import { generateTerminalId, TerminalService } from '../services/terminal/index.js';
import { registerHandler } from './registerHandler.js';

/** Abre el canal de datos de una terminal recién creada: doc 04 §16, PreloadApi.onTerminalPort —
 *  un MessagePort no puede devolverse como valor de retorno de `invoke`, así que main lo transfiere
 *  por separado con `webContents.postMessage('terminal:port', { terminalId }, [port1])` (implementado
 *  en main/index.ts, que es quien conoce el BrowserWindow). */
export interface TerminalPortHandle {
  onData(cb: (chunk: string) => void): void;
  postData(chunk: string): void;
  close(): void;
}

export interface TerminalPortOpener {
  openPort(terminalId: string): TerminalPortHandle;
}

export function registerTerminalHandlers(
  service: TerminalService,
  ports: TerminalPortOpener,
  workingDir: () => string,
): void {
  registerHandler('terminal:create', ipc['terminal:create'], async (input) => {
    const terminalId = generateTerminalId();
    const port = ports.openPort(terminalId);

    // Deviation: `input.projectId` debería resolver el cwd de ESE proyecto vía ProjectRepository
    // (packages/runtime/src/persistence/types.ts), todavía sin instancia real conectada (ver
    // RuntimeHost.projectRepository); por ahora `workingDir()` devuelve un cwd fijo inyectado desde
    // main/index.ts (el último proyecto abierto o el home del usuario), sin distinguir por proyecto.
    service.create(
      terminalId,
      { cwd: workingDir(), shell: input.shell },
      (chunk) => port.postData(chunk),
      () => port.close(),
    );
    port.onData((chunk) => service.write(terminalId, chunk));

    return { terminalId };
  });

  registerHandler('terminal:resize', ipc['terminal:resize'], async (input) => {
    service.resize(input.terminalId, input.cols, input.rows);
  });

  registerHandler('terminal:close', ipc['terminal:close'], async (input) => {
    service.close(input.terminalId);
  });
}
