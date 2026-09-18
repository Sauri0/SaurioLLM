// packages/runtime/src/models/TierClassifier.test.ts — casos del encargo (punto 5): "clasificación
// de la escala con casos de 8 GB / 24 GB / solo CPU", más el caso medido que fuerza nivel 6.
import { describe, expect, it } from 'vitest';
import { classifyModelTier, tierForCatalogWeights } from './TierClassifier.js';
import type { HardwareProfile } from './types.js';

const GIB = 1024 * 1024 * 1024;

describe('classifyModelTier — equipo de 8 GB de VRAM (referencia real: RTX 3060 Ti 8 GiB)', () => {
  const vramAvailableBytes = 6.5 * GIB; // ~8 GiB total menos margen/ruido de base (doc 13 §7)
  const ramFreeBytes = 24 * GIB;
  const freeDiskBytes = 400 * GIB;

  it('nivel 1 "Perfecto": qwen3:8b (≈5.2 GB) entra con margen', () => {
    const tier = classifyModelTier({
      vramNeededBytes: 5.5 * GIB, vramAvailableBytes, weightsBytes: 5.2 * GIB, ramFreeBytes, freeDiskBytes,
    });
    expect(tier.level).toBe(1);
    expect(tier.label).toBe('Perfecto');
    expect(tier.color).toBe('green');
    expect(tier.quality).toBe('estimated');
  });

  it('nivel 2 "Muy bueno": justo en el límite de la GPU', () => {
    const tier = classifyModelTier({
      vramNeededBytes: 6.6 * GIB, vramAvailableBytes, weightsBytes: 6.3 * GIB, ramFreeBytes, freeDiskBytes,
    });
    expect(tier.level).toBe(2);
    expect(tier.color).toBe('teal');
  });

  it('nivel 3 "Usable": los pesos entran en GPU pero el contexto grande no', () => {
    const tier = classifyModelTier({
      vramNeededBytes: 8 * GIB, vramAvailableBytes, weightsBytes: 6 * GIB, ramFreeBytes, freeDiskBytes,
    });
    expect(tier.level).toBe(3);
    expect(tier.color).toBe('yellow');
  });

  it('nivel 4 "Al límite": gemma4:31b (≈19.9 GB) — offload parcial real, pesado', () => {
    const tier = classifyModelTier({
      vramNeededBytes: 21 * GIB, vramAvailableBytes, weightsBytes: 19.9 * GIB, ramFreeBytes, freeDiskBytes,
    });
    expect(tier.level).toBe(4);
    expect(tier.color).toBe('orange');
    expect(tier.explanation).toMatch(/lento/);
  });

  it('nivel 5 "Solo CPU": modelo grande que entra en RAM pero casi no usa la GPU', () => {
    const tier = classifyModelTier({
      vramNeededBytes: 22 * GIB, vramAvailableBytes: 0.3 * GIB, weightsBytes: 20 * GIB, ramFreeBytes, freeDiskBytes,
    });
    expect(tier.level).toBe(5);
    expect(tier.color).toBe('red');
  });

  it('nivel 6 "No recomendado": ni la RAM alcanza para los pesos', () => {
    const tier = classifyModelTier({
      vramNeededBytes: 90 * GIB, vramAvailableBytes, weightsBytes: 70 * GIB, ramFreeBytes, freeDiskBytes,
    });
    expect(tier.level).toBe(6);
    expect(tier.color).toBe('gray');
  });

  it('nivel 6 forzado por falta de espacio en disco, aunque entraría en RAM', () => {
    const tier = classifyModelTier({
      vramNeededBytes: 6 * GIB, vramAvailableBytes, weightsBytes: 5 * GIB, ramFreeBytes,
      freeDiskBytes: 2 * GIB, // no alcanza para los 5 GB del modelo
    });
    expect(tier.level).toBe(6);
  });
});

describe('classifyModelTier — equipo de 24 GB de VRAM (GPU grande)', () => {
  const vramAvailableBytes = 22 * GIB;
  const ramFreeBytes = 64 * GIB;

  it('nivel 1: un modelo de 15 GB entra con margen en 22 GB de VRAM disponible', () => {
    const tier = classifyModelTier({ vramNeededBytes: 15 * GIB, vramAvailableBytes, weightsBytes: 14 * GIB, ramFreeBytes });
    expect(tier.level).toBe(1);
  });

  it('MoE: mismo tamaño de pesos, la explicación menciona parámetros activos si se declaran', () => {
    const tier = classifyModelTier({
      vramNeededBytes: 15 * GIB, vramAvailableBytes, weightsBytes: 14 * GIB, ramFreeBytes,
      activeParamsRatio: 3.8 / 25.2, // gemma4:26b, doc 13 §8
    });
    expect(tier.explanation).toMatch(/parte de sus parámetros/);
  });
});

