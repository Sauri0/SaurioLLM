// Wrapper único de child_process para packages/runtime — packages/runtime/src/util/spawnHidden.ts.
//
// BUG REAL (usuario real, notebook Windows 11 sin NVIDIA, v0.2.0): "muchísimas ventanas de
// PowerShell/cmd abriéndose y cerrándose" al iniciar la app. Causa: Electron corre como app GUI (sin
// consola propia); cualquier `child_process.spawn/exec/execFile(Sync)` que lance un ejecutable de
// consola en Windows SIN la opción `windowsHide: true` hace que Windows le abra una consola nueva,
// visible un instante y después cerrada — el parpadeo reportado. `windowsHide: true` (flag
// `CREATE_NO_WINDOW` de Win32) evita esa ventana.
//
// Este módulo es el ÚNICO lugar de packages/runtime que importa 'node:child_process' fuera de los
// call-sites que YA pasaban `windowsHide: true` de forma explícita antes de esta tarea (`checkpoint/
// git.ts`, `tools/builtin/search_code.ts`, `models/CommandRunner.ts` — se dejaron como estaban para no
// tocar código ya correcto sin necesidad). Todo llamado NUEVO o corregido en esta tarea pasa por acá.
import { spawn, execFile, execFileSync, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio, type ExecFileOptions, type ExecFileSyncOptions } from 'node:child_process';

export interface ExecHiddenResult { stdout: string; stderr: string }

/** `child_process.spawn` con `windowsHide` siempre forzado a `true` (no sobreescribible por
 *  `options.windowsHide` — a propósito: este wrapper existe justamente para que nadie pueda spawnear
 *  sin ocultar la consola). Tipado sin `stdio` custom para que `child.stdout`/`stderr` salgan no-nulos
 *  (mismo criterio que `search_code.ts`, que lee `child.stdout` directo). */
export function spawnHidden(command: string, args: readonly string[] = [], options: SpawnOptionsWithoutStdio = {}): ChildProcessWithoutNullStreams {
  return spawn(command, [...args], { ...options, windowsHide: true });
}

/** `child_process.execFile` en forma de Promise, con `windowsHide` forzado — equivalente a
 *  `util.promisify(execFile)` pero sin el hueco de `promisify(execFile)(cmd, args)` (sin tercer
 *  argumento de opciones, `windowsHide` nunca se aplicaría). */
export function execFileHidden(command: string, args: readonly string[] = [], options: ExecFileOptions = {}): Promise<ExecHiddenResult> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { ...options, windowsHide: true }, (error, stdout, stderr) => {
      if (error) { reject(error); return; }
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

/** `child_process.execFileSync` con `windowsHide` forzado — para chequeos rápidos ("¿existe este
 *  comando?") o kill de árbol de procesos donde no vale la pena volverse async. */
export function execFileSyncHidden(command: string, args: readonly string[] = [], options: ExecFileSyncOptions = {}): Buffer | string {
  return execFileSync(command, [...args], { ...options, windowsHide: true } as ExecFileSyncOptions);
}
