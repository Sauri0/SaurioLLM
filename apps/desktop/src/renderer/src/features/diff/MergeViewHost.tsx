// Monta un @codemirror/merge MergeView de solo lectura en un <div>; usado por DiffPanel para la
// vista antes/después (doc 09 §4.2 "revisión post-hoc": `checkpoint:diff` + CodeMirror 6).
// apps/desktop/src/renderer/src/features/diff/MergeViewHost.tsx.
import { useEffect, useRef } from 'react';
import { MergeView } from '@codemirror/merge';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import './diff.css';

export interface MergeViewHostProps {
  before: string;
  after: string;
}

export function MergeViewHost({ before, after }: MergeViewHostProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const readOnlyExtensions = [oneDark, EditorState.readOnly.of(true), EditorView.lineWrapping];
    const view = new MergeView({
      a: { doc: before, extensions: readOnlyExtensions },
      b: { doc: after, extensions: readOnlyExtensions },
      parent: container,
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: { margin: 3, minSize: 4 },
    });
    return () => view.destroy();
  }, [before, after]);

  return <div ref={containerRef} className="saurio-mono diff-merge-view" />;
}
