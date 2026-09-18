// fileLogger — apps/desktop/src/main/services/updater/fileLogger.ts.
// Punto 2 del encargo: "errores de red silenciosos con log a archivo en userData/logs/". Un logger de
// una sola línea por llamada, de solo apéndice, que nunca puede tirar (si falla escribir el log no
// puede hacer caer al updater ni a la app).
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export type Logger = (line: string) => void;

/** `logFilePath` típicamente `path.join(userDataDir, 'logs', 'updater.log')` (mismo directorio
 *  `logs/` que ya usa el resto de la app, ver `HostAdapter.paths.logsDir` en host/RuntimeHost.ts). */
export function createFileLogger(logFilePath: string): Logger {
  return (line: string) => {
    try {
      mkdirSync(path.dirname(logFilePath), { recursive: true });
      appendFileSync(logFilePath, `[${new Date().toISOString()}] ${line}\n`, 'utf-8');
    } catch (error) {
      // No hay a dónde escalar esto sin arriesgar interrumpir el arranque de la app; se deja constancia
      // en consola nomás (mismo criterio que el resto de main/index.ts con errores no fatales).
      console.error('[updater] no se pudo escribir en el log de actualizaciones', error);
    }
  };
}
