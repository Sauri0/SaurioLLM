// CRUD sobre la tabla `providers` (ya migrada, packages/runtime/src/persistence/migrations/0001_init.ts)
// — apps/desktop/src/main/services/providers/SqlProvidersRepository.ts. Mismo patrón que
// services/downloads/SqlDownloadsRepository.ts: SQL directo sobre el `SqliteDriver` YA EXPUESTO por
// `openPersistence()` (`prepare/run/get`), sin tocar el esquema ni los repositorios de
// packages/runtime/src/persistence (zona de otro agente en esta sesión).
//
// `config_json` (columna libre de la migración 1) guarda lo que el esquema fijo de `providers` no
// tiene lugar para: `preset` (qué UI/baseUrl-default usó el usuario), `label` (nombre visible) y
// `headers` extra (p. ej. HTTP-Referer/X-Title de OpenRouter, doc 18 §1). La clave de API NUNCA entra
// acá — vive únicamente en SecureKeyStore.ts (safeStorage), punto 1 del encargo.
import type { SqliteDriver } from '@saurio/runtime/persistence/driver';
import type { ProviderConfig, ProviderPreset } from '@saurio/shared';

export const OLLAMA_PROVIDER_ID = 'ollama';

interface ProviderConfigJson {
  preset: ProviderPreset;
  label: string;
  headers?: Record<string, string>;
}

interface ProviderRow {
  [key: string]: unknown;
  id: string;
  kind: 'ollama' | 'openai-compat' | 'cloud';
  transport: string;
  base_url: string;
  is_loopback: number;
  enabled: number;
  mode: 'attach' | 'managed';
  max_concurrency: number;
  config_json: string | null;
}

export interface StoredProvider {
  id: string;
  kind: 'ollama' | 'openai-compat' | 'cloud';
  baseUrl: string;
  isLoopback: boolean;
  enabled: boolean;
  mode: 'attach' | 'managed';
  preset: ProviderPreset;
  label: string;
  headers?: Record<string, string>;
}

function parseConfigJson(raw: string | null, fallbackPreset: ProviderPreset, fallbackLabel: string): ProviderConfigJson {
  if (!raw) return { preset: fallbackPreset, label: fallbackLabel };
  try {
    const parsed = JSON.parse(raw) as Partial<ProviderConfigJson>;
    return { preset: parsed.preset ?? fallbackPreset, label: parsed.label ?? fallbackLabel, headers: parsed.headers };
  } catch {
    return { preset: fallbackPreset, label: fallbackLabel };
  }
}

function rowToStored(row: ProviderRow): StoredProvider {
  const cfg = parseConfigJson(row.config_json, row.kind === 'ollama' ? 'ollama' : 'custom', row.id);
  return {
    id: row.id,
    kind: row.kind,
    baseUrl: row.base_url,
    isLoopback: row.is_loopback === 1,
    enabled: row.enabled === 1,
    mode: row.mode,
    preset: cfg.preset,
    label: cfg.label,
    headers: cfg.headers,
  };
}

export class ProviderInUseError extends Error {
  constructor(readonly providerId: string, options?: { cause?: unknown }) {
    super(
      `saurio: el provider "${providerId}" no se puede borrar — tiene descargas/modelos registrados; deshabilitalo en cambio.`,
      options,
    );
    this.name = 'ProviderInUseError';
  }
}

/** `true` si `baseUrl` resuelve a loopback (127.0.0.1/localhost/::1) — mismo criterio que
 *  `classifyLocality` de doc 18 §1 (packages/runtime/src/gateway/providers/openai-compat/mappers.ts,
 *  no reexportado; se reimplementa acá el subconjunto mínimo que este repositorio necesita para la
 *  columna `is_loopback`, que es solo informativa — la locality real que usan Provider/ModelGateway
 *  la calcula cada Provider concreto en createRuntime.ts). */
