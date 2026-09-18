// Test de NativeToolProtocol: renderTools, parse (tool_calls nativos + escaneo de content), renderResult.
// Define: doc 04 §4, ADR-6, doc 05 §2.5 paso 20.
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@saurio/shared';
import { NativeToolProtocol } from './native.js';
import type { ToolDefinition } from '../types.js';

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `desc ${name}`,
    inputSchema: { type: 'object', properties: {} },
    category: 'read',
    mutating: false,
    idempotent: true,
    allowedInModes: ['agent'],
    source: { kind: 'builtin' },
    handler: async () => ({ content: [{ type: 'text', text: 'x' }], isError: false }),
  };
}

describe('tools/protocols/native', () => {
  const proto = new NativeToolProtocol();

  it('renderTools produce apiTools en formato JsonSchemaTool', () => {
    const { apiTools, systemSuffix, stop } = proto.renderTools([tool('read_file')]);
    expect(apiTools).toEqual([{ type: 'function', function: { name: 'read_file', description: 'desc read_file', parameters: { type: 'object', properties: {} } } }]);
    expect(systemSuffix).toBeUndefined();
    expect(stop).toBeUndefined();
  });

  it('parse usa message.toolCalls cuando el provider ya los estructuró', () => {
    const msg: ChatMessage = {
      id: 'm1', role: 'assistant', content: '',
      toolCalls: [{ id: 't1', name: 'read_file', args: { path: 'a.ts' }, transport: 'native' }],
    };
    const { toolCalls, parseErrors } = proto.parse(msg);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.name).toBe('read_file');
    expect(parseErrors).toHaveLength(0);
  });

  it('parse escanea content por <tool_call> aunque el transporte sea nativo (fallback)', () => {
    const msg: ChatMessage = {
      id: 'm2', role: 'assistant',
      content: 'Voy a leer el archivo:\n<tool_call>\n{"name": "read_file", "arguments": {"path": "a.ts"}}\n</tool_call>',
    };
    const { toolCalls, text } = proto.parse(msg);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.name).toBe('read_file');
    expect(text).toContain('Voy a leer el archivo');
  });

  it('renderResult produce role tool con toolCallId y toolName', () => {
    const msg = proto.renderResult(
      { id: 'call-1', name: 'read_file', args: {}, transport: 'native' },
      { content: [{ type: 'text', text: 'contenido del archivo' }], isError: false },
    );
    expect(msg.role).toBe('tool');
    expect(msg.toolCallId).toBe('call-1');
    expect(msg.toolName).toBe('read_file');
    expect(msg.content).toBe('contenido del archivo');
  });
});
