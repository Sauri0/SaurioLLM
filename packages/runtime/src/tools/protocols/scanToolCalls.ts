// Escaneo de bloques <tool_call>JSON</tool_call> en `content` — packages/runtime/src/tools/protocols/scanToolCalls.ts.
// Define: doc 05 §2.5 paso 20 ("escanea el content acumulado buscando bloques <tool_call>, estilo
// Hermes") y §2.5 paso 20 bis (tolerancias de parseo) y research-small-models.md §2.3 (formato Hermes,
// tag sin cerrar, texto narrativo antes del bloque). Usado por NativeToolProtocol (fallback sobre
// content) y TextToolProtocol (mecanismo principal).
import { randomUUID } from 'node:crypto';
import type { ToolCall } from '@saurio/shared';
import type { ToolDefinition } from '../types.js';
import { repairJson, unwrapDoubleEncodedArguments } from './jsonRepair.js';

export interface ScanOutcome {
  toolCalls: ToolCall[];
  /** `content` con los bloques <tool_call> quitados (solo texto narrativo). */
  text: string;
  parseErrors: string[];
}

const OPEN_TAG = '<tool_call>';
const CLOSE_TAG = '</tool_call>';

interface RawToolCallJson { name?: unknown; arguments?: unknown }

/** Subconjunto de `ToolDefinition` que necesita el fallback narrado (doc 16 §4 ítem 3/§9.7, punto 3
 *  del encargo): "elegí el PRIMER bloque válido que corresponda a una tool EXISTENTE con argumentos
 *  VÁLIDOS". `RunController` ya arma `availableTools` para este turno (para `protocol.renderTools()`)
 *  antes de llamar a `protocol.parse()`, así que se lo pasa tal cual — sin acoplar este módulo a
 *  `ToolRegistry`. */
export type KnownToolCallTarget = Pick<ToolDefinition, 'name' | 'argsSchema'>;

export function scanToolCallBlocks(
  content: string, transport: 'native' | 'text', knownTools?: KnownToolCallTarget[],
): ScanOutcome {
  const toolCalls: ToolCall[] = [];
  const parseErrors: string[] = [];
  let text = '';
  let cursor = 0;
  let index = 0;

  while (cursor < content.length) {
    const openIdx = content.indexOf(OPEN_TAG, cursor);
    if (openIdx < 0) {
      text += content.slice(cursor);
      break;
    }
    text += content.slice(cursor, openIdx);
    const bodyStart = openIdx + OPEN_TAG.length;
    const closeIdx = content.indexOf(CLOSE_TAG, bodyStart);
    let bodyEnd: number;
    let nextCursor: number;
    if (closeIdx < 0) {
      // tag sin cerrar (research-small-models.md §2.3): se toma el resto del mensaje como cuerpo.
      bodyEnd = content.length;
      nextCursor = content.length;
    } else {
      bodyEnd = closeIdx;
      nextCursor = closeIdx + CLOSE_TAG.length;
    }
    const rawBody = content.slice(bodyStart, bodyEnd).trim();
    cursor = nextCursor;
    if (rawBody === '') continue;
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        parsed = repairJson(rawBody).value;
      }
      const obj = parsed as RawToolCallJson;
      if (typeof obj.name !== 'string') {
        parseErrors.push(`bloque <tool_call> sin "name" válido: ${rawBody.slice(0, 120)}`);
        continue;
      }
      const args = unwrapDoubleEncodedArguments(obj.arguments ?? {});
      toolCalls.push({ id: randomUUID(), name: obj.name, args, index: index++, transport });
    } catch (err) {
      parseErrors.push(`bloque <tool_call> con JSON inválido: ${(err as Error).message}`);
    }
  }

  const trimmedText = text.trim();

  // Doc 16 §4 ítem 3 ("TextToolProtocol con qwen2.5-coder:7b, arreglá parser/prompt si falla"):
  // MEDIDO 2026-09-18 contra Ollama 0.34.1 real — qwen2.5-coder:7b, con el `systemSuffix` de
  // TextToolProtocol pidiendo explícitamente el formato `<tool_call>{...}</tool_call>`, responde el
  // JSON de la tool call SIN las etiquetas Hermes, de tres formas distintas medidas en la misma
  // corrida: (a) el JSON bare como contenido completo del mensaje; (b) prosa + el JSON envuelto en
  // un fence ```json ... ```; (c) prosa + fence + el mismo JSON repetido bare a continuación del
  // fence. El bucle de arriba nunca encuentra `<tool_call>` en ninguno de los tres casos y esto se
  // trataba como "sin tool call" — tres turnos así y el LoopDetector fuerza el cierre con la
  // respuesta de texto (doc 05 §2.10), sin haber intentado ninguna tool ni una sola vez. Se agrega
  // un fallback que busca, en el texto restante completo (con o sin prosa alrededor), un objeto JSON
  // balanceado con un campo `name` string.
  //
  // Doc 16 §9.7 / punto 3 del encargo: corrida real con `qwen2.5-coder:7b` narrando un PLAN de varios
  // pasos en el mismo turno (4 bloques JSON: `read_file` ya ejecutado, `edit_file`, un `read_file` de
  // verificación y `finish`) — quedarse con el ÚLTIMO bloque (`finish`) cerraba el run sin aplicar el
  // cambio. Fix: `findCandidateToolCallJson` ahora prefiere el PRIMER bloque, en dos pasadas —
  // (1) con `knownTools` (tools existentes de este turno, con validación de `argsSchema` si la
  // tool la declara) cuando está disponible, (2) sin filtrar por tool si ninguno matchea esa pasada
  // más estricta (mismo criterio permisivo de antes: cualquier `name` string, primero en vez de
  // último) — nunca deja de intentar algo por falta de `knownTools` (native.ts/text.ts lo pasan).
  if (toolCalls.length === 0 && parseErrors.length === 0) {
    const candidate = findCandidateToolCallJson(trimmedText, knownTools);
    if (candidate !== undefined) {
      try {
        let parsed: unknown;
        try {
          parsed = JSON.parse(candidate);
        } catch {
          parsed = repairJson(candidate).value;
        }
        const obj = parsed as RawToolCallJson;
        if (typeof obj.name === 'string') {
          const args = unwrapDoubleEncodedArguments(obj.arguments ?? {});
          return {
            toolCalls: [{ id: randomUUID(), name: obj.name, args, index: 0, transport }],
            text: '',
            parseErrors: [],
          };
        }
      } catch {
        // No era JSON válido ni reparable: se sigue tratando como texto narrativo normal, sin error
        // (no hay ninguna tag <tool_call> de por medio que indique una intención fallida de llamar).
      }
    }
  }

  return { toolCalls, text: trimmedText, parseErrors };
}

