// Smoke acotado del cierre real de Electron en reposo. Usa perfil aislado y el mismo launcher que
// los demás smokes de v0.2.3; la cobertura de runs activos vive en shutdown.test.ts/RuntimeHost.test.ts
// para no depender de una inferencia real ni de una API paga.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { launchAtPort, stop, waitForRenderedRoot, assertCleanShutdown } from './smoke-release-functional.mjs';

function cliValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`falta la ruta después de ${flag}`);
  return value;
}

const dev = process.argv.includes('--dev');
const exePath = resolve(dev
  ? 'node_modules/electron/dist/electron.exe'
  : (cliValue('--exe') ?? 'apps/desktop/release/win-unpacked/SaurioLLM.exe'));
if (!existsSync(exePath)) throw new Error(`no existe el ejecutable: ${exePath}`);

const tempRoot = mkdtempSync(join(tmpdir(), 'saurio-shutdown-023-'));
let instance;
let completed = false;
try {
  instance = await launchAtPort(exePath, join(tempRoot, 'perfil aislado'), dev ? [resolve('apps/desktop')] : []);
  await waitForRenderedRoot(instance.cdp);

  const result = await stop(instance);
  instance = undefined;
  assertCleanShutdown(result, 'cierre en reposo');
  if (result.elapsedMs >= 2_000) {
    throw new Error(`el cierre en reposo tardó ${result.elapsedMs} ms (límite: <2000 ms)`);
  }

  completed = true;
  console.log(JSON.stringify({
    ok: true,
    mode: dev ? 'dev' : 'packaged',
    idleShutdown: result,
    activeRunCoverage: 'unitaria: confirmación, cancelación padre/hijo, persistencia terminal, error y reintento',
  }, null, 2));
} finally {
  if (instance) await stop(instance);
  const resolvedTemp = resolve(tempRoot);
  const expectedParent = resolve(tmpdir());
  if (completed && resolve(resolvedTemp, '..') === expectedParent && basename(resolvedTemp).startsWith('saurio-shutdown-023-')) {
    rmSync(resolvedTemp, { recursive: true, force: true });
  } else if (!completed) {
    console.error(`Smoke de cierre falló; se preservó el perfil aislado: ${resolvedTemp}`);
  }
}