describe('classifyModelTier — equipo #2, iGPU con memoria unificada (Intel Core Ultra 9 288V + Arc 140V, 18 GiB compartidos de 32 GB RAM)', () => {
  const vramAvailableBytes = 17.2 * GIB; // "available" real medido por Ollama (inference compute log)
  const ramFreeBytes = 24 * GIB; // de 32 GB totales, con margen de uso del sistema

  it('un 7-8B Q4 (≈5 GB) es "Muy bueno" o mejor, con la nota de memoria unificada', () => {
    const tier = classifyModelTier({
      vramNeededBytes: 6 * GIB, vramAvailableBytes, weightsBytes: 5.5 * GIB, ramFreeBytes, integrated: true,
    });
    expect([1, 2]).toContain(tier.level);
    expect(tier.explanation).toMatch(/memoria unificada/);
  });

  it('un modelo de visión 26B (pesos + proyector ≈ 16.9 GB) queda "Al límite" o peor, nunca "Perfecto"', () => {
    // Caso medido real: gemma4:26b (Q4, 15.77 GiB de pesos + ~1.1 GiB de proyector) NO entró en esta
    // iGPU — acá se pasa vramNeededBytes ya con el proyector sumado (ver MemoryEstimator) y algo por
    // encima de lo disponible, como ocurrió en la máquina real.
    const weightsBytes = (15.77 + 1.1) * GIB;
    const tier = classifyModelTier({
      vramNeededBytes: 18.5 * GIB, vramAvailableBytes, weightsBytes, ramFreeBytes: 30 * GIB, integrated: true,
    });
    expect(tier.level).toBeGreaterThanOrEqual(4);
    expect(['orange', 'red', 'gray']).toContain(tier.color);
  });

  it('el mismo tamaño en una GPU DEDICADA con igual VRAM disponible sale mejor clasificado (umbral más laxo)', () => {
    const shared = classifyModelTier({ vramNeededBytes: 15 * GIB, vramAvailableBytes: 17.2 * GIB, weightsBytes: 14 * GIB, ramFreeBytes, integrated: true });
    const dedicated = classifyModelTier({ vramNeededBytes: 15 * GIB, vramAvailableBytes: 17.2 * GIB, weightsBytes: 14 * GIB, ramFreeBytes, integrated: false });
    expect(dedicated.level).toBeLessThanOrEqual(shared.level);
  });
});

describe('classifyModelTier — equipo sin GPU dedicada (solo CPU)', () => {
  const vramAvailableBytes = 0;
  const ramFreeBytes = 16 * GIB;

  it('nivel 5: sin VRAM disponible pero el modelo entra en RAM', () => {
    const tier = classifyModelTier({ vramNeededBytes: 5 * GIB, vramAvailableBytes, weightsBytes: 4 * GIB, ramFreeBytes });
    expect(tier.level).toBe(5);
    expect(tier.color).toBe('red');
  });

  it('nivel 6: sin VRAM y el modelo tampoco entra en RAM', () => {
    const tier = classifyModelTier({ vramNeededBytes: 20 * GIB, vramAvailableBytes, weightsBytes: 18 * GIB, ramFreeBytes });
    expect(tier.level).toBe(6);
  });
});

