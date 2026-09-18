// LoopDetector: detecta que el modelo se repite sin converger — packages/runtime/src/agent/LoopDetector.ts.
// Define: doc 05 §2.10 paso 36 y doc 10 caso (10). Ventana de 20 eventos del run:
//   - misma tool + mismo args_hash 3 veces seguidas -> nudge; si el patrón sigue tras el nudge -> abort.
//   - mismo código de error 3 veces seguidas -> nudge.
//   - alternancia A-B (dos claves distintas turnándose) 6 veces seguidas -> abort directo.
//   - 3 mensajes seguidos sin tool call ni `finish` -> se fuerza el cierre del turno como respuesta final
//     (no es nudge ni abort: es la señal `force_final`, distinta a las demás).
const WINDOW_SIZE = 20;

type LoopEvent =
  | { kind: 'tool'; key: string }
  | { kind: 'error'; code: string }
  | { kind: 'no_tool' };

export type LoopVerdict = 'nudge' | 'abort' | 'force_final' | null;

export class LoopDetector {
  private readonly window: LoopEvent[] = [];
  private nudgedToolKey: string | undefined;
  private nudgedErrorCode: string | undefined;
  private noToolStreak = 0;
  /** Doc 16 §4 ítem "robustez con modelos chicos" (medido: qwen3:8b repitiendo un `edit_file`
   *  ambiguo, doc 16 §6): racha de "mismo texto de error, misma tool", consecutiva — a propósito NO
   *  exige args idénticos (a diferencia de `recordToolCall`), porque un modelo puede variar levemente
   *  los argumentos y aun así pegar contra el mismo error una y otra vez. No tiene verdict de
   *  abort propio: solo cuenta, para que `RunController` pueda agregar una pista concreta ANTES de
   *  que `recordToolCall`/`recordError` disparen el abort real (mismo mecanismo, ventana separada). */
  private readonly lastToolError = new Map<string, { text: string; count: number }>();

  private push(ev: LoopEvent): void {
    this.window.push(ev);
    if (this.window.length > WINDOW_SIZE) this.window.shift();
  }

  private tailToolStreak(key: string): number {
    let n = 0;
    for (let i = this.window.length - 1; i >= 0; i -= 1) {
      const ev = this.window[i];
      if (ev?.kind === 'tool' && ev.key === key) n += 1; else break;
    }
    return n;
  }

  private tailErrorStreak(code: string): number {
    let n = 0;
    for (let i = this.window.length - 1; i >= 0; i -= 1) {
      const ev = this.window[i];
      if (ev?.kind === 'error' && ev.code === code) n += 1; else break;
    }
    return n;
  }

  /** true si los últimos `count` eventos son tool calls que alternan estrictamente entre exactamente
   *  dos claves distintas (A-B-A-B-...). */
  private tailAlternates(count: number): boolean {
    if (this.window.length < count) return false;
    const tail = this.window.slice(-count);
    if (!tail.every((ev): ev is { kind: 'tool'; key: string } => ev.kind === 'tool')) return false;
    const [a, b] = [tail[0]!.key, tail[1]!.key];
    if (a === b) return false;
    return tail.every((ev, i) => ev.key === (i % 2 === 0 ? a : b));
  }

  recordToolCall(toolName: string, argsHash: string): LoopVerdict {
    const key = `${toolName}:${argsHash}`;
    this.push({ kind: 'tool', key });
    this.noToolStreak = 0;
    if (this.tailAlternates(6)) return 'abort';
    const streak = this.tailToolStreak(key);
    if (streak >= 6 && this.nudgedToolKey === key) return 'abort';
    if (streak >= 3 && this.nudgedToolKey !== key) {
      this.nudgedToolKey = key;
      return 'nudge';
    }
    return null;
  }

  recordError(code: string): LoopVerdict {
    this.push({ kind: 'error', code });
    const streak = this.tailErrorStreak(code);
    if (streak >= 3 && this.nudgedErrorCode !== code) {
      this.nudgedErrorCode = code;
      return 'nudge';
    }
    return null;
  }

  /** Cuenta cuántas veces SEGUIDAS `toolName` falló con exactamente el mismo `errorText`. Un texto
   *  distinto (o la primera vez) reinicia la cuenta en 1. Devuelve el streak actual (1, 2, 3, ...). */
  recordToolResultError(toolName: string, errorText: string): number {
    const prev = this.lastToolError.get(toolName);
    const count = prev && prev.text === errorText ? prev.count + 1 : 1;
    this.lastToolError.set(toolName, { text: errorText, count });
    return count;
  }

  /** El problema se resolvió (la tool call terminó sin error): no tiene sentido que un éxito
   *  intermedio deje la cuenta "caliente" para la próxima vez que esa tool falle por otra razón. */
  clearToolResultError(toolName: string): void {
    this.lastToolError.delete(toolName);
  }

  /** Turno sin ninguna tool call ni `finish`. Devuelve `force_final` la tercera vez consecutiva. */
  recordNoToolTurn(): LoopVerdict {
    this.push({ kind: 'no_tool' });
    this.noToolStreak += 1;
    if (this.noToolStreak >= 3) {
      this.noToolStreak = 0;
      return 'force_final';
    }
    return null;
  }
}
