// ModelManager, MemoryEstimator, HardwareProbe (MVP), DownloadManager (v0.2), RecommendationEngine (v0.3).
// Implementación MVP: ver doc 08-model-manager-y-scheduler.md y doc 13-centro-de-modelos.md.
// `types.js` declara las interfaces contrato `HardwareProbe`/`ModelManager`/`MemoryEstimator`;
// las clases concretas de este archivo (mismo nombre) las implementan, así que se reexportan las
// interfaces bajo un alias `*Contract` para no chocar de nombre con la clase.
export type {
  HardwareDatum,
  HardwareProfile,
  HardwareProbe as HardwareProbeContract,
  MemoryEstimator as MemoryEstimatorContract,
  ModelManager as ModelManagerContract,
  DownloadJob,
  DownloadManager as DownloadManagerContract,
  ModelCatalogEntry,
  Recommendation,
  RecommendationEngine as RecommendationEngineContract,
  FitEstimate,
  ModelInfo,
  ModelDescription,
  LoadedModel,
  MemoryEstimate,
  RegistryLayer,
  RegistryManifest,
  ManifestFetcher,
  BlobStoreProbe,
  DiskSpaceProbe,
  DownloadRecord,
  DownloadsRepositoryPort,
  DownloadProvider,
  DownloadManagerOptions,
} from './types.js';
export { HardwareProbe } from './HardwareProbe.js';
export type { HardwareProbeOptions } from './HardwareProbe.js';
export { MemoryEstimator, DEFAULT_MEMORY_OVERHEAD_BYTES } from './MemoryEstimator.js';
export type { ModelDescriber, OverheadCalibrator } from './MemoryEstimator.js';
export { ModelManager } from './ModelManager.js';
export type {
  ModelProvider,
  ModelLoadSample,
  ModelLoadSamplesRepository,
  ModelManagerOptions,
  DetectedModelsFolder,
  AttachWarning,
  AttachWarningInput,
} from './ModelManager.js';
export type { CommandRunner, CommandResult } from './CommandRunner.js';
export { realCommandRunner, POWERSHELL_EXE } from './CommandRunner.js';
export { DownloadManager } from './DownloadManager.js';
export { RegistryClient, FsBlobStoreProbe, FsDiskSpaceProbe, digestToBlobFilename } from './RegistryClient.js';
export { RecommendationEngine } from './RecommendationEngine.js';
export { loadModelCatalog, DEFAULT_CATALOG_PATH } from './catalog.js';
export {
  parseHumanSize, parseContextWindow, parseLibraryListHtml, parseTagsPageHtml,
} from './ollamaLibraryParser.js';
export type { OllamaLibraryFamilySummary, OllamaLibraryVariant } from './ollamaLibraryParser.js';
export {
  loadOllamaLibrarySnapshot, mergeSnapshotWithCuratedCatalog, DEFAULT_SNAPSHOT_PATH, OllamaLibrarySnapshotSchema,
} from './ollamaLibrarySnapshot.js';
export type {
  OllamaLibrarySnapshot, OllamaLibrarySnapshotFamily, OllamaLibrarySnapshotVariant,
} from './ollamaLibrarySnapshot.js';
export { OllamaLibraryClient, DEFAULT_LIBRARY_CACHE_TTL_MS } from './OllamaLibraryClient.js';
export type { LibraryCachePort, OllamaLibraryClientOptions } from './OllamaLibraryClient.js';
export { HuggingFaceClient } from './HuggingFaceClient.js';
export type { HuggingFaceGgufFile, HuggingFaceSearchResult } from './HuggingFaceClient.js';
export { classifyModelTier, tierForCatalogWeights } from './TierClassifier.js';
export type { ModelTier, ModelTierLevel, ModelTierColor, TierClassificationInput } from './TierClassifier.js';
