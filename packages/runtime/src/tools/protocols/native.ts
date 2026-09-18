// NativeToolProtocol: usa `tools` de la API y además escanea `content` — protocols/native.ts.
// Define: doc 04 §4 (ToolProtocol), ADR-6 de la columna vertebral ("NativeToolProtocol usa la API
// tools; en transporte texto los resultados viajan como role:'user' con <tool_result>") y doc 05
// §2.5 paso 20 ("combina las tool calls nativas del chunk con un escaneo del content acumulado").
import { randomUUID } from 'node:crypto';
import type { ChatMessage, ToolCall, ToolResult } from '@saurio/shared';
import type { JsonSchemaTool } from '../../gateway/types.js';
import type { ToolDefinition, ToolProtocol } from '../types.js';
import { scanToolCallBlocks } from './scanToolCalls.js';
import { extractText } from './common.js';

export class NativeToolProtocol implements ToolProtocol {
  renderTools(tools: ToolDefinition[]): { apiTools?: JsonSchemaTool[]; systemSuffix?: string; stop?: string[] } {
    const apiTools: JsonSchemaTool[] = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
    return { apiTools };
  }

  parse(message: ChatMessage, tools?: ToolDefinition[]): { toolCalls: ToolCall[]; text: string; parseErrors: string[] } {
    const native = message.toolCalls ?? [];
    const scanned = scanToolCallBlocks(message.content, 'native', tools);
    // Si el provider ya entregó tool_calls nativos, `content` normalmente viene vacío o es solo
    // texto narrativo; igual se escanea (doc 05 paso 20) por si el modelo "narró" una llamada además
    // o en lugar de usar la estructura nativa (research-small-models.md §1.2 punto 5).
    const toolCalls = native.length > 0 ? native : scanned.toolCalls;
    const text = native.length > 0 ? message.content : scanned.text;
    return { toolCalls, text, parseErrors: scanned.parseErrors };
  }

  renderResult(call: ToolCall, result: ToolResult): ChatMessage {
    return {
      id: randomUUID(),
      role: 'tool',
      content: extractText(result),
      toolCallId: call.id,
      toolName: call.name,
    };
  }
}

export function createNativeToolProtocol(): NativeToolProtocol {
  return new NativeToolProtocol();
}
