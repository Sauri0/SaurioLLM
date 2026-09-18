// Handlers IPC del dominio "models" (doc 02 §1: apps/desktop/src/main/ipc/models.ts, doc 01 §6).
// models:list/loaded/describe/fits/folderInfo son MVP (ModelManager). models:pull/pullCancel/delete
// (DownloadManager) y models:catalog/recommend (RecommendationEngine + resources/model-catalog.json)
// son v0.2/v0.3 (doc 13 §5/§8) — implementados acá con handler real, conectado de punta a punta
// contra Ollama real (probado con all-minilm, ver packages/runtime/src/models/DownloadManager.ts).
// models:libraryCatalog/hfSearch/hfFiles/resolveByName/pullExternal son la cobertura máxima del
// catálogo (doc 16 §12.6, puntos 1-5 del encargo).
import { ipc, type CatalogItem, type ModelTier, type ResolveModelByNameResult } from '@saurio/shared';
import { tierForCatalogWeights } from '@saurio/runtime/models/TierClassifier';
import { RegistryClient, mergeSnapshotWithCuratedCatalog } from '@saurio/runtime/models/index';
import type { HardwareProfile, ModelCatalogEntry } from '@saurio/runtime/models/index';
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

/** Compartido por `models:catalog` (solo el curado, 16 entradas) y `models:libraryCatalog` (curado +
 *  snapshot completo fusionados, cientos de entradas, doc 16 §12.6 punto 1/2) — mismo cálculo de
 *  estado/nivel para las dos vistas, una sola vez. */
function buildCatalogItem(
  entry: ModelCatalogEntry, host: RuntimeHost,
  installedNames: Set<string>, loadedNames: Set<string>,
  hardware: HardwareProfile | undefined, freeDiskBytes: number | undefined,
): CatalogItem {
  const fullName = `${entry.name}:${entry.tag}`;
  const downloadingId = host.downloadManager.isDownloading(fullName)
    ? host.downloadManager.downloadIdFor(fullName)
    : undefined;
  const tier: ModelTier | undefined = hardware
    ? tierForCatalogWeights(entry.sizeBytes, hardware, { freeDiskBytes })
    : undefined;
  return {
    entry,
    status: catalogStatus(entry, installedNames, loadedNames, downloadingId),
    downloadId: downloadingId,
    tier,
  } satisfies CatalogItem;
}

/** `hf.co/<usuario>/<repo>:<quant>` (formato vigente, verificado contra la doc oficial de HF para
 *  Ollama — ver HuggingFaceClient.ts). El repo puede tener `/` en el nombre del usuario/org pero nunca
 *  en el `:quant` final, así que se corta en los DOS PRIMEROS `/` y en el ÚLTIMO `:`. */
const HF_REF_RE = /^hf\.co\/([^/]+\/[^:]+):([^:]+)$/;

/** Margen de seguridad antes de considerar "sin espacio" (mismo valor que
 *  `DownloadManager.DEFAULT_FREE_SPACE_MARGIN_BYTES`, duplicado a propósito: ese valor es privado del
 *  módulo y esto es solo una previsualización antes de decidir descargar, no la verificación real que
 *  ya hace `DownloadManager.pull()`/`pullKnownSize()` en el momento de descargar de verdad). */
