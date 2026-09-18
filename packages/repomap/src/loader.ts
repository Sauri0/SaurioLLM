// Carga de grammars .wasm vía web-tree-sitter (doc 02 §1: packages/repomap/loader; ADR-008).
// GRAMMARS = @vscode/tree-sitter-wasm (ver N:\saurio-smoke\RESULTADOS-electron.md §6: tree-sitter-wasms 0.1.13
// es incompatible con web-tree-sitter 0.27 por falta de dylink.0; @vscode/tree-sitter-wasm sí carga).
//
// Punto 5 del encargo (doc 16): antes `grammarsDir` se derivaba de `import.meta.url` subiendo tres
// niveles ("here/../../../resources/grammars"). Esa cuenta es correcta en dev/tests (este archivo
// corre desde su ubicación real en `packages/repomap/src/`) pero se rompe en cuanto electron-vite
// bundlea `apps/desktop/src/main/**` en un único `out/main/index.js`: TODO el código bundleado
// (incluido este módulo, que se transpila dentro de ese bundle porque @saurio/repomap exporta .ts
// fuente sin build propio) comparte el mismo `import.meta.url` — el del chunk final, no el de este
// archivo — así que la cuenta de "tres niveles arriba" dejaba de apuntar a `resources/grammars` real
// (funcionaba por una coincidencia aritmética de profundidad con `out/main/`, documentada como hack en
// electron-builder.yml). Ahora la carpeta es inyectable: `setGrammarsDir()` la fija explícitamente
// (apps/desktop la llama una vez al arrancar, con `resourcesPath` en empaquetado o la raíz del repo
// en dev — mismo criterio que `apps/desktop/src/main/services/resources.ts`); sin llamarla nunca
// (tests de este paquete, `eval/harness.ts` corriendo con `tsx` sin bundlear), se usa el default de
// abajo, que sigue siendo válido porque en esos casos SÍ corre como archivo fuente real.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, Parser } from 'web-tree-sitter';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Default: resources/grammars/ en la raíz del monorepo, tres niveles arriba de packages/repomap/src
 *  — válido cuando este módulo corre como archivo fuente real (dev sin bundlear, vitest,
 *  eval/harness.ts vía tsx). Ver comentario de arriba para el caso bundleado. */
const DEFAULT_GRAMMARS_DIR = path.resolve(here, '../../../resources/grammars');
let grammarsDirOverride: string | undefined;

/** Inyecta la carpeta real de grammars (punto 5 del encargo) — quien arma el runtime empaquetado
 *  (apps/desktop/src/main/host/createRuntime.ts) la llama una sola vez al arrancar, con la ruta ya
 *  resuelta contra `process.resourcesPath` (empaquetado) o la raíz del repo (dev). */
export function setGrammarsDir(dir: string | undefined): void {
  grammarsDirOverride = dir;
}

/** Carpeta de grammars efectiva: la inyectada por `setGrammarsDir()`, o el default de arriba si
 *  nadie la llamó todavía. */
export function getGrammarsDir(): string {
  return grammarsDirOverride ?? DEFAULT_GRAMMARS_DIR;
}

let parserInitialized = false;

/** Inicializa el runtime de web-tree-sitter (idempotente); debe correr antes de Language.load(). */
export async function initParser(): Promise<void> {
  if (parserInitialized) return;
  await Parser.init();
  parserInitialized = true;
}

/** True si existe un .wasm para `lang` en la carpeta de grammars efectiva (`getGrammarsDir()`). */
export function hasGrammar(lang: string): boolean {
  return existsSync(path.join(getGrammarsDir(), `${lang}.wasm`));
}

/**
 * Carga la grammar de `lang` desde `getGrammarsDir()`/<lang>.wasm. Devuelve null si el archivo no
 * existe (repo map degrada a árbol plano de archivos en ese caso, ver ADR-008 en
 * docs/architecture/12-decisiones.md).
 */
export async function loadGrammar(lang: string): Promise<Language | null> {
  if (!hasGrammar(lang)) return null;
  await initParser();
  return Language.load(path.join(getGrammarsDir(), `${lang}.wasm`));
}
