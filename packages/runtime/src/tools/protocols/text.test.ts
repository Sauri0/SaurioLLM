// Test de TextToolProtocol: renderTools (systemSuffix + stop), parse tolerante, renderResult <tool_result>.
// Define: doc 04 §4, ADR-6, research-small-models.md §2.2-2.3.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ChatMessage } from '@saurio/shared';
import { TextToolProtocol } from './text.js';
import type { ToolDefinition } from '../types.js';

function tool(name: string, argsSchema?: ToolDefinition['argsSchema']): ToolDefinition {
  return {
    name,
    description: `desc ${name}`,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    argsSchema,
    category: 'read',
    mutating: false,
    idempotent: true,
    allowedInModes: ['agent'],
    source: { kind: 'builtin' },
    handler: async () => ({ content: [{ type: 'text', text: 'x' }], isError: false }),
  };
}

describe('tools/protocols/text', () => {
  const proto = new TextToolProtocol();

  it('renderTools produce systemSuffix con las tools y stop en </tool_call>', () => {
    const { apiTools, systemSuffix, stop } = proto.renderTools([tool('read_file')]);
    expect(apiTools).toBeUndefined();
    expect(systemSuffix).toContain('read_file');
    expect(systemSuffix).toContain('<tool_call>');
    expect(systemSuffix).toContain('se considera tu respuesta final y termina este run');
    expect(systemSuffix).toContain('no respondas en prosa ni le pidas al usuario que copie o confirme contenido o permisos');
    expect(systemSuffix).toContain('Respondé directamente con texto sólo para conversación');
    expect(systemSuffix).toContain('tu próxima respuesta DEBE ser exclusivamente');
    expect(systemSuffix?.trimEnd().endsWith('Esta regla no aplica a saludos ni a preguntas generales que pueden responderse sin inspeccionar el proyecto.')).toBe(true);
    expect(stop).toEqual(['</tool_call>']);
  });

  it('parse extrae un tool call Hermes bien formado', () => {
    const msg: ChatMessage = {
      id: 'm1', role: 'assistant',
      content: '<tool_call>\n{"name": "read_file", "arguments": {"path": "src/a.ts"}}\n</tool_call>',
    };
    const { toolCalls, parseErrors } = proto.parse(msg);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ name: 'read_file', args: { path: 'src/a.ts' }, transport: 'text' });
    expect(parseErrors).toHaveLength(0);
  });

  it('parse tolera fences markdown, comillas simples y coma final', () => {
    const msg: ChatMessage = {
      id: 'm2', role: 'assistant',
      content: "<tool_call>\n```json\n{'name': 'read_file', 'arguments': {'path': 'a.ts',},}\n```\n</tool_call>",
    };
    const { toolCalls } = proto.parse(msg);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.name).toBe('read_file');
  });

  it('parse tolera el tag <tool_call> sin cerrar', () => {
    const msg: ChatMessage = {
      id: 'm3', role: 'assistant',
      content: '<tool_call>\n{"name": "finish", "arguments": {"summary": "listo"}}',
    };
    const { toolCalls } = proto.parse(msg);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.name).toBe('finish');
  });

  it('parse desdobla arguments codificado dos veces como string', () => {
    const msg: ChatMessage = {
      id: 'm4', role: 'assistant',
      content: '<tool_call>{"name": "read_file", "arguments": "{\\"path\\": \\"a.ts\\"}"}</tool_call>',
    };
    const { toolCalls } = proto.parse(msg);
    expect(toolCalls[0]?.args).toEqual({ path: 'a.ts' });
  });

  it('parse acepta un tool call JSON sin las etiquetas <tool_call> (doc 16 §4 ítem 3, medido con qwen2.5-coder:7b)', () => {
    const msg: ChatMessage = {
      id: 'm5', role: 'assistant',
      content: '{"name": "edit_file", "arguments": {"path": "src/coder.ts", "old_string": "return n;", "new_string": "return n * 2;"}}',
    };
    const { toolCalls, parseErrors, text } = proto.parse(msg);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ name: 'edit_file', args: { path: 'src/coder.ts' }, transport: 'text' });
    expect(parseErrors).toHaveLength(0);
    expect(text).toBe('');
  });

  it('parse no confunde prosa normal (no empieza con "{") con un tool call sin etiquetas', () => {
    const msg: ChatMessage = { id: 'm6', role: 'assistant', content: 'Che, no encontré ningún bug en ese archivo.' };
    const { toolCalls, parseErrors } = proto.parse(msg);
    expect(toolCalls).toHaveLength(0);
    expect(parseErrors).toHaveLength(0);
  });

  it('parse acepta un tool call en un fence ```json``` con prosa antes (medido con qwen2.5-coder:7b)', () => {
    const msg: ChatMessage = {
      id: 'm7', role: 'assistant',
      content: 'Voy a editar el archivo para corregir la función.\n\n```json\n{"name": "edit_file", "arguments": {"path": "src/coder.ts", "old_string": "return n;", "new_string": "return n * 2;"}}\n```',
    };
    const { toolCalls, parseErrors } = proto.parse(msg);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ name: 'edit_file', args: { path: 'src/coder.ts' } });
    expect(parseErrors).toHaveLength(0);
  });

  it('parse con el JSON duplicado (fence + bare a continuación) se queda con uno solo', () => {
    const msg: ChatMessage = {
      id: 'm8', role: 'assistant',
      content: 'Voy a editar.\n\n```json\n{"name": "edit_file", "arguments": {"path": "a.ts"}}\n```\n\n{"name": "edit_file", "arguments": {"path": "a.ts"}}',
    };
    const { toolCalls } = proto.parse(msg);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.name).toBe('edit_file');
  });

  it('con varios bloques JSON narrados en el mismo turno, elige el PRIMERO que corresponde a una tool existente (doc 16 §9.7/punto 3 del encargo, caso real medido con qwen2.5-coder:7b: read_file, edit_file, read_file de verificación, finish)', () => {
    const tools = [tool('read_file'), tool('edit_file'), tool('finish')];
    const msg: ChatMessage = {
      id: 'm9', role: 'assistant',
      content: [
        'Primero reviso el archivo.',
        '```json',
        '{"name": "read_file", "arguments": {"path": "src/math.ts"}}',
        '```',
        'Ahora corrijo el bug.',
        '```json',
        '{"name": "edit_file", "arguments": {"path": "src/math.ts", "old_string": "a - b", "new_string": "a + b"}}',
        '```',
        'Reviso de nuevo.',
        '```json',
        '{"name": "read_file", "arguments": {"path": "src/math.ts"}}',
        '```',
        'Listo.',
        '```json',
        '{"name": "finish", "arguments": {"summary": "arreglado"}}',
        '```',
      ].join('\n'),
    };
    const { toolCalls } = proto.parse(msg, tools);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.name).toBe('read_file'); // el PRIMER bloque válido, no "finish" (el último)
  });

  it('salta un bloque cuya tool no existe en este turno y sigue con el primer bloque de una tool real', () => {
    const tools = [tool('edit_file'), tool('finish')];
    const msg: ChatMessage = {
      id: 'm10', role: 'assistant',
      content: [
        '```json',
        '{"name": "tool_que_no_existe", "arguments": {}}',
        '```',
        '```json',
        '{"name": "edit_file", "arguments": {"path": "a.ts"}}',
        '```',
        '```json',
        '{"name": "finish", "arguments": {"summary": "listo"}}',
        '```',
      ].join('\n'),
    };
    const { toolCalls } = proto.parse(msg, tools);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.name).toBe('edit_file');
  });

  it('salta un bloque cuyos argumentos no validan contra el argsSchema de la tool y sigue con el siguiente candidato válido', () => {
    const tools = [
      tool('edit_file', z.object({ path: z.string(), old_string: z.string(), new_string: z.string() })),
      tool('finish', z.object({ summary: z.string() })),
    ];
    const msg: ChatMessage = {
      id: 'm11', role: 'assistant',
      content: [
        // Primer bloque: "edit_file" pero le falta "new_string" -> no valida contra argsSchema.
        '```json',
        '{"name": "edit_file", "arguments": {"path": "a.ts", "old_string": "x"}}',
        '```',
        '```json',
        '{"name": "finish", "arguments": {"summary": "listo"}}',
        '```',
      ].join('\n'),
    };
    const { toolCalls } = proto.parse(msg, tools);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.name).toBe('finish');
  });

  it('renderResult produce role user con <tool_result>', () => {
    const msg = proto.renderResult(
      { id: 'c1', name: 'read_file', args: {}, transport: 'text' },
      { content: [{ type: 'text', text: 'contenido' }], isError: false },
    );
    expect(msg.role).toBe('user');
    expect(msg.content).toContain('<tool_result name="read_file">');
    expect(msg.content).toContain('contenido');
  });
});
