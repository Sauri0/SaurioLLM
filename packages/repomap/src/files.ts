// Listado de archivos del proyecto: `rg --files` + `.saurioignore`, exclusión de binarios y
// archivos > 1 MB (doc 07 §2.1 paso 1).
import { statSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ignore from 'ignore';
import type { RepoFile, SupportedLang } from './types.js';
import { spawnHidden } from './spawnHidden.js';

export const MAX_FILE_BYTES = 1024 * 1024; // 1 MB (doc 07 §2.1 paso 1)

const EXT_TO_LANG: Record<string, SupportedLang> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.pyi': 'python',
};

/** Lenguaje soportado por extensión, o undefined si no hay grammar en el MVP (doc 07 §2.5:
 *  degrada a árbol plano). */
export function langForFile(relPath: string): SupportedLang | undefined {
  return EXT_TO_LANG[path.extname(relPath).toLowerCase()];
}

/** Extensiones tratadas como binarias sin necesidad de sniffear bytes (heurística barata; el resto
 *  se decide por presencia de bytes NUL en los primeros 8 KiB, ver `looksBinary`). */
const KNOWN_BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg', '.pdf',
  '.zip', '.gz', '.tar', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.node',
  '.wasm', '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4', '.mov', '.avi',
  '.db', '.sqlite', '.sqlite3', '.bin', '.class', '.jar', '.pyc',
]);

function looksBinary(absPath: string): boolean {
  const ext = path.extname(absPath).toLowerCase();
  if (KNOWN_BINARY_EXT.has(ext)) return true;
  try {
    const fd = readFileSync(absPath, { encoding: null, flag: 'r' }).subarray(0, 8192);
    return fd.includes(0);
  } catch {
    return true; // ilegible: se trata como binario para no romper el indexado
  }
}

/** `.saurioignore` propio de SaurioLLM (doc 07 §2.1 paso 1): node_modules/, dist/, .saurio/,
 *  blobs de checkpoints, y lo que el usuario agregue en el archivo del proyecto. */
const DEFAULT_SAURIOIGNORE = [
  'node_modules/',
  'dist/',
  'out/',
  '.saurio/',
  '.git/',
  '*.wasm',
];

function loadSaurioIgnore(projectRoot: string): string[] {
  const file = path.join(projectRoot, '.saurioignore');
  const lines = [...DEFAULT_SAURIOIGNORE];
  if (existsSync(file)) {
    try {
      const content = readFileSync(file, 'utf8');
      lines.push(...content.split(/\r?\n/).filter((l) => l.trim().length > 0 && !l.trim().startsWith('#')));
    } catch {
      // .saurioignore ilegible: se sigue solo con los defaults, no bloquea el indexado (doc 07 §2.5)
    }
  }
  return lines;
}

/** BUG REAL v0.2.0 ("ventanas de consola parpadeando al iniciar"): `rg` es un ejecutable de consola —
 *  sin `windowsHide: true` abre una ventana visible cada vez que se indexa un proyecto (apertura +
 *  cada reindexado disparado por cambios de archivos). `spawnHidden` lo fuerza siempre. */
function runRgFiles(projectRoot: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    const child = spawnHidden('rg', ['--files', '--hidden', '--glob', '!.git'], { cwd: projectRoot });
    let out = '';
    let errored = false;
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.on('error', () => {
      errored = true;
      resolve(null); // rg no está en PATH: el llamador cae al walker manual (ver walkManually)
    });
    child.on('close', () => {
      if (errored) return;
      resolve(out.split(/\r?\n/).filter((l) => l.length > 0));
    });
  });
}

const ALWAYS_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.saurio']);

/**
 * Fallback cuando `rg` no está disponible en el equipo (visto en este entorno: `rg` solo existe
 * como función de shell de Claude Code, no como binario en PATH accesible a `child_process.spawn`
 * — mismo tipo de gotcha que pwsh 7 documentado en N:\saurio-smoke\RESULTADOS-electron.md).
 * Camina el árbol a mano; no interpreta `.gitignore` (solo evita los directorios más costosos por
 * nombre) — degradación aceptable para no bloquear el indexado (doc 07 §2.5), la app empaquetada
 * sigue usando `rg --files` como pide la arquitectura.
 */
function walkManually(projectRoot: string): string[] {
  const results: string[] = [];
  const stack: string[] = [projectRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (ALWAYS_SKIP_DIRS.has(entry.name)) continue;
        stack.push(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        results.push(path.relative(projectRoot, path.join(dir, entry.name)));
      }
    }
  }
  return results;
}

/**
 * Lista los archivos indexables del proyecto (doc 07 §2.1 paso 1): `rg --files` respetando
 * `.gitignore` de forma nativa, filtrado por `.saurioignore`, excluyendo binarios y archivos
 * > 1 MB. Si `rg` no está disponible en el equipo, degrada a `[]` (el llamador cae al árbol
 * plano / índice vacío en vez de tirar la app abajo — doc 07 §2.5, misma disciplina de "no
 * abortar el pipeline por un fallo puntual").
 */
export async function listProjectFiles(projectRoot: string): Promise<RepoFile[]> {
  const rgOut = (await runRgFiles(projectRoot)) ?? walkManually(projectRoot);
  const ig = ignore().add(loadSaurioIgnore(projectRoot));
  const relPaths = rgOut
    .map((p) => p.split(path.sep).join('/'))
    .filter((rel) => !ig.ignores(rel));

  const result: RepoFile[] = [];
  for (const relPath of relPaths) {
    const absPath = path.join(projectRoot, relPath);
    let st;
    try {
      st = statSync(absPath);
    } catch {
      continue; // borrado entre el listado y el stat: se ignora, no rompe el indexado
    }
    if (!st.isFile()) continue;
    if (st.size > MAX_FILE_BYTES) continue;
    if (looksBinary(absPath)) continue;
    result.push({ relPath, absPath, mtimeMs: st.mtimeMs, size: st.size });
  }
  return result;
}
