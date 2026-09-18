// Error boundary de última instancia del renderer (apps/desktop/src/renderer/src/ErrorBoundary.tsx).
//
// HALLAZGO (sesión de debugging "renderer en blanco en modo dev"): un selector de Zustand que
// devolvía un array nuevo en cada render (`?? []`) producía un loop infinito de actualizaciones en
// <ChatCenter>. React, al no encontrar un error boundary en el árbol, desmontaba la app entera
// dejando <div id="root"></div> vacío — sin ningún indicio visual del problema, solo el error en la
// consola de DevTools. Este componente evita que un error de render futuro (de cualquier causa)
// vuelva a dejar la ventana en blanco sin explicación: en vez de eso, muestra el mensaje de error y
// el stack directamente en la página.
import { Component, type ErrorInfo, type ReactNode } from 'react';
import './ErrorBoundary.css';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Diagnóstico intencional: sin esto el error solo aparece truncado en la UI de React, y
    // queremos el stack completo en la consola/logs. `no-console` no está activo en este proyecto
    // (eslint.config.mjs), así que el `eslint-disable` que había acá quedó sin efecto (punto 6 del
    // encargo: "warnings reales" — este era un `eslint-disable` fantasma, no un warning de código).
    console.error('[renderer] ErrorBoundary atrapó un error no manejado', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <main className="saurio-error-boundary">
        <h1 className="saurio-error-boundary__title">SaurioLLM encontró un error inesperado</h1>
        <p>La interfaz no pudo renderizarse. Detalle del error:</p>
        <pre className="saurio-error-boundary__stack">
          {error.stack ?? error.message}
        </pre>
      </main>
    );
  }
}
