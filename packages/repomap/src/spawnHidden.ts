// Wrapper único de child_process para packages/repomap — packages/repomap/src/spawnHidden.ts.
// Mismo bug/mismo criterio que packages/runtime/src/util/spawnHidden.ts (ver ese comentario para el
// detalle): sin `windowsHide: true`, cualquier proceso de consola (acá, `rg --files`) que esta app GUI
// spawnea en Windows abre una ventana visible un instante. `packages/repomap` no depende de
// `packages/runtime` (es al revés), así que no puede reusar ESE wrapper — de ahí la duplicación
// mínima en vez de una dependencia cruzada nueva.
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';

/** `child_process.spawn` con `windowsHide` siempre forzado a `true`. Tipado sin `stdio` custom (los
 *  únicos llamadores de este paquete leen `child.stdout`/`child.stderr`, que TypeScript solo tipa
 *  como no-nulos con la sobrecarga `SpawnOptionsWithoutStdio` — igual que el `spawn` directo que
 *  reemplaza). */
export function spawnHidden(command: string, args: readonly string[] = [], options: SpawnOptionsWithoutStdio = {}): ChildProcessWithoutNullStreams {
  return spawn(command, [...args], { ...options, windowsHide: true });
}
