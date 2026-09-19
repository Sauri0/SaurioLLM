import { describe, expect, it, vi } from 'vitest';
import { copyMessageText } from './messageCopy.js';

describe('copyMessageText', () => {
  it('escribe el texto exacto y confirma la copia', async () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };

    await expect(copyMessageText('texto con\nsaltos', clipboard)).resolves.toEqual({ ok: true });
    expect(clipboard.writeText).toHaveBeenCalledWith('texto con\nsaltos');
  });

  it('devuelve un error visible si el portapapeles rechaza', async () => {
    const clipboard = { writeText: vi.fn().mockRejectedValue(new Error('Permiso denegado')) };

    await expect(copyMessageText('texto', clipboard)).resolves.toEqual({ ok: false, message: 'Permiso denegado' });
  });

  it('no finge una copia cuando la ventana no expone portapapeles', async () => {
    await expect(copyMessageText('texto', undefined)).resolves.toEqual({
      ok: false,
      message: 'El portapapeles no está disponible en esta ventana.',
    });
  });
});
