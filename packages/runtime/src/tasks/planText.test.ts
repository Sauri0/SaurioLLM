import { describe, expect, it } from 'vitest';
import { planStepsFromText } from './planText.js';

describe('planStepsFromText', () => {
  it('preserva los pasos y el estado explícito sin incluir bloques de código', () => {
    expect(planStepsFromText('## Plan\n1. Leer el archivo\n2) Revisar el resultado\n- [x] Preparar fixture\n```md\n- ejemplo\n```'))
      .toEqual([
        { title: 'Leer el archivo', status: 'pending' },
        { title: 'Revisar el resultado', status: 'pending' },
        { title: 'Preparar fixture', status: 'done' },
      ]);
  });
  it('no inventa tareas para una respuesta sin lista', () => {
    expect(planStepsFromText('Hola. Necesito más información para armar el plan.')).toEqual([]);
  });
  it('no convierte sublistas ni viñetas explicativas en pasos principales', () => {
    expect(planStepsFromText('1. Revisar\n  - [ ] Detalle\n   1. Subpaso\n- Observación\n- [ ] Validar'))
      .toEqual([{ title: 'Revisar', status: 'pending' }, { title: 'Validar', status: 'pending' }]);
  });
});
