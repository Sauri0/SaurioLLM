// Wrapper único de child_process para apps/desktop/src/main — apps/desktop/src/main/services/process/
// spawnHidden.ts. Mismo bug/mismo criterio que packages/runtime/src/util/spawnHidden.ts (ver ese
// comentario para el detalle del bug real): sin `windowsHide: true`, cualquier proceso de consola que
// esta app GUI spawnea en Windows (nvidia-smi, `where`, PowerShell) abre una ventana visible un
// instante. Duplicado a propósito en vez de importado desde packages/runtime: apps/desktop es el
// consumidor final del monorepo (packages/runtime no depende de apps/desktop, nunca al revés), y este
// archivo no necesita nada Electron-específico como para justificar vivir en otro lado.
import { spawn, execFile, execFileSync, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio, type ExecFileOptions, type ExecFileSyncOptions } from 'node:child_process';

export interface ExecHiddenResult { stdout: string; stderr: string }

/** `child_process.spawn` con `windowsHide` siempre forzado a `true`. Tipado sin `stdio` custom para
 *  que `child.stdout`/`stderr` salgan no-nulos. */
export function spawnHidden(command: string, args: readonly string[] = [], options: SpawnOptionsWithoutStdio = {}): ChildProcessWithoutNullStreams {
  return spawn(command, [...args], { ...options, windowsHide: true });
}

/** `child_process.execFile` en forma de Promise, con `windowsHide` forzado — reemplaza
 *  `util.promisify(execFile)` (que sin un tercer argumento de opciones nunca aplicaría `windowsHide`). */
export function execFileHidden(command: string, args: readonly string[] = [], options: ExecFileOptions = {}): Promise<ExecHiddenResult> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { ...options, windowsHide: true }, (error, stdout, stderr) => {
      if (error) { reject(error); return; }
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

/** `child_process.execFileSync` con `windowsHide` forzado. */
export function execFileSyncHidden(command: string, args: readonly string[] = [], options: ExecFileSyncOptions = {}): Buffer | string {
  return execFileSync(command, [...args], { ...options, windowsHide: true } as ExecFileSyncOptions);
}