/** Substring balanceado en llaves que empieza en `text[from]` (que debe ser '{'), o `undefined` si
 *  nunca vuelve a profundidad 0 (llave sin cerrar). */
function extractBalancedJsonObject(text: string, from: number): string | undefined {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }
  return undefined;
}

/** Busca un objeto JSON con forma de tool call en texto narrativo (fenced ```json``` o bare, con o
 *  sin prosa alrededor) — ver comentario de doc 16 §4 ítem 3/§9.7 arriba. Prueba cada '{' del texto
 *  como posible inicio de un objeto balanceado, y de los candidatos que efectivamente parsean con un
 *  `name` string prefiere el PRIMERO (no el último, punto 3 del encargo) que además corresponda a
 *  una tool EXISTENTE de `knownTools` con argumentos válidos según su `argsSchema` (si la tool la
 *  declara) — esa es la pasada estricta. Si ninguno cumple esa pasada (p. ej. `knownTools` no vino,
 *  o el modelo narró una tool que no existe en este turno), cae al criterio permisivo de antes:
 *  el PRIMER candidato con cualquier `name` string. Si ninguno parsea limpio, devuelve el último
 *  candidato balanceado tal cual para que el llamador intente `repairJson` sobre él (igual que
 *  antes). */
function findCandidateToolCallJson(text: string, knownTools?: KnownToolCallTarget[]): string | undefined {
  const candidates: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '{') continue;
    const candidate = extractBalancedJsonObject(text, i);
    if (candidate) candidates.push(candidate);
  }
  if (candidates.length === 0) return undefined;

  const parsedCandidates: { raw: string; parsed: RawToolCallJson }[] = [];
  for (const raw of candidates) {
    try {
      const parsed = JSON.parse(raw) as RawToolCallJson;
      if (typeof parsed.name === 'string') parsedCandidates.push({ raw, parsed });
    } catch {
      // este candidato en particular no es JSON válido tal cual (puede tener comillas simples, coma
      // final, etc.) — se sigue probando el resto de la lista.
    }
  }

  if (knownTools && knownTools.length > 0) {
    for (const { raw, parsed } of parsedCandidates) {
      const tool = knownTools.find((t) => t.name === parsed.name);
      if (!tool) continue;
      if (!tool.argsSchema) return raw; // sin schema declarado: alcanza con que la tool exista
      const args = unwrapDoubleEncodedArguments(parsed.arguments ?? {});
      if (tool.argsSchema.safeParse(args).success) return raw;
    }
  }

  if (parsedCandidates.length > 0) return parsedCandidates[0]!.raw;
  return candidates[candidates.length - 1];
}
