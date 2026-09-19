import type { ChatPermissionPreset, PermissionPreset } from '@saurio/shared';

export const CHAT_PERMISSION_INFO: Record<ChatPermissionPreset, {
  label: string;
  description: string;
  risk: 'low' | 'medium' | 'high';
}> = {
  ask: {
    label: 'Preguntar por cambios',
    description: 'Permite lecturas; pide confirmación antes de escribir, borrar, ejecutar comandos, usar red o delegar.',
    risk: 'low',
  },
  edit_in_folder: {
    label: 'Editar en la carpeta',
    description: 'Permite leer, escribir y borrar dentro del proyecto; comandos, red y delegación siguen pidiendo confirmación.',
    risk: 'medium',
  },
  full_in_folder: {
    label: 'Acceso amplio en la carpeta',
    description: 'Permite archivos y comandos ordinarios dentro del proyecto; push, red, rutas protegidas y comandos críticos conservan controles.',
    risk: 'medium',
  },
  unrestricted: {
    label: 'Sin preguntas habituales',
    description: 'Permite acciones ordinarias sin preguntar; rutas protegidas, comandos críticos y el límite de proyecto de las tools de archivos siguen vigentes.',
    risk: 'high',
  },
};

const AGENT_PERMISSION_INFO: Record<PermissionPreset, { label: string; description: string }> = {
  strict: {
    label: 'Heredado · Estricto',
    description: 'Base del agente: lee src sin preguntar; otras lecturas, cambios y acciones sensibles pueden pedir confirmación. También se aplican sus reglas guardadas.',
  },
  balanced: {
    label: 'Heredado · Balanceado',
    description: 'Base del agente: permite lecturas y escrituras; borrados, comandos y otras acciones sensibles piden confirmación. También se aplican sus reglas guardadas.',
  },
  trusting: {
    label: 'Heredado · Confiado',
    description: 'Base del agente: permite lecturas, escrituras y borrados; comandos y otras acciones sensibles piden confirmación. También se aplican sus reglas guardadas.',
  },
};

export interface ChatPermissionDisplay {
  chatPreset: ChatPermissionPreset | undefined;
  label: string;
  description: string;
  source: 'chat' | 'agent' | 'unknown';
}

export function resolveChatPermissionDisplay(
  chatPreset: ChatPermissionPreset | undefined,
  agentPreset: PermissionPreset | undefined,
  lookupState: 'loading' | 'ready' | 'failed' = 'ready',
): ChatPermissionDisplay {
  if (chatPreset) {
    const info = CHAT_PERMISSION_INFO[chatPreset];
    return {
      chatPreset,
      label: info.label,
      description: `${info.description} Configurado para este chat; reemplaza la base del agente y conserva las reglas guardadas.`,
      source: 'chat',
    };
  }
  if (agentPreset) {
    const info = AGENT_PERMISSION_INFO[agentPreset];
    return { chatPreset: undefined, ...info, source: 'agent' };
  }
  return {
    chatPreset: undefined,
    label: lookupState === 'loading' ? 'Heredado · Cargando…' : 'Heredado · Sin confirmar',
    description: lookupState === 'loading'
      ? 'Leyendo la política base del agente. El runtime la conserva mientras este chat no tenga un override.'
      : 'No se pudo confirmar la política base del agente. El runtime la conserva; elegí un preset para fijar un override en este chat.',
    source: 'unknown',
  };
}
