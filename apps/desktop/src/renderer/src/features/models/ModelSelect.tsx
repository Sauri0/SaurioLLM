// Selector de modelo agrupado por proveedor con badge LOCAL/LAN/NUBE (punto 3 del encargo: "Selector
// de modelo (barra lateral y cabecera de chat) agrupado por proveedor con badge LOCAL / LAN / NUBE")
// — apps/desktop/src/renderer/src/features/models/ModelSelect.tsx. Un solo componente para
// layout/Sidebar.tsx (modelo del próximo chat nuevo) y features/chat/ChatHeader.tsx (modelo del chat
// activo), para no duplicar el agrupamiento por `<optgroup>` ni el cálculo del badge.
//
// Tarea "ModelSelect: estados explícitos" (punto 2, encargo "Cerrá lo que falta"): antes esto era
// SIEMPRE un `<select>`, aunque estuviera vacío (sin ningún `<option>`) — el usuario no tenía forma
// de distinguir "Ollama todavía está arrancando", "Ollama está apagado" y "no hay ningún modelo
// instalado" sin mirar la barra de estado aparte. `engineState` (opcional, opt-in: sin él el
// comportamiento es EXACTAMENTE el previo) reemplaza el `<select>` por el estado explícito que
// corresponda + una acción concreta.
import type { ModelInfo, ModelRef, ProviderConfig } from '@saurio/shared';
import { localityLabel } from './locality.js';
import { useUiNavStore } from '../../stores/uiNavStore.js';
import './modelSelect.css';

function refKey(ref: ModelRef): string {
  return `${ref.providerId}::${ref.name}`;
}

function providerLabel(providerId: string, providers: ProviderConfig[]): string {
  return providers.find((p) => p.id === providerId)?.label ?? providerId;
}

export type ModelSelectEngineState = 'ready' | 'starting' | 'down';

export interface ModelSelectProps {
  models: ModelInfo[];
  providers: ProviderConfig[];
  value: ModelRef | undefined;
  onChange: (ref: ModelRef) => void;
  disabled?: boolean;
  title?: string;
  /** Tarea "ModelSelect: estados explícitos": `'starting'`/`'down'` reemplazan el `<select>` por un
   *  texto + acción ("Iniciando motor local…" / "Ollama no está corriendo" + botón "Iniciar").
   *  `'ready'` (o `undefined`, comportamiento previo) sigue el flujo normal: `<select>` si hay
   *  modelos, o "No hay modelos instalados" + "Abrir Modelos" si `models` está vacío. */
  engineState?: ModelSelectEngineState;
  /** Requerido cuando `engineState === 'starting' | 'down'` puede ocurrir — botón "Iniciar" del
   *  estado `'down'`. */
  onStartEngine?: () => void;
  /** Mensaje de error de un intento de arranque anterior (`ollamaHealthStore.startError`); se
   *  muestra como `title` del estado `'down'` si está presente. */
  startEngineError?: string;
}

export function ModelSelect({
  models, providers, value, onChange, disabled, title, engineState, onStartEngine, startEngineError,
}: ModelSelectProps): React.JSX.Element {
  if (engineState === 'starting') {
    return (
      <span className="saurio-model-select saurio-model-select--status" role="status">
        Iniciando motor local…
      </span>
    );
  }

  if (engineState === 'down') {
    return (
      <span className="saurio-model-select saurio-model-select--status" title={startEngineError}>
        Ollama no está corriendo
        <button type="button" className="saurio-btn-ghost saurio-model-select__action" onClick={onStartEngine}>
          Iniciar
        </button>
      </span>
    );
  }

  if (models.length === 0) {
    return (
      <span className="saurio-model-select saurio-model-select--status">
        No hay modelos instalados
        <button
          type="button"
          className="saurio-btn-ghost saurio-model-select__action"
          onClick={() => useUiNavStore.getState().requestTab('Modelos')}
        >
          Abrir Modelos
        </button>
      </span>
    );
  }

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
        disabled={disabled}
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
