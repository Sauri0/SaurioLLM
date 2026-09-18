// LocalSettingsStore: respaldo de settings:get/settings:set (doc 04 §16) mientras
// packages/runtime/src/persistence/schema.ts (SettingsRepository real, tabla `settings` de doc 03)
// es todavía un placeholder de esqueleto (ver packages/runtime/src/persistence/schema.ts). Guarda un
// único archivo JSON en userData, con claves `${projectId ?? '__global__'}::${key}`.
// Deviation (doc 02 §3, "si necesitás un tipo nuevo, definilo local a tu módulo"): esta clase no
// tiene equivalente en ningún documento de arquitectura; RuntimeHost la reemplaza por
// `SettingsRepository` real en cuanto la integración la conecte (ver host/RuntimeHost.ts).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

function storeKey(key: string, projectId: string | undefined): string {
  return `${projectId ?? '__global__'}::${key}`;
}

export class LocalSettingsStore {
  private data: Record<string, unknown> = {};
  private loaded = false;

  constructor(private readonly filePath: string) {}

  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (existsSync(this.filePath)) {
        this.data = JSON.parse(readFileSync(this.filePath, 'utf-8')) as Record<string, unknown>;
      }
    } catch (error) {
      console.error('[settings] no se pudo leer settings.local.json, se arranca vacío', error);
      this.data = {};
    }
  }

  get(key: string, projectId?: string): unknown {
    this.load();
    return this.data[storeKey(key, projectId)];
  }

  set(key: string, value: unknown, projectId?: string): void {
    this.load();
    this.data[storeKey(key, projectId)] = value;
    this.persist();
  }

  private persist(): void {
    try {
      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    } catch (error) {
      console.error('[settings] no se pudo escribir settings.local.json', error);
    }
  }
}
