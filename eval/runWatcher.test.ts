import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunEvent } from '@saurio/shared';
import { answerKnownFixtureTestPermission, CODER_FIXTURE_TEST_SCRIPT, driveThroughPermissionAsks } from './runWatcher.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const events: RunEvent[] = [];
  const listeners = new Set<(event: RunEvent) => void>();
  const answered: string[] = [];
  const cancelled: string[] = [];
  let pending: string | undefined;
  function emit(value: object) {
    const event = { runId: 'run', chatId: 'chat', ts: 1, seq: events.length + 1, ...value } as RunEvent;
    events.push(event);
    for (const listener of listeners) listener(event);
  }
  function ask(id: string) {
    pending = id;
    emit({ type: 'tool.permission', request: { toolCallId: id } });
  }
  const runtime = {
    events: {
      subscribe(listener: (event: RunEvent) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      since: () => events,
    },
    persistence: { repositories: { toolCalls: {
      async listByRun() {
        return pending ? [{
          id: pending,
          status: 'awaiting_permission',
          ...(pending === 'verify' ? { toolName: 'run_command', args: { command: 'npm test', cwd: '.', timeout: 60 } } : {}),
        }] : [];
      },
    } } },
  };
  const controller = { async cancel(id: string) { cancelled.push(id); pending = undefined; }, async answerPermission(id: string) {
    answered.push(id);
    pending = undefined;
    if (id === 'first') ask('second');
    else emit({ type: 'run.state', from: 'generating', to: 'completed' });
  } };
  return { runtime, controller, answered, cancelled, listeners, ask, emit };
}

describe('harness: permisos sucesivos', () => {
  it('contesta ambos permisos y observa el final emitido durante la última respuesta', async () => {
    const f = fixture();
    const result = driveThroughPermissionAsks(f.runtime, f.controller, 'run',
      (id) => ({ toolCallId: id, answer: 'allow_once' }), { perRoundTimeoutMs: 100 });
    f.ask('first');
    expect(await result).toEqual({ rounds: 2, firstToolCallId: 'first', finalState: 'completed' });
    expect(f.answered).toEqual(['first', 'second']);
    expect(f.listeners.size).toBe(0);
  });

  it('recupera el permiso anterior a la suscripción sin procesarlo dos veces', async () => {
    const f = fixture();
    f.ask('first');
    const result = await driveThroughPermissionAsks(f.runtime, f.controller, 'run',
      (id) => ({ toolCallId: id, answer: 'allow_once' }));
    expect(result.finalState).toBe('completed');
    expect(f.answered).toEqual(['first', 'second']);
  });

  it('recupera un run ya terminado y libera la suscripción', async () => {
    const f = fixture();
    f.emit({ type: 'run.state', from: 'generating', to: 'completed' });
    expect((await driveThroughPermissionAsks(f.runtime, f.controller, 'run',
      (id) => ({ toolCallId: id, answer: 'allow_once' }))).finalState).toBe('completed');
    expect(f.listeners.size).toBe(0);
  });

  it('distingue un límite de rondas de un timeout', async () => {
    const f = fixture();
    f.ask('first');
    expect((await driveThroughPermissionAsks(f.runtime, f.controller, 'run',
      (id) => ({ toolCallId: id, answer: 'allow_once' }), { maxRounds: 1 })).finalState).toBe('permission_round_limit');
    expect(f.answered).toEqual(['first']);
    expect(f.cancelled).toEqual(['run']);
    expect(await f.runtime.persistence.repositories.toolCalls.listByRun()).toEqual([]);
    expect(f.listeners.size).toBe(0);
  });
  it('cancela el run si deja de recibir eventos', async () => {
    const f = fixture();
    expect((await driveThroughPermissionAsks(f.runtime, f.controller, 'run',
      (id) => ({ toolCallId: id, answer: 'allow_once' }), { perRoundTimeoutMs: 1 })).finalState).toBe('timeout');
    expect(f.cancelled).toEqual(['run']);
    expect(f.listeners.size).toBe(0);
  });

  it('entrega la tool call persistida al decisor para inspeccionarla antes de responder', async () => {
    const f = fixture();
    f.ask('verify');
    let inspected: unknown;
    const result = await driveThroughPermissionAsks(f.runtime, f.controller, 'run', (id, call) => {
      inspected = call;
      return { toolCallId: id, answer: 'allow_once' };
    });
    expect(result.finalState).toBe('completed');
    expect(inspected).toMatchObject({
      id: 'verify',
      toolName: 'run_command',
      args: { command: 'npm test', cwd: '.', timeout: 60 },
    });
  });
});

describe('harness: permiso de verificación del fixture', () => {
  const expectedTestScript = "node -e \"process.exit(0)\"";

  function fixtureRoot(scripts: Record<string, string> = { test: expectedTestScript }): string {
    const root = mkdtempSync(path.join(tmpdir(), 'saurio-run-watcher-'));
    tempDirs.push(root);
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, scripts }), 'utf8');
    return root;
  }

  function call(overrides: Record<string, unknown> = {}) {
    return {
      id: 'permission-1',
      status: 'awaiting_permission',
      toolName: 'run_command',
      args: { command: 'npm test', cwd: '.', timeout: 60 },
      ...overrides,
    };
  }

  it('autoriza una sola vez el npm test exacto con script conocido y sin hooks', () => {
    expect(answerKnownFixtureTestPermission(call(), fixtureRoot(), expectedTestScript)).toMatchObject({
      toolCallId: 'permission-1',
      answer: 'allow_once',
    });
  });

  it.each([
    ['comando compuesto', call({ args: { command: 'npm test && echo injected', cwd: '.' } })],
    ['cwd externo', call({ args: { command: 'npm test', cwd: '..' } })],
    ['otra herramienta', call({ toolName: 'edit_file', args: { path: 'package.json' } })],
    ['timeout fuera de límite', call({ args: { command: 'npm test', cwd: '.', timeout: 600 } })],
  ])('deniega explícitamente %s', (_label, pending) => {
    const answer = answerKnownFixtureTestPermission(pending, fixtureRoot(), expectedTestScript);
    expect(answer.answer).toBe('deny');
    expect(answer.reason).toMatch(/^evaluación automática:/);
  });

  it('deniega si el script cambió o aparece un hook npm adicional', () => {
    const changed = answerKnownFixtureTestPermission(call(), fixtureRoot({ test: 'node unsafe.js' }), expectedTestScript);
    const hooked = answerKnownFixtureTestPermission(
      call(),
      fixtureRoot({ pretest: 'node unsafe.js', test: expectedTestScript }),
      expectedTestScript,
    );
    expect(changed.answer).toBe('deny');
    expect(hooked.answer).toBe('deny');
  });
});
