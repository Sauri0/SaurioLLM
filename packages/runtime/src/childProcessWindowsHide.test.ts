// Test de grep sobre el código fuente (packages/runtime/src): ningún archivo puede importar
// spawn/exec/execFile/execSync/spawnSync/execFileSync directo de 'node:child_process' sin forzar
// `windowsHide` — mismo bug real v0.2.0 documentado en apps/desktop/src/main/
// childProcessWindowsHide.test.ts ("ventanas de PowerShell/cmd parpadeando al iniciar" en Windows sin
// GPU dedicada). El wrapper único de este paquete es `util/spawnHidden.ts` (spawnHidden/
// execFileHidden/execFileSyncHidden); los call-sites que siguen importando 'node:child_process'
// directo (checkpoint/git.ts, models/CommandRunner.ts, tools/builtin/search_code.ts,
// tools/builtin/run_command.ts) ya pasaban `windowsHide: true` explícito antes de esta tarea, así que
// pasan el chequeo igual (el criterio es "el archivo menciona windowsHide", no "usa el wrapper").
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

describe('auditoría windowsHide (packages/runtime/src)', () => {
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
