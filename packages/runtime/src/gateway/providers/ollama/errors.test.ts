// Tests de clasificación de errores de Ollama (packages/runtime/src/gateway/providers/ollama/errors.ts)
// — tarea "carga de modelo/oom_load": un usuario real (Intel Core Ultra 9 288V, iGPU Arc 140V por
// Vulkan) reportó bloqueos con textos de oom que `classifyErrorMessage` todavía no reconocía porque
// usan guion ("out-of-memory", no "out of memory") o vocabulario de Vulkan en vez de CUDA.
import { describe, expect, it } from 'vitest';
import { classifyErrorMessage, classifyHttpError, refineOomCode } from './errors.js';

describe('classifyErrorMessage — oom_load (doc "carga de modelo", fixtures reales)', () => {
  it('reconoce el error real reportado por el usuario (Vulkan, GGML_ASSERT)', () => {
    const real = 'llama-server reported out-of-memory during startup: GGML_ASSERT(buffer) failed alloc_tensor_range: failed to allocate Vulkan0 buffer of size 1072462848';
    expect(classifyErrorMessage(real)).toBe('oom_load');
  });

  it.each([
    'out-of-memory during startup',
    'failed to allocate Vulkan0 buffer of size 1072462848',
    'cudaMalloc failed: out of memory',
    'model is too large to fit in available memory',
    'ErrorOutOfDeviceMemory',
  ])('reconoce el texto real "%s" como oom_load', (message) => {
    expect(classifyErrorMessage(message)).toBe('oom_load');
  });

  it('sigue reconociendo la forma con espacios ("out of memory") ya cubierta antes', () => {
    expect(classifyErrorMessage('CUDA error: out of memory')).toBe('oom_load');
  });

  it('un texto sin ninguna de las señales conocidas cae en unknown', () => {
    expect(classifyErrorMessage('algo salió mal, sin más detalle')).toBe('unknown');
  });
});

describe('classifyHttpError — status 500 con body de oom real cae en oom_load', () => {
  it('HTTP 500 con el body real del usuario', () => {
    const body = 'llama-server reported out-of-memory during startup: GGML_ASSERT(buffer) failed alloc_tensor_range: failed to allocate Vulkan0 buffer of size 1072462848';
    expect(classifyHttpError(500, body)).toBe('oom_load');
  });
});

describe('refineOomCode', () => {
  it('reclasifica a oom_generate cuando ya se había emitido contenido', () => {
    expect(refineOomCode('oom_load', true)).toBe('oom_generate');
  });
  it('deja oom_load cuando todavía no se emitió nada (falló al cargar)', () => {
    expect(refineOomCode('oom_load', false)).toBe('oom_load');
  });
});
