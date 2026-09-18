// Test de read_output(toolCallId, start?, end?) — doc 07 §3, columna vertebral §4.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createReadOutputTool } from './read_output.js';
import { defaultBuiltinToolsDeps } from './deps.js';
import { makeToolContext } from '../testUtils.js';

describe('tools/builtin/read_output', () => {
  let root: string;
  let outputsDir: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'saurio-read-output-'));
    outputsDir = mkdtempSync(path.join(tmpdir(), 'saurio-tool-outputs-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outputsDir, { recursive: true, force: true });
  });

  it('relee la salida completa persistida sin volver a ejecutar nada', async () => {
    mkdirSync(outputsDir, { recursive: true });
    writeFileSync(path.join(outputsDir, 'call-123.txt'), 'l1\nl2\nl3\nl4\n');
    const tool = createReadOutputTool(defaultBuiltinToolsDeps({ toolOutputsDir: outputsDir }));
    const ctx = makeToolContext(root);
    const res = await tool.handler({ toolCallId: 'call-123' }, ctx);
    expect(res.isError).toBe(false);
    const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toContain('l1');
    expect(text).toContain('l4');
  });

  it('respeta start/end y avisa si trunca', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
    writeFileSync(path.join(outputsDir, 'call-abc.txt'), lines);
    const tool = createReadOutputTool(defaultBuiltinToolsDeps({ toolOutputsDir: outputsDir, maxCommandLines: 3 }));
    const ctx = makeToolContext(root);
    const res = await tool.handler({ toolCallId: 'call-abc', start: 2, end: 9 }, ctx);
    const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toContain('line1');
    expect(text).toContain('[salida de 10 líneas');
    expect(res.truncated).toBe(true);
  });

  it('devuelve isError si no hay salida persistida para ese toolCallId', async () => {
    const tool = createReadOutputTool(defaultBuiltinToolsDeps({ toolOutputsDir: outputsDir }));
    const ctx = makeToolContext(root);
    const res = await tool.handler({ toolCallId: 'no-existe' }, ctx);
    expect(res.isError).toBe(true);
  });
});
