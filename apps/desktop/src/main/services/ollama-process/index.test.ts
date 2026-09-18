// Tests de OllamaProcessManager (PRIORIDAD CERO punto 1) — sin depender de que Ollama esté instalado
// ni corriendo en la máquina que ejecuta vitest: `fetch` global se reemplaza por un fake controlable,
// `spawnFn`/`execFileFn` se inyectan como fakes.
import { describe, expect, it, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { OllamaProcessManager, extractLastInferenceComputeLine } from './index.js';

function fakeFetchSequence(responses: Array<boolean | 'throw'>): typeof fetch {
  let i = 0;
  return vi.fn(async () => {
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (next === 'throw') throw new Error('fetch failed: ECONNREFUSED');
    return { ok: next } as Response;
  }) as unknown as typeof fetch;
}

describe('OllamaProcessManager', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('ya responde en loopback -> no busca el binario ni spawnea nada', async () => {
    global.fetch = fakeFetchSequence([true]);
    const execFileFn = vi.fn();
    const spawnFn = vi.fn();
    const manager = new OllamaProcessManager({ execFileFn: execFileFn as never, spawnFn: spawnFn as never });

    const result = await manager.ensureRunning();

    expect(result).toEqual({ running: true, startedByApp: false });
    expect(execFileFn).not.toHaveBeenCalled();
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('no responde y no se encuentra el binario -> ollama_not_installed, sin spawnear', async () => {
    global.fetch = fakeFetchSequence(['throw']);
    const execFileFn = vi.fn((_cmd, _args, _opts, cb: (err: Error | null) => void) => cb(new Error('ENOENT')));
    const spawnFn = vi.fn();
    const manager = new OllamaProcessManager({
      execFileFn: execFileFn as never, spawnFn: spawnFn as never,
      platform: 'win32', env: {},
    });

    const result = await manager.ensureRunning();

    expect(result).toEqual({ running: false, startedByApp: false, error: 'ollama_not_installed' });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('no responde pero el binario está en PATH -> lo arranca oculto (detached, windowsHide) y espera a que responda', async () => {
    global.fetch = fakeFetchSequence(['throw', 'throw', true]);
    const execFileFn = vi.fn((_cmd, _args, _opts, cb: (err: Error | null) => void) => cb(null));
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
    const spawnFn = vi.fn(() => child);
    const manager = new OllamaProcessManager({ execFileFn: execFileFn as never, spawnFn: spawnFn as never });

    const result = await manager.ensureRunning();

    expect(result).toEqual({ running: true, startedByApp: true });
    expect(spawnFn).toHaveBeenCalledWith('ollama', ['serve'], expect.objectContaining({
      detached: true, windowsHide: true,
    }));
    expect(child.unref).toHaveBeenCalled();
  });

  it('dos llamadas concurrentes coalescen en una sola corrida (no spawnea dos veces)', async () => {
    global.fetch = fakeFetchSequence(['throw', true]);
    const execFileFn = vi.fn((_cmd, _args, _opts, cb: (err: Error | null) => void) => cb(null));
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
    const spawnFn = vi.fn(() => child);
    const manager = new OllamaProcessManager({ execFileFn: execFileFn as never, spawnFn: spawnFn as never });

    const [a, b] = await Promise.all([manager.ensureRunning(), manager.ensureRunning()]);

    expect(a).toEqual(b);
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  // Tarea "carga de modelo/oom_load" punto 4: captura de stdout/stderr + stop() + lectura de
  // "inference compute" (log propio y modo attach).
  function makeFakeChild(): EventEmitter & { unref: () => void; kill: () => void; stdout: EventEmitter; stderr: EventEmitter; pid: number } {
    const child = new EventEmitter() as EventEmitter & {
      unref: () => void; kill: () => void; stdout: EventEmitter; stderr: EventEmitter; pid: number;
    };
    child.unref = vi.fn();
    child.kill = vi.fn();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 4242;
    return child;
  }

  it('con logsDir configurado, captura stdout/stderr en ollama-serve.log (append)', async () => {
    global.fetch = fakeFetchSequence(['throw', true]);
    const execFileFn = vi.fn((_cmd, _args, _opts, cb: (err: Error | null) => void) => cb(null));
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child);
    const written: Buffer[] = [];
    const fakeStream = { write: (chunk: Buffer) => { written.push(chunk); return true; } };
    const createLogStream = vi.fn(() => fakeStream as never);
    const manager = new OllamaProcessManager({
      execFileFn: execFileFn as never, spawnFn: spawnFn as never,
      logsDir: 'C:\\fake\\logs', createLogStream,
    });

    const resultPromise = manager.ensureRunning();
    await vi.waitFor(() => expect(spawnFn).toHaveBeenCalled());
    child.stdout.emit('data', Buffer.from('arrancando...\n'));
    child.stderr.emit('data', Buffer.from('msg="inference compute" total="18.0 GiB"\n'));
    await resultPromise;

    expect(createLogStream).toHaveBeenCalledWith(expect.stringContaining('ollama-serve.log'));
    expect(spawnFn).toHaveBeenCalledWith('ollama', ['serve'], expect.objectContaining({
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    expect(Buffer.concat(written).toString()).toContain('inference compute');
  });

  it('stop() detiene SOLO el proceso que esta clase arrancó, nunca una instancia ajena', async () => {
    global.fetch = fakeFetchSequence([true]); // ya responde -> nunca arranca nada
    const spawnFn = vi.fn();
    const manager = new OllamaProcessManager({ spawnFn: spawnFn as never, execFileFn: vi.fn() as never });
    await manager.ensureRunning();

    manager.stop(); // no hay child propio -> no debe explotar ni intentar matar nada
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('stop() mata el child real cuando esta clase sí lo arrancó', async () => {
    global.fetch = fakeFetchSequence(['throw', true]);
    const execFileFn = vi.fn((_cmd, _args, _opts, cb: (err: Error | null) => void) => cb(null));
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child);
    const manager = new OllamaProcessManager({ execFileFn: execFileFn as never, spawnFn: spawnFn as never });
    await manager.ensureRunning();

    manager.stop();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('readInferenceComputeLine lee el log propio primero (línea real de ollama serve)', async () => {
    global.fetch = fakeFetchSequence(['throw', true]);
    const execFileFn = vi.fn((_cmd, _args, _opts, cb: (err: Error | null) => void) => cb(null));
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child);
    const readFileFn = vi.fn(async (p: string) => {
      if (p.includes('ollama-serve.log')) {
        return 'algo\nmsg="inference compute" id=GPU-0 total="17.2 GiB" available="16.8 GiB"\n';
      }
      throw new Error('ENOENT');
    });
    const manager = new OllamaProcessManager({
      execFileFn: execFileFn as never, spawnFn: spawnFn as never,
      logsDir: 'C:\\fake\\logs', createLogStream: vi.fn(() => ({ write: () => true }) as never),
      readFileFn: readFileFn as never,
    });
    await manager.ensureRunning();

    const line = await manager.readInferenceComputeLine();
    expect(line).toContain('total="17.2 GiB"');
  });

  it('readInferenceComputeLine cae al log de modo attach (%LOCALAPPDATA%\\Ollama\\server.log) si no hay log propio', async () => {
    global.fetch = fakeFetchSequence([true]); // ya responde -> nunca arranca (nunca hay ownLogPath)
    const readFileFn = vi.fn(async (p: string) => {
      if (p.includes('Ollama') && p.includes('server.log')) {
        return 'msg="inference compute" id=iGPU total="18.0 GiB"\n';
      }
      throw new Error('ENOENT');
    });
    const manager = new OllamaProcessManager({
      execFileFn: vi.fn() as never, spawnFn: vi.fn() as never,
      platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local' },
      readFileFn: readFileFn as never,
    });
    await manager.ensureRunning();

    const line = await manager.readInferenceComputeLine();
    expect(line).toContain('id=iGPU');
    expect(readFileFn).toHaveBeenCalledWith(
      expect.stringContaining('Ollama\\server.log'), 'utf8',
    );
  });

  it('readInferenceComputeLine devuelve undefined sin ninguna fuente disponible', async () => {
    global.fetch = fakeFetchSequence([true]);
    // env: {} a propósito: sin esto, el equipo real que corre este test puede tener una instalación
    // real de Ollama con un %LOCALAPPDATA%\Ollama\server.log real, y el test dejaría de probar el
    // caso "ninguna fuente disponible" (falso positivo dependiente de la máquina).
    const manager = new OllamaProcessManager({
      execFileFn: vi.fn() as never, spawnFn: vi.fn() as never, env: {},
    });
    await manager.ensureRunning();

    expect(await manager.readInferenceComputeLine()).toBeUndefined();
  });
});

describe('extractLastInferenceComputeLine', () => {
  it('devuelve la ÚLTIMA línea que contiene msg="inference compute" (varios dispositivos/cargas)', () => {
    const text = [
      'level=INFO msg="inference compute" id=GPU-0 total="8.0 GiB"',
      'level=INFO msg="algo más"',
      'level=INFO msg="inference compute" id=GPU-0 total="8.0 GiB" available="6.2 GiB"',
    ].join('\n');
    expect(extractLastInferenceComputeLine(text)).toBe(
      'level=INFO msg="inference compute" id=GPU-0 total="8.0 GiB" available="6.2 GiB"',
    );
  });

  it('undefined si ninguna línea matchea', () => {
    expect(extractLastInferenceComputeLine('nada por acá\nni acá')).toBeUndefined();
  });
});
