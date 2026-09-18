// Registro de "último hash leído por path en este run" — packages/runtime/src/tools/readTracker.ts.
// Define: doc 05 §2.8 punto 32 (edit_file "compara el hash contra la última lectura registrada en
// este run; si difiere, falla") y §2.8 punto 32 para write_file/delete_file ("expected_pre_hash NULL
// si el run nunca leyó ese path con read_file en esta ejecución"). `ToolContext` (tools/types.ts, no
// modificable) no declara este registro como campo propio; se implementa acá como una dependencia que
// `createBuiltinTools()` inyecta en los handlers de read_file/edit_file/write_file/delete_file, en vez
// de agregar un campo nuevo a la interfaz — ver deviations en la salida del módulo.
export class ReadTracker {
  private readonly byRun = new Map<string, Map<string, string>>();

  record(runId: string, relPath: string, hash: string): void {
    let m = this.byRun.get(runId);
    if (!m) { m = new Map(); this.byRun.set(runId, m); }
    m.set(relPath, hash);
  }

  lastHash(runId: string, relPath: string): string | undefined {
    return this.byRun.get(runId)?.get(relPath);
  }

  clearRun(runId: string): void {
    this.byRun.delete(runId);
  }
}
