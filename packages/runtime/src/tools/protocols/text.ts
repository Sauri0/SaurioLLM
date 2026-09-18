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
      'sin texto antes ni después del bloque salvo que sea tu respuesta final (sin tool call).',
      '',
      'Tools:',
      list,
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
