// PRIORIDAD CERO punto 6 (bloqueo real reportado en otro equipo del usuario, sin qwen3:8b instalado):
// antes `layout/Sidebar.tsx` y `layout/ChatCenter.tsx` cada una tenía su propio
// `DEFAULT_MODEL_REF = { name: 'qwen3:8b', ... }` hardcodeado como modelo del próximo chat, sin
// importar qué haya instalado el usuario real — la app mandaba `/api/chat` a un modelo que no
// existía en ese equipo (404 confirmado en el log de Ollama). Este archivo centraliza la única
// fuente real: los modelos que `models:list` reportó instalados.
//
// Tarea "ModelSelect: estados explícitos" (punto 2), cierra los dos huecos que dejaba abiertos la
// pasada anterior de este archivo:
// - "Último usado si sigue instalado": sale del chat con `modelRef` más reciente (`updatedAt`) de
//   ESTE proyecto — no hace falta una preferencia persistida nueva, `chatStore` ya tiene esa
//   información real (cada `chat:setModel`/`chat:create` la actualiza).
// - "El mejor clasificado por la escala para este hardware": sale de `models:catalog` (API PÚBLICA
//   ya expuesta por IPC para el Centro de modelos, doc 16 §12 — no se importa nada de
//   `packages/runtime/src/models/**` ni de `features/models/**` fuera de este contrato), cruzando el
//   `tier` de cada entrada instalada contra el `ModelInfo` real. `catalog` es opcional (el llamador
//   puede no haberlo pedido todavía, p. ej. justo al abrir un proyecto) — sin él, se cae al primer
//   instalado, comportamiento previo.
import type { Chat, CatalogItem, ModelInfo, ModelRef } from '@saurio/shared';

/** Chat con `modelRef` más reciente (`updatedAt` descendente) cuyo modelo TODAVÍA está instalado —
 *  `undefined` si ningún chat tiene modelo, o si el último usado ya no está instalado (se sigue
 *  bajando la lista: un modelo desinstalado hace 3 chats no debería tapar uno más viejo que sí
 *  sigue existiendo). */
export function pickLastUsedModelRef(chats: Chat[], installed: ModelInfo[]): ModelRef | undefined {
  const withModel = [...chats]
    .filter((c): c is Chat & { modelRef: ModelRef } => c.modelRef !== undefined)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  for (const chat of withModel) {
    if (installed.some((m) => m.ref.name === chat.modelRef.name)) return chat.modelRef;
  }
  return undefined;
}

/** El modelo YA INSTALADO con el mejor (número más bajo) `tier.level` de `models:catalog` —
 *  `undefined` si no hay `catalog` todavía o si ninguna entrada instalada tiene `tier` calculado
 *  (p. ej. no se pudo muestrear el hardware). Nunca compara contra modelos NO instalados: elegir uno
 *  así de "mejor clasificado" sin estar instalado llevaría a mandar `/api/chat` a un modelo
 *  inexistente en este equipo (el mismo bug que motivó este archivo). */
export function pickBestInstalledModelRef(installed: ModelInfo[], catalog: CatalogItem[] | undefined): ModelRef | undefined {
  if (!catalog || catalog.length === 0) return undefined;
  const ranked = installed
    .map((model) => ({ model, tier: catalog.find((item) => item.entry.name === model.ref.name)?.tier }))
    .filter((x): x is { model: ModelInfo; tier: NonNullable<CatalogItem['tier']> } => x.tier !== undefined)
    .sort((a, b) => a.tier.level - b.tier.level);
  return ranked[0]?.model.ref;
}

/** `undefined` cuando no hay ningún modelo instalado — el llamador debe mostrarlo explícito
 *  (nunca inventar un modelo ni caer a uno hardcodeado que puede no existir en este equipo). Orden
 *  de preferencia (tarea "ModelSelect: estados explícitos"): último usado en este proyecto (si sigue
 *  instalado) -> mejor clasificado por la escala de seis niveles para este hardware -> primer
 *  instalado (`chats`/`catalog` opcionales para no romper a los llamadores que todavía no los
 *  cargaron: sin ellos, el comportamiento es exactamente el de la pasada anterior). */
export function pickDefaultModelRef(installed: ModelInfo[], chats: Chat[] = [], catalog?: CatalogItem[]): ModelRef | undefined {
  if (installed.length === 0) return undefined;
  return pickLastUsedModelRef(chats, installed) ?? pickBestInstalledModelRef(installed, catalog) ?? installed[0]?.ref;
}
