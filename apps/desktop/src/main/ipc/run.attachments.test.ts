// Test de resolución de adjuntos en run:start (punto 1c/9 del encargo, feedback real v0.2.1) —
// apps/desktop/src/main/ipc/run.attachments.test.ts. Mismo patrón que providers.test.ts.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Attachment } from '@saurio/shared';

const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
const fakeFrame = {} as never;

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, fn);
    },
  },
}));

const { allowFrame } = await import('./registerHandler.js');
const { registerRunHandlers } = await import('./run.js');
type RuntimeHost = import('../host/RuntimeHost.js').RuntimeHost;

function makeFakeHost() {
  const start = vi.fn(async (chatId: string, text: string, mode: string, attachments?: Attachment[]) =>
    ({ runId: 'run_1', received: { chatId, text, mode, attachments } }));
  const regenerate = vi.fn(async (runId: string) => ({ runId: `${runId}_regenerated` }));
  const cancelChild = vi.fn(async () => undefined);
  const host = { runController: { start, cancel: vi.fn(), cancelChild, continueRun: vi.fn(), regenerate } };
  return { host, start, regenerate, cancelChild };
}

async function invoke(channel: string, payload: unknown): Promise<unknown> {
  const handle = handlers.get(channel);
  if (!handle) throw new Error(`canal no registrado: ${channel}`);
  return handle({ senderFrame: fakeFrame }, payload);
}

describe('ipc/run — adjuntos', () => {
  let dir: string;

  beforeEach(() => {
    handlers.clear();
    allowFrame(fakeFrame);
    dir = mkdtempSync(path.join(tmpdir(), 'saurio-run-attachments-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('sin adjuntos, pasa attachments undefined', async () => {
    const { host, start } = makeFakeHost();
    registerRunHandlers(host as unknown as RuntimeHost);
    await invoke('run:start', { chatId: 'c1', text: 'hola', mode: 'agent' });
    expect(start).toHaveBeenCalledWith('c1', 'hola', 'agent', undefined);
  });

  it('resuelve un adjunto por path a dataBase64', async () => {
    const filePath = path.join(dir, 'notas.txt');
    writeFileSync(filePath, 'contenido de prueba');
    const { host, start } = makeFakeHost();
    registerRunHandlers(host as unknown as RuntimeHost);
    await invoke('run:start', {
      chatId: 'c1', text: 'mirá esto', mode: 'agent',
      attachments: [{ kind: 'file', name: 'notas.txt', mime: 'text/plain', path: filePath }],
    });
    const [, , , attachments] = start.mock.calls[0]!;
    expect(attachments).toHaveLength(1);
    expect(Buffer.from(attachments![0]!.dataBase64!, 'base64').toString('utf8')).toBe('contenido de prueba');
  });

  it('rechaza un adjunto de texto por encima del límite de tamaño', async () => {
    const filePath = path.join(dir, 'grande.txt');
    writeFileSync(filePath, 'x'.repeat(3 * 1024 * 1024)); // 3 MB > límite de 2 MB
    const { host } = makeFakeHost();
    registerRunHandlers(host as unknown as RuntimeHost);
    await expect(invoke('run:start', {
      chatId: 'c1', text: 'mirá esto', mode: 'agent',
      attachments: [{ kind: 'file', name: 'grande.txt', mime: 'text/plain', path: filePath }],
    })).rejects.toThrow(/límite de/);
  });

  it('rechaza más de 10 adjuntos', async () => {
    const { host } = makeFakeHost();
    registerRunHandlers(host as unknown as RuntimeHost);
    const attachments = Array.from({ length: 11 }, (_, i) => ({
      kind: 'file' as const, name: `a${i}.txt`, mime: 'text/plain', dataBase64: Buffer.from('x').toString('base64'),
    }));
    await expect(invoke('run:start', { chatId: 'c1', text: 'x', mode: 'agent', attachments }))
      .rejects.toThrow(/máximo 10 adjuntos/);
  });

  it('delega run:regenerate y devuelve el nuevo runId', async () => {
    const { host, regenerate } = makeFakeHost();
    registerRunHandlers(host as unknown as RuntimeHost);
    await expect(invoke('run:regenerate', { runId: 'run_original' }))
      .resolves.toEqual({ runId: 'run_original_regenerated' });
    expect(regenerate).toHaveBeenCalledOnce();
    expect(regenerate).toHaveBeenCalledWith('run_original');
  });

  it('delega run:cancelChild con la relación padre/hijo explícita', async () => {
    const { host, cancelChild } = makeFakeHost();
    registerRunHandlers(host as unknown as RuntimeHost);
    await expect(invoke('run:cancelChild', { parentRunId: 'run_parent', childRunId: 'run_child' }))
      .resolves.toBeUndefined();
    expect(cancelChild).toHaveBeenCalledWith('run_parent', 'run_child');
  });
});
