// Ejecutor de comandos externos (nvidia-smi, powershell.exe) — packages/runtime/src/models/CommandRunner.ts.
// Define: doc 08 §6 (HardwareProbe) y doc 13 §6 (detección de OLLAMA_MODELS). Utilidad compartida
// entre HardwareProbe.ts y ModelManager.ts para no duplicar la lógica de invocar procesos externos;
// se inyecta como dependencia para que los tests puedan mockear stdout/stderr sin lanzar procesos
// reales (regla: "no uses Ollama real en tests"; lo mismo aplica a nvidia-smi/PowerShell reales).
import { execFile } from 'node:child_process';

export interface CommandResult { stdout: string; stderr: string }

/** `(cmd, args) => Promise<{stdout, stderr}>`; rechaza si el proceso sale con código != 0. */
export type CommandRunner = (cmd: string, args: string[]) => Promise<CommandResult>;

/** Runner real basado en child_process.execFile. pwsh 7 NO está instalado en el equipo de
 *  referencia (RESULTADOS-electron.md): se usa siempre `powershell.exe` para PowerShell, nunca
 *  `pwsh.exe` a ciegas. */
export const realCommandRunner: CommandRunner = (cmd, args) =>
  new Promise<CommandResult>((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 5000 }, (error, stdout, stderr) => {
      if (error) { reject(error); return; }
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });

export const POWERSHELL_EXE = 'powershell.exe';
