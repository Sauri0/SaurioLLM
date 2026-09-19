import { describe, expect, it } from 'vitest';
import type { Checkpoint } from '@saurio/shared';
import { mergeRunCheckpoints } from './runCheckpoints.js';

function checkpoint(overrides: Partial<Checkpoint> & Pick<Checkpoint, 'id'>): Checkpoint {
  return {
    runId: 'run-1', chatId: 'chat-1', kind: 'tool', files: [],
    stats: { files: 0, added: 0, removed: 0 }, status: 'active',
    ...overrides,
  };
}

describe('mergeRunCheckpoints', () => {
  it('undefined si no hay checkpoints (sin tarjeta "0 archivo(s)")', () => {
    expect(mergeRunCheckpoints([])).toBeUndefined();
  });

  it('undefined si los checkpoints no tocaron ningún archivo', () => {
    const cps = [checkpoint({ id: 'c1', files: [], stats: { files: 0, added: 0, removed: 0 } })];
    expect(mergeRunCheckpoints(cps)).toBeUndefined();
  });

  it('suma stats y dedupea archivos por relPath entre varios checkpoints del mismo run', () => {
    const cps: Checkpoint[] = [
      checkpoint({
        id: 'c1',
        files: [{ relPath: 'src/a.ts', change: 'modified' }],
        stats: { files: 1, added: 3, removed: 1 },
      }),
      checkpoint({
        id: 'c2',
        files: [
          { relPath: 'src/a.ts', change: 'modified' },
          { relPath: 'src/b.test.ts', change: 'created' },
        ],
        stats: { files: 2, added: 10, removed: 0 },
      }),
    ];
    const merged = mergeRunCheckpoints(cps);
    expect(merged).toBeDefined();
    expect(merged!.checkpointIds).toEqual(['c1', 'c2']);
    expect(merged!.stats).toEqual({ files: 2, added: 13, removed: 1 });
    expect(merged!.files.map((f) => f.relPath).sort()).toEqual(['src/a.ts', 'src/b.test.ts']);
  });

  it('un "created" nunca se pisa con un "modified" posterior del mismo archivo/run', () => {
    const cps: Checkpoint[] = [
      checkpoint({ id: 'c1', files: [{ relPath: 'src/new.ts', change: 'created' }], stats: { files: 1, added: 5, removed: 0 } }),
      checkpoint({ id: 'c2', files: [{ relPath: 'src/new.ts', change: 'modified' }], stats: { files: 1, added: 2, removed: 0 } }),
    ];
    const merged = mergeRunCheckpoints(cps);
    expect(merged!.files).toEqual([{ relPath: 'src/new.ts', change: 'created' }]);
  });
});