const PREVIEW_FREE_SPACE_MARGIN_BYTES = 2 * 1024 * 1024 * 1024;

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
  // en descarga, MÁS la escala de seis niveles (punto 3 del encargo "cobertura máxima del catálogo"),
  // para que la ficha muestre de entrada "¿me conviene este modelo en esta PC?" sin que el usuario
  // tenga que abrir cada ficha y pedir models:fits una por una. Sigue sin estimar tok/s reales acá
  // (eso es Benchmark/model_compat, v0.3) — TierClassifier solo decide el nivel 1-6.
  registerHandler('models:catalog', ipc['models:catalog'], async () => {
    const [installed, loaded, hardware, folder] = await Promise.all([
      host.modelManager.listInstalled(),
      host.modelManager.listLoaded().catch(() => []),
      host.hardwareProbe.sample().catch(() => undefined),
      host.modelManager.detectedModelsFolder().catch(() => undefined),
    ]);
    const installedNames = new Set(installed.map((m) => m.ref.name));
    const loadedNames = new Set(loaded.map((m) => m.name));
    const freeDiskBytes = folder?.spaceQuality === 'measured' ? folder.freeBytes : undefined;
    return host.modelCatalog.map((entry) => buildCatalogItem(entry, host, installedNames, loadedNames, hardware, freeDiskBytes));
  });

  // Punto 1/2 del encargo (doc 16 §12.6): biblioteca COMPLETA de Ollama (curado + snapshot fusionados
  // por name:tag, cientos de entradas) en vez de solo las 16 del catálogo curado. `forceRefresh` es el
  // botón "Actualizar catálogo" de la UI; sin él, `OllamaLibraryClient` decide caché/red/empaquetado
  // según el TTL de 24h (nunca deja el Explorador sin catálogo alguno).
  registerHandler('models:libraryCatalog', ipc['models:libraryCatalog'], async (input) => {
    const [{ snapshot, source, cachedAt }, installed, loaded, hardware, folder] = await Promise.all([
      host.ollamaLibraryClient.getCatalog({ forceRefresh: input.forceRefresh }),
      host.modelManager.listInstalled(),
      host.modelManager.listLoaded().catch(() => []),
      host.hardwareProbe.sample().catch(() => undefined),
      host.modelManager.detectedModelsFolder().catch(() => undefined),
    ]);
    const installedNames = new Set(installed.map((m) => m.ref.name));
    const loadedNames = new Set(loaded.map((m) => m.name));
    const freeDiskBytes = folder?.spaceQuality === 'measured' ? folder.freeBytes : undefined;
    const merged = mergeSnapshotWithCuratedCatalog(snapshot, host.modelCatalog);
    return {
      items: merged.map((entry) => buildCatalogItem(entry, host, installedNames, loadedNames, hardware, freeDiskBytes)),
      source,
      cachedAt,
      familyCount: snapshot.familyCount,
      variantCount: snapshot.variantCount,
    };
  });

  // Punto 3 del encargo: búsqueda de modelos GGUF en Hugging Face por texto libre.
  registerHandler('models:hfSearch', ipc['models:hfSearch'], async (input) =>
    host.huggingFaceClient.searchModels(input.query));

  // Punto 3 del encargo: archivos .gguf de un repo (tamaño real + cuantización) para elegir con cuál
  // descargar (`hf.co/<repo>:<quant>`).
  registerHandler('models:hfFiles', ipc['models:hfFiles'], async (input) =>
    host.huggingFaceClient.listGgufFiles(input.modelId));

  // Punto 4 del encargo ("Descargar por nombre"): valida el nombre libre contra el registry de Ollama
  // o contra `hf.co/<usuario>/<repo>:<quant>`, sin descargar nada todavía — la ficha muestra tamaño,
  // espacio y nivel de la escala ANTES de que el usuario confirme.
  registerHandler('models:resolveByName', ipc['models:resolveByName'], async (input) => {
    const name = input.name.trim();
    if (name.length === 0) throw new Error('escribí un nombre de modelo');

    const [folder, hardware] = await Promise.all([
      host.modelManager.detectedModelsFolder().catch(() => undefined),
      host.hardwareProbe.sample().catch(() => undefined),
    ]);
    const freeBytes = folder?.spaceQuality === 'measured' ? folder.freeBytes : undefined;

    const hfMatch = HF_REF_RE.exec(name);
    let sizeBytes: number;
    let source: ResolveModelByNameResult['source'];
    if (hfMatch) {
      const [, repo, quant] = hfMatch as unknown as [string, string, string];
      const files = await host.huggingFaceClient.listGgufFiles(repo);
      const match = files.find((f) => f.quant?.toLowerCase() === quant.toLowerCase());
      if (!match) throw new Error(`no se encontró la cuantización "${quant}" en "${repo}" (revisá el nombre exacto del archivo .gguf)`);
      if (match.sizeBytes === undefined) throw new Error(`"${repo}:${quant}" no trae tamaño en Hugging Face — no se puede verificar espacio`);
      sizeBytes = match.sizeBytes;
      source = 'huggingface';
    } else {
      const manifest = await new RegistryClient().fetchManifest(name);
      const layers = manifest.config ? [...manifest.layers, manifest.config] : manifest.layers;
      sizeBytes = layers.reduce((sum, layer) => sum + layer.size, 0);
      source = 'ollama';
    }

    // Sin dato de espacio medido (`spaceQuality: 'unavailable'`), no se bloquea el botón "Descargar"
    // con una respuesta que no se puede confirmar (mismo criterio que TierClassifier nivel 6: "si no
    // hay dato de disco, nunca se fuerza por falta de disco").
    const spaceOk = freeBytes === undefined || freeBytes >= sizeBytes + PREVIEW_FREE_SPACE_MARGIN_BYTES;
    const tier = hardware ? tierForCatalogWeights(sizeBytes, hardware, { freeDiskBytes: freeBytes }) : undefined;

    return { fullName: name, source, sizeBytes, freeBytes, spaceOk, tier } satisfies ResolveModelByNameResult;
  });

  // Punto 3/4 del encargo: descarga de una referencia que no vive en el registry de Ollama (hf.co/...
  // o cualquier nombre resuelto por `models:resolveByName` como `source: 'huggingface'`) reutilizando
  // DownloadManager (progreso/cancelación/eventos ya existentes, `pullKnownSize` en vez de `pull`
  // porque no hay manifest Docker v2 que diffear contra `blobs/`).
  registerHandler('models:pullExternal', ipc['models:pullExternal'], async (input) =>
    host.downloadManager.pullKnownSize(input.ref, input.sizeBytes));

  // Selector de contexto 4k/8k/16k/32k de la ficha de Explorar (punto 5 del encargo): recalcula
  // nivel/memoria para un tamaño de pesos ya conocido (el que ya trae la ficha en pantalla) sin volver
  // a pedir el catálogo completo — mismo `tierForCatalogWeights`, mismo hardware muestreado.
  registerHandler('models:tierForSize', ipc['models:tierForSize'], async (input) => {
    const [hardware, folder] = await Promise.all([
      host.hardwareProbe.sample(),
      host.modelManager.detectedModelsFolder().catch(() => undefined),
    ]);
    const freeDiskBytes = folder?.spaceQuality === 'measured' ? folder.freeBytes : undefined;
    return tierForCatalogWeights(input.sizeBytes, hardware, { freeDiskBytes, numCtx: input.numCtx });
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
