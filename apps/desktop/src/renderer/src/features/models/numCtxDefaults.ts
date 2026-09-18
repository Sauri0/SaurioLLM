// numCtx por defecto por modelo (punto 4 del encargo: "ajustes faltantes... numCtx por defecto por
// modelo") — apps/desktop/src/renderer/src/features/models/numCtxDefaults.ts.
// Re-exporta packages/shared/src/settingsKeys.ts: la clave/constantes se movieron ahí (punto 5 del
// encargo nuevo, "el numCtx por defecto por modelo debe llegar al runtime") porque
// apps/desktop/src/main/host/createRuntime.ts también necesita leerlas y el proceso main no debe
// importar del renderer. Este archivo se mantiene para no tocar sus importers existentes
// (ModelsPanel.tsx, SettingsPanel.tsx).
export {
  NUM_CTX_SETTINGS_KEY, NUM_CTX_GLOBAL_DEFAULT, isNumCtxDefaults, numCtxFor, type NumCtxDefaults,
} from '@saurio/shared';
