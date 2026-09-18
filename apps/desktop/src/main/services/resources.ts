// Resuelve rutas a recursos empaquetados (resources/, raíz del monorepo) — apps/desktop/src/main/
// services/resources.ts. `import.meta.url`/`__dirname` no sirven para esto una vez que electron-vite
// bundlea main en un único `out/main/index.js` (el bundle pierde la ubicación original de cada
// módulo fuente): se resuelve en cambio contra `app.getAppPath()` (dev: carpeta `apps/desktop/`;
// empaquetado: dentro del `app.asar`) y `process.resourcesPath` para el caso empaquetado, donde
// `electron-builder.yml` copia `resources/` como `extraResources`.
//
// Deliberadamente SIN `import { app } from 'electron'` acá: `createRuntime.ts` (que usa este módulo)
// se ejercita directo en tests de integración con vitest, sin Electron real (`createRuntime.test.ts`)
// — `app` fuera de un proceso Electron real no es el objeto de la API, así que este módulo recibe
// `appPath`/`resourcesPath` ya resueltos por `index.ts` (que sí es el único lugar con `app` real,
// doc 02 §1 ADR-002) en vez de leerlos él mismo.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface ResourcePathsInput {
  /** `app.getAppPath()` (dev: `apps/desktop/`; empaquetado: dentro del `app.asar`). */
  appPath: string;
  /** `process.resourcesPath`; `undefined` fuera de un proceso Electron real. */
  resourcesPath?: string;
}

/** Candidatos, en orden: dev (monorepo, dos niveles arriba de `apps/desktop`), empaquetado
 *  (`extraResources` junto al ejecutable) y, por si acaso, dentro del propio `appPath`. */
function candidatePaths(relPath: string, input: ResourcePathsInput): string[] {
  return [
    path.join(input.appPath, '..', '..', 'resources', relPath),
    path.join(input.resourcesPath ?? '', relPath),
    path.join(input.appPath, 'resources', relPath),
  ];
}

export function resolveResourcePath(relPath: string, input: ResourcePathsInput): string | undefined {
  return candidatePaths(relPath, input).find((p) => existsSync(p));
}

export function readResourceFile(relPath: string, input: ResourcePathsInput): string | undefined {
  const resolved = resolveResourcePath(relPath, input);
  return resolved ? readFileSync(resolved, 'utf-8') : undefined;
}

/** Punto 5 del encargo (doc 16): resuelve las dos carpetas que necesita `@saurio/repomap` (grammars
 *  .wasm, queries .scm) para inyectárselas a `configureRepoMapResources`
 *  (packages/runtime/src/context/engine-repo-map-client.ts) — reemplaza la derivación rota vía
 *  `import.meta.url` que packages/repomap/src/{loader,tags}.ts usaban antes.
 *  - `grammars/` sigue el mismo layout que el resto de `resources/` (`resolveResourcePath` ya cubre
 *    dev y empaquetado, igual que `model-catalog.json`/`prompts/`).
 *  - Los `.scm` de queries viven en `packages/repomap/queries/` EN EL CÓDIGO FUENTE (no se duplican
 *    bajo `resources/` solo para esta resolución); `electron-builder.yml` los copia como
 *    `repomap-queries/` en el empaquetado. */
export function resolveRepoMapResourceDirs(input: ResourcePathsInput): { grammarsDir?: string; queriesDir?: string } {
  const grammarsDir = resolveResourcePath('grammars', input);
  const queriesCandidates = [
    path.join(input.resourcesPath ?? '', 'repomap-queries'),
    path.join(input.appPath, '..', '..', 'packages', 'repomap', 'queries'),
  ];
  const queriesDir = queriesCandidates.find((p) => existsSync(p));
  return { grammarsDir, queriesDir };
}
