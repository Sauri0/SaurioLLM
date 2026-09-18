// Protected paths — packages/runtime/src/permissions/protected.ts.
// Define: doc 06-permisos-y-modos.md §5 ("Invariantes: protected paths, deny duro"). Lista fija,
// no configurable desde ningún preset ni regla del usuario (paso 1 del algoritmo, §6). `node_modules/**`
// se excluye a propósito (doc §5: "no es protected, queda en ask por defecto porque patch-package
// es un caso legítimo").
import { matchGlob, normalizeRelPath } from './patterns.js';

export const PROTECTED_PATH_GLOBS: readonly string[] = [
  '.git/**', '.saurio/**', '.env*', '*.pem', 'id_rsa*', '.vscode/**', '.idea/**',
];

/** `relPath` ya relativo al workspace (sin `..` que escape la raíz — eso lo garantiza
 *  `WorkspaceFs.resolve` antes de llegar acá). Matchea el path completo y también, para los globs
 *  de un solo segmento (`.env*`, `*.pem`, `id_rsa*`), cualquier basename dentro de un subdirectorio
 *  (p. ej. `config/.env.local` debe protegerse igual que `.env.local`). */
export function isProtectedPath(relPath: string): boolean {
  const norm = normalizeRelPath(relPath);
  const basename = norm.split('/').pop() ?? norm;
  return PROTECTED_PATH_GLOBS.some((glob) => {
    if (matchGlob(glob, norm)) return true;
    if (!glob.includes('/') && matchGlob(glob, basename)) return true;
    return false;
  });
}
