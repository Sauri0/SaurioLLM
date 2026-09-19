export type RecommendedModelTarget =
  | { kind: 'chat'; chatId: string }
  | { kind: 'project-draft'; projectId: string }
  | { kind: 'personal-chat' };

/** El asistente aplica el modelo donde el usuario está trabajando. Sin un proyecto activo no toma
 * uno reciente arbitrariamente: abre el chat personal, que es una intención visible y recuperable. */
export function recommendedModelTarget(currentChatId: string | undefined, currentProjectId: string | undefined): RecommendedModelTarget {
  if (currentChatId) return { kind: 'chat', chatId: currentChatId };
  if (currentProjectId) return { kind: 'project-draft', projectId: currentProjectId };
  return { kind: 'personal-chat' };
}
