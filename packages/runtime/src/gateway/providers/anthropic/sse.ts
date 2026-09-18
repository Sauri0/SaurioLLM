// Parser SSE (Server-Sent Events) para /v1/messages — packages/runtime/src/gateway/providers/anthropic/sse.ts.
// Formato: bloques `event: <tipo>\ndata: <json>\n\n` [VERIFICADO EN DOC OFICIAL:
// build-with-claude/streaming]. Solo se extrae el string crudo de cada línea `data:`: el `type`
// dentro del JSON ya identifica el evento (ver schemas.ts, AnthropicStreamEventSchema), así que no
// hace falta interpretar la línea `event:` por separado. Duplicado deliberadamente respecto de
// ../openai-compat/sse.ts (mismo algoritmo, formato de framing SSE compatible) para no crear un
// módulo compartido fuera de la zona exclusiva de cada provider.
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
        // Líneas "event:"/"id:"/":" (comentario) y las líneas vacías que separan eventos se
        // ignoran a propósito: el `type` dentro del JSON de `data:` ya alcanza.
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
