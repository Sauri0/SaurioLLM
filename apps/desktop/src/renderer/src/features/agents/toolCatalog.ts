// Catálogo local de tools builtin, solo para el checklist de AgentEditorModal (doc 19 §1.6) —
// apps/desktop/src/renderer/src/features/agents/toolCatalog.ts.
// DEVIATION (mismo criterio que features/settings/SettingsPanel.tsx con PermissionRuleView): la
// lista real de `BuiltinToolName` vive en packages/runtime/src/agent/defaults.ts
// (`DEFAULT_ALLOWED_TOOLS`), un paquete de proceso main puro del que la UI no debe depender
// directamente (doc 01 §2 principio 9). Se repite acá como constante local en vez de importarla.
export interface ToolCatalogEntry {
  name: string;
  label: string;
}

/** Las builtins del runtime, en el mismo orden que
 *  `DEFAULT_ALLOWED_TOOLS`. */
export const BUILTIN_TOOL_CATALOG: ToolCatalogEntry[] = [
  { name: 'list_files', label: 'Listar archivos' },
  { name: 'search_code', label: 'Buscar en el código' },
  { name: 'read_file', label: 'Leer archivos' },
  { name: 'read_output', label: 'Leer salida de comandos' },
  { name: 'edit_file', label: 'Editar archivos' },
  { name: 'write_file', label: 'Crear/sobreescribir archivos' },
  { name: 'make_dir', label: 'Crear carpetas' },
  { name: 'delete_file', label: 'Borrar archivos' },
  { name: 'run_command', label: 'Ejecutar comandos de terminal' },
  { name: 'task_update', label: 'Actualizar checklist de tareas' },
  { name: 'finish', label: 'Terminar el turno' },
];

/** Doc 19 §2.5 (E3a): NO forma parte de `DEFAULT_ALLOWED_TOOLS` — solo un agente que la tenga
 *  explícitamente en su `allowedTools` puede delegar. Se muestra separada en el editor, nunca
 *  marcada por defecto. */
export const DELEGATE_TOOL: ToolCatalogEntry = { name: 'delegate', label: 'Delegar a otro agente (o a un worker temporal)' };
