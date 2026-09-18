// Test de run_command(command, cwd?, timeout?) — doc 05 §2.8 punto 32.
// Usa comandos simples multiplataforma (echo/exit vía el propio shell resuelto) para no depender de
// que el entorno de CI tenga node/bash instalado aparte del shell del sistema.
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRunCommandTool, classifyCommand } from './run_command.js';
import { defaultBuiltinToolsDeps } from './deps.js';
import { makeToolContext } from '../testUtils.js';

describe('tools/builtin/run_command', () => {
  let root: string;
  let outputsDir: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'saurio-run-cmd-'));
    outputsDir = mkdtempSync(path.join(tmpdir(), 'saurio-run-cmd-out-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outputsDir, { recursive: true, force: true });
  });

  it('ejecuta un comando exitoso y devuelve stdout + exit code 0', async () => {
    const tool = createRunCommandTool(defaultBuiltinToolsDeps({ toolOutputsDir: outputsDir }));
    const ctx = makeToolContext(root);
    const res = await tool.handler({ command: 'echo hola-saurio' }, ctx);
    expect(res.isError).toBe(false);
    const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toContain('hola-saurio');
    expect((res.structured as { exitCode: number }).exitCode).toBe(0);
  }, 20000);

  it('reporta isError en un comando con exit code distinto de 0', async () => {
    const tool = createRunCommandTool(defaultBuiltinToolsDeps({ toolOutputsDir: outputsDir }));
    const ctx = makeToolContext(root);
    const res = await tool.handler({ command: 'exit 3' }, ctx);
    expect(res.isError).toBe(true);
    expect((res.structured as { exitCode: number }).exitCode).toBe(3);
  }, 20000);

  it('emite salida en vivo vía ctx.emit', async () => {
    const chunks: string[] = [];
    const tool = createRunCommandTool(defaultBuiltinToolsDeps({ toolOutputsDir: outputsDir }));
    const ctx = makeToolContext(root, { emit: (ev) => chunks.push(ev.text) });
    await tool.handler({ command: 'echo streamed' }, ctx);
    expect(chunks.join('')).toContain('streamed');
  }, 20000);

  it('mata el proceso al vencer el timeout configurado', async () => {
    const tool = createRunCommandTool(defaultBuiltinToolsDeps({ toolOutputsDir: outputsDir }));
    const ctx = makeToolContext(root);
    const start = Date.now();
    const sleepCmd = process.platform === 'win32'
      ? 'Start-Sleep -Seconds 30'
      : 'sleep 30';
    const res = await tool.handler({ command: sleepCmd, timeout: 500 }, ctx);
    const elapsed = Date.now() - start;
    expect(res.isError).toBe(true);
    expect(elapsed).toBeLessThan(15000);
  }, 20000);

  it('cancela el proceso cuando se aborta la signal', async () => {
    const tool = createRunCommandTool(defaultBuiltinToolsDeps({ toolOutputsDir: outputsDir }));
    const controller = new AbortController();
    const ctx = makeToolContext(root, { signal: controller.signal });
    const sleepCmd = process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30';
    const promise = tool.handler({ command: sleepCmd }, ctx);
    setTimeout(() => controller.abort(), 300);
    const res = await promise;
    expect(res.isError).toBe(true);
  }, 20000);

  it('persiste la salida completa en tool-outputs/ y marca truncated cuando supera 30.000 chars', async () => {
    const tool = createRunCommandTool(defaultBuiltinToolsDeps({ toolOutputsDir: outputsDir }));
    const ctx = makeToolContext(root);
    const bigCmd = process.platform === 'win32'
      ? '1..3200 | ForEach-Object { "x".PadRight(10, "x") }'
      : "yes xxxxxxxxxx | head -n 3200";
    const res = await tool.handler({ command: bigCmd }, ctx);
    expect(res.truncated).toBe(true);
    expect(res.fullOutputPath).toBeTruthy();
    if (res.fullOutputPath) {
      const full = await readFile(res.fullOutputPath, 'utf8');
      expect(full.length).toBeGreaterThan(30000);
    }
  }, 20000);

  it('classifyCommand marca instalación de dependencias como riesgo medio', () => {
    const c = classifyCommand('npm install left-pad');
    expect(c.risk).toBe('medium');
    expect(c.category).toBe('terminal');
  });

  it('classifyCommand marca git reset --hard como riesgo alto', () => {
    const c = classifyCommand('git reset --hard origin/main');
    expect(c.risk).toBe('high');
  });

  it('classifyCommand marca un comando común como riesgo bajo', () => {
    const c = classifyCommand('echo hola');
    expect(c.risk).toBe('low');
  });
});
