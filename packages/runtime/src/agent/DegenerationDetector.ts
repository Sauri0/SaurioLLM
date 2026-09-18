// DegenerationDetector: corta un stream que se repite sin avanzar — packages/runtime/src/agent/DegenerationDetector.ts.
// Define: doc 05 §2.4 paso 18: "si una ventana de 50 caracteres se repite 4 o más veces seguidas, el
// turno se aborta con failed(format) sin esperar a que el modelo termine solo." Corre en paralelo al
// streaming (un `push` por cada chunk de texto acumulado).
const WINDOW_SIZE = 50;
const MIN_REPEATS = 4;

export class DegenerationDetector {
  private buffer = '';

  /** Acumula `chunk` y devuelve `true` la primera vez que detecta la ventana repetida; una vez
   *  disparado, sigue devolviendo `true` (el llamador debe abortar el turno en el primer `true`). */
  push(chunk: string): boolean {
    this.buffer += chunk;
    if (this.buffer.length < WINDOW_SIZE * MIN_REPEATS) return false;
    const tail = this.buffer.slice(-WINDOW_SIZE * MIN_REPEATS);
    const window = tail.slice(-WINDOW_SIZE);
    if (window.length < WINDOW_SIZE) return false;
    let repeats = 1;
    for (let i = 2; i <= MIN_REPEATS; i += 1) {
      const start = tail.length - WINDOW_SIZE * i;
      if (start < 0) break;
      const candidate = tail.slice(start, start + WINDOW_SIZE);
      if (candidate === window) repeats += 1; else break;
    }
    return repeats >= MIN_REPEATS;
  }

  reset(): void {
    this.buffer = '';
  }
}