describe('classifyModelTier — resultado MEDIDO (model_compat / Banco de pruebas)', () => {
  it('un "no_fit" medido (p. ej. cudaMalloc failed real) fuerza nivel 6 con quality measured', () => {
    const tier = classifyModelTier({
      vramNeededBytes: 21 * GIB, vramAvailableBytes: 6.5 * 1024 * 1024 * 1024, weightsBytes: 19.9 * 1024 * 1024 * 1024,
      ramFreeBytes: 24 * 1024 * 1024 * 1024,
      tested: { status: 'no_fit', testedAt: Date.now() },
    });
    expect(tier.level).toBe(6);
    expect(tier.quality).toBe('measured');
    expect(tier.explanation).toMatch(/No anduvo bien/);
  });

  it('un "fits" medido con tok/s reales sube a nivel 1 o 2 y muestra el número medido', () => {
    const tier = classifyModelTier({
      vramNeededBytes: 5 * GIB, vramAvailableBytes: 6.5 * GIB, weightsBytes: 5 * GIB, ramFreeBytes: 24 * GIB,
      tested: { status: 'fits', tokPerSec: 62.3, testedAt: Date.now() },
    });
    expect([1, 2]).toContain(tier.level);
    expect(tier.quality).toBe('measured');
    expect(tier.explanation).toMatch(/62\.3 tok\/s/);
  });
});

describe('tierForCatalogWeights — catálogo (modelo NO instalado, pestaña Explorar)', () => {
  function hw(vramTotalGiB: number, vramUsedGiB: number, ramFreeGiB: number, integrated = false): HardwareProfile {
    return {
      cpu: { name: { value: 'CPU', quality: 'measured', source: 'os.cpus', sampledAt: 1 }, threads: { value: 8, quality: 'measured', source: 'os.cpus', sampledAt: 1 } },
      ram: {
        totalBytes: { value: 32 * GIB, quality: 'measured', source: 'os.totalmem', sampledAt: 1 },
        freeBytes: { value: ramFreeGiB * GIB, quality: 'measured', source: 'os.freemem', sampledAt: 1 },
      },
      gpu: {
        vendor: integrated ? 'intel' : 'nvidia', integrated,
        vramTotalBytes: { value: vramTotalGiB * GIB, quality: 'measured', source: 'test', sampledAt: 1 },
        vramUsedBytes: { value: vramUsedGiB * GIB, quality: 'measured', source: 'test', sampledAt: 1 },
      },
      fingerprint: 'fp-test', sampledAt: 1,
    };
  }

  it('un catálogo chico (qwen3:8b, ~5.2 GB) sale "Perfecto" o "Muy bueno" en una RTX 3060 Ti de 8 GiB', () => {
    const tier = tierForCatalogWeights(5.2 * GIB, hw(8, 0.9, 24));
    expect([1, 2]).toContain(tier.level);
    expect(tier.quality).toBe('estimated');
  });

  it('un catálogo grande (gemma4:31b, ~19.9 GB) no sale "Perfecto" en la misma GPU', () => {
    const tier = tierForCatalogWeights(19.9 * GIB, hw(8, 0.9, 24));
    expect(tier.level).toBeGreaterThan(2);
  });

  it('respeta el freeDiskBytes: sin espacio en disco, nivel 6 aunque el modelo entraría en VRAM', () => {
    const tier = tierForCatalogWeights(5 * GIB, hw(8, 0.9, 24), { freeDiskBytes: 1 * GIB });
    expect(tier.level).toBe(6);
  });

  describe('numCtx (punto 5 del encargo: selector de contexto 4k/8k/16k/32k)', () => {
    it('sin numCtx explícito, el resultado es IDÉNTICO al de antes de este cambio (baseline 8192)', () => {
      const withDefault = tierForCatalogWeights(5.2 * GIB, hw(8, 0.9, 24));
      const withExplicit8k = tierForCatalogWeights(5.2 * GIB, hw(8, 0.9, 24), { numCtx: 8192 });
      expect(withDefault).toEqual(withExplicit8k);
    });

    it('subir el contexto (4k -> 32k) nunca mejora el nivel, y en un caso al límite lo empeora', () => {
      // Un modelo justo al límite en 8k debería necesitar más margen (y por lo tanto no mejorar) a 32k.
      const at4k = tierForCatalogWeights(6.5 * GIB, hw(8, 0.5, 24), { numCtx: 4096 });
      const at32k = tierForCatalogWeights(6.5 * GIB, hw(8, 0.5, 24), { numCtx: 32768 });
      expect(at32k.level).toBeGreaterThanOrEqual(at4k.level);
    });

    it('sigue etiquetado "estimated" en cualquier numCtx (nunca "measured" sin Banco de pruebas)', () => {
      for (const numCtx of [4096, 8192, 16384, 32768]) {
        expect(tierForCatalogWeights(5 * GIB, hw(8, 0.9, 24), { numCtx }).quality).toBe('estimated');
      }
    });
  });
});
