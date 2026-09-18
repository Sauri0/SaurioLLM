// AgentEditorModal: alta/edición de un agente personal (doc 19 §1.6) — nombre, emoji+color, rol,
// modelo fijo o automático, checklist de tools, preset de permisos, alcance de memoria. Ningún campo
// es obligatorio salvo `name` (R01/E2a: "sin plantilla obligatoria... la app sigue siendo usable sin
// crear ningún agente"). apps/desktop/src/renderer/src/features/agents/AgentEditorModal.tsx.
import { useState } from 'react';
import type { AgentProfile, IpcInput, ModelInfo, ModelRef, ProviderConfig } from '@saurio/shared';
import { ModelSelect } from '../models/ModelSelect.js';
import { BUILTIN_TOOL_CATALOG, DELEGATE_TOOL } from './toolCatalog.js';
import './agents.css';

type CreateInput = IpcInput<'agents:create'>;
type Role = CreateInput['role'];
type PermissionPreset = CreateInput['permissionPreset'];
type ModelMode = CreateInput['modelMode'];

const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: 'custom', label: 'Personalizado' },
  { value: 'lead', label: 'Líder' },
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
  onSave(input: CreateInput): Promise<void>;
}

export function AgentEditorModal({ initial, installedModels = [], providers = [], onClose, onSave }: AgentEditorModalProps): React.JSX.Element {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [avatarEmoji, setAvatarEmoji] = useState(initial?.avatarEmoji ?? '');
  const [avatarColor, setAvatarColor] = useState(initial?.avatarColor ?? '');
  const [role, setRole] = useState<Role>(initial?.role ?? 'custom');
  const [modelMode, setModelMode] = useState<ModelMode>(initial?.modelMode ?? 'fixed');
  const [model, setModel] = useState<ModelRef | undefined>(initial?.model);
  const [permissionPreset, setPermissionPreset] = useState<PermissionPreset>(initial?.permissionPreset ?? 'balanced');
  const [memoryScope, setMemoryScope] = useState<'global' | 'project'>('global');
  const [allowedTools, setAllowedTools] = useState<Set<string>>(new Set(initial?.allowedTools ?? BUILTIN_TOOL_CATALOG.map((t) => t.name)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  function toggleTool(name: string): void {
    setAllowedTools((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }

  async function handleSubmit(): Promise<void> {
    if (name.trim().length === 0) { setError('El nombre es obligatorio.'); return; }
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
        allowedTools: [...allowedTools],
        permissionPreset,
        memoryScope,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="agent-editor__backdrop" role="dialog" aria-modal="true" aria-label={initial ? 'Editar agente' : 'Nuevo agente'}>
      <div className="agent-editor__card">
        <h2>{initial ? `Editar "${initial.name}"` : 'Nuevo agente'}</h2>

        <label className="agent-editor__field">
          <span>Nombre *</span>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>

        <label className="agent-editor__field">
          <span>Descripción</span>
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Para qué usás este agente" />
        </label>

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
            <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
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
              <input type="radio" name="modelMode" checked={modelMode === 'auto'} onChange={() => setModelMode('auto')} /> Automático
            </label>
          </div>
          {modelMode === 'fixed' && (
            <ModelSelect models={installedModels} providers={providers} value={model} onChange={setModel} title="Modelo de este agente" />
          )}
          {modelMode === 'auto' && (
            <p className="saurio-text-dim agent-editor__hint">
              Prefiere el modelo ya cargado si entra en memoria; si no, usa un modelo por defecto (doc 19 §1.5, heurística mínima en evaluación).
            </p>
          )}
        </fieldset>

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

        {!initial && (
          <label className="agent-editor__field">
            <span>Memoria</span>
            <select value={memoryScope} onChange={(e) => setMemoryScope(e.target.value as 'global' | 'project')}>
              <option value="global">Global (visible en cualquier proyecto)</option>
              <option value="project">Solo este proyecto</option>
            </select>
          </label>
        )}

        {error && <div className="saurio-banner danger">{error}</div>}

        <div className="agent-editor__actions">
          <button type="button" className="saurio-btn-ghost" onClick={onClose} disabled={saving}>Cancelar</button>
          <button type="button" className="saurio-btn-primary" onClick={() => void handleSubmit()} disabled={saving}>
            {saving ? 'Guardando…' : initial ? 'Guardar cambios' : 'Crear agente'}
          </button>
        </div>
      </div>
    </div>
  );
}
