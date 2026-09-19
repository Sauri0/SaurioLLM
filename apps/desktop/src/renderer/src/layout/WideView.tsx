// Envoltorio de las secciones a pantalla completa (Modelos/Agentes/Rendimiento/Ajustes, punto 1 del
// encargo de rediseño): aire, tipografía base más grande y un máximo de ancho de lectura para que
// las listas/tarjetas no se estiren de borde a borde en pantallas grandes (2000px+). Los paneles en
// sí (features/models/**, features/agents/**, features/perf/**, features/settings/**) no cambian —
// esto es solo "cómo se montan". apps/desktop/src/renderer/src/layout/WideView.tsx.
export function WideView({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="saurio-view saurio-view--wide">
      <div className="saurio-view__inner">{children}</div>
    </div>
  );
}
