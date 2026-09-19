// AgentsPanel: pestaña "Agentes" del panel derecho (doc 19 §1.6) — lista de agentes personales con
// avatar/nombre/rol, "+ Nuevo agente", editar/duplicar/archivar. apps/desktop/src/renderer/src/features/agents/AgentsPanel.tsx.
import { useEffect, useMemo, useState } from 'react';
import type { AgentProfile, ModelInfo, ProviderConfig } from '@saurio/shared';
import { useAgentsStore } from '../../stores/agentsStore.js';
import { useProjectStore } from '../../stores/projectStore.js';
import { AgentEditorModal } from './AgentEditorModal.js';
import { createStarterTeamInputs } from './agentTemplates.js';
import './agents.css';

const ROLE_LABEL: Record<string, string> = {
  lead: 'Director', coder: 'Programador', reviewer: 'Revisor', explorer: 'Explorador', custom: 'Personalizado',
};

function memoryScopeLabel(agent: AgentProfile): string {
  return agent.memoryScope === 'global'
    ? 'Memoria global'
    : agent.memoryScope === 'project'
      ? 'Memoria del proyecto'
      : 'Memoria sin confirmar';
}

export interface AgentsPanelProps {
  installedModels?: ModelInfo[];
  providers?: ProviderConfig[];
  /** Sidebar/ChatCenter pueden pasar esto para abrir un chat directo con el agente elegido
   *  (doc 19 §1.6: "click en un agente... reusa el flujo de creación de chat ya existente"). */
  onChatWithAgent?: (agent: AgentProfile) => Promise<void>;
}

