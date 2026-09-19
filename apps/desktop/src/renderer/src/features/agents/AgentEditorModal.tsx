// AgentEditorModal: alta/edición de un agente personal (doc 19 §1.6) — nombre, emoji+color, rol,
// modelo fijo o automático, checklist de tools, preset de permisos, alcance de memoria. Ningún campo
// es obligatorio salvo `name` (R01/E2a: "sin plantilla obligatoria... la app sigue siendo usable sin
// crear ningún agente"). apps/desktop/src/renderer/src/features/agents/AgentEditorModal.tsx.
import { useEffect, useRef, useState } from 'react';
import type { AgentProfile, IpcInput, ModelInfo, ModelRef, ProviderConfig, Recommendation } from '@saurio/shared';
import { invoke } from '../../ipc/client.js';
import { useProjectStore } from '../../stores/projectStore.js';
import { ModelSelect } from '../models/ModelSelect.js';
import { BUILTIN_TOOL_CATALOG, DELEGATE_TOOL } from './toolCatalog.js';
import { recommendationUse, topAgentRecommendations } from './agentRecommendations.js';
import { AGENT_TEMPLATE_OPTIONS, agentTemplateDefaults, type AgentTemplateId } from './agentTemplates.js';
import { focusTrapTarget, shouldRestoreOverlayFocus } from '../../layout/dialogFocus.js';
import './agents.css';

type CreateInput = IpcInput<'agents:create'>;
type Role = CreateInput['role'];
type PermissionPreset = CreateInput['permissionPreset'];
type ModelMode = CreateInput['modelMode'];

const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: 'custom', label: 'Personalizado' },
  { value: 'lead', label: 'Director' },
  { value: 'coder', label: 'Programador' },
  { value: 'reviewer', label: 'Revisor' },
  { value: 'explorer', label: 'Explorador' },
];

const PERMISSION_OPTIONS: { value: PermissionPreset; label: string }[] = [
  { value: 'strict', label: 'Estricto (pregunta más seguido)' },
  { value: 'balanced', label: 'Balanceado' },
  { value: 'trusting', label: 'Confiado (pregunta menos)' },
];

export interface AgentEditorModalProps {
  /** `undefined`: alta de un agente nuevo. Presente: edición de este perfil existente. */
  initial?: AgentProfile;
  installedModels?: ModelInfo[];
  providers?: ProviderConfig[];
  onClose(): void;
  onSave(input: CreateInput, options: { openChat: boolean }): Promise<void>;
}

