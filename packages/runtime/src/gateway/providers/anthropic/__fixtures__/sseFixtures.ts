// Fixtures SSE de /v1/messages para mockear fetch en los tests (regla de la tarea: fixtures reales,
// nunca una llamada real a la API). Formas verbatim de build-with-claude/streaming (respuestas de
// ejemplo publicadas por Anthropic, transcritas el 2026-09-18).

export const STREAM_NORMAL_LINES = [
  { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-5', stop_reason: null, stop_sequence: null, usage: { input_tokens: 25, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'ping' },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hola' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' mundo' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 15 } },
  { type: 'message_stop' },
];

/** tool_use con `input` partido en varios `input_json_delta` — exactamente el caso de la tarea. */
export const STREAM_TOOL_CALL_SPLIT_LINES = [
  { type: 'message_start', message: { id: 'msg_2', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-5', stop_reason: null, stop_sequence: null, usage: { input_tokens: 472, output_tokens: 2 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: "Let's check." } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_01T1x1fJ34qAmk2tNTrN7Up6', name: 'get_weather', input: {} } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"location":' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ' "San Fran' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'cisco, CA"}' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 89 } },
  { type: 'message_stop' },
];

/** Error a mitad de stream: HTTP ya en 200, Anthropic manda `event: error` (típico overloaded_error
 *  en picos de uso) [VERIFICADO EN DOC OFICIAL: build-with-claude/streaming, "Error events"]. */
export const STREAM_ERROR_MIDWAY_LINES = [
  { type: 'message_start', message: { id: 'msg_3', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-5', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'empe' } },
  { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
];

export function sseBody(events: Array<Record<string, unknown>>): string {
  return events.map((ev) => `event: ${String(ev.type)}\ndata: ${JSON.stringify(ev)}\n\n`).join('');
}

export function mockSseResponse(events: Array<Record<string, unknown>>, opts: { status?: number; splitMidLine?: boolean } = {}): Response {
  const encoder = new TextEncoder();
  const body = sseBody(events);
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
