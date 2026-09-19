import { useEffect, useRef, useState } from 'react';
import type { AgentProfile } from '@saurio/shared';
import { invoke } from '../../ipc/client.js';
import { useAgentsStore } from '../../stores/agentsStore.js';
import './agents.css';

export interface ChatCollaboratorsProps {
  chatId: string;
  projectId: string;
  director: AgentProfile;
  disabled?: boolean;
}

export function collaboratorScope(projectId: string, chatId: string): string {
  return `${projectId}\0${chatId}`;
}

export function acceptsCollaboratorResponse(
  currentRequest: number, responseRequest: number, loadedScope: string, expectedScope: string,
): boolean {
  return currentRequest === responseRequest && loadedScope === expectedScope;
}

export function collaboratorControlsDisabled(
  loadedScope: string | undefined, scope: string, saving: boolean, disabled: boolean,
): boolean {
  return loadedScope !== scope || saving || disabled;
}

/** Selector del equipo de un chat. El padre sólo debe montarlo para un agente Director (`lead`). */
export function ChatCollaborators({ chatId, projectId, director, disabled = false }: ChatCollaboratorsProps): React.JSX.Element | null {
  const agents = useAgentsStore((state) => state.personalAgents);
  const loadAgents = useAgentsStore((state) => state.load);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [loadedScope, setLoadedScope] = useState<string>();
  const requestRef = useRef(0);
  const scope = collaboratorScope(projectId, chatId);

  useEffect(() => {
    if (director.role !== 'lead') return;
    const request = ++requestRef.current;
    const requestedScope = collaboratorScope(projectId, chatId);
    setSelected(new Set());
    setLoadedScope(undefined);
    setSaving(false);
    setError(undefined);
    void loadAgents();
    void invoke('agents:collaborators:get', { chatId, projectId })
      .then(({ agentIds }) => {
        if (!acceptsCollaboratorResponse(requestRef.current, request, scope, requestedScope)) return;
        setSelected(new Set(agentIds));
        setLoadedScope(requestedScope);
      })
      .catch((reason) => {
        if (!acceptsCollaboratorResponse(requestRef.current, request, scope, requestedScope)) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => { if (requestRef.current === request) requestRef.current += 1; };
  }, [chatId, projectId, director.role, loadAgents, scope]);

  if (director.role !== 'lead') return null;
  const available = agents.filter((agent) => agent.id !== director.id && !agent.archivedAt);
  const loaded = loadedScope === scope;
  const visibleSelected = loaded ? selected : new Set<string>();

  async function toggle(id: string): Promise<void> {
    if (!loaded || saving || disabled) return;
    const request = requestRef.current;
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next); setSaving(true); setError(undefined);
    try {
      const saved = await invoke('agents:collaborators:set', { chatId, projectId, agentIds: [...next] });
      if (!acceptsCollaboratorResponse(requestRef.current, request, scope, scope)) return;
      setSelected(new Set(saved.agentIds));
    } catch (reason) {
      if (!acceptsCollaboratorResponse(requestRef.current, request, scope, scope)) return;
      setSelected(selected);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (requestRef.current === request) setSaving(false);
    }
  }

  const roleLabel: Record<string, string> = { lead: 'Director', coder: 'Programador', reviewer: 'Revisor', explorer: 'Explorador', custom: 'Personalizado' };
  return <details className="chat-collaborators">
    <summary>Colaboradores ({visibleSelected.size})</summary>
    <p className="saurio-text-dim">El Director sólo puede delegar a los agentes habilitados acá.</p>
    {disabled && <p className="saurio-text-dim">Podés cambiar el equipo al terminar la tarea.</p>}
    <div className="chat-collaborators__list">
      {available.length === 0 && <p className="saurio-text-dim">Creá un Programador, Tester o Revisor para sumarlo.</p>}
      {available.map((agent) => <label key={agent.id} className="agent-editor__tool">
        <input type="checkbox" checked={visibleSelected.has(agent.id)} disabled={collaboratorControlsDisabled(loadedScope, scope, saving, disabled)} onChange={() => void toggle(agent.id)} />
        {agent.avatarEmoji ?? '🤖'} {agent.name} · {roleLabel[agent.role] ?? agent.role}
      </label>)}
    </div>
    {!loaded && !error && <p className="saurio-text-dim">Cargando equipo…</p>}
    {error && <div className="saurio-banner danger">{error}</div>}
  </details>;
}
