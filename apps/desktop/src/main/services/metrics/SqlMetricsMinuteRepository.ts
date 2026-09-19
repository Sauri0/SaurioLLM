// Persistencia real de `metrics_minute` (doc 14 §5, tabla ya migrada) sobre SQL directo — apps/
// desktop/src/main/services/metrics/SqlMetricsMinuteRepository.ts. Mismo patrón que
// `SqlDownloadsRepository`: `packages/runtime/src/persistence` es zona de otro agente, así que esto
// vive acá y usa solo el `SqliteDriver` ya expuesto por `openPersistence()`.
import type { SqliteDriver } from '@saurio/runtime/persistence/driver';

export interface MinuteSample {
  cpuPct?: number;
  ramUsedBytes?: number;
  gpuUtilPct?: number;
  vramUsedBytes?: number;
  gpuTempC?: number;
  powerW?: number;
  appRssBytes?: number;
  /** Fracción de muestras `measured` de este minuto, por dato (doc 14 §5: "para que un gráfico de
   *  30 días no mienta silenciosamente"); se recalcula en cada `upsert` sobre lo acumulado. */
  quality: Record<string, 'measured' | 'estimated' | 'unavailable'>;
}

interface Accumulator {
  count: number;
  cpu: number[]; ram: number[]; gpuUtil: number[]; vram: number[]; gpuTemp: number[]; power: number[]; appRss: number[];
  qualityCounts: Record<string, Record<string, number>>;
}

/** Bug real v0.2.0 (doc 16, "crash al cerrar"): better-sqlite3 lanza exactamente este `TypeError`
 *  (mensaje verbatim del driver) cuando se usa una `Database` ya cerrada — pasaba cuando
 *  `MetricsTicker.dispose()` volcaba el minuto en curso DESPUÉS de que `RuntimeHost.dispose()` ya
 *  había cerrado `saurio.db` (orden de apagado arreglado en `main/host/shutdown.ts`; esto es la
 *  segunda barrera: ningún repositorio debería poder tirar la app por escribir tarde). */
function isClosedDbError(error: unknown): boolean {
  return error instanceof TypeError && /database connection is not open/i.test(error.message);
}

function avg(values: number[]): number | undefined {
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
}
function max(values: number[]): number | undefined {
  return values.length > 0 ? Math.max(...values) : undefined;
}

/** Agrega en memoria las muestras del minuto en curso y las vuelca a SQL cuando el minuto cierra
 *  (doc 14 §5: "una fila por minuto... retención de 30 días"). No usa una transacción por muestra
 *  (costaría escribir SQLite cada 2 s) — un `UPSERT` por minuto, igual que doc 14 §5 pide para no
 *  "pelear con WAL en cada turno". */
export class SqlMetricsMinuteRepository {
  private currentMinute: number | undefined;
  private acc: Accumulator = this.emptyAcc();

  constructor(private readonly driver: SqliteDriver, private readonly now: () => number = Date.now) {}

  private emptyAcc(): Accumulator {
    return { count: 0, cpu: [], ram: [], gpuUtil: [], vram: [], gpuTemp: [], power: [], appRss: [], qualityCounts: {} };
  }

  private track(field: string, quality: string): void {
    const counts = (this.acc.qualityCounts[field] ??= {});
    counts[quality] = (counts[quality] ?? 0) + 1;
  }

  /** Acumula una muestra; si cambió el minuto respecto de la anterior, vuelca el minuto cerrado a
   *  SQL antes de empezar el nuevo acumulador. */
  addSample(sample: MinuteSample): void {
    const minute = Math.floor(this.now() / 60_000) * 60_000;
    if (this.currentMinute !== undefined && minute !== this.currentMinute) {
      this.flush(this.currentMinute);
      this.acc = this.emptyAcc();
    }
    this.currentMinute = minute;
    this.acc.count += 1;
    if (sample.cpuPct !== undefined) { this.acc.cpu.push(sample.cpuPct); this.track('cpu', sample.quality['cpu'] ?? 'measured'); }
    if (sample.ramUsedBytes !== undefined) { this.acc.ram.push(sample.ramUsedBytes); this.track('ram', sample.quality['ram'] ?? 'measured'); }
    if (sample.gpuUtilPct !== undefined) { this.acc.gpuUtil.push(sample.gpuUtilPct); this.track('gpu', sample.quality['gpu'] ?? 'measured'); }
    else this.track('gpu', 'unavailable');
    if (sample.vramUsedBytes !== undefined) this.acc.vram.push(sample.vramUsedBytes);
    if (sample.gpuTempC !== undefined) this.acc.gpuTemp.push(sample.gpuTempC);
    if (sample.powerW !== undefined) this.acc.power.push(sample.powerW);
    if (sample.appRssBytes !== undefined) this.acc.appRss.push(sample.appRssBytes);
  }

