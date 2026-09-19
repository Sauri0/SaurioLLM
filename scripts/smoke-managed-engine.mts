// Real, opt-in download and inference against an isolated managed engine. No API credentials.
// pnpm exec tsx scripts/smoke-managed-engine.mts [isolated-user-data-directory]
import path from 'node:path';
import { ManagedOllamaInstaller } from '../apps/desktop/src/main/services/ollama-process/ManagedOllamaInstaller.js';
import { OllamaProcessManager } from '../apps/desktop/src/main/services/ollama-process/index.js';

const directory = path.resolve(process.argv[2] ?? 'smoke/managed-engine-023');
const installer = new ManagedOllamaInstaller(directory);
const baseUrl = 'http://127.0.0.1:11435';
const manager = new OllamaProcessManager({ baseUrl, binaryPath: () => installer.executablePath(),
  processEnv: { ...process.env, OLLAMA_HOST: '127.0.0.1:11435', OLLAMA_MODELS: installer.modelsDir,
    OLLAMA_MAX_LOADED_MODELS: '1', OLLAMA_NUM_PARALLEL: '1' }, logsDir: path.join(directory, 'logs') });
if (await manager.checkHealth()) throw new Error('El puerto de prueba está ocupado; no se usará un motor ajeno.');
const startedAt = Date.now();
try {
  if (!installer.executablePath()) {
    installer.start(); await installer.wait();
    if (installer.status().phase !== 'installed') throw new Error(JSON.stringify(installer.status()));
  }
  const started = await manager.ensureRunning();
  if (!started.running || !started.startedByApp) throw new Error(JSON.stringify(started));
  const post = async (endpoint: string, value: unknown) => {
    const response = await fetch(`${baseUrl}/api/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value), signal: AbortSignal.timeout(10 * 60_000) });
    if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}: ${await response.text()}`);
    return response.json() as Promise<Record<string, unknown>>;
  };
  console.log('Descargando modelo pequeño al almacén aislado…');
  await post('pull', { model: 'qwen3:0.6b', stream: false });
  const described = await post('show', { model: 'qwen3:0.6b' });
  const info = described['model_info'] as Record<string, unknown>;
  const contextMax = Object.entries(info).find(([key]) => key.endsWith('.context_length'))?.[1];
  if (typeof contextMax !== 'number' || contextMax <= 0) throw new Error('Contexto máximo desconocido.');
  const result = await post('chat', { model: 'qwen3:0.6b', stream: false, think: false,
    messages: [{ role: 'user', content: 'Respondé únicamente: motor local funcionando' }],
    options: { num_ctx: contextMax, num_predict: 80, temperature: 0, num_gpu: 0, num_thread: 4 } });
  const content = (result['message'] as { content?: string } | undefined)?.content;
  if (result['done'] !== true || !content?.trim()) throw new Error(`Sin respuesta final: ${JSON.stringify(result)}`);
  console.log(JSON.stringify({ contextMax, content, evalCount: result['eval_count'], elapsedMs: Date.now() - startedAt, compute: 'CPU, 4 hilos', directory }));
} finally {
  await manager.configure('http://127.0.0.1:9', undefined, undefined, true);
  console.log('Motor propio detenido; los archivos de prueba se conservaron.');
}
