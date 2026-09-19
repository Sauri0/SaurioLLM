import type { ContextBudgetReport, ContextInspection, ModelResolution } from '@saurio/shared';
import './contextInspector.css';

const LABELS: Record<ContextInspection['sources'][number]['kind'], string> = {
  system_prompt: 'Instrucciones del agente', environment: 'Carpeta y entorno', tools: 'Herramientas habilitadas',
  project_instructions: 'Instrucciones del proyecto (SAURIO.md)', repo_map: 'Mapa del proyecto',
  agent_memory: 'Memorias recuperadas', history: 'Historial', summary: 'Resumen de conversación',
};
const STATUS = { included: 'Incluido', absent: 'Sin contenido', pruned: 'Recortado', compacted: 'Resumido', unavailable: 'No disponible' };
function sourceOrigin(value: string): string {
  if (value.startsWith('agent_memory:')) return 'Memoria habilitada para este agente';
  if (value.startsWith('agent:')) return 'Perfil del agente de esta ejecución';
  const names: Record<string, string> = {
    runtime: 'Entorno de la aplicación', tool_registry: 'Herramientas del modo actual',
    project_index: 'Índice del proyecto', chat_history: 'Mensajes de este chat',
    context_compactor: 'Resumen generado para esta conversación',
  };
  return names[value] ?? value;
}
const REASONS: Record<NonNullable<ContextInspection['sources'][number]['reason']>, string> = {
  not_connected: 'Fuente no conectada', not_configured: 'Sin configurar', disabled: 'Desactivado', empty: 'Sin contenido disponible',
  build_failed: 'No se pudo preparar', budget: 'No entraba en el presupuesto', compaction: 'Reemplazado por un resumen',
  missing_data: 'No se recibió el contenido', truncated_for_limit: 'Recortado por el límite',
  unavailable_after_restart: 'Este detalle no se conserva después de reiniciar',
};

const MODEL_RESOLUTION_LABELS: Record<ModelResolution['source'], string> = {
  chat_override: 'Elegido explícitamente para este chat.',
  agent_fixed: 'Modelo fijo del perfil del agente.',
  automatic_recommendation: 'Selección automática desde las recomendaciones locales por rol y hardware.',
  automatic_loaded: 'Selección automática de un modelo local que ya estaba cargado.',
  automatic_profile: 'Fallback automático al modelo local del perfil.',
  builtin_fallback: 'Fallback integrado de SaurioLLM.',
};

const FIT_LABELS: Record<NonNullable<ModelResolution['fitClass']>, string> = {
  fits_gpu: 'entra en GPU', tight: 'entra justo', partial_offload: 'usa CPU/offload',
};

export function modelResolutionText(resolution: ModelResolution | undefined): string {
  if (!resolution) return 'Origen sin confirmar: esta ejecución no guardó el motivo de selección.';
  const details = [MODEL_RESOLUTION_LABELS[resolution.source]];
  if (resolution.fitClass) details.push(`Ajuste estimado: ${FIT_LABELS[resolution.fitClass]}.`);
  if (resolution.contextMax) details.push(`Contexto evaluado: ${resolution.contextMax.toLocaleString('es-AR')} tokens.`);
  if (resolution.inheritedFromRunId) details.push('Conservado al continuar una ejecución anterior.');
  return details.join(' ');
}

export function ContextInspector({
  report, modelResolution,
}: { report: ContextBudgetReport | undefined; modelResolution?: ModelResolution }): React.JSX.Element {
  const inspection = report?.inspection;
  return <details className="context-inspector">
    <summary>Qué contexto recibió la IA</summary>
    <div className="context-inspector__body">
      <p>Última preparación del contexto de este chat. Los tokens son estimados; no anticipa el próximo envío.</p>
      <p>Abrir una carpeta no envía todos sus archivos. El mapa describe el proyecto; las lecturas de herramientas aparecen en el historial.</p>
      <p><strong>Selección del modelo:</strong> {modelResolutionText(modelResolution)}</p>
      {!inspection || !report ? <p>No hay un detalle registrado. Se generará al enviar un mensaje nuevo.</p> : <>
        <p><strong>Carpeta:</strong> <code>{inspection.projectRoot}</code></p>
        <p>Uso ≈ {report.totalUsed.toLocaleString('es-AR')} tokens. Límite {inspection.limitSource === 'reported' ? 'confirmado' : 'provisional'}: {(report.effectiveNumCtx ?? report.numCtx).toLocaleString('es-AR')}. Reserva de respuesta: {report.reserveForResponse.toLocaleString('es-AR')}.</p>
        {!report.fits && <p role="alert">El contenido preparado excede el presupuesto disponible.</p>}
        <ul>{inspection.sources.map((source) => <li key={source.kind}>
          <strong>{LABELS[source.kind]}</strong> · {STATUS[source.status]}
          {source.tokens !== undefined && <> · ≈ {source.tokens.toLocaleString('es-AR')} tokens</>}
          {source.provenance && <span>Origen: {sourceOrigin(source.provenance)}</span>}
          {source.reason && <span>{REASONS[source.reason]}</span>}
          {!!source.omittedCount && <span>{source.omittedCount} elementos omitidos</span>}
        </li>)}</ul>
        <p>Historial: {inspection.history.includedMessages} mensajes incluidos, {inspection.history.prunedMessages} recortados y {inspection.history.compactedMessages} resumidos. {inspection.history.summaryIncluded ? 'Resumen incluido.' : 'Sin resumen incluido.'}</p>
        <strong>Adjuntos del envío</strong>
        {!inspection.attachmentsKnown ? <p>Detalle de adjuntos no disponible.</p> : inspection.attachments.length === 0 ? <p>Sin adjuntos en este envío.</p> : <ul>{inspection.attachments.map((item, index) => <li key={`${item.name}-${index}`}>
          {item.name} · {item.kind === 'image' ? 'Imagen' : 'Archivo'} · {item.status === 'included' ? 'Incluido' : 'Excluido'}
          {item.truncated && ' · Recortado'}{item.reason && <span>{REASONS[item.reason]}</span>}
        </li>)}</ul>}
      </>}
    </div>
  </details>;
}
