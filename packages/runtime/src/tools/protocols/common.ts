// Utilidades compartidas entre NativeToolProtocol y TextToolProtocol — protocols/common.ts.
// Define: doc 04 §4 (ToolProtocol.renderResult) — armado del texto que ve el modelo a partir de
// ToolResult.content (ContentPart[]).
import type { ContentPart, ToolResult } from '@saurio/shared';

export function extractText(result: ToolResult): string {
  const parts = result.content.map((p: ContentPart) => {
    if (p.type === 'text') return p.text;
    if (p.type === 'image') return `[imagen ${p.mime}]`;
    return p.text ?? `[recurso ${p.uri}]`;
  });
  return parts.join('\n');
}
