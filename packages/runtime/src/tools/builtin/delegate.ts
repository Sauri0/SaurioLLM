// Tool `delegate` (doc 19 §2.5, E3a "Delegación desde el chat") — packages/runtime/src/tools/builtin/delegate.ts.
// A diferencia de las 10 builtins del MVP, esta tool NO se agrega a `DEFAULT_ALLOWED_TOOLS`
// (agent/defaults.ts) — solo un agente que la tenga explícita en su `allowedTools` puede delegar
// (mitigación "delegación solo por tool explícita", doc 19 §5). Igual se registra siempre en el
// `ToolRegistry` (tools/builtin/index.ts) para que `tools.list({names: agent.allowedTools})` pueda
// resolverla cuando un agente puntual la pida.
//
// El `handler` de abajo NUNCA debería ejecutarse en un run real: la orquestación de delegación
// (crear agente/chat/run hijo, llamar `RunController.start()` recursivamente, parsear el
// `DelegationResultSchema` de la última respuesta del hijo) necesita acceso a los repositorios y al
// propio `RunController`, que `ToolContext` no expone a propósito (doc 04 §4: las tools solo ven
// fs/checkpoint/emit/log). Por eso `RunController` intercepta la tool call `delegate` ANTES del
// despacho genérico (mismo patrón que ya usa para `finish`, ver `runFinish`/`handleToolCalls`) y
// llama a su método privado `runDelegateTool` en su lugar.
import { z } from 'zod';
import { DelegationRequestSchema } from '@saurio/shared';
import type { ToolDefinition, ToolContext } from '../types.js';
import type { BuiltinToolsDeps } from './deps.js';

type Args = z.infer<typeof DelegationRequestSchema>;

export function createDelegateTool(_deps: BuiltinToolsDeps): ToolDefinition<Args> {
  return {
    name: 'delegate',
    description: 'Delega una tarea acotada a un agente personal existente (targetAgentId) o, si no se indica, a un worker temporal que no se vuelve permanente. Profundidad máxima 1: no se puede delegar desde un run que ya es hijo de otra delegación.',
    inputSchema: z.toJSONSchema(DelegationRequestSchema),
    argsSchema: DelegationRequestSchema,
    category: 'delegate',
    mutating: false,
    idempotent: false,
    allowedInModes: ['plan', 'edit', 'agent'],
    source: { kind: 'delegate' },
    async handler(_args: Args, _ctx: ToolContext) {
      throw new Error(
        'saurio: la tool "delegate" debe ser interceptada por RunController.runDelegateTool antes de ' +
        'llegar a este handler genérico (doc 19 §2.5) — si esto se ejecutó, hay un error de cableado.',
      );
    },
  };
}