  /** Fuerza el volcado del minuto en curso (usado al cerrar la app, para no perder la última
   *  ventana parcial). */
  flushCurrent(): void {
    if (this.currentMinute !== undefined) this.flush(this.currentMinute);
  }

  private flush(tsMinute: number): void {
    if (this.acc.count === 0) return;
    try {
      this.driver.prepare(`
        INSERT INTO metrics_minute (ts_minute, cpu_avg, cpu_max, ram_used_avg, ram_used_max, gpu_util_avg, gpu_util_max,
          vram_used_avg, vram_used_max, gpu_temp_max, power_avg, app_rss_max, samples, quality_json)
        VALUES (@tsMinute, @cpuAvg, @cpuMax, @ramAvg, @ramMax, @gpuAvg, @gpuMax, @vramAvg, @vramMax, @gpuTempMax, @powerAvg, @appRssMax, @samples, @qualityJson)
        ON CONFLICT(ts_minute) DO UPDATE SET
          cpu_avg = excluded.cpu_avg, cpu_max = excluded.cpu_max, ram_used_avg = excluded.ram_used_avg,
          ram_used_max = excluded.ram_used_max, gpu_util_avg = excluded.gpu_util_avg, gpu_util_max = excluded.gpu_util_max,
          vram_used_avg = excluded.vram_used_avg, vram_used_max = excluded.vram_used_max, gpu_temp_max = excluded.gpu_temp_max,
          power_avg = excluded.power_avg, app_rss_max = excluded.app_rss_max, samples = excluded.samples,
          quality_json = excluded.quality_json
      `).run({
        tsMinute,
        cpuAvg: avg(this.acc.cpu) ?? null, cpuMax: max(this.acc.cpu) ?? null,
        ramAvg: avg(this.acc.ram) ?? null, ramMax: max(this.acc.ram) ?? null,
        gpuAvg: avg(this.acc.gpuUtil) ?? null, gpuMax: max(this.acc.gpuUtil) ?? null,
        vramAvg: avg(this.acc.vram) ?? null, vramMax: max(this.acc.vram) ?? null,
        gpuTempMax: max(this.acc.gpuTemp) ?? null,
        powerAvg: avg(this.acc.power) ?? null,
        appRssMax: max(this.acc.appRss) ?? null,
        samples: this.acc.count,
        qualityJson: JSON.stringify(this.acc.qualityCounts),
      });
    } catch (error) {
      if (!isClosedDbError(error)) throw error;
      // Apagado en curso (bug real v0.2.0, ver comentario de `isClosedDbError`): se descarta el
      // volcado del minuto en vez de tirar la app con un diálogo de error nativo.
      console.warn('[SqlMetricsMinuteRepository] se descartó un volcado de métricas: la base ya está cerrada (apagado en curso)');
    }
  }

  /** Retención de 30 días (doc 14 §5): borra filas más viejas. Se llama una vez al arrancar la app,
   *  no en cada muestra. */
  pruneOlderThan30Days(): void {
    try {
      const cutoff = this.now() - 30 * 24 * 60 * 60 * 1000;
      this.driver.exec(`DELETE FROM metrics_minute WHERE ts_minute < ${Math.floor(cutoff)}`);
    } catch (error) {
      if (!isClosedDbError(error)) throw error;
      console.warn('[SqlMetricsMinuteRepository] no se pudo podar métricas viejas: la base ya está cerrada');
    }
  }
}
