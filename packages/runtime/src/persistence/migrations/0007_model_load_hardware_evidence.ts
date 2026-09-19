import type { Migration } from './types.js';

/** Las muestras anteriores a esta migración siguen disponibles como historial, pero al no tener
 * fingerprint no se usan para calibrar otro equipo de manera silenciosa. */
export const migration0007: Migration = {
  version: 7,
  name: '0007_model_load_hardware_evidence',
  sql: `
ALTER TABLE model_load_samples ADD COLUMN hardware_fingerprint TEXT;
CREATE INDEX model_load_samples_evidence
  ON model_load_samples(provider_id, model_name, model_digest, num_ctx, hardware_fingerprint, sampled_at DESC);
`,
};
