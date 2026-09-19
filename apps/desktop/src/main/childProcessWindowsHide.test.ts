// Test de grep sobre el código fuente (apps/desktop/src/main): ningún archivo puede importar
// spawn/exec/execFile/execSync/spawnSync/execFileSync directo de 'node:child_process' sin forzar
// `windowsHide` — bug real v0.2.0 ("muchísimas ventanas de PowerShell/cmd parpadeando al iniciar" en
// una notebook Windows sin GPU dedicada). Electron corre como app GUI sin consola propia: cualquier
// ejecutable de consola (nvidia-smi, PowerShell, `where`, `rg`, `taskkill`) que se spawnee sin
// `windowsHide: true` abre una ventana visible un instante en Windows.
//
// El wrapper único de este paquete es `services/process/spawnHidden.ts` (spawnHidden/execFileHidden/
// execFileSyncHidden) — cualquier código nuevo debería usarlo en vez de `node:child_process` directo.
// Los pocos call-sites que siguen importando `node:child_process` directamente (services/ollama-
// process/index.ts) ya pasaban `windowsHide: true` explícito antes de esta tarea; este test los deja
// pasar porque el chequeo es "el archivo menciona windowsHide en alguna parte", no "usa el wrapper" —
// más simple y sin falsos positivos por nombres de parámetros inyectables (p. ej. `execSync` como
// nombre de un parámetro que en runtime apunta a `execFileSyncHidden`, no al `execSync` real de Node).
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = path.dirname(fileURLToPath(import.meta.url));
const RISKY_NAMES = ['spawn', 'execFile', 'exec', 'execSync', 'spawnSync', 'execFileSync'];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Nombres de funciones riesgosas importadas directo de 'node:child_process'/'child_process' (ignora
 *  imports type-only de tipos como `ChildProcess`/`SpawnOptions`, que no son invocables). */
function riskyChildProcessImports(content: string): string[] {
  const names: string[] = [];
  const importRe = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"](?:node:)?child_process['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(content)) !== null) {
    const clause = match[1] ?? '';
    for (const rawSpecifier of clause.split(',')) {
      const name = rawSpecifier.trim().split(/\s+as\s+/)[0]?.replace(/^type\s+/, '').trim();
      if (name && RISKY_NAMES.includes(name)) names.push(name);
    }
  }
  return names;
}

describe('auditoría windowsHide (apps/desktop/src/main)', () => {
  it('todo archivo que importe spawn/exec directo de node:child_process menciona windowsHide', () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(SRC_ROOT)) {
      const content = readFileSync(file, 'utf8');
      const risky = riskyChildProcessImports(content);
      if (risky.length > 0 && !content.includes('windowsHide')) {
        offenders.push(`${path.relative(SRC_ROOT, file)}: importa ${risky.join(', ')} de node:child_process sin 'windowsHide' en el archivo`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
