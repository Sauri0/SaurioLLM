import { ipc } from '@saurio/shared';
import type { GlobalRuntime } from '../host/createRuntime.js';
import type { ManagedOllamaInstaller } from '../services/ollama-process/ManagedOllamaInstaller.js';
import { MANAGED_OLLAMA_URL } from '../services/ollama-process/ManagedOllamaInstaller.js';
import type { OllamaProcessManager } from '../services/ollama-process/index.js';
import type { LocalSettingsStore } from '../services/settings/LocalSettingsStore.js';
import { registerHandler } from './registerHandler.js';

export function registerEngineHandlers(installer: ManagedOllamaInstaller, manager: OllamaProcessManager,
  settings: LocalSettingsStore, runtime?: GlobalRuntime): void {
  let selecting = false;
  const status = () => ({ ...installer.status(), mode: settings.get('engine.mode') === 'managed' ? 'managed' as const : 'external' as const,
    hasManaged: installer.executablePath() !== undefined });
  registerHandler('engine:status', ipc['engine:status'], async () => status());
  registerHandler('engine:install', ipc['engine:install'], async () => { installer.start(); return status(); });
  registerHandler('engine:cancel', ipc['engine:cancel'], async () => { installer.cancel(); });
  registerHandler('engine:select', ipc['engine:select'], async ({ mode }) => {
    if (selecting) throw new Error('Esperá a que termine el cambio de motor.');
    selecting = true;
    try {
    if (!runtime) throw new Error('No se pudo abrir la base de datos. Reiniciá la aplicación para conectar el motor.');
    if ((await runtime.persistence.repositories.runs.listActive()).length > 0
      || runtime.downloadManager.listAll().some((job) => ['queued', 'running', 'paused'].includes(job.status))) {
      throw new Error('Terminá o detené las tareas y descargas antes de cambiar de motor.');
    }
    const nextExecutable = installer.executablePath();
    if (mode === 'managed' && !nextExecutable) throw new Error('Primero prepará el motor local.');
    const previous = manager.configuration();
    const previousMode = settings.get('engine.mode');
    const previousProvider = runtime.providersRepository.get('ollama');
    const wasRunning = await manager.checkHealth();
    const baseUrl = mode === 'managed' ? MANAGED_OLLAMA_URL : process.env['SAURIO_OLLAMA_URL'] ?? 'http://127.0.0.1:11434';
    let configured = false;
    try {
      await manager.configure(baseUrl, mode === 'managed' ? () => nextExecutable : undefined,
        mode === 'managed' ? { ...process.env, OLLAMA_HOST: '127.0.0.1:11435', OLLAMA_MODELS: installer.modelsDir,
          OLLAMA_NUM_PARALLEL: '1', OLLAMA_MAX_LOADED_MODELS: '1' } : undefined,
        mode === 'external' && Boolean(process.env['SAURIO_OLLAMA_URL']));
      configured = true;
      const result = await manager.ensureRunning();
      if (!result.running) {
        const detail = result.error ?? 'sin detalle del sistema';
        const explanation = detail === 'timeout_starting'
          ? 'El motor local no respondió dentro del tiempo de arranque. Podés reintentar sin volver a descargarlo.'
          : detail === 'ollama_not_installed'
            ? 'No encontramos Ollama instalado. Elegí Preparar motor local para usar el motor de SaurioLLM.'
            : detail === 'external_unavailable'
              ? 'El motor externo no respondió. Comprobá que esté iniciado y que su dirección sea correcta.'
              : detail.startsWith('spawn_failed:')
                ? 'Windows no pudo abrir el proceso del motor local.'
                : detail.startsWith('process_exited:')
                  ? 'El motor local se cerró antes de quedar listo.'
                  : 'No se pudo iniciar el motor local.';
        throw new Error(`${explanation} Si el problema continúa, compartí las últimas líneas de logs/ollama-serve.log en la carpeta de datos de SaurioLLM. Detalle: ${detail}`);
      }
      runtime.providersRepository.update('ollama', { baseUrl, enabled: true,
        label: mode === 'managed' ? 'Motor local de SaurioLLM' : 'Ollama existente' });
      runtime.modelManager.setManagedModelsFolder(mode === 'managed' ? installer.modelsDir : undefined);
      runtime.refreshProviders();
      settings.set('engine.mode', mode);
      return result;
    } catch (error) {
      if (configured) {
        try {
          await manager.configure(previous.baseUrl, previous.binaryPath, previous.processEnv, previous.attachOnly);
          if (previousProvider) runtime.providersRepository.update('ollama', previousProvider);
          runtime.modelManager.setManagedModelsFolder(previousMode === 'managed' ? installer.modelsDir : undefined);
          runtime.refreshProviders();
          settings.set('engine.mode', previousMode);
          if (wasRunning) {
            const restored = await manager.ensureRunning();
            if (!restored.running) throw new Error(restored.error ?? 'El motor anterior no respondió.', { cause: error });
          }
        } catch (rollbackError) {
          throw new Error(`No se pudo cambiar el motor ni recuperar completamente el anterior: ${String(error)}. Recuperación: ${String(rollbackError)}`, { cause: rollbackError });
        }
      }
      throw error;
    }
    } finally { selecting = false; }
  });
}
