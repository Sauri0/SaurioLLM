/** Recupera pasos explícitos de un plan Markdown sin otra llamada al modelo ni tareas inventadas. */
export function planStepsFromText(text: string): { title: string; status: 'pending' | 'done' }[] {
  const steps: { title: string; status: 'pending' | 'done' }[] = [];
  let fence: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) { fence = fence === marker[0] ? undefined : fence ?? marker[0]; continue; }
    if (fence) continue;
    // Solo ítems principales, no sublistas, ejemplos de código ni prosa suelta.
    const match = /^(?:\d+[.)]\s+(?:\[([ xX])\]\s+)?|[-*+]\s+\[([ xX])\]\s+)(\S.*)$/.exec(line);
    if (!match) continue;
    steps.push({ title: match[3]!.trim(), status: (match[1] ?? match[2])?.toLowerCase() === 'x' ? 'done' : 'pending' });
  }
  return steps;
}
