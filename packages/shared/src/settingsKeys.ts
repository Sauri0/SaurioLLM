// Claves/constantes de `settings:get`/`settings:set` (doc 04 §16) compartidas entre el proceso main y
// el renderer — packages/shared/src/settingsKeys.ts. Antes vivían solo en
// apps/desktop/src/renderer/src/features/models/numCtxDefaults.ts (ese archivo se mantiene como
// re-export, para no tocar sus dos importers) — se mueven acá porque el punto 5 del encargo
// ("el numCtx por defecto por modelo de Ajustes debe llegar al runtime") necesita leer la misma clave
// desde apps/desktop/src/main/host/createRuntime.ts, y el proceso main no debe importar del renderer
// (bundles/targets separados de electron-vite).
export const NUM_CTX_SETTINGS_KEY = 'models.numCtxDefaults';
export const NUM_CTX_GLOBAL_DEFAULT = 8192; // medido en esta máquina para qwen3:8b/qwen2.5-coder:7b (docs/MANUAL.md §7)

export type NumCtxDefaults = Record<string, number>;

export function isNumCtxDefaults(value: unknown): value is NumCtxDefaults {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((v) => typeof v === 'number');
}

export function numCtxFor(modelName: string, defaults: NumCtxDefaults): number {
  return defaults[modelName] ?? NUM_CTX_GLOBAL_DEFAULT;
}

/** Punto 4 del encargo (frontera local/nube): clave de settings de scope `project` para el
 *  consentimiento explícito "el contenido de este chat saldrá de tu PC hacia <proveedor>", una sola
 *  vez por proyecto — `chat:setModel` la lee/escribe (apps/desktop/src/main/ipc/chat.ts). Valor:
 *  `true` una vez que el usuario confirmó al menos un modelo NUBE en ese proyecto. */
export const CLOUD_CONSENT_SETTINGS_KEY = 'providers.cloudConsent';

/** Ajuste global "Solo local" (punto 4 del encargo) — ya existía como toggle de UI sin efecto
 *  (apps/desktop/src/renderer/src/features/settings/SettingsPanel.tsx, doc 01 §2 principio 7); se
 *  reutiliza la misma clave para que activarlo bloquee de verdad `chat:setModel` hacia no-local. */
export const LOCAL_ONLY_SETTINGS_KEY = 'models.localOnly';