export function AgentEditorModal({ initial, installedModels = [], providers = [], onClose, onSave }: AgentEditorModalProps): React.JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const savingRef = useRef(false);
  const modelPopoverOpenRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const currentProjectId = useProjectStore((state) => state.currentProjectId);
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [avatarEmoji, setAvatarEmoji] = useState(initial?.avatarEmoji ?? '');
  const [avatarColor, setAvatarColor] = useState(initial?.avatarColor ?? '');
  const [role, setRole] = useState<Role>(initial?.role ?? 'custom');
  const [template, setTemplate] = useState<AgentTemplateId>(
    initial?.role === 'lead' ? 'director'
      : initial?.role === 'coder' ? 'programmer'
        : initial?.role === 'reviewer' ? 'reviewer'
          : initial?.systemPrompt.startsWith('Sos Tester') ? 'tester' : 'custom',
  );
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? '');
  // En alta mostramos recomendaciones locales por rol; un perfil existente conserva su elección.
  const [modelMode, setModelMode] = useState<ModelMode>(initial?.modelMode ?? 'auto');
  const [model, setModel] = useState<ModelRef | undefined>(initial?.model);
  const [permissionPreset, setPermissionPreset] = useState<PermissionPreset>(initial?.permissionPreset ?? 'balanced');
  // Un perfil histórico puede no tener una política persistida: no lo convertimos a global al guardarlo.
  const [memoryScope, setMemoryScope] = useState<'global' | 'project' | undefined>(
    initial ? initial.memoryScope : 'global',
  );
  const [allowedTools, setAllowedTools] = useState<Set<string>>(new Set(initial?.allowedTools ?? BUILTIN_TOOL_CATALOG.map((t) => t.name)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [recommendationError, setRecommendationError] = useState<string>();
  const [recommendationLoading, setRecommendationLoading] = useState(false);
  const [downloading, setDownloading] = useState<string>();
  const [modelPopoverOpen, setModelPopoverOpen] = useState(false);

  savingRef.current = saving;
  modelPopoverOpenRef.current = modelPopoverOpen;
  onCloseRef.current = onClose;

  useEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    nameRef.current?.focus({ preventScroll: true });
    const card = cardRef.current;
    if (!card) return;
    const dialogCard = card;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape' && !savingRef.current && !modelPopoverOpenRef.current) {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialogCard.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
      )).filter((element) => !element.hidden
        && !element.closest('[hidden], [aria-hidden="true"]')
        && getComputedStyle(element).display !== 'none'
        && getComputedStyle(element).visibility !== 'hidden');
      if (focusable.length === 0) return;
      const target = focusTrapTarget(focusable, document.activeElement as HTMLElement | null, event.shiftKey);
      if (target) { event.preventDefault(); target.focus(); }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const active = document.activeElement;
      if (shouldRestoreOverlayFocus(active, document.body, (target) => dialogCard.contains(target)) && openerRef.current?.isConnected) {
        openerRef.current.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    if (modelMode !== 'auto') return;
    let cancelled = false;
    setRecommendationError(undefined);
    setRecommendations([]);
    setRecommendationLoading(true);
    void invoke('models:recommend', { use: recommendationUse(role, template), goal: 'quality' })
      .then((items) => { if (!cancelled) setRecommendations(topAgentRecommendations(items)); })
      .catch((reason) => { if (!cancelled) setRecommendationError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (!cancelled) setRecommendationLoading(false); });
    return () => { cancelled = true; };
  }, [modelMode, role, template]);

  function toggleTool(name: string): void {
    setAllowedTools((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }

  async function handleSubmit(openChat = false): Promise<void> {
    if (name.trim().length === 0) { setError('El nombre es obligatorio.'); return; }
    const memoryProjectId = memoryScope === 'project' ? (initial?.projectId ?? currentProjectId) : undefined;
    if (memoryScope === 'project' && !memoryProjectId) {
      setError('Abrí un proyecto antes de elegir memoria solo para ese proyecto.');
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await onSave({
        name: name.trim(),
        description: description.trim() || undefined,
        role,
        avatarEmoji: avatarEmoji.trim() || undefined,
        avatarColor: avatarColor.trim() || undefined,
        modelMode,
        model: modelMode === 'fixed' ? model : undefined,
        // En alta vacía se aplica el default; al editar, vacío es una decisión explícita que no se pierde.
        systemPrompt: initial ? systemPrompt.trim() : systemPrompt.trim() || undefined,
        allowedTools: [...allowedTools],
        permissionPreset,
        ...(memoryScope ? {
          memoryScope,
          ...(memoryScope === 'project' && memoryProjectId ? { projectId: memoryProjectId } : {}),
        } : {}),
      }, { openChat });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="agent-editor__backdrop" role="presentation">
      <div ref={cardRef} className="agent-editor__card" role="dialog" aria-modal="true" aria-label={initial ? 'Editar agente' : 'Nuevo agente'}>
        <h2>{initial ? `Editar "${initial.name}"` : 'Nuevo agente'}</h2>

        <label className="agent-editor__field">
          <span>Nombre *</span>
          <input ref={nameRef} type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </label>

        <label className="agent-editor__field">
          <span>Descripción</span>
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Para qué usás este agente" />
        </label>

        <label className="agent-editor__field">
          <span>Instrucciones del agente</span>
          <textarea value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} placeholder="Cómo querés que trabaje este agente" rows={4} />
        </label>

        {!initial && <label className="agent-editor__field">
          <span>Crear por rol</span>
          <select value={template} onChange={(e) => {
            const next = agentTemplateDefaults(e.target.value as AgentTemplateId);
            setTemplate(next.value); setRole(next.role); setDescription(next.description);
            setSystemPrompt(next.systemPrompt);
            setAllowedTools(new Set(next.allowedTools));
            setPermissionPreset(next.permissionPreset);
          }}>
            {AGENT_TEMPLATE_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>}

        <div className="agent-editor__row">
          <label className="agent-editor__field agent-editor__field--small">
            <span>Emoji</span>
            <input type="text" value={avatarEmoji} onChange={(e) => setAvatarEmoji(e.target.value)} placeholder="🤖" maxLength={4} />
          </label>
          <label className="agent-editor__field agent-editor__field--small">
            <span>Color</span>
            <input type="color" value={avatarColor || '#3a7bd5'} onChange={(e) => setAvatarColor(e.target.value)} />
          </label>
          <label className="agent-editor__field agent-editor__field--small">
            <span>Rol</span>
            <select value={role} onChange={(e) => {
              const nextRole = e.target.value as Role;
              setRole(nextRole);
              setTemplate('custom');
            }}>
              {ROLE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        </div>

        <fieldset className="agent-editor__field">
          <legend>Modelo</legend>
          <div className="agent-editor__row">
            <label>
              <input type="radio" name="modelMode" checked={modelMode === 'fixed'} onChange={() => setModelMode('fixed')} /> Fijo
            </label>
            <label>
              <input type="radio" name="modelMode" checked={modelMode === 'auto'} onChange={() => {
                // Al desmontar el selector abierto no pasa por su Escape: liberamos el cierre del modal.
                setModelPopoverOpen(false);
                setModelMode('auto');
              }} /> Automático
            </label>
          </div>
          {modelMode === 'fixed' && (
            <ModelSelect models={installedModels} providers={providers} value={model} onChange={setModel} title="Modelo de este agente" onPopoverOpenChange={setModelPopoverOpen} />
          )}
          {modelMode === 'auto' && (
            <div className="agent-editor__recommendations">
              <p className="saurio-text-dim agent-editor__hint">
                Usa un modelo local disponible que entre con su contexto máximo confirmado. La selección explícita del chat tiene prioridad.
              </p>
              {recommendations.map((item) => {
                const name = `${item.catalogEntry.name}:${item.catalogEntry.tag}`;
                const installed = installedModels.find((candidate) => candidate.ref.locality === 'local' && candidate.ref.name === name);
                const fit = item.fitClass === 'fits_gpu' ? 'entra en GPU' : item.fitClass === 'tight' ? 'entra justo' : item.fitClass === 'partial_offload' ? 'usa CPU/offload' : 'no entra';
                return <div key={name} className="agent-editor__recommendation">
                  <span title={item.reason}><strong>{name}</strong> · {Math.round((item.contextUsed ?? item.catalogEntry.contextMax) / 1024)}k contexto · {fit}{item.fitQuality === 'estimated' ? ' (estimado)' : ''}</span>
                  {installed
                    ? <button type="button" className="saurio-btn-ghost" onClick={() => { setModel(installed.ref); setModelMode('fixed'); }}>Usar fijo</button>
                    : <button type="button" className="saurio-btn-ghost" disabled={downloading === name || item.fitClass === 'no_fit'} onClick={async () => {
                      setDownloading(name); setRecommendationError(undefined);
                      try { await invoke('models:pull', { name }); }
                      catch (reason) { setRecommendationError(reason instanceof Error ? reason.message : String(reason)); }
                      finally { setDownloading(undefined); }
                    }}>{downloading === name ? 'Iniciando…' : 'Descargar'}</button>}
                </div>;
              })}
              {recommendationLoading && <p className="saurio-text-dim">Calculando recomendaciones locales…</p>}
              {!recommendationLoading && recommendations.length === 0 && !recommendationError && <p className="saurio-text-dim">No hay una recomendación local compatible para este rol.</p>}
              {recommendationError && <p className="saurio-text-dim">No se pudieron calcular recomendaciones: {recommendationError}</p>}
            </div>
          )}
        </fieldset>

        <details className="agent-editor__advanced">
          <summary>Opciones avanzadas: alcance, herramientas y permisos</summary>
        <fieldset className="agent-editor__field">
          <legend>Herramientas permitidas</legend>
          <div className="agent-editor__tools">
            {BUILTIN_TOOL_CATALOG.map((tool) => (
              <label key={tool.name} className="agent-editor__tool">
                <input type="checkbox" checked={allowedTools.has(tool.name)} onChange={() => toggleTool(tool.name)} />
                {tool.label}
              </label>
            ))}
          </div>
          <label className="agent-editor__tool agent-editor__tool--delegate">
            <input type="checkbox" checked={allowedTools.has(DELEGATE_TOOL.name)} onChange={() => toggleTool(DELEGATE_TOOL.name)} />
            {DELEGATE_TOOL.label}
          </label>
        </fieldset>

        <label className="agent-editor__field">
          <span>Permisos</span>
          <select value={permissionPreset} onChange={(e) => setPermissionPreset(e.target.value as PermissionPreset)}>
            {PERMISSION_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>

          <label className="agent-editor__field">
            <span>Memoria</span>
            <select aria-label="Alcance de memoria" value={memoryScope ?? ''} onChange={(e) => setMemoryScope(e.target.value === '' ? undefined : e.target.value as 'global' | 'project')}>
              {memoryScope === undefined && <option value="">Alcance sin confirmar (conservar)</option>}
              <option value="global">Global (visible en cualquier proyecto)</option>
              <option value="project">{initial?.projectId ? 'Solo el proyecto asociado' : 'Solo el proyecto abierto'}</option>
            </select>
            <span className="saurio-text-dim">Define dónde se guardan las nuevas memorias. Las memorias existentes conservan su alcance.</span>
          </label>
        </details>

        {error && <div className="saurio-banner danger" role="alert">{error}</div>}

        <div className="agent-editor__actions">
          <button type="button" className="saurio-btn-ghost" onClick={onClose} disabled={saving}>Cancelar</button>
          {initial ? (
            <button type="button" className="saurio-btn-primary" onClick={() => void handleSubmit()} disabled={saving}>
              {saving ? 'Guardando…' : 'Guardar cambios'}
            </button>
          ) : (
            <>
              <button type="button" className="saurio-btn-ghost" onClick={() => void handleSubmit(false)} disabled={saving}>Crear</button>
              <button type="button" className="saurio-btn-primary" onClick={() => void handleSubmit(true)} disabled={saving}>
                {saving ? 'Guardando…' : 'Crear y abrir chat'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
