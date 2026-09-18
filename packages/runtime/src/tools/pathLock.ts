// Lock por rel_path para escrituras concurrentes — packages/runtime/src/tools/pathLock.ts.
// Define: doc 09 §3.3 punto 0 ("Adquiere un lock por rel_path dentro de WorkspaceFs, alcance proceso
// main, antes de llamar a checkpoint.before(); si no puede obtenerlo dentro de un timeout corto, la
// tool falla con ToolCallErrorCode = 'edit_conflict'"). Vive en tools/ (no en checkpoint/, fuera de mi
// alcance) porque son los handlers de edit_file/write_file/delete_file (tools/builtin/) los que deben
// mantenerlo tomado durante todo el ciclo begin -> escritura -> after, no solo durante el I/O.
import { ToolExecutionError } from './errors.js';

interface Waiter { resolve(): void }

/** Mutex en memoria por clave, alcance del proceso `main` (un solo `PathLock` por WorkspaceFs/proceso).
 *  No es reentrante: una misma clave tomada dos veces por el mismo llamador esperaría a sí misma. */
export class PathLock {
  private readonly held = new Set<string>();
  private readonly waiters = new Map<string, Waiter[]>();

  /** Espera hasta `timeoutMs` para tomar la clave; devuelve una función `release()`.
   *  Si vence el timeout, lanza ToolExecutionError('edit_conflict', ...). */
  async acquire(key: string, timeoutMs = 2000): Promise<() => void> {
    const start = Date.now();
    while (this.held.has(key)) {
      const remaining = timeoutMs - (Date.now() - start);
      if (remaining <= 0) {
        throw new ToolExecutionError('edit_conflict', `no se pudo obtener el lock de "${key}" (otra tool call lo tiene tomado)`);
      }
      await this.waitOrTimeout(key, remaining);
    }
    this.held.add(key);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.held.delete(key);
      const list = this.waiters.get(key);
      if (list && list.length > 0) {
        const next = list.shift();
        next?.resolve();
        if (list.length === 0) this.waiters.delete(key);
      }
    };
  }

  private waitOrTimeout(key: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const list = this.waiters.get(key);
        if (list) {
          const idx = list.indexOf(entry);
          if (idx >= 0) list.splice(idx, 1);
          if (list.length === 0) this.waiters.delete(key);
        }
        resolve();
      }, ms);
      const entry: Waiter = { resolve: () => { clearTimeout(timer); resolve(); } };
      const list = this.waiters.get(key) ?? [];
      list.push(entry);
      this.waiters.set(key, list);
    });
  }
}
