// Visor de archivos de solo lectura con CodeMirror 6 (punto 1 del encargo: "abrir archivo en un
// visor de solo lectura (CodeMirror)"). apps/desktop/src/renderer/src/features/files/FileViewer.tsx.
//
// Se carga con `React.lazy` desde FilesPanel.tsx (punto 7 del encargo, code-splitting): CodeMirror
// (`@codemirror/*`) no tiene por qué ir en el bundle inicial del renderer si el usuario nunca abre
// el panel de Archivos ni selecciona un archivo.
import { useEffect, useRef } from 'react';
import { EditorView, lineNumbers } from '@codemirror/view';
import { EditorState, type Extension } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';

export interface FileViewerProps {
  relPath: string;
  content: string;
}

/** Detección mínima por extensión (doc 09 §3.2 ya hace algo similar para binarios; acá solo es
 *  resaltado de sintaxis, sin impacto funcional si no matchea nada). */
function languageExtensionFor(relPath: string): Extension[] {
  const ext = relPath.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return [javascript({ jsx: ext === 'jsx' })];
    case 'ts':
    case 'tsx':
      return [javascript({ jsx: ext === 'tsx', typescript: true })];
    case 'py':
      return [python()];
    default:
      return [];
  }
}

export function FileViewer({ relPath, content }: FileViewerProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions: [
          oneDark,
          lineNumbers(),
          EditorView.lineWrapping,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          ...languageExtensionFor(relPath),
        ],
      }),
      parent: container,
    });
    return () => view.destroy();
  }, [relPath, content]);

  return (
    <div
      ref={containerRef}
      className="saurio-mono"
      style={{ height: '100%', overflow: 'auto', border: '1px solid var(--saurio-border)', borderRadius: 4 }}
    />
  );
}
