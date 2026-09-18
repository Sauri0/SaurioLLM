// Selector de modelo agrupado por proveedor con badge LOCAL/LAN/NUBE (punto 3 del encargo: "Selector
// de modelo (barra lateral y cabecera de chat) agrupado por proveedor con badge LOCAL / LAN / NUBE")
// — apps/desktop/src/renderer/src/features/models/ModelSelect.tsx. Un solo componente para
// layout/Sidebar.tsx (modelo del próximo chat nuevo) y features/chat/ChatHeader.tsx (modelo del chat
// activo), para no duplicar el agrupamiento por `<optgroup>` ni el cálculo del badge.
import type { ModelInfo, ModelRef, ProviderConfig } from '@saurio/shared';
import { localityLabel } from './locality.js';
import './modelSelect.css';

function refKey(ref: ModelRef): string {
  return `${ref.providerId}::${ref.name}`;
}

function providerLabel(providerId: string, providers: ProviderConfig[]): string {
  return providers.find((p) => p.id === providerId)?.label ?? providerId;
}

export interface ModelSelectProps {
  models: ModelInfo[];
  providers: ProviderConfig[];
  value: ModelRef | undefined;
  onChange: (ref: ModelRef) => void;
  disabled?: boolean;
  title?: string;
}

export function ModelSelect({ models, providers, value, onChange, disabled, title }: ModelSelectProps): React.JSX.Element {
  const grouped = new Map<string, ModelInfo[]>();
  for (const model of models) {
    grouped.set(model.ref.providerId, [...(grouped.get(model.ref.providerId) ?? []), model]);
  }
  const selectedKey = value ? refKey(value) : '';
  const selectedIsKnown = value ? models.some((m) => refKey(m.ref) === selectedKey) : true;

  return (
    <span className="saurio-model-select">
      <select
        value={selectedKey}
        disabled={disabled || models.length === 0}
        title={title ?? 'Elegir modelo'}
        onChange={(ev) => {
          const found = models.find((m) => refKey(m.ref) === ev.target.value);
          if (found) onChange(found.ref);
        }}
      >
        {value && !selectedIsKnown && <option value={selectedKey}>{value.name}</option>}
        {[...grouped.entries()].map(([providerId, list]) => (
          <optgroup key={providerId} label={providerLabel(providerId, providers)}>
            {list.map((model) => (
              <option key={refKey(model.ref)} value={refKey(model.ref)}>
                {model.ref.name} · {localityLabel(model.ref.locality)}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {value && <span className={`saurio-badge ${value.locality}`}>{localityLabel(value.locality)}</span>}
    </span>
  );
}
