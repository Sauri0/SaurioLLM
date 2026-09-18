// Fixtures NDJSON de /api/chat para mockear fetch en los tests (regla de la tarea: "No uses Ollama
// real en tests unitarios; mockeá fetch con fixtures NDJSON"). Formas verbatim de
// docs/research/research-ollama.md §1.4 (chunks de stream, tool calls, error a mitad de stream).

export const STREAM_NORMAL_LINES = [
  JSON.stringify({ model: 'qwen3:8b', created_at: '2026-09-18T00:00:00Z', message: { role: 'assistant', content: 'Hola' }, done: false }),
  JSON.stringify({ model: 'qwen3:8b', created_at: '2026-09-18T00:00:00Z', message: { role: 'assistant', content: ' mundo' }, done: false }),
  JSON.stringify({
    model: 'qwen3:8b', created_at: '2026-09-18T00:00:01Z',
    message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop',
    total_duration: 4883583458, load_duration: 1334875,
    prompt_eval_count: 26, prompt_eval_cached_count: 10, prompt_eval_duration: 342546000,
    eval_count: 282, eval_duration: 4535599000,
  }),
];

export const STREAM_TOOL_CALL_LINES = [
  JSON.stringify({
    model: 'qwen3:8b', created_at: '2026-09-18T00:00:00Z',
    message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'call_abc123', function: { index: 0, name: 'get_weather', arguments: { city: 'Tokyo' } } }],
    },
    done: false,
  }),
  JSON.stringify({
    model: 'qwen3:8b', created_at: '2026-09-18T00:00:01Z',
    message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop',
    total_duration: 885095291, load_duration: 3753500,
    prompt_eval_count: 122, prompt_eval_duration: 328493000,
    eval_count: 33, eval_duration: 552222000,
  }),
];

export const STREAM_ERROR_MIDWAY_LINES = [
  JSON.stringify({ model: 'gemma4:31b', created_at: '2026-09-17T00:00:00Z', message: { role: 'assistant', content: 'empezando' }, done: false }),
  JSON.stringify({ error: 'cudaMalloc failed: out of memory' }),
];

export const STREAM_THINKING_LINES = [
  JSON.stringify({ model: 'qwen3:8b', created_at: '2026-09-18T00:00:00Z', message: { role: 'assistant', content: '', thinking: 'pensando...' }, done: false }),
  JSON.stringify({ model: 'qwen3:8b', created_at: '2026-09-18T00:00:00Z', message: { role: 'assistant', content: 'listo' }, done: false }),
  JSON.stringify({
    model: 'qwen3:8b', created_at: '2026-09-18T00:00:01Z', message: { role: 'assistant', content: '' },
    done: true, done_reason: 'stop', total_duration: 1000000, load_duration: 500000,
    prompt_eval_count: 10, prompt_eval_duration: 100000, eval_count: 5, eval_duration: 400000,
  }),
];

/** Construye un ReadableStream<Uint8Array> NDJSON a partir de líneas ya serializadas, con la opción
 *  de emitirlas en varios `enqueue()` separados (simula fragmentación real de TCP) — usado para
 *  probar que el parser reensambla líneas cortadas a mitad de chunk. */
export function ndjsonStream(lines: string[], opts: { splitMidLine?: boolean } = {}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const body = lines.map((l) => `${l}\n`).join('');
  return new ReadableStream<Uint8Array>({
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
}

export function mockStreamResponse(lines: string[], opts: { status?: number; splitMidLine?: boolean } = {}): Response {
  return new Response(ndjsonStream(lines, opts), {
    status: opts.status ?? 200,
    headers: { 'content-type': 'application/x-ndjson' },
  });
}

/** `/api/pull` en streaming (doc 13 §5.2), forma verbatim de una descarga real chica observada
 *  contra Ollama 0.34.1 (`all-minilm`, ver DownloadManager.test.ts para el equivalente con fixtures
 *  puras y este archivo para el equivalente con fetch mockeado a nivel de OllamaProvider). */
export const PULL_STREAM_LINES = [
  JSON.stringify({ status: 'pulling manifest' }),
  JSON.stringify({ status: 'downloading', digest: 'sha256:layer1', total: 1000, completed: 500 }),
  JSON.stringify({ status: 'downloading', digest: 'sha256:layer1', total: 1000, completed: 1000 }),
  JSON.stringify({ status: 'verifying sha256 digest' }),
  JSON.stringify({ status: 'writing manifest' }),
  JSON.stringify({ status: 'success' }),
];

export const PULL_STREAM_ERROR_LINES = [
  JSON.stringify({ status: 'pulling manifest' }),
  JSON.stringify({ error: 'model "no-existe:latest" not found' }),
];
