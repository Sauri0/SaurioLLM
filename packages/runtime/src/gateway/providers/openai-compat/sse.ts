// Parser SSE (Server-Sent Events) para /v1/chat/completions — packages/runtime/src/gateway/providers/openai-compat/sse.ts.
// Formato: bloques `data: <json>\n\n`, terminados por el centinela literal `data: [DONE]`
// [VERIFICADO EN DOC OFICIAL: platform.openai.com/docs/api-reference/chat-streaming]. Solo extrae
// el string crudo de cada línea `data:`; el parseo/validación JSON pasa después, en client.ts —
// mismo criterio de separación de responsabilidades que ../ollama/ndjson.ts.
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string, void, unknown> {
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
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        buffer = buffer.slice(newlineIndex + 1);
        // Líneas "event:"/"id:"/":" (comentario o keep-alive) y las líneas vacías que separan
        // eventos se ignoran a propósito: solo `data:` importa para este formato.
        if (line.startsWith('data:')) {
          const data = line.slice(5).trimStart();
          if (data.length > 0) yield data;
        }
        newlineIndex = buffer.indexOf('\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}
