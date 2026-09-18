// Fixtures SSE de /v1/chat/completions para mockear fetch en los tests (regla de la tarea: fixtures
// reales, nunca un servidor real en tests unitarios). Formas verbatim de
// platform.openai.com/docs/api-reference/chat-streaming.

export const STREAM_NORMAL_LINES = [
  JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }),
  JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Hola' }, finish_reason: null }] }),
  JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: ' mundo' }, finish_reason: null }] }),
  JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }),
  '[DONE]',
];

/** Tool call partido en varios deltas: id+name en el primero, `arguments` fragmentado en varios
 *  `content_block_delta`-equivalentes — exactamente el caso que la tarea pide cubrir. */
export const STREAM_TOOL_CALL_SPLIT_LINES = [
  JSON.stringify({ id: 'chatcmpl-2', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_abc123', type: 'function', function: { name: 'get_weather', arguments: '' } }] }, finish_reason: null }] }),
  JSON.stringify({ id: 'chatcmpl-2', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"loc' } }] }, finish_reason: null }] }),
  JSON.stringify({ id: 'chatcmpl-2', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ation":' } }] }, finish_reason: null }] }),
  JSON.stringify({ id: 'chatcmpl-2', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ' "Tokyo"}' } }] }, finish_reason: null }] }),
  JSON.stringify({ id: 'chatcmpl-2', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
  JSON.stringify({ id: 'chatcmpl-2', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 40, completion_tokens: 15, total_tokens: 55 } }),
  '[DONE]',
];

/** Error a mitad de stream: algunos proxies (LM Studio) ya respondieron HTTP 200 y recién ahí
 *  informan el fallo como un objeto `{"error": {...}}` dentro del SSE. */
export const STREAM_ERROR_MIDWAY_LINES = [
  JSON.stringify({ id: 'chatcmpl-3', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'empe' }, finish_reason: null }] }),
  JSON.stringify({ error: { message: 'context length exceeded', type: 'invalid_request_error' } }),
];

export function sseBody(lines: string[]): string {
  return lines.map((l) => `data: ${l}\n\n`).join('');
}

export function mockSseResponse(lines: string[], opts: { status?: number; splitMidLine?: boolean } = {}): Response {
  const encoder = new TextEncoder();
  const body = sseBody(lines);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (opts.splitMidLine === true && body.length > 4) {
        const mid = Math.floor(body.length / 2);
        controller.enqueue(encoder.encode(body.slice(0, mid)));
        controller.enqueue(encoder.encode(body.slice(mid)));
      } else {
        controller.enqueue(encoder.encode(body));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: opts.status ?? 200, headers: { 'content-type': 'text/event-stream' } });
}
