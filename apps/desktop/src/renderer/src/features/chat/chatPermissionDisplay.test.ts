import { describe, expect, it } from 'vitest';
import { resolveChatPermissionDisplay } from './chatPermissionDisplay.js';

describe('resolveChatPermissionDisplay', () => {
  it('muestra el override del chat con prioridad', () => {
    const display = resolveChatPermissionDisplay('edit_in_folder', 'strict');
    expect(display).toMatchObject({ source: 'chat', chatPreset: 'edit_in_folder', label: 'Editar en la carpeta' });
    expect(display.description).toContain('reemplaza la base');
  });

  it('muestra la política heredada sin inventar un preset de chat', () => {
    const display = resolveChatPermissionDisplay(undefined, 'trusting');
    expect(display).toMatchObject({ source: 'agent', chatPreset: undefined, label: 'Heredado · Confiado' });
  });

  it('no presenta ask como efectivo cuando el perfil todavía no se resolvió', () => {
    const display = resolveChatPermissionDisplay(undefined, undefined, 'failed');
    expect(display).toMatchObject({ source: 'unknown', chatPreset: undefined, label: 'Heredado · Sin confirmar' });
  });
});
