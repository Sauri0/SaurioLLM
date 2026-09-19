import { describe, expect, it } from 'vitest';
import { textMutationCorrectionFor } from './textMutationCorrection.js';

describe('textMutationCorrectionFor', () => {
  it.each([
    [
      'Arreglá el bug de la función doble en src/coder.ts: tiene que devolver n * 2.',
      '¿Podrías proporcionar el contenido de src/coder.ts para que pueda modificarlo?',
    ],
    [
      'Corregí src/coder.ts para que duplique el número.',
      '¿Podrías confirmar que es el contenido exacto de src/coder.ts?',
    ],
    [
      'Arreglá src/coder.ts para que duplique el número.',
      'Primero, necesito leer el contenido de src/coder.ts para poder arreglar el bug.',
    ],
    [
      'Arreglá el bug de la función doble en src/coder.ts: tiene que devolver n * 2.',
      'Para arreglar el bug de la función `doble` en `src/coder.ts`, necesito leer el contenido de ese archivo.',
    ],
    [
      'Please fix src/coder.ts so it doubles the number.',
      'First, I need to read the contents of src/coder.ts before fixing it.',
    ],
  ])('detecta una corrección estrecha para %s', (userText, assistantText) => {
    expect(textMutationCorrectionFor(userText, assistantText)).toEqual({ path: 'src/coder.ts' });
  });

  it.each([
    ['saludo', 'Hola', '¡Hola! ¿En qué te ayudo?'],
    ['pregunta explicativa', '¿Cómo arreglarías src/coder.ts?', 'Primero necesito leer el contenido de src/coder.ts.'],
    ['ejemplo', 'Dame un ejemplo para editar src/coder.ts', '¿Querés que use el contenido de src/coder.ts?'],
    ['cita', 'Citá cómo modificar src/coder.ts', '¿Confirmás el contenido de src/coder.ts?'],
    ['negación', 'No editar src/coder.ts', '¿Confirmás el contenido de src/coder.ts?'],
    ['negación en inglés', "Don't edit src/coder.ts", 'Could you confirm the file content of src/coder.ts?'],
    ['texto citado', 'El texto dice «editar src/coder.ts»', '¿Confirmás el contenido de src/coder.ts?'],
    ['condicional', 'Podrías editar src/coder.ts si te parece', '¿Confirmás el contenido de src/coder.ts?'],
    ['condición posterior', 'Editá src/coder.ts solo si te confirmo', 'Primero necesito leer el contenido de src/coder.ts.'],
    ['negación posterior', 'Arreglá src/coder.ts, pero no lo hagas todavía', 'Primero necesito leer el contenido de src/coder.ts.'],
    ['aprobación posterior', 'Edit src/coder.ts only after approval', 'I need to read the content of src/coder.ts.'],
    ['dos rutas', 'Corregí src/a.ts y src/b.ts', '¿Compartís el contenido de src/a.ts?'],
    ['decisión real', 'Corregí src/coder.ts', '¿Preferís la alternativa A o B para src/coder.ts?'],
    ['respuesta final', 'Corregí src/coder.ts', 'Listo, corregí src/coder.ts.'],
    ['explicación', 'Corregí src/coder.ts', 'Necesito leer el contenido de src/coder.ts para explicarte cómo funciona.'],
    ['ya leído', 'Corregí src/coder.ts', 'Ya leí el contenido de src/coder.ts; ahora voy a corregirlo.'],
    ['error de lectura', 'Corregí src/coder.ts', 'Primero necesito leer el contenido de src/coder.ts, pero no puedo acceder al archivo.'],
    ['sin acceso', 'Fix src/coder.ts', 'I need to read the content of src/coder.ts, but I have no access.'],
  ])('no corrige %s', (_name, userText, assistantText) => {
    expect(textMutationCorrectionFor(userText, assistantText)).toBeUndefined();
  });
});
