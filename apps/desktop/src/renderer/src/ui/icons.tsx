// Iconos SVG inline (doc de la pasada de diseño: "lucide-react NO está instalada, usá SVG inline o
// caracteres" — no se agregan librerías nuevas). apps/desktop/src/renderer/src/ui/icons.tsx.
// Todos son `stroke="currentColor"` para heredar el color de texto del contenedor y `aria-hidden`
// porque siempre acompañan a un texto o llevan su propio `aria-label` en el elemento padre.
import type { SVGProps } from 'react';

function Svg(props: SVGProps<SVGSVGElement>): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    />
  );
}

export function FolderIcon(props: SVGProps<SVGSVGElement>): React.JSX.Element {
  return <Svg {...props}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" /></Svg>;
}

export function ChatIcon(props: SVGProps<SVGSVGElement>): React.JSX.Element {
  return <Svg {...props}><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" /></Svg>;
}

export function WrenchIcon(props: SVGProps<SVGSVGElement>): React.JSX.Element {
  return <Svg {...props}><path d="m14.7 6.3 3 3L21 6l-3-3-3.3 3.3ZM14.7 6.3 3 18v3h3L17.7 9.3M9 9l3 3" /></Svg>;
}

export function TerminalIcon(props: SVGProps<SVGSVGElement>): React.JSX.Element {
  return <Svg {...props}><path d="m4 17 6-5-6-5M12 19h8" /></Svg>;
}

export function FileIcon(props: SVGProps<SVGSVGElement>): React.JSX.Element {
  return <Svg {...props}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z" /><path d="M14 2v6h6" /></Svg>;
}

export function ShieldIcon(props: SVGProps<SVGSVGElement>): React.JSX.Element {
  return <Svg {...props}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /></Svg>;
}

export function CheckIcon(props: SVGProps<SVGSVGElement>): React.JSX.Element {
  return <Svg {...props}><path d="M20 6 9 17l-5-5" /></Svg>;
}

export function CircleDotIcon(props: SVGProps<SVGSVGElement>): React.JSX.Element {
  return <Svg {...props}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" /></Svg>;
}

export function GitBranchIcon(props: SVGProps<SVGSVGElement>): React.JSX.Element {
  return <Svg {...props}><circle cx="6" cy="6" r="2.4" /><circle cx="6" cy="18" r="2.4" /><circle cx="18" cy="9" r="2.4" /><path d="M6 8.4V15.6M6 8.4C6 12 9 12.6 12.5 12.6h1.5c1.7 0 3-1.2 3-2.7" /></Svg>;
}

export function CpuIcon(props: SVGProps<SVGSVGElement>): React.JSX.Element {
  return <Svg {...props}><rect x="6" y="6" width="12" height="12" rx="1.5" /><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" /></Svg>;
}

export function GaugeIcon(props: SVGProps<SVGSVGElement>): React.JSX.Element {
  return <Svg {...props}><path d="M12 15v-3.5M4.9 19a9 9 0 1 1 14.2 0" /><path d="M8 19h8" /></Svg>;
}

export function PlugIcon(props: SVGProps<SVGSVGElement>): React.JSX.Element {
  return <Svg {...props}><path d="M9 2v4M15 2v4M7 8h10l-1 5a4 4 0 0 1-4 3.5A4 4 0 0 1 8 13L7 8ZM11 16.5V22" /></Svg>;
}

export function ChevronDownIcon(props: SVGProps<SVGSVGElement>): React.JSX.Element {
  return <Svg {...props}><path d="m6 9 6 6 6-6" /></Svg>;
}

export function AlertIcon(props: SVGProps<SVGSVGElement>): React.JSX.Element {
  return <Svg {...props}><path d="M12 9v4M12 17h.01M10.3 3.9 2.5 18a1.5 1.5 0 0 0 1.3 2.2h16.4a1.5 1.5 0 0 0 1.3-2.2L13.7 3.9a1.7 1.7 0 0 0-3.4 0Z" /></Svg>;
}

export function SettingsIcon(props: SVGProps<SVGSVGElement>): React.JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.32 9c.14.36.4.68.72.9.28.2.62.31.96.32H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </Svg>
  );
}

export function SendIcon(props: SVGProps<SVGSVGElement>): React.JSX.Element {
  return <Svg {...props}><path d="m3 3 18 9-18 9 4-9-4-9Z" /><path d="M7 12h13" /></Svg>;
}

/** Doc 19 §1.6 (pestaña "Agentes" del panel derecho, E2a "Mis agentes"). */
export function UserIcon(props: SVGProps<SVGSVGElement>): React.JSX.Element {
  return <Svg {...props}><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" /></Svg>;
}

/** Rediseño de la barra de navegación izquierda (layout/NavRail.tsx): ítem "Inicio". */
export function HomeIcon(props: SVGProps<SVGSVGElement>): React.JSX.Element {
  return <Svg {...props}><path d="m3 11 9-8 9 8" /><path d="M5 10v10a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V10" /></Svg>;
}

/** Rediseño: botón para mostrar/ocultar el panel contextual de la vista Chats (layout/ChatsView.tsx). */
export function PanelRightIcon(props: SVGProps<SVGSVGElement>): React.JSX.Element {
  return <Svg {...props}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></Svg>;
}

/** Rediseño: cerrar el panel contextual (layout/ChatsView.tsx). */
export function CloseIcon(props: SVGProps<SVGSVGElement>): React.JSX.Element {
  return <Svg {...props}><path d="M18 6 6 18M6 6l12 12" /></Svg>;
}