export function isLoopbackUrl(baseUrl: string): boolean {
  try {
    const { hostname } = new URL(baseUrl);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

export class SqlProvidersRepository {
  constructor(private readonly driver: SqliteDriver) {}

  list(): StoredProvider[] {
    return this.driver.prepare<ProviderRow>('SELECT * FROM providers ORDER BY id').all().map(rowToStored);
  }

  get(id: string): StoredProvider | undefined {
    const row = this.driver.prepare<ProviderRow>('SELECT * FROM providers WHERE id = ?').get(id);
    return row ? rowToStored(row) : undefined;
  }

  insert(input: {
    id: string; kind: 'ollama' | 'openai-compat' | 'cloud'; baseUrl: string; preset: ProviderPreset;
    label: string; headers?: Record<string, string>; enabled?: boolean;
  }): StoredProvider {
    const configJson: ProviderConfigJson = { preset: input.preset, label: input.label, headers: input.headers };
    this.driver.prepare(`
      INSERT INTO providers (id, kind, transport, base_url, is_loopback, enabled, mode, max_concurrency, config_json)
      VALUES (@id, @kind, 'http', @baseUrl, @isLoopback, @enabled, 'attach', 1, @configJson)
    `).run({
      id: input.id, kind: input.kind, baseUrl: input.baseUrl,
      isLoopback: isLoopbackUrl(input.baseUrl) ? 1 : 0,
      enabled: input.enabled === false ? 0 : 1,
      configJson: JSON.stringify(configJson),
    });
    const created = this.get(input.id);
    if (!created) throw new Error(`saurio: no se pudo leer el provider "${input.id}" recién insertado`);
    return created;
  }

  update(id: string, patch: { label?: string; baseUrl?: string; enabled?: boolean; headers?: Record<string, string> }): StoredProvider {
    const current = this.get(id);
    if (!current) throw new Error(`saurio: no existe el provider "${id}"`);
    const nextBaseUrl = patch.baseUrl ?? current.baseUrl;
    const configJson: ProviderConfigJson = {
      preset: current.preset,
      label: patch.label ?? current.label,
      headers: patch.headers ?? current.headers,
    };
    this.driver.prepare(`
      UPDATE providers SET base_url = @baseUrl, is_loopback = @isLoopback, enabled = @enabled, config_json = @configJson
      WHERE id = @id
    `).run({
      id, baseUrl: nextBaseUrl, isLoopback: isLoopbackUrl(nextBaseUrl) ? 1 : 0,
      enabled: (patch.enabled ?? current.enabled) ? 1 : 0,
      configJson: JSON.stringify(configJson),
    });
    const updated = this.get(id);
    if (!updated) throw new Error(`saurio: no se pudo releer el provider "${id}" tras actualizarlo`);
    return updated;
  }

  /** Ollama (sembrado por defecto, doc 13 §6) nunca se borra desde acá — el handler IPC ya lo
   *  bloquea antes (`ProviderConfig.removable`), esto es la segunda barrera a nivel de datos. */
  remove(id: string): void {
    if (id === OLLAMA_PROVIDER_ID) throw new ProviderInUseError(id);
    try {
      this.driver.prepare('DELETE FROM providers WHERE id = ?').run(id);
    } catch (error) {
      throw new ProviderInUseError(id, { cause: error });
    }
  }
}

/** `StoredProvider` + lo que agrega el almacén de claves -> `ProviderConfig` (forma que cruza IPC,
 *  packages/shared/src/domain.ts) — la clave real nunca entra acá, solo `hasApiKey`/`apiKeyLast4`. */
export function toProviderConfig(stored: StoredProvider, locality: ProviderConfig['locality'], hasApiKey: boolean, apiKeyLast4: string | undefined): ProviderConfig {
  return {
    id: stored.id, preset: stored.preset, kind: stored.kind, label: stored.label, baseUrl: stored.baseUrl,
    enabled: stored.enabled, locality, hasApiKey, apiKeyLast4, headers: stored.headers,
    removable: stored.id !== OLLAMA_PROVIDER_ID,
  };
}
