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
    vi.useRealTimers();
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

  it('un portable administrado arranca desde su propio directorio y tolera más de 15 s de cold start', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    global.fetch = vi.fn(async () => {
      if (Date.now() < 16_000) throw new Error('fetch failed: ECONNREFUSED');
      return { ok: true } as Response;
    }) as unknown as typeof fetch;
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
    const spawnFn = vi.fn(() => child);
    const manager = new OllamaProcessManager({
      binaryPath: () => 'C:\\Saurio\\engines\\ollama\\v1\\ollama.exe',
      spawnFn: spawnFn as never,
    });

    const resultPromise = manager.ensureRunning();
    await vi.advanceTimersByTimeAsync(16_500);

    await expect(resultPromise).resolves.toEqual({ running: true, startedByApp: true });
    expect(spawnFn).toHaveBeenCalledWith(
      'C:\\Saurio\\engines\\ollama\\v1\\ollama.exe', ['serve'],
      expect.objectContaining({ cwd: 'C:\\Saurio\\engines\\ollama\\v1' }),
    );
  });

  it('informa un error asíncrono de spawn sin degradarlo a timeout_starting', async () => {
    global.fetch = fakeFetchSequence(['throw']);
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')));
      return child;
    });
    const manager = new OllamaProcessManager({
      binaryPath: () => 'C:\\managed\\ollama.exe', spawnFn: spawnFn as never,
    });

    await expect(manager.ensureRunning()).resolves.toEqual({
      running: false, startedByApp: false, error: 'spawn_failed:spawn ENOENT',
    });
  });

  it('informa la salida temprana del proceso sin esperar el timeout completo', async () => {
    global.fetch = fakeFetchSequence(['throw']);
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        child.exitCode = 3221225781;
        child.emit('exit', 3221225781);
      });
      return child;
    });
    const manager = new OllamaProcessManager({
      binaryPath: () => 'C:\\managed\\ollama.exe', spawnFn: spawnFn as never,
    });

    await expect(manager.ensureRunning()).resolves.toEqual({
      running: false, startedByApp: true, error: 'process_exited:3221225781',
    });
  });

  it('conserva la señal si el proceso termina sin exit code', async () => {
    global.fetch = fakeFetchSequence(['throw']);
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => child.emit('exit', null, 'SIGABRT'));
      return child;
    });
    const manager = new OllamaProcessManager({
      binaryPath: () => 'C:\\managed\\ollama.exe', spawnFn: spawnFn as never,
    });

    await expect(manager.ensureRunning()).resolves.toEqual({
      running: false, startedByApp: true, error: 'process_exited:signal=SIGABRT',
    });
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
  function makeFakeChild(): EventEmitter & {
    unref: () => void;
    kill: () => boolean;
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number;
    exitCode: number | null;
  } {
    const child = new EventEmitter() as EventEmitter & {
      unref: () => void;
      kill: () => boolean;
      stdout: EventEmitter;
      stderr: EventEmitter;
      pid: number;
      exitCode: number | null;
    };
    child.unref = vi.fn();
    child.exitCode = null;
    child.kill = vi.fn(() => {
      child.exitCode = 0;
      child.emit('exit', 0);
      return true;
    });
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 4242;
    return child;
  }

  function makeTreeKiller(child: ReturnType<typeof makeFakeChild>) {
    return vi.fn(async () => {
      child.exitCode = 0;
      child.emit('exit', 0);
      return { stdout: '', stderr: '' };
    });
  }

  it('attachOnly comprueba el endpoint configurado sin buscar ni arrancar un binario local', async () => {
    global.fetch = fakeFetchSequence(['throw']);
    const execFileFn = vi.fn();
    const spawnFn = vi.fn();
    const manager = new OllamaProcessManager({
      baseUrl: 'http://127.0.0.1:22434',
      attachOnly: true,
      execFileFn: execFileFn as never,
      spawnFn: spawnFn as never,
    });

    await expect(manager.ensureRunning()).resolves.toEqual({
      running: false,
      startedByApp: false,
      error: 'external_unavailable',
    });
    expect(execFileFn).not.toHaveBeenCalled();
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('configuration() permite restaurar baseUrl, binario, entorno y attachOnly sin perder referencias', async () => {
    const binaryPath = () => 'C:\\managed\\ollama.exe';
    const processEnv = { OLLAMA_MODELS: 'C:\\managed\\models' };
    const manager = new OllamaProcessManager({
      baseUrl: 'http://127.0.0.1:22434', binaryPath, processEnv, attachOnly: true,
    });

    expect(manager.configuration()).toEqual({
      baseUrl: 'http://127.0.0.1:22434', binaryPath, processEnv, attachOnly: true,
    });

    await manager.configure('http://127.0.0.1:33434', undefined, undefined, false);
    expect(manager.configuration()).toEqual({
      baseUrl: 'http://127.0.0.1:33434',
      binaryPath: undefined,
      processEnv: undefined,
      attachOnly: false,
    });
  });

  it('si vence el arranque, mata el child propio, espera su salida y cierra el log', async () => {
    global.fetch = fakeFetchSequence(['throw']);
    const execFileFn = vi.fn((_cmd, _args, _opts, cb: (err: Error | null) => void) => cb(null));
    const child = makeFakeChild();
    const execFileHiddenFn = makeTreeKiller(child);
    const end = vi.fn();
    const manager = new OllamaProcessManager({
      execFileFn: execFileFn as never,
      spawnFn: vi.fn(() => child) as never,
      logsDir: 'C:\\fake\\logs',
      createLogStream: vi.fn(() => ({ write: () => true, end }) as never),
      startTimeoutMs: 1,
      pollIntervalMs: 1,
      stopTimeoutMs: 20,
      platform: 'win32',
      execFileHiddenFn,
    });

    const result = await manager.ensureRunning();

    expect(result).toEqual({ running: false, startedByApp: true, error: 'timeout_starting' });
    expect(execFileHiddenFn).toHaveBeenCalledWith(
      'taskkill.exe',
      ['/PID', '4242', '/T', '/F'],
      { timeout: 20 },
    );
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.exitCode).toBe(0);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('cierra el log si el spawn falla antes de entregar un child', async () => {
    global.fetch = fakeFetchSequence(['throw']);
    const execFileFn = vi.fn((_cmd, _args, _opts, cb: (err: Error | null) => void) => cb(null));
    const end = vi.fn();
    const manager = new OllamaProcessManager({
      execFileFn: execFileFn as never,
      spawnFn: vi.fn(() => { throw new Error('spawn EACCES'); }) as never,
      logsDir: 'C:\\fake\\logs',
      createLogStream: vi.fn(() => ({ write: () => true, end }) as never),
    });

    await expect(manager.ensureRunning()).resolves.toEqual({
      running: false,
      startedByApp: false,
      error: 'spawn_failed:spawn EACCES',
    });
    expect(end).toHaveBeenCalledTimes(1);
  });

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
    const execFileHiddenFn = vi.fn();
    const manager = new OllamaProcessManager({
      spawnFn: spawnFn as never,
      execFileFn: vi.fn() as never,
      execFileHiddenFn: execFileHiddenFn as never,
      platform: 'win32',
    });
    await manager.ensureRunning();

    await manager.stop(); // no hay child propio -> no debe explotar ni intentar matar nada
    expect(spawnFn).not.toHaveBeenCalled();
    expect(execFileHiddenFn).not.toHaveBeenCalled();
  });

  it('stop() termina el árbol del PID propio en Windows y espera su salida', async () => {
    global.fetch = fakeFetchSequence(['throw', true]);
    const execFileFn = vi.fn((_cmd, _args, _opts, cb: (err: Error | null) => void) => cb(null));
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child);
    const execFileHiddenFn = makeTreeKiller(child);
    const manager = new OllamaProcessManager({
      execFileFn: execFileFn as never,
      execFileHiddenFn,
      spawnFn: spawnFn as never,
      platform: 'win32',
      stopTimeoutMs: 20,
    });
    await manager.ensureRunning();

    await manager.stop();

    expect(execFileHiddenFn).toHaveBeenCalledWith(
      'taskkill.exe',
      ['/PID', '4242', '/T', '/F'],
      { timeout: 20 },
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('stop() deduplica pedidos simultáneos sobre el mismo árbol propio', async () => {
    global.fetch = fakeFetchSequence(['throw', true]);
    const execFileFn = vi.fn((_cmd, _args, _opts, cb: (err: Error | null) => void) => cb(null));
    const child = makeFakeChild();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const execFileHiddenFn = vi.fn(async () => {
      await waiting;
      child.exitCode = 0;
      child.emit('exit', 0);
      return { stdout: '', stderr: '' };
    });
    const manager = new OllamaProcessManager({
      execFileFn: execFileFn as never,
      execFileHiddenFn,
      spawnFn: vi.fn(() => child) as never,
      platform: 'win32',
      stopTimeoutMs: 50,
    });
    await manager.ensureRunning();

    const first = manager.stop();
    const second = manager.stop();
    await vi.waitFor(() => expect(execFileHiddenFn).toHaveBeenCalledTimes(1));
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(execFileHiddenFn).toHaveBeenCalledTimes(1);
  });

  it('si vence el stop conserva el PID propio y permite reintentar exactamente ese árbol', async () => {
    global.fetch = fakeFetchSequence(['throw', true]);
    const execFileFn = vi.fn((_cmd, _args, _opts, cb: (err: Error | null) => void) => cb(null));
    const child = makeFakeChild();
    let attempt = 0;
    const execFileHiddenFn = vi.fn(async (_command: string, _args: readonly string[] = []) => {
      attempt += 1;
      if (attempt === 2) {
        child.exitCode = 0;
        child.emit('exit', 0);
      }
      return { stdout: '', stderr: '' };
    });
    const manager = new OllamaProcessManager({
      execFileFn: execFileFn as never,
      execFileHiddenFn,
      spawnFn: vi.fn(() => child) as never,
      platform: 'win32',
      stopTimeoutMs: 5,
    });
    await manager.ensureRunning();

    await expect(manager.stop()).rejects.toThrow('todavía está cerrando');
    await expect(manager.stop()).resolves.toBeUndefined();

    expect(execFileHiddenFn).toHaveBeenCalledTimes(2);
    expect(execFileHiddenFn.mock.calls.map((call) => call[1])).toEqual([
      ['/PID', '4242', '/T', '/F'],
      ['/PID', '4242', '/T', '/F'],
    ]);
  });

  it('una salida natural durante taskkill prevalece sobre su error de carrera', async () => {
    global.fetch = fakeFetchSequence(['throw', true]);
    const execFileFn = vi.fn((_cmd, _args, _opts, cb: (err: Error | null) => void) => cb(null));
    const child = makeFakeChild();
    const execFileHiddenFn = vi.fn(async () => {
      child.exitCode = 0;
      child.emit('exit', 0);
      throw new Error('ERROR: no se encontró el proceso');
    });
    const manager = new OllamaProcessManager({
      execFileFn: execFileFn as never,
      execFileHiddenFn,
      spawnFn: vi.fn(() => child) as never,
      platform: 'win32',
      stopTimeoutMs: 20,
    });
    await manager.ensureRunning();

    await expect(manager.stop()).resolves.toBeUndefined();
    expect(execFileHiddenFn).toHaveBeenCalledTimes(1);
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

  it('al pasar de proceso propio a attach descarta el log propio cerrado y lee la fuente externa', async () => {
    global.fetch = fakeFetchSequence(['throw', true]);
    const execFileFn = vi.fn((_cmd, _args, _opts, cb: (err: Error | null) => void) => cb(null));
    const child = makeFakeChild();
    const end = vi.fn();
    const readFileFn = vi.fn(async (p: string) => {
      if (p.includes('fake') && p.includes('ollama-serve.log')) {
        return 'msg="inference compute" id=PROPIO total="8.0 GiB"\n';
      }
      if (p.includes('Ollama') && p.includes('server.log')) {
        return 'msg="inference compute" id=EXTERNO total="12.0 GiB"\n';
      }
      throw new Error('ENOENT');
    });
    const manager = new OllamaProcessManager({
      execFileFn: execFileFn as never,
      execFileHiddenFn: makeTreeKiller(child),
      spawnFn: vi.fn(() => child) as never,
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local' },
      logsDir: 'C:\\fake\\logs',
      createLogStream: vi.fn(() => ({ write: () => true, end }) as never),
      readFileFn: readFileFn as never,
      stopTimeoutMs: 20,
    });
    await manager.ensureRunning();
    expect(await manager.readInferenceComputeLine()).toContain('id=PROPIO');

    await manager.configure('http://127.0.0.1:22434', undefined, undefined, true);

    expect(end).toHaveBeenCalledTimes(1);
    expect(await manager.readInferenceComputeLine()).toContain('id=EXTERNO');
    expect(readFileFn).toHaveBeenLastCalledWith(expect.stringContaining('Ollama\\server.log'), 'utf8');
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
