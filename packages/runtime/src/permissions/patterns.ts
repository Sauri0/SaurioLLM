// Coincidencia de patrones y generación de sugerencias — packages/runtime/src/permissions/patterns.ts.
// Define: doc 06-permisos-y-modos.md §4 (sintaxis de `PermissionRule.pattern`) y §4/§7 ("patrón más
// específico" sugerido en `PermissionRequest.rememberOptions`). Dos sintaxis conviven: glob relativo
// al workspace (edit_file/write_file/delete_file/read_file) y prefijo de tokens (run_command).
// Sin dependencias externas: un glob mínimo alcanza para `**`, `*` y segmentos literales, que es
// todo lo que doc 06 pide para el MVP.

/** Normaliza separadores a '/' y quita un prefijo './'; no resuelve '..' (eso es responsabilidad
 *  de `WorkspaceFs.resolve`, fuera de este módulo — acá solo comparamos strings ya relativos). */
export function normalizeRelPath(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Convierte un glob estilo `.gitignore`/`edit_file(src/**)` a RegExp. Soporta `**` (cualquier
 *  cantidad de segmentos, incluido cero) y `*` (cualquier cosa dentro de un segmento, sin `/`).
 *  Un prefijo `!` en el glob se interpreta por el llamador (rules.ts), no acá. */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? '';
    if (c === '*' && glob[i + 1] === '*') {
      // '**' seguido de '/' opcional: matchea cero o más segmentos completos.
      if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2; }
      else { out += '.*'; i += 1; }
    } else if (c === '*') {
      out += '[^/]*';
    } else if (c === '?') {
      out += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

/** true si `relPath` (ya normalizado) matchea `glob` (soporta prefijo `!` = negación pura de la
 *  forma, la semántica de "forzar deny/ask" vive en rules.ts). */
export function matchGlob(glob: string, relPath: string): boolean {
  const g = glob.startsWith('!') ? glob.slice(1) : glob;
  return globToRegExp(normalizeRelPath(g)).test(normalizeRelPath(relPath));
}

/** Prefijo de tokens para `run_command` (doc 06 §4): sin `*` final, coincidencia exacta de
 *  comando+argumentos fijos; con `*` final, matchea cualquier continuación con el mismo prefijo. */
export function matchCommandPattern(pattern: string, tokens: string[]): boolean {
  const patternTokens = tokenize(pattern);
  if (patternTokens.length === 0) return false;
  const last = patternTokens[patternTokens.length - 1];
  const wildcard = last === '*';
  const fixed = wildcard ? patternTokens.slice(0, -1) : patternTokens;
  if (wildcard) {
    if (tokens.length < fixed.length) return false;
  } else if (tokens.length !== fixed.length) {
    return false;
  }
  return fixed.every((t, idx) => t === tokens[idx]);
}

/** Tokenizador simple por espacios respetando comillas simples/dobles; suficiente para patrones
 *  de configuración (no para parsear la línea de comando real del usuario, ver command-parser.ts). */
export function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return tokens;
}

/** "Patrón más específico que cubre la llamada actual" para `run_command` (doc 06 §4): el propio
 *  comando, sin comodines — el usuario puede ampliarlo a mano en el diálogo. */
export function suggestCommandPattern(tokens: string[]): string {
  return tokens.map(quoteIfNeeded).join(' ');
}

function quoteIfNeeded(token: string): string {
  return /\s/.test(token) ? `"${token}"` : token;
}

/** "Patrón más específico" para paths (doc 06 §4): el directorio contenedor + `/**`, nunca `**`
 *  ni el segmento raíz del workspace. Un archivo en la raíz del workspace sugiere su propio nombre
 *  exacto (no hay directorio más específico que ofrecer sin ampliar a todo el workspace). */
export function suggestPathPattern(relPath: string): string {
  const norm = normalizeRelPath(relPath);
  const idx = norm.lastIndexOf('/');
  if (idx === -1) return norm;
  return `${norm.slice(0, idx)}/**`;
}
