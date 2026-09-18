// Test del parser NDJSON — packages/runtime/src/gateway/providers/ollama/ndjson.test.ts.
import { describe, expect, it } from 'vitest';
import { parseNdjson } from './ndjson.js';
import { ndjsonStream, STREAM_NORMAL_LINES } from './__fixtures__/ndjsonFixtures.js';

async function collect<T>(iter: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

describe('gateway/providers/ollama/ndjson', () => {
  it('parsea una línea por objeto JSON', async () => {
    const stream = ndjsonStream(STREAM_NORMAL_LINES);
    const items = await collect(parseNdjson(stream));
    expect(items).toHaveLength(3);
    expect((items[0] as { message: { content: string } }).message.content).toBe('Hola');
  });

  it('reensambla una línea partida en dos chunks TCP', async () => {
    const stream = ndjsonStream(STREAM_NORMAL_LINES, { splitMidLine: true });
    const items = await collect(parseNdjson(stream));
    expect(items).toHaveLength(3);
    const last = items[2] as { done: boolean; done_reason: string };
    expect(last.done).toBe(true);
    expect(last.done_reason).toBe('stop');
  });

  it('ignora líneas vacías (\\n final)', async () => {
    const stream = ndjsonStream(['{"a":1}', '', '{"a":2}']);
    const items = await collect(parseNdjson(stream));
    expect(items).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('aborta con AbortError cuando el signal ya está abortado', async () => {
    const stream = ndjsonStream(STREAM_NORMAL_LINES);
    const controller = new AbortController();
    controller.abort();
    await expect(collect(parseNdjson(stream, controller.signal))).rejects.toMatchObject({ name: 'AbortError' });
  });
});
