// Panel "settings" del renderer (doc 02 §1 y §2: apps/desktop/src/renderer/src/features/settings/).
export { SettingsPanel } from './SettingsPanel.js';
export type { PermissionRuleView } from './SettingsPanel.js';
export { ResourceSettings, type ResourceSettingsProps } from './ResourceSettings.js';
export {
  LOCAL_INFERENCE_SETTING_KEY, defaultLocalInferencePreference, parseLocalInferencePreference,
  type LocalInferencePreference, type ResourceHardware,
} from './resourceSettingsLogic.js';
