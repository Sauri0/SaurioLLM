// TextToolProtocol: Hermes <tool_call>JSON</tool_call> inyectado en el system prompt — protocols/text.ts.
// Define: doc 04 §4 (ToolProtocol), ADR-6 ("en transporte texto los resultados viajan como role:'user'
// con <tool_result>; stop: ['</tool_call>']") y research-small-models.md §2.2-2.3 (formato recomendado,
// stopSequences, tolerancias). settings.toolTransportOverrides trae qwen2.5-coder -> text por defecto
// (medido, no discutir) — esa tabla de overrides es responsabilidad de ModelManager/Settings, fuera de
// mi alcance; acá solo se implementa el protocolo que ese override selecciona.
import { randomUUID } from 'node:crypto';
import type { ChatMessage, ToolCall, ToolResult } from '@saurio/shared';
import type { JsonSchemaTool } from '../../gateway/types.js';
import type { ToolDefinition, ToolProtocol } from '../types.js';
import { scanToolCallBlocks } from './scanToolCalls.js';
import { extractText } from './common.js';

function renderToolSpec(t: ToolDefinition): string {
  return `- ${t.name}: ${t.description}\n  schema: ${JSON.stringify(t.inputSchema)}`;
}

export class TextToolProtocol implements ToolProtocol {
  renderTools(tools: ToolDefinition[]): { apiTools?: JsonSchemaTool[]; systemSuffix?: string; stop?: string[] } {
    const list = tools.map(renderToolSpec).join('\n');
    const systemSuffix = [
      'Tenés disponibles las siguientes tools. Para usar UNA, respondé exclusivamente con:',
      '<tool_call>',
      '{"name": "<nombre_tool>", "arguments": {...}}',
      '</tool_call>',
      '',
      'No hay tool_calls nativos en este modelo: cualquier llamada tiene que ir en ese formato exacto,',
      'sin texto antes ni después del bloque.',
      'Una respuesta sin <tool_call> se considera tu respuesta final y termina este run.',
      'Si el pedido concreto requiere leer, buscar o modificar el proyecto y una tool puede obtener lo necesario,',
      'no respondas en prosa ni le pidas al usuario que copie o confirme contenido o permisos: emití ahora la primera tool necesaria.',
      'Si el usuario nombró una ruta que todavía no leíste en este run, usá read_file antes de editarla.',
      'Respondé directamente con texto sólo para conversación o preguntas que no requieren tools,',
      'o si falta una decisión del usuario que ninguna tool disponible puede obtener.',
      '',
      'Tools:',
      list,
      '',
      'REGLA OPERATIVA FINAL: ante un pedido de modificación que nombra una ruta, si todavía no recibiste',
      'un <tool_result name="read_file"> para esa ruta en este run, tu próxima respuesta DEBE ser exclusivamente',
      'la llamada a read_file. Nunca le pidas al usuario que proporcione o confirme el contenido del archivo.',
      'Esta regla no aplica a saludos ni a preguntas generales que pueden responderse sin inspeccionar el proyecto.',
    ].join('\n');
    return { systemSuffix, stop: ['</tool_call>'] };
  }

  parse(message: ChatMessage, tools?: ToolDefinition[]): { toolCalls: ToolCall[]; text: string; parseErrors: string[] } {
    const scanned = scanToolCallBlocks(message.content, 'text', tools);
    return scanned;
  }

  renderResult(call: ToolCall, result: ToolResult): ChatMessage {
    return {
      id: randomUUID(),
      role: 'user',
      content: `<tool_result name="${call.name}">\n${extractText(result)}\n</tool_result>`,
    };
  }
}

export function createTextToolProtocol(): TextToolProtocol {
  return new TextToolProtocol();
}
