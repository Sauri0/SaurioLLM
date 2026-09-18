// Extracción de tags (definiciones/referencias) por archivo (doc 07 §2.2 paso 3; doc 04 §12).
// Corre la query queries/<lang>-tags.scm sobre el árbol tree-sitter de cada archivo. Captura
// `@name.definition.*` -> kind 'def'; `@name.reference.*` -> kind 'ref' (doc 07 §2.2 paso 3).
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser, Query, type Language, type Node } from 'web-tree-sitter';
import { hasGrammar, loadGrammar } from './loader.js';
import type { RepoTag, SupportedLang } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Default: `packages/repomap/queries/` — válido cuando este módulo corre como archivo fuente real
 *  (dev sin bundlear, vitest, eval/harness.ts vía tsx). Mismo problema y mismo arreglo que
 *  `loader.ts`/`getGrammarsDir()` (punto 5 del encargo, doc 16): una vez que electron-vite bundlea
 *  `apps/desktop/src/main/**` en un único `out/main/index.js`, `import.meta.url` deja de
 *  corresponder a la ubicación real de este archivo fuente. */
const DEFAULT_QUERIES_DIR = path.resolve(here, '../queries');
let queriesDirOverride: string | undefined;

/** Inyecta la carpeta real de queries .scm — apps/desktop la llama una sola vez al arrancar, junto
 *  con `setGrammarsDir()` (mismo origen: `resourcesPath` empaquetado o raíz del repo en dev). */
export function setQueriesDir(dir: string | undefined): void {
  queriesDirOverride = dir;
}

/** Carpeta de queries .scm efectiva: la inyectada por `setQueriesDir()`, o el default si nadie la
 *  llamó todavía. */
export function getQueriesDir(): string {
  return queriesDirOverride ?? DEFAULT_QUERIES_DIR;
}

const queryCache = new Map<SupportedLang, Query | null>();
const languageCache = new Map<SupportedLang, Language | null>();

function queryFileFor(lang: SupportedLang): string {
  return path.join(getQueriesDir(), `${lang}-tags.scm`);
}

/** True si hay grammar .wasm Y query .scm para `lang` (ambas condiciones de doc 07 §2.5). */
export function hasTagSupport(lang: SupportedLang): boolean {
  return hasGrammar(lang) && existsSync(queryFileFor(lang));
}

async function getQuery(lang: SupportedLang): Promise<{ query: Query; language: Language } | null> {
  if (queryCache.has(lang)) {
    const q = queryCache.get(lang);
    const l = languageCache.get(lang);
    return q && l ? { query: q, language: l } : null;
  }
  if (!hasTagSupport(lang)) {
    queryCache.set(lang, null);
    languageCache.set(lang, null);
    return null;
  }
  try {
    const language = await loadGrammar(lang);
    if (!language) {
      queryCache.set(lang, null);
      languageCache.set(lang, null);
      return null;
    }
    const source = readFileSync(queryFileFor(lang), 'utf8');
    const query = new Query(language, source);
    queryCache.set(lang, query);
    languageCache.set(lang, language);
    return { query, language };
  } catch {
    // Grammar o query rota: se degrada a árbol plano para este lenguaje (doc 07 §2.5), sin
    // abortar el resto del pipeline.
    queryCache.set(lang, null);
    languageCache.set(lang, null);
    return null;
  }
}

function captureKind(name: string): 'def' | 'ref' | null {
  if (name.startsWith('name.definition.')) return 'def';
  if (name.startsWith('name.reference.')) return 'ref';
  return null;
}

/**
 * Extrae los tags de un archivo ya parseado con la grammar de `lang`. Devuelve `null` si no hay
 * grammar+query disponible o si el parseo falla (el llamador degrada a árbol plano, doc 07 §2.5).
 */
export async function extractTags(relPath: string, source: string, lang: SupportedLang): Promise<RepoTag[] | null> {
  const loaded = await getQuery(lang);
  if (!loaded) return null;
  const parser = new Parser();
  try {
    parser.setLanguage(loaded.language);
    const tree = parser.parse(source);
    if (!tree) return null;
    const captures = loaded.query.captures(tree.rootNode);
    const tags: RepoTag[] = [];
    for (const cap of captures) {
      const kind = captureKind(cap.name);
      if (!kind) continue;
      const node: Node = cap.node;
      tags.push({ file: relPath, name: node.text, kind, line: node.startPosition.row + 1 });
    }
    tree.delete();
    return tags;
  } catch {
    return null;
  } finally {
    parser.delete();
  }
}
