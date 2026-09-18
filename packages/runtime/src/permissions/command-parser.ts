// CommandParser (PowerShell + bash) — packages/runtime/src/permissions/command-parser.ts.
// Define: doc 06-permisos-y-modos.md §3 ("Clasificación por argumentos") y §12/Desvíos #4 (MVP:
// solo `pwsh`; `bash` queda como extensión prevista, `CommandParser.forShell` ya es genérico por
// shell). Implementa `CommandParser` de packages/runtime/src/permissions/types.ts (NO se modifica
// ese archivo, es contrato).
import type { PermissionCategory } from '@saurio/shared';
import type { CommandParser, ParsedCommand } from './types.js';
import { tokenize } from './patterns.js';

interface Segment { raw: string; confident: boolean }

/** Separadores de nivel de sentencia reconocidos por pwsh en el MVP (doc 06 §3): `;`, `|`, `&&`,
 *  `||`, salto de línea (`\n`/`\r\n`, tan válido como `;` para separar sentencias en un script de
 *  varias líneas — hallazgo #2 de la revisión 2026-09-18: sin esto, `tokenize` colapsaba un
 *  `run_command` multilínea en un solo subcomando cuyo `tokens[0]` era el de la primera línea) y
 *  `&` de fondo. `& { }` (operador de invocación de script block) se desenvuelve aparte porque no
 *  es un separador sino un prefijo. */
function splitTopLevel(raw: string): Segment[] {
  const segments: Segment[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let braceDepth = 0;
  const confident = true;

  const push = () => {
    const trimmed = current.trim();
    if (trimmed.length > 0) segments.push({ raw: trimmed, confident });
    current = '';
  };

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    const next = raw[i + 1];

    if (quote) {
      current += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; current += c; continue; }
    if (c === '{') { braceDepth++; current += c; continue; }
    if (c === '}') { braceDepth = Math.max(0, braceDepth - 1); current += c; continue; }

    if (braceDepth === 0) {
      if (c === ';') { push(); continue; }
      if (c === '\n' || c === '\r') {
        if (c === '\r' && next === '\n') i++;
        push();
        continue;
      }
      if (c === '|' && next === '|') { push(); i++; continue; }
      if (c === '|') { push(); continue; }
      if (c === '&' && next === '&') { push(); i++; continue; }
      if (c === '&') {
        // Operador de fondo (`cmd &`), a diferencia de `& { ... }` (operador de invocación de
        // script block, un prefijo, no un separador): si lo que sigue -ignorando espacios- es
        // `{`, no es un separador.
        let j = i + 1;
        while (j < raw.length && (raw[j] === ' ' || raw[j] === '\t')) j++;
        if (raw[j] !== '{') { push(); continue; }
      }
    }
    current += c;
  }
  push();

  if (quote !== null || braceDepth !== 0) {
    // Cadena mal balanceada (comilla o llave sin cerrar): no se puede separar con confianza.
    return [{ raw, confident: false }];
  }
  return segments;
}

/** Desenvuelve `& { ... }` (operador de invocación de script block): el contenido interno se
 *  trata como un nuevo comando, pero marcado `confident: false` — es una indirección que el
 *  clasificador estático no puede seguir con certeza (doc §3: "en caso de duda, nunca allow"). */
function unwrapCallOperator(raw: string): Segment {
  const m = /^&\s*\{([\s\S]*)\}\s*$/.exec(raw.trim());
  if (m) return { raw: (m[1] ?? '').trim(), confident: false };
  return { raw, confident: true };
}

const RE_DYNAMIC = /invoke-expression|iex\b|-command\b/i;

function classifyTokens(tokens: string[]): PermissionCategory {
  const t0 = (tokens[0] ?? '').toLowerCase();
  const t1 = (tokens[1] ?? '').toLowerCase();

  if (t0 === 'rm' || t0 === 'del' || t0 === 'remove-item' || t0 === 'ri' || t0 === 'rd' || t0 === 'rmdir' || t0 === 'erase') return 'delete';
  if (t0 === 'format-volume' || t0 === 'diskpart' || t0 === 'mkfs') return 'delete';
  if (t0 === 'git' && t1 === 'commit') return 'git_commit';
  if (t0 === 'git' && t1 === 'push') return 'git_push';
  if (t0 === 'curl' || t0 === 'wget' || t0 === 'invoke-webrequest' || t0 === 'iwr') return 'network';
  return 'terminal';
}

class PwshCommandParser implements CommandParser {
  parse(raw: string, shell: 'pwsh' | 'bash'): ParsedCommand {
    const dynamicTop = RE_DYNAMIC.test(raw);
    const rawSegments = splitTopLevel(raw);
    const segments = rawSegments.map((seg) => {
      const unwrapped = unwrapCallOperator(seg.raw);
      return { raw: unwrapped.raw, confident: seg.confident && unwrapped.confident };
    });

    const subcommands = segments
      .filter((s) => s.raw.length > 0)
      .map((s) => {
        const tokens = tokenize(s.raw);
        return { tokens, category: classifyTokens(tokens) };
      });

    const confident = !dynamicTop && subcommands.length > 0 && segments.every((s) => s.confident);
    return { raw, shell, subcommands, confident };
  }
}

/** Bash queda previsto para más adelante (doc §12/Desvíos #4): la interfaz ya es genérica por
 *  shell, así que agregarlo es una extensión de este archivo, no un rediseño. En el MVP, pedir
 *  `bash` devuelve un resultado no-confiable (fuerza `ask`) en vez de lanzar, para que un llamador
 *  que reciba `shell: 'bash'` por error de configuración no rompa el runtime — nunca se ofrece
 *  `allow` sin certeza. // v0.2
 */
class UnimplementedBashCommandParser implements CommandParser {
  parse(raw: string, shell: 'pwsh' | 'bash'): ParsedCommand {
    return { raw, shell, subcommands: [{ tokens: tokenize(raw), category: 'terminal' }], confident: false };
  }
}

const pwshParser = new PwshCommandParser();
const bashParser = new UnimplementedBashCommandParser();

/** `CommandParser` genérico por shell (doc §3: "MVP: solo pwsh"); dispatcher único que implementa
 *  la interfaz de types.ts delegando en el parser concreto. */
export const commandParser: CommandParser = {
  parse(raw: string, shell: 'pwsh' | 'bash'): ParsedCommand {
    return shell === 'pwsh' ? pwshParser.parse(raw, shell) : bashParser.parse(raw, shell);
  },
};

export { classifyTokens as classifyCommandTokens };
