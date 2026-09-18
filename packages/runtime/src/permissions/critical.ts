// Comandos críticos y bloqueos de git — packages/runtime/src/permissions/critical.ts.
// Define: doc 06-permisos-y-modos.md §5 ("Invariantes: comandos críticos" y "bloqueados por
// defecto"). `isCriticalCommand`/`isBlockedByDefault` toman `ParsedCommand` (no un cwd/projectRoot
// explícito: la interfaz de PermissionEngine en types.ts no lo expone), así que la detección de
// "raíz de unidad / home / raíz del proyecto o padres" es sintáctica sobre los tokens del comando
// (patrones de la propia sintaxis del path, no resolución contra el filesystem real) — es la única
// superficie disponible sin ampliar el contrato (anotado en deviations de la salida estructurada).
import type { ParsedCommand } from './types.js';

const RECURSIVE_RM_FLAGS = new Set(['-r', '-rf', '-fr', '--recursive']);

/** PowerShell acepta abreviaturas de parámetro: `-r`, `-re`, `-rec`, `-recu`, `-recurs`,
 *  `-recurse` son todas el mismo flag `-Recurse` (hallazgo #3 de la revisión 2026-09-18). */
const RECURSIVE_REMOVE_ITEM_FLAG_RE = /^-r(e(c(u(r(s(e)?)?)?)?)?)?$/i;

/** Alias de `Remove-Item` en PowerShell (`ri`) y equivalentes de `cmd.exe` (`rd`/`rmdir`,
 *  `del`/`erase`) que también borran recursivamente. */
const REMOVE_ITEM_NAMES = new Set(['remove-item', 'ri']);
const CMD_RECURSIVE_DIR_NAMES = new Set(['rd', 'rmdir']);
const CMD_RECURSIVE_FILE_NAMES = new Set(['del', 'erase']);

/** Flags recursivos de `cmd.exe` (`del /f /s /q`, `rd /s /q`): `/s` es el que importa acá. */
function hasCmdRecursiveFlag(tokens: string[]): boolean {
  return tokens.some((t) => /^\/s$/i.test(t.trim()));
}

/** Argumentos que sintácticamente apuntan a "todo": raíz de unidad (`C:\`, `C:/`, `/`), home
 *  (`~`, `$HOME`, `%USERPROFILE%`, `$env:USERPROFILE`) o la raíz/ancestros del árbol actual
 *  (`.`, `..`, `../..`, `..\..`, y variantes con más segmentos). */
function isRootLikeTarget(token: string): boolean {
  const t = token.trim();
  if (/^[a-zA-Z]:[\\/]?$/.test(t)) return true;                 // C:\  C:/  C:
  if (t === '/' || t === '\\') return true;
  if (/^~[\\/]?$/.test(t)) return true;
  if (/^\$HOME[\\/]?$/i.test(t)) return true;
  if (/^%USERPROFILE%[\\/]?$/i.test(t)) return true;
  if (/^\$env:USERPROFILE[\\/]?$/i.test(t)) return true;
  if (t === '.') return true;
  if (/^(\.\.[\\/]?)+$/.test(t)) return true;                    // ..  ../..  ..\..\..
  return false;
}

function hasFlag(tokens: string[], flags: Set<string>): boolean {
  return tokens.some((t) => flags.has(t.toLowerCase()));
}

function hasRecursiveRemoveItemFlag(tokens: string[]): boolean {
  return tokens.some((t) => RECURSIVE_REMOVE_ITEM_FLAG_RE.test(t.trim()));
}

function positionalArgs(tokens: string[]): string[] {
  return tokens.slice(1).filter((t) => !t.startsWith('-'));
}

/** `rm -rf` / `Remove-Item -Recurse` apuntando a raíz de unidad, home, raíz del proyecto o
 *  alguno de sus padres; `git push --force`(-with-lease); formateo de discos/particionado. */
