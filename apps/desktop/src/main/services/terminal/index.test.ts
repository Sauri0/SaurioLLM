// Tests de TerminalService (doc 01 §4.10) con un pty falso inyectado: no dependen de un shell real
// instalado en la máquina que corre vitest, ni de node-pty realmente spawneando un proceso.
import { describe, expect, it, vi } from 'vitest';
import type * as pty from 'node-pty';
import { TerminalService, commandExists, resolveShell, type PtySpawnFn } from './index.js';

function makeFakePty(): { proc: pty.IPty; dataListeners: ((chunk: string) => void)[]; exitListeners: ((e: { exitCode: number }) => void)[] } {
  const dataListeners: ((chunk: string) => void)[] = [];
  const exitListeners: ((e: { exitCode: number }) => void)[] = [];
  const proc = {
    onData: (cb: (chunk: string) => void) => {
      dataListeners.push(cb);
      return { dispose: () => {} };
    },
    onExit: (cb: (e: { exitCode: number }) => void) => {
      exitListeners.push(cb);
      return { dispose: () => {} };
    },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  } as unknown as pty.IPty;
  return { proc, dataListeners, exitListeners };
}

describe('resolveShell', () => {
  it('respeta el shell explícito si se pasa uno', () => {
    expect(resolveShell('bash')).toBe('bash');
  });
});

describe('commandExists', () => {
  it('devuelve false si el comando no existe (execFileSync tira)', () => {
    const throwing = vi.fn(() => {
      throw new Error('not found');
    });
    expect(commandExists('comando-que-no-existe-xyz', throwing as never)).toBe(false);
  });

  it('devuelve true si execFileSync no tira', () => {
    const ok = vi.fn(() => Buffer.from(''));
    expect(commandExists('algo', ok as never)).toBe(true);
  });
});

describe('TerminalService', () => {
  it('create() spawnea con el shell resuelto y trackea la sesión', () => {
    const { proc } = makeFakePty();
    const spawn: PtySpawnFn = vi.fn(() => proc);
    const service = new TerminalService(spawn);

    service.create('t1', { cwd: '/tmp' }, () => {}, () => {});

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(service.has('t1')).toBe(true);
  });

  it('crear dos veces el mismo id tira', () => {
    const { proc } = makeFakePty();
    const spawn: PtySpawnFn = () => proc;
    const service = new TerminalService(spawn);
    service.create('t1', { cwd: '/tmp' }, () => {}, () => {});
    expect(() => service.create('t1', { cwd: '/tmp' }, () => {}, () => {})).toThrow();
  });

  it('onData reenvía los chunks de salida', () => {
    const { proc, dataListeners } = makeFakePty();
    const spawn: PtySpawnFn = () => proc;
    const service = new TerminalService(spawn);
    const received: string[] = [];
    service.create('t1', { cwd: '/tmp' }, (chunk) => received.push(chunk), () => {});

    dataListeners[0]?.('hola\r\n');
    expect(received).toEqual(['hola\r\n']);
  });

  it('write/resize delegan al proceso de la sesión', () => {
    const { proc } = makeFakePty();
    const spawn: PtySpawnFn = () => proc;
    const service = new TerminalService(spawn);
    service.create('t1', { cwd: '/tmp' }, () => {}, () => {});

    service.write('t1', 'ls\n');
    service.resize('t1', 100, 40);

    expect(proc.write).toHaveBeenCalledWith('ls\n');
    expect(proc.resize).toHaveBeenCalledWith(100, 40);
  });

  it('write en una sesión inexistente tira', () => {
    const service = new TerminalService(() => makeFakePty().proc);
    expect(() => service.write('nope', 'x')).toThrow();
  });

  it('close() mata el proceso y borra la sesión', () => {
    const { proc } = makeFakePty();
    const spawn: PtySpawnFn = () => proc;
    const service = new TerminalService(spawn);
    service.create('t1', { cwd: '/tmp' }, () => {}, () => {});

    service.close('t1');

    expect(proc.kill).toHaveBeenCalled();
    expect(service.has('t1')).toBe(false);
  });

  it('la salida del proceso (onExit) limpia la sesión y notifica el código', () => {
    const { proc, exitListeners } = makeFakePty();
    const spawn: PtySpawnFn = () => proc;
    const service = new TerminalService(spawn);
    const exitCodes: number[] = [];
    service.create('t1', { cwd: '/tmp' }, () => {}, (code) => exitCodes.push(code));

    exitListeners[0]?.({ exitCode: 1 });

    expect(exitCodes).toEqual([1]);
    expect(service.has('t1')).toBe(false);
  });

  it('closeAll() cierra todas las sesiones abiertas', () => {
    const a = makeFakePty();
    const b = makeFakePty();
    let call = 0;
    const spawn: PtySpawnFn = () => (call++ === 0 ? a.proc : b.proc);
    const service = new TerminalService(spawn);
    service.create('a', { cwd: '/tmp' }, () => {}, () => {});
    service.create('b', { cwd: '/tmp' }, () => {}, () => {});

    service.closeAll();

    expect(a.proc.kill).toHaveBeenCalled();
    expect(b.proc.kill).toHaveBeenCalled();
    expect(service.has('a')).toBe(false);
    expect(service.has('b')).toBe(false);
  });
});
