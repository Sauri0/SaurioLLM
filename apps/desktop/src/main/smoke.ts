// Verificación de arranque con SAURIO_SMOKE=1 — apps/desktop/src/main/smoke.ts.
// Define: doc 02 §1 (canal de prueba 'app:ping' del scaffolding), ampliado por la fase de
// integración del MVP: además del ping, el smoke comprueba que `models:list` responde de verdad
// contra Ollama en 127.0.0.1:11434 antes de cerrar la app sola.
//
// No es parte del contrato de doc 04: es una ayuda de verificación que solo se activa con la
// variable de entorno SAURIO_SMOKE=1 y no tiene ningún efecto en una ejecución normal.
import { writeFileSync } from 'node:fs';
import path from 'node:path';

export function isSmokeRun(): boolean {
  return process.env['SAURIO_SMOKE'] === '1';
}

export interface SmokeRecorder {
  /** Registra la respuesta de un canal esperado; cuando están todos, dispara `onComplete`. */
  record(channel: string, payload: unknown): void;
}

/**
 * Escribe `out/smoke-<canal>.json` por cada canal esperado y llama a `onComplete` cuando ya
 * respondieron todos. `outDir` es absoluto (app.getAppPath() + '/out') para no depender del cwd.
 */
export function createSmokeRecorder(
  outDir: string,
  expectedChannels: readonly string[],
  onComplete: (results: Record<string, unknown>) => void,
): SmokeRecorder {
  const pending = new Set(expectedChannels);
  const results: Record<string, unknown> = {};

  return {
    record(channel, payload) {
      if (!pending.has(channel)) return;
      pending.delete(channel);
      results[channel] = payload;
      const file = path.join(outDir, `smoke-${channel.replace(':', '-')}.json`);
      try {
        writeFileSync(file, JSON.stringify(payload, null, 2));
        console.log(`[main][smoke] ${channel} OK -> ${file}`);
      } catch (error) {
        console.error(`[main][smoke] no se pudo escribir ${file}`, error);
      }
      if (pending.size === 0) onComplete(results);
    },
  };
}