export function isCriticalCommand(parsed: ParsedCommand): boolean {
  return parsed.subcommands.some((sub) => {
    const [cmd] = sub.tokens;
    const t0 = (cmd ?? '').toLowerCase();

    if ((t0 === 'rm') && hasFlag(sub.tokens, RECURSIVE_RM_FLAGS)) {
      return positionalArgs(sub.tokens).some(isRootLikeTarget);
    }
    if (REMOVE_ITEM_NAMES.has(t0) && hasRecursiveRemoveItemFlag(sub.tokens)) {
      return positionalArgs(sub.tokens).some(isRootLikeTarget);
    }
    if (CMD_RECURSIVE_DIR_NAMES.has(t0) && hasCmdRecursiveFlag(sub.tokens)) {
      return positionalArgs(sub.tokens).some(isRootLikeTarget);
    }
    if (CMD_RECURSIVE_FILE_NAMES.has(t0) && hasCmdRecursiveFlag(sub.tokens)) {
      return positionalArgs(sub.tokens).some(isRootLikeTarget);
    }
    if (t0 === 'git' && (sub.tokens[1] ?? '').toLowerCase() === 'push') {
      return sub.tokens.some((t) => /^--force(-with-lease)?$/i.test(t));
    }
    if (t0 === 'format-volume' || t0 === 'diskpart' || t0 === 'mkfs') return true;
    return false;
  });
}

const RESET_HARD = (tokens: string[]) =>
  tokens[0]?.toLowerCase() === 'git' && tokens[1]?.toLowerCase() === 'reset'
  && tokens.some((t) => t.toLowerCase() === '--hard');
const CHECKOUT_PATH = (tokens: string[]) =>
  tokens[0]?.toLowerCase() === 'git' && tokens[1]?.toLowerCase() === 'checkout' && tokens.includes('--');
const RESTORE = (tokens: string[]) => tokens[0]?.toLowerCase() === 'git' && tokens[1]?.toLowerCase() === 'restore';
const CLEAN = (tokens: string[]) => tokens[0]?.toLowerCase() === 'git' && tokens[1]?.toLowerCase() === 'clean';
const STASH = (tokens: string[]) => tokens[0]?.toLowerCase() === 'git' && tokens[1]?.toLowerCase() === 'stash';
const REMOTE_MUTATION = (tokens: string[]) =>
  tokens[0]?.toLowerCase() === 'git' && tokens[1]?.toLowerCase() === 'remote'
  && ['add', 'set-url'].includes((tokens[2] ?? '').toLowerCase());
const GIT_CONFIG_OR_HOOKS = (tokens: string[]) =>
  tokens.some((t) => /\.git[\\/](config|hooks[\\/].*)/i.test(t));

/** Bloqueados por defecto salvo que TODOS los paths afectados ya hayan sido tocados por este run
 *  (`touchedByRun`); si el comando no declara paths explícitos (afecta todo el árbol, p. ej.
 *  `git reset --hard` sin argumentos) no hay forma de acotarlo a lo tocado, así que se bloquea. */
export function isBlockedByDefault(parsed: ParsedCommand, touchedByRun: Set<string>): boolean {
  return parsed.subcommands.some((sub) => {
    const { tokens } = sub;
    if (GIT_CONFIG_OR_HOOKS(tokens) || REMOTE_MUTATION(tokens)) return true;

    const isGuardedOp = RESET_HARD(tokens) || CHECKOUT_PATH(tokens) || RESTORE(tokens)
      || CLEAN(tokens) || STASH(tokens);
    if (!isGuardedOp) return false;

    const paths = extractPathArgsAfterFlags(tokens);
    if (paths.length === 0) return true;   // afecta todo: no hay "path tocado" que lo excuse
    return !paths.every((p) => touchedByRun.has(p));
  });
}

function extractPathArgsAfterFlags(tokens: string[]): string[] {
  const dashDashIdx = tokens.indexOf('--');
  const scanFrom = dashDashIdx === -1 ? 2 : dashDashIdx + 1;
  return tokens.slice(scanFrom).filter((t) => !t.startsWith('-'));
}

/** Tokens que apuntan sintácticamente a un protected path (doc §5) dentro de un subcomando de
 *  categoría `delete` (hallazgo #4 de la revisión 2026-09-18): `evaluate()` solo miraba `paths`
 *  declarados por `edit_file`/`delete_file`, así que un `run_command` que borra `.git/config`,
 *  `.env` o similar no lo frenaba nada antes de ejecutarse. No resuelve contra el filesystem real
 *  (mismo límite documentado arriba para `isRootLikeTarget`): matchea sobre la sintaxis del token. */
const PROTECTED_TOKEN_RE = /(^|[\\/])(\.git|\.saurio)([\\/]|$)|(^|[\\/])\.env[^\\/]*$|(^|[\\/])[^\\/]*\.pem$|(^|[\\/])id_rsa[^\\/]*$/i;

export function hasProtectedPathTarget(parsed: ParsedCommand): boolean {
  return parsed.subcommands.some((sub) => {
    if (sub.category !== 'delete') return false;
    return positionalArgs(sub.tokens).some((t) => PROTECTED_TOKEN_RE.test(t.trim()));
  });
}
