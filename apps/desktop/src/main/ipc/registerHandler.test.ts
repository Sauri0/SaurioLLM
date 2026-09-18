// Test de registerHandler: valida input con zod y event.senderFrame contra allowedFrames (doc 01 §5
// "Seguridad de Electron", ADR-014). `electron` se mockea porque vitest corre fuera de Electron.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, fn);
    },
  },
}));

// Import dinámico DESPUÉS del mock (vi.mock se hoistea, pero mantenemos el orden explícito por claridad).
const mod = await import('./registerHandler.js');
const allowFrame = mod.allowFrame;
// registerHandler es genérico sobre IpcChannel (packages/shared/src/ipc.ts); acá se prueba su
// comportamiento (validación zod + senderFrame) con un canal y un contrato de prueba que no forman
// parte del mapa real, así que se relaja el tipo a propósito solo dentro de este archivo de test.
const registerHandler = mod.registerHandler as unknown as (
  channel: string,
  contract: { input: z.ZodType; output: z.ZodType },
  fn: (input: { n: number }, event: unknown) => unknown,
) => void;

describe('registerHandler', () => {
  const contract = { input: z.object({ n: z.number() }), output: z.object({ doubled: z.number() }) };
  const channel = 'test:channel';

  beforeEach(() => {
    handlers.clear();
  });

  it('registra el canal contra ipcMain.handle', () => {
    registerHandler(channel, contract, (input: { n: number }) => ({ doubled: input.n * 2 }));
    expect(handlers.has('test:channel')).toBe(true);
  });

  it('rechaza un frame no autorizado sin llegar a ejecutar fn', async () => {
    const fn = vi.fn((input: { n: number }) => ({ doubled: input.n * 2 }));
    registerHandler(channel, contract, fn);
    const handle = handlers.get('test:channel')!;

    const fakeFrame = {};
    await expect(handle({ senderFrame: fakeFrame }, { n: 2 })).rejects.toThrow(/no autorizado/);
    expect(fn).not.toHaveBeenCalled();
  });

  it('acepta un frame autorizado con allowFrame() y devuelve el resultado de fn', async () => {
    const fn = vi.fn((input: { n: number }) => ({ doubled: input.n * 2 }));
    registerHandler(channel, contract, fn);
    const handle = handlers.get('test:channel')!;

    const fakeFrame = {} as never;
    allowFrame(fakeFrame);

    const result = await handle({ senderFrame: fakeFrame }, { n: 21 });
    expect(result).toEqual({ doubled: 42 });
    expect(fn).toHaveBeenCalledWith({ n: 21 }, { senderFrame: fakeFrame });
  });

  it('valida el input con zod: un payload inválido tira antes de llamar a fn', async () => {
    const fn = vi.fn();
    registerHandler(channel, contract, fn);
    const handle = handlers.get('test:channel')!;

    const fakeFrame = {} as never;
    allowFrame(fakeFrame);

    await expect(handle({ senderFrame: fakeFrame }, { n: 'no-es-un-numero' })).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });

  it('un frame null (invoke sin senderFrame vivo) se rechaza', async () => {
    const fn = vi.fn();
    registerHandler(channel, contract, fn);
    const handle = handlers.get('test:channel')!;

    await expect(handle({ senderFrame: null }, { n: 1 })).rejects.toThrow(/no autorizado/);
    expect(fn).not.toHaveBeenCalled();
  });
});
