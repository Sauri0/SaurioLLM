// Etiqueta visible para cada `Locality` (punto 3/4 del encargo: "badge LOCAL / LAN / NUBE") —
// apps/desktop/src/renderer/src/features/models/locality.ts. Un solo lugar para no repetir el mapeo
// en ProvidersSection.tsx/ModelSelect.tsx/ChatHeader.tsx.
import type { Locality } from '@saurio/shared';

export function localityLabel(locality: Locality): string {
  switch (locality) {
    case 'local': return 'LOCAL';
    case 'lan': return 'LAN';
    case 'cloud': return 'NUBE';
    case 'proxied-cloud': return 'NUBE (proxy)';
    default: return locality;
  }
}
