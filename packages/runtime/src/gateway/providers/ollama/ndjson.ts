// Parser NDJSON del stream de Ollama — packages/runtime/src/gateway/providers/ollama/ndjson.ts.
// Define: doc research-ollama.md §1 ("Streaming = NDJSON, una línea JSON por chunk") y ADR-2 de la
// columna vertebral (fetch nativo + parser propio, nunca el cliente npm `ollama` porque no permite
// abort por request). Recibe el `ReadableStream<Uint8Array>` del body de fetch y produce un
// `AsyncIterable<unknown>` de objetos JSON ya parseados, uno por línea no vacía; el `.parse()` con
// zod pasa DESPUÉS de esto, en schemas.ts/client.ts (esto solo separa líneas, no valida forma).
export async function* parseNdjson(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<unknown, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    for (;;) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => undefined);
        throw new DOMException('Aborted', 'AbortError');
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) yield JSON.parse(line) as unknown;
        newlineIndex = buffer.indexOf('\n');
      }
    }
    const rest = buffer.trim();
    if (rest.length > 0) yield JSON.parse(rest) as unknown;
  } finally {
    reader.releaseLock();
  }
}