function modelOriginLabel(agent: AgentProfile, providers: ProviderConfig[]): string {
  if (agent.modelMode === 'auto') return 'Automático local';
  if (!agent.model) return 'Sin modelo fijo';
  const provider = providers.find((item) => item.id === agent.model!.providerId);
  return `Modelo fijo · ${agent.model.name} · ${provider?.label ?? agent.model.providerId} · ${agent.model.locality.toUpperCase()}`;
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
  const restore = useAgentsStore((s) => s.restore);
  const duplicate = useAgentsStore((s) => s.duplicate);
  const favoriteAgentIds = useAgentsStore((s) => s.favoriteAgentIds);
  const toggleFavorite = useAgentsStore((s) => s.toggleFavorite);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const projects = useProjectStore((s) => s.projects);

  const [editing, setEditing] = useState<AgentProfile | 'new' | undefined>(undefined);
  const [createdForOpen, setCreatedForOpen] = useState<AgentProfile>();
  const [creatingTeam, setCreatingTeam] = useState(false);
  const [teamMessage, setTeamMessage] = useState<string>();
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [scopeFilter, setScopeFilter] = useState<'all' | 'global' | 'project'>('all');
  const [archiveFilter, setArchiveFilter] = useState<'active' | 'archived' | 'all'>('active');
  const [favoritesOnly, setFavoritesOnly] = useState(false);

  useEffect(() => { void load({ projectId: currentProjectId, includeArchived: archiveFilter !== 'active' }); }, [archiveFilter, currentProjectId, load]);

  const filteredAgents = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return agents.filter((agent) => {
      const searchable = `${agent.name} ${ROLE_LABEL[agent.role] ?? agent.role} ${agent.description ?? ''}`.toLocaleLowerCase();
      const archiveMatches = archiveFilter === 'all' || (archiveFilter === 'archived' ? Boolean(agent.archivedAt) : !agent.archivedAt);
      const scopeMatches = scopeFilter === 'all'
        || (scopeFilter === 'global' ? agent.memoryScope === 'global' : agent.memoryScope === 'project' && agent.projectId === currentProjectId);
      return (!needle || searchable.includes(needle))
        && (roleFilter === 'all' || agent.role === roleFilter)
        && archiveMatches
        && scopeMatches
        && (!favoritesOnly || favoriteAgentIds.includes(agent.id));
    });
  }, [agents, archiveFilter, currentProjectId, favoriteAgentIds, favoritesOnly, query, roleFilter, scopeFilter]);

  async function createStarterTeam(): Promise<void> {
    setCreatingTeam(true); setTeamMessage(undefined);
    const created: AgentProfile[] = [];
    try {
      for (const input of createStarterTeamInputs()) created.push(await create(input));
      setTeamMessage('Equipo creado. Abrí un chat con Director y elegí sus colaboradores.');
    } catch (reason) {
      const rollback = await Promise.allSettled(created.map((agent) => archive(agent.id)));
      const remaining = created.filter((_, index) => rollback[index]?.status === 'rejected');
      setTeamMessage(remaining.length === 0
        ? `No se pudo crear el equipo y se revirtieron los perfiles nuevos: ${reason instanceof Error ? reason.message : String(reason)}`
        : `Creación parcial: no se pudieron revertir ${remaining.map((agent) => agent.name).join(', ')}. Revisalos antes de reintentar.`);
    } finally { setCreatingTeam(false); }
  }

  async function archiveAgent(id: string): Promise<void> {
    await archive(id);
    await load({ projectId: currentProjectId, includeArchived: archiveFilter !== 'active' });
  }

  function clearFilters(): void {
    setQuery(''); setRoleFilter('all'); setScopeFilter('all'); setArchiveFilter('active'); setFavoritesOnly(false);
  }

  return (
    <section className="agents-panel" aria-label="Mis agentes">
      <div className="agents-panel__header">
        <h2>Mis agentes</h2>
        <span className="agents-panel__actions">
          <button type="button" className="saurio-btn-ghost" disabled={creatingTeam} onClick={() => void createStarterTeam()}>
            {creatingTeam ? 'Creando equipo…' : 'Crear equipo base'}
          </button>
          <button type="button" className="saurio-btn-primary" onClick={() => setEditing('new')}>+ Nuevo agente</button>
        </span>
      </div>

      {teamMessage && <div className="saurio-banner">{teamMessage}</div>}

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
        <>
          <div className="agents-panel__filters" aria-label="Filtros de agentes">
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar nombre, rol o descripción…" aria-label="Buscar agente" />
            <select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)} aria-label="Filtrar por rol">
              <option value="all">Todos los roles</option>
              {Object.entries(ROLE_LABEL).map(([role, label]) => <option key={role} value={role}>{label}</option>)}
            </select>
            <select value={scopeFilter} onChange={(event) => setScopeFilter(event.target.value as typeof scopeFilter)} aria-label="Filtrar por alcance">
              <option value="all">Todos los alcances</option>
              <option value="global">Memoria global</option>
              <option value="project">Este proyecto</option>
            </select>
            <select value={archiveFilter} onChange={(event) => setArchiveFilter(event.target.value as typeof archiveFilter)} aria-label="Filtrar por archivado">
              <option value="active">Activos</option>
              <option value="archived">Archivados</option>
              <option value="all">Todos</option>
            </select>
            <label><input type="checkbox" checked={favoritesOnly} onChange={(event) => setFavoritesOnly(event.target.checked)} /> Favoritos</label>
            <span className="agents-panel__count" aria-live="polite">{filteredAgents.length} de {agents.length}</span>
            {(query || roleFilter !== 'all' || scopeFilter !== 'all' || archiveFilter !== 'active' || favoritesOnly) && <button type="button" className="saurio-btn-ghost" onClick={clearFilters}>Limpiar</button>}
          </div>
          {filteredAgents.length === 0 ? (
            <div className="saurio-empty-state"><span className="saurio-empty-state__hint">No hay agentes que coincidan con estos filtros.</span></div>
          ) : (
        <ul className="agents-panel__list">
          {filteredAgents.map((agent) => (
            <li key={agent.id} className="agents-panel__row">
              <button
                type="button"
                className="agents-panel__identity"
                onClick={() => { void onChatWithAgent?.(agent).catch(() => undefined); }}
                disabled={Boolean(agent.archivedAt) || !onChatWithAgent}
                title={onChatWithAgent ? 'Abrir chat con este agente' : undefined}
              >
                <span className="agents-panel__avatar" style={agent.avatarColor ? { background: agent.avatarColor } : undefined}>
                  {agent.avatarEmoji ?? agent.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="agents-panel__name-block">
                  <span className="agents-panel__name">{agent.name}</span>
                  <span className="saurio-text-dim">{ROLE_LABEL[agent.role] ?? agent.role}{agent.description ? ` — ${agent.description}` : ''}</span>
                  <span className="agents-panel__badges">
                    <span className={`saurio-badge ${agent.model?.locality ?? 'local'}`}>{modelOriginLabel(agent, providers)}</span>
                    <span className="saurio-badge">{memoryScopeLabel(agent)}</span>
                  </span>
                  <span className="saurio-text-dim">
                    {agent.memoryScope === 'project'
                      ? `Proyecto: ${projects.find((project) => project.id === agent.projectId)?.name ?? agent.projectId ?? 'sin confirmar'}`
                      : agent.memoryScope === 'global' ? 'Disponible en todos los proyectos' : 'Ubicación sin confirmar'}
                  </span>
                </span>
              </button>
              <span className="agents-panel__actions">
                {onChatWithAgent && <button type="button" className="saurio-btn-primary" onClick={() => { void onChatWithAgent(agent).catch(() => undefined); }} disabled={Boolean(agent.archivedAt)}>Abrir chat</button>}
                <button type="button" className="saurio-btn-ghost" aria-pressed={favoriteAgentIds.includes(agent.id)} onClick={() => { void toggleFavorite(agent.id).catch(() => undefined); }}>{favoriteAgentIds.includes(agent.id) ? 'Quitar favorito' : 'Favorito'}</button>
                <button type="button" className="saurio-btn-ghost" onClick={() => setEditing(agent)} disabled={busyId === agent.id}>Editar</button>
                <button type="button" className="saurio-btn-ghost" onClick={() => { void duplicate(agent.id).catch(() => undefined); }} disabled={busyId === agent.id}>Duplicar</button>
                {agent.archivedAt
                  ? <button type="button" className="saurio-btn-ghost" onClick={() => { void restore(agent.id).catch(() => undefined); }} disabled={busyId === agent.id}>Restaurar</button>
                  : <button type="button" className="saurio-btn-ghost" onClick={() => { void archiveAgent(agent.id).catch(() => undefined); }} disabled={busyId === agent.id}>Archivar</button>}
              </span>
            </li>
          ))}
        </ul>
          )}
        </>
      )}

      {editing && (
        <AgentEditorModal
          initial={editing === 'new' ? undefined : editing}
          installedModels={installedModels}
          providers={providers}
          onClose={() => { setEditing(undefined); setCreatedForOpen(undefined); }}
          onSave={async (input, { openChat }) => {
            if (editing === 'new') {
              // Si la apertura falla, el modal conserva borrador y este perfil para reintentar sin
              // crear una segunda copia. Cancelar luego sólo cierra: no borra el perfil ya creado.
              // Tras un fallo al abrir, se conserva el mismo perfil y se aplica cualquier cambio
              // del borrador antes del reintento; así no hay duplicados ni se descarta lo escrito.
              const created = createdForOpen ? await update(createdForOpen.id, input) : await create(input);
              setCreatedForOpen(created);
              if (openChat) {
                if (!onChatWithAgent) throw new Error('No se puede abrir el chat desde esta vista.');
                await onChatWithAgent(created);
              }
              setCreatedForOpen(undefined);
            } else {
              await update(editing.id, input);
            }
          }}
        />
      )}
    </section>
  );
}
