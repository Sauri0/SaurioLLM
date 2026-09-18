// AgentsPanel: pestaña "Agentes" del panel derecho (doc 19 §1.6) — lista de agentes personales con
// avatar/nombre/rol, "+ Nuevo agente", editar/duplicar/archivar. apps/desktop/src/renderer/src/features/agents/AgentsPanel.tsx.
import { useEffect, useState } from 'react';
import type { AgentProfile, ModelInfo, ProviderConfig } from '@saurio/shared';
import { useAgentsStore } from '../../stores/agentsStore.js';
import { AgentEditorModal } from './AgentEditorModal.js';
import './agents.css';

const ROLE_LABEL: Record<string, string> = {
  lead: 'Líder', coder: 'Programador', reviewer: 'Revisor', explorer: 'Explorador', custom: 'Personalizado',
};

export interface AgentsPanelProps {
  installedModels?: ModelInfo[];
  providers?: ProviderConfig[];
  /** Sidebar/ChatCenter pueden pasar esto para abrir un chat directo con el agente elegido
   *  (doc 19 §1.6: "click en un agente... reusa el flujo de creación de chat ya existente"). */
  onChatWithAgent?: (agent: AgentProfile) => void;
}

export function AgentsPanel({ installedModels = [], providers = [], onChatWithAgent }: AgentsPanelProps): React.JSX.Element {
  const agents = useAgentsStore((s) => s.personalAgents);
  const loading = useAgentsStore((s) => s.loading);
  const error = useAgentsStore((s) => s.error);
  const busyId = useAgentsStore((s) => s.busyId);
  const load = useAgentsStore((s) => s.load);
  const create = useAgentsStore((s) => s.create);
  const update = useAgentsStore((s) => s.update);
  const archive = useAgentsStore((s) => s.archive);
  const duplicate = useAgentsStore((s) => s.duplicate);

  const [editing, setEditing] = useState<AgentProfile | 'new' | undefined>(undefined);

  useEffect(() => { void load(); }, [load]);

  return (
    <section className="agents-panel" aria-label="Mis agentes">
      <div className="agents-panel__header">
        <h2>Mis agentes</h2>
        <button type="button" className="saurio-btn-primary" onClick={() => setEditing('new')}>+ Nuevo agente</button>
      </div>

      {error && <div className="saurio-banner danger">{error}</div>}

      {loading && agents.length === 0 ? (
        <p className="saurio-text-dim">Cargando…</p>
      ) : agents.length === 0 ? (
        <div className="saurio-empty-state">
          <span className="saurio-empty-state__hint">
            Todavía no creaste ningún agente personal. La app funciona igual sin ellos — son opcionales.
          </span>
        </div>
      ) : (
        <ul className="agents-panel__list">
          {agents.map((agent) => (
            <li key={agent.id} className="agents-panel__row">
              <button
                type="button"
                className="agents-panel__identity"
                onClick={() => onChatWithAgent?.(agent)}
                title={onChatWithAgent ? 'Abrir chat con este agente' : undefined}
              >
                <span className="agents-panel__avatar" style={agent.avatarColor ? { background: agent.avatarColor } : undefined}>
                  {agent.avatarEmoji ?? agent.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="agents-panel__name-block">
                  <span className="agents-panel__name">{agent.name}</span>
                  <span className="saurio-text-dim">{ROLE_LABEL[agent.role] ?? agent.role}{agent.description ? ` — ${agent.description}` : ''}</span>
                </span>
              </button>
              <span className="agents-panel__actions">
                <button type="button" className="saurio-btn-ghost" onClick={() => setEditing(agent)} disabled={busyId === agent.id}>Editar</button>
                <button type="button" className="saurio-btn-ghost" onClick={() => void duplicate(agent.id)} disabled={busyId === agent.id}>Duplicar</button>
                <button type="button" className="saurio-btn-ghost" onClick={() => void archive(agent.id)} disabled={busyId === agent.id}>Archivar</button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <AgentEditorModal
          initial={editing === 'new' ? undefined : editing}
          installedModels={installedModels}
          providers={providers}
          onClose={() => setEditing(undefined)}
          onSave={async (input) => {
            if (editing === 'new') await create(input);
            else await update(editing.id, input);
          }}
        />
      )}
    </section>
  );
}
