// Handlers IPC del dominio "models" (doc 02 §1: apps/desktop/src/main/ipc/models.ts, doc 01 §6).
// models:list/loaded/describe/fits/folderInfo son MVP (ModelManager). models:pull/pullCancel/delete
// (DownloadManager) y models:catalog/recommend (RecommendationEngine + resources/model-catalog.json)
// son v0.2/v0.3 (doc 13 §5/§8) — implementados acá con handler real, conectado de punta a punta
// contra Ollama real (probado con all-minilm, ver packages/runtime/src/models/DownloadManager.ts).
import { ipc, type CatalogItem } from '@saurio/shared';
import type { RuntimeHost } from '../host/RuntimeHost.js';
import { registerHandler } from './registerHandler.js';
import { toDownloadJob } from '../services/downloads/SqlDownloadsRepository.js';

/** Estado derivado de una entrada del catálogo curado contra `models`(instalado)/`/api/ps`(cargado)/
 *  descargas en curso (doc 13 §11: estados de ficha, no una columna SQL nueva). */
function catalogStatus(
  entry: { name: string; tag: string },
  installedNames: Set<string>,
  loadedNames: Set<string>,
  downloadingId: string | undefined,
): CatalogItem['status'] {
  const fullName = `${entry.name}:${entry.tag}`;
  if (downloadingId) return 'downloading';
  if (loadedNames.has(fullName)) return 'loaded';
  if (installedNames.has(fullName)) return 'installed_untested'; // "probado" solo con model_compat (Benchmark, v0.3)
  return 'not_installed';
}

export function registerModelsHandlers(host: RuntimeHost): void {
  registerHandler('models:list', ipc['models:list'], async (input) =>
    host.modelManager.listInstalled(input.refresh));

  registerHandler('models:loaded', ipc['models:loaded'], async () => host.modelManager.listLoaded());

  registerHandler('models:describe', ipc['models:describe'], async (input) =>
    host.modelManager.describeModel(input.ref));

  registerHandler('models:fits', ipc['models:fits'], async (input) =>
    host.modelManager.fits(input.ref, input.numCtx));

  // Punto 2 del encargo / doc 16 §12: `ModelManager.detectedModelsFolder()` y `.attachWarnings()`
  // ya existían implementados (doc 13 §6/§7), pero sin canal IPC — el Centro de modelos no podía
  // mostrar la carpeta detectada ni sus avisos. Se agrega acá el único canal que faltaba, sin tocar
  // la lógica de ModelManager salvo agregarle el espacio libre/total (fs.statfs, doc 13 §5 punto 1).
  registerHandler('models:folderInfo', ipc['models:folderInfo'], async () => {
    const detected = await host.modelManager.detectedModelsFolder();
    const loaded = await host.modelManager.listLoaded().catch(() => []);
    const warnings = host.modelManager.attachWarnings({
      // Deviation (doc 13 §6): SaurioLLM solo puede leer `OLLAMA_HOST` de SU PROPIO entorno de
      // proceso, no del proceso servidor de Ollama (no lo controla en modo attach) — es la misma
      // heurística limitada que doc 13 §6 ya declara como tal ("no hay endpoint que confirme el bind").
      baseUrl: 'http://127.0.0.1:11434',
      observedContextLength: loaded[0]?.contextLength,
      ollamaHostEnv: process.env['OLLAMA_HOST'],
    });
    return { ...detected, warnings };
  });

  registerHandler('models:pull', ipc['models:pull'], async (input) =>
    host.downloadManager.pull(input.name));

  registerHandler('models:pullCancel', ipc['models:pullCancel'], async (input) =>
    host.downloadManager.cancel(input.downloadId));

  registerHandler('models:delete', ipc['models:delete'], async (input) =>
    host.downloadManager.delete(input.name));

  // Punto 5 del encargo ("historial de Descargas desde SqlDownloadsRepository por IPC para que
  // sobreviva reinicios", doc 16 §8 "No abordado... punto 2"): `DownloadManager.listAll()` solo tiene
  // lo que pasó por ESTE proceso desde que arrancó; se completa con lo persistido
  // (`SqlDownloadsRepository.listActiveOrRecent`, ya existía sin canal IPC) para descargas de una
  // sesión anterior. Las activas en memoria tienen prioridad (traen `bytesPerSec`/`etaMs` reales).
  registerHandler('models:downloads', ipc['models:downloads'], async () => {
    const active = host.downloadManager.listAll();
    const activeIds = new Set(active.map((job) => job.id));
    const persisted = await host.downloadsRepository.listActiveOrRecent();
    const historical = persisted.filter((record) => !activeIds.has(record.id)).map(toDownloadJob);
    return [...active, ...historical];
  });

  // Pestaña "Explorar" (doc 13 §10): catálogo curado + estado derivado contra lo instalado/cargado/
  // en descarga. No estima VRAM/tok-s acá (eso es models:fits/models:recommend, doc 13 §2).
  registerHandler('models:catalog', ipc['models:catalog'], async () => {
    const [installed, loaded] = await Promise.all([
      host.modelManager.listInstalled(),
      host.modelManager.listLoaded().catch(() => []),
    ]);
    const installedNames = new Set(installed.map((m) => m.ref.name));
    const loadedNames = new Set(loaded.map((m) => m.name));
    return host.modelCatalog.map((entry) => {
      const fullName = `${entry.name}:${entry.tag}`;
      const downloadingId = host.downloadManager.isDownloading(fullName)
        ? host.downloadManager.downloadIdFor(fullName)
        : undefined;
      return {
        entry,
        status: catalogStatus(entry, installedNames, loadedNames, downloadingId),
        downloadId: downloadingId,
      } satisfies CatalogItem;
    });
  });

  // Pestaña "Recomendaciones" (doc 13 §8, v0.3): hardware actual (HardwareProbe, mismo que
  // models:fits) x catálogo x uso/objetivo elegidos en la UI.
  registerHandler('models:recommend', ipc['models:recommend'], async (input) => {
    const hardware = await host.hardwareProbe.sample();
    return host.recommendationEngine.recommend(hardware, input.use, input.goal);
  });

  // Deviation: doc 02 §1 no le asigna un archivo propio a 'provider:health' (solo nombra
  // project/chat/run/permission/checkpoint/models/terminal/metrics/settings/bench); se registra acá
  // por estar pegado a Providers/ModelGateway, igual que el resto de este archivo.
  registerHandler('provider:health', ipc['provider:health'], async () =>
    Promise.all(host.providers.map((provider) => provider.health().then((health) => ({ providerId: provider.id, ...health })))));
}
