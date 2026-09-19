// Bloque dinámico de entorno para el system prompt — packages/runtime/src/agent/environmentPrompt.ts.
// Feedback real v0.2.1 (usuario, modo Agente): "a '¿tenés acceso a la carpeta del proyecto?' contestó
// 'No tengo acceso a carpetas externas'" y "creá 5 carpetas... encadenó `mkdir -p A/B/C && ...`" (sintaxis
// bash, inválida en PowerShell nativo). Punto 3 del encargo: el system prompt tiene que decir
// EXPLÍCITAMENTE la carpeta de trabajo real, que el agente SÍ tiene acceso de lectura/escritura ahí
// (según los permisos vigentes), el sistema operativo y el shell reales, con sus reglas de sintaxis.
//
// Deliberadamente separado de `DEFAULT_SYSTEM_PROMPT` (defaults.ts): ese string es el que se hashea en
// `AgentConfig.systemPromptHash`/`run.effective_config_json` (doc 02 §1, "prefijo estable para el
// cache") y es el mismo para cualquier proyecto/carpeta. Este bloque depende de `workingDir` (distinto
// por proyecto) y se concatena en `context-builder.ts` DESPUÉS del system prompt del agente, en el
// mismo punto donde ya vive el sufijo de modo plan — sigue siendo estable DENTRO de un run (no cambia
// turno a turno, solo entre proyectos), así que no rompe el cacheo de prefijo de la sesión.
import os from 'node:os';
import { resolveShell } from '../tools/builtin/run_command.js';

function describePlatform(): string {
  switch (process.platform) {
    case 'win32': return 'Windows';
    case 'darwin': return 'macOS';
    case 'linux': return 'Linux';
    default: return process.platform;
  }
}

/** Nombre legible del shell real que va a ejecutar `run_command` en esta máquina — mismo resultado
 *  que usa la tool (`resolveShell`, cacheado), para no prometerle al modelo una sintaxis que después
 *  no es la que realmente corre. */
function describeShell(): { name: string; rules: string } {
  if (process.platform === 'win32') {
    const isPwsh = resolveShell().exe === 'pwsh.exe';
    const name = isPwsh ? 'PowerShell 7 (pwsh.exe)' : 'Windows PowerShell 5.1 (powershell.exe)';
    const rules = isPwsh
      ? 'Sintaxis PowerShell: NO uses `mkdir -p` (no existe) — usá `New-Item -ItemType Directory -Force -Path <ruta>` o, mejor, la tool `make_dir`. `&&`/`||` SÍ funcionan encadenando comandos en pwsh 7, pero preferí `;` o comandos separados si no te importa que el segundo corra aunque el primero falle.'
      : 'Sintaxis PowerShell 5.1: NO uses `mkdir -p` (no existe) — usá `New-Item -ItemType Directory -Force -Path <ruta>` o, mejor, la tool `make_dir`. `&&` y `||` NO existen en esta versión (rompen el comando) — separá con `;` o con comandos en llamadas distintas.';
    return { name, rules };
  }
  return {
    name: 'bash',
    rules: 'Sintaxis bash: `mkdir -p <ruta>` es válido para crear carpetas anidadas (igual, preferí la tool `make_dir` si solo necesitás crear carpetas). `&&`/`||` funcionan normalmente.',
  };
}

/** `folderIsEmpty` es best-effort (lo resuelve quien arma el run, ej. `RunController`, con
 *  `fs.readdir` — no se recalcula acá para no acoplar este módulo a I/O). `undefined` = no se sabe
 *  (se omite esa línea en vez de afirmar algo no verificado, regla del punto 3 "reportar solo lo
 *  verificado" aplicada también al propio prompt). */
export function buildEnvironmentPrompt(workingDir: string, folderIsEmpty?: boolean): string {
  const shell = describeShell();
  const lines = [
    '',
    '## Entorno real de este proyecto',
    `Carpeta de trabajo: ${workingDir}`,
    'Tenés acceso de lectura y escritura dentro de esa carpeta (según los permisos vigentes de este chat) — NO es una carpeta externa ni fuera de tu alcance.',
    ...(folderIsEmpty === true ? ['La carpeta está vacía: podés crear archivos y carpetas nuevos ahí sin problema.'] : []),
    `Sistema operativo: ${describePlatform()}.`,
    `Shell real de \`run_command\`: ${shell.name}.`,
    shell.rules,
  ];
  return lines.join('\n');
}
